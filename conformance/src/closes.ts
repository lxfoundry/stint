import type { Address, Rpc, SolanaRpcApi } from "@solana/kit";
import { findClose, type FoundClose, type RetryOptions } from "@lxfoundry/stint-x402";
import { sleep } from "./assert.js";

// The lookup itself lives in the scheme package, which the gate uses too (spec §7.3).
export { findClose, type FoundClose };

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
