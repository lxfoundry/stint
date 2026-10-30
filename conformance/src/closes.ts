import type { Address, Rpc, SolanaRpcApi } from "@solana/kit";
import { findClosedEvent, type ClosedEvent } from "@lxfoundry/stint-program-client";
import { fetchProgramInstructions, type RetryOptions } from "@lxfoundry/stint-x402";
import { sleep } from "./assert.js";

/** A close that the scenario did not send: its signature, and the `Closed` event it emitted. */
export interface FoundClose {
  readonly signature: string;
  readonly event: ClosedEvent;
}

/** How many of an address's newest transactions are looked through. */
const LOOKBACK = 20;

/**
 * The close of a session that the gate or the sweeper closed (spec §7.3, "Account closed by another party"): the newest
 * successful transaction that loaded the session's address and emitted a `Closed` event for it. A failed close, and a later
 * transfer of lamports to the closed address (S12), can come after the close, so the newest entry alone is not enough (the probe
 * of Group 0 shows it on the local node). Undefined while there is none.
 *
 * Each entry is a request for its transaction, so a caller that looks again passes the same `notCloses` set: a signature that was
 * read and holds no close of this session is added to it, and is not read again. One that could not be read (the node does not
 * return it yet) is not added, and is tried at the next look.
 */
export async function findClose(
  rpc: Rpc<SolanaRpcApi>,
  session: Address,
  retry: RetryOptions,
  notCloses: Set<string> = new Set(),
): Promise<FoundClose | undefined> {
  const entries = await rpc.getSignaturesForAddress(session, { commitment: "confirmed", limit: LOOKBACK }).send();
  for (const entry of entries) {
    if (entry.err !== null || notCloses.has(entry.signature)) continue;
    const instructions = await fetchProgramInstructions(rpc, entry.signature, retry);
    if (!instructions) continue;
    const event = findClosedEvent(instructions);
    if (event?.session === session) return { signature: entry.signature, event };
    notCloses.add(entry.signature);
  }
  return undefined;
}

/**
 * Looks for the close every `pollMs` until it shows up, or throws, naming `what`, after `timeoutMs`. A transaction that held no
 * close is read once over all the looks, not once per look. A look that the node rejects (a public node's rate limit, say) counts
 * as no close yet and is repeated; if the last look before the deadline was rejected, the error it throws has that one as its cause.
 */
export async function awaitClose(
  rpc: Rpc<SolanaRpcApi>,
  session: Address,
  retry: RetryOptions,
  timeoutMs: number,
  what: string,
  pollMs = 1_000,
): Promise<FoundClose> {
  const deadline = Date.now() + timeoutMs;
  const notCloses = new Set<string>();
  let rejected: unknown;
  for (;;) {
    try {
      const found = await findClose(rpc, session, retry, notCloses);
      if (found) return found;
      rejected = undefined;
    } catch (error) {
      rejected = error;
    }
    if (Date.now() >= deadline) {
      throw new Error(`${what}: not within ${timeoutMs} ms`, rejected === undefined ? undefined : { cause: rejected });
    }
    await sleep(pollMs);
  }
}
