import {
  getBase58Decoder,
  getBase64Encoder,
  getSignatureFromTransaction,
  getTransactionDecoder,
  type Address,
  type Base58EncodedBytes,
  type Base64EncodedWireTransaction,
  type Rpc,
  type SolanaRpcApi,
} from "@solana/kit";
import {
  CloseKind,
  SESSION_DISCRIMINATOR,
  STINT_PROGRAM_ADDRESS,
  fetchMaybeSession,
  getSessionDecoder,
  getSessionSize,
  paidUntil,
} from "@lxfoundry/stint-program-client";
import { buildCloseTransaction, redactUrls, type SettleResponse } from "@lxfoundry/stint-x402";
import { submitSettlement } from "./settle.js";
import type { FacilitatorContext } from "./verify.js";

export interface SweeperConfig {
  /** Milliseconds between sweeps. Default 30_000. */
  readonly intervalMs?: number;
  /** An endpoint that lists the program's accounts, if `rpcUrl` refuses that (a provider's free tier may). Default `rpcUrl`. */
  readonly scanRpcUrl?: string;
  /** Milliseconds since the epoch; default `Date.now`. Decides which sessions have expired. */
  readonly clock?: () => number;
}

export interface SweepReport {
  readonly closed: readonly Address[];
  readonly failed: readonly { readonly session: Address; readonly error: string }[];
}

export interface SweeperDeps {
  readonly ctx: FacilitatorContext;
  /** Lists the program's accounts: the main RPC, unless its provider refuses that. */
  readonly scanRpc: Rpc<SolanaRpcApi>;
  /** Milliseconds since the epoch. */
  readonly clock: () => number;
  readonly log: (entry: Record<string, unknown>) => void;
}

export interface Sweeper {
  /** Runs one sweep now and resolves to its report. A sweep already in flight is joined, not repeated. */
  sweepOnce(): Promise<SweepReport>;
  /** Sweeps every `intervalMs` from now on, the first sweep one interval from now. The timer does not keep the process alive, and no tick throws: a failed sweep is logged. */
  start(intervalMs: number): void;
  /** Ends the interval and waits for a sweep in flight. `sweepOnce` still works afterwards. */
  stop(): Promise<void>;
}

export const DEFAULT_SWEEP_INTERVAL_MS = 30_000;

/**
 * Where a session account stores `rent_payer`: discriminator 8, version 1, bump 1, authority 32, seed 8, mint 32,
 * receiver 32, receiver authorizer 32 and refund owner 32 come first (`programs/stint/src/state.rs`).
 */
const RENT_PAYER_OFFSET = 178n;

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

function describeFailure(settled: SettleResponse): string {
  const detail = [settled.errorReason, settled.errorMessage].filter((part) => part).join(": ");
  return redactUrls(settled.transaction ? `${detail} (transaction ${settled.transaction})` : detail);
}

/** Spec §6.4: closes the sessions that name the facilitator's rent payer and whose paid time has passed. */
export function createSweeper(deps: SweeperDeps): Sweeper {
  const { ctx, scanRpc, clock, log } = deps;

  // A logger that throws must not escape: it would lose a sweep's report, or become an unhandled rejection in the timer.
  const record = (entry: Record<string, unknown>): void => {
    try {
      log(entry);
    } catch {
      // Nothing else can be done with a logger that fails.
    }
  };

  /** The listed sessions that have expired at `now` (seconds), in the order the node lists them. */
  async function listExpired(now: bigint): Promise<Address[]> {
    const accounts = await scanRpc
      .getProgramAccounts(STINT_PROGRAM_ADDRESS, {
        commitment: "confirmed",
        encoding: "base64",
        filters: [
          { dataSize: BigInt(getSessionSize()) },
          { memcmp: { offset: 0n, bytes: getBase58Decoder().decode(SESSION_DISCRIMINATOR) as Base58EncodedBytes, encoding: "base58" } },
          { memcmp: { offset: RENT_PAYER_OFFSET, bytes: ctx.keys.rentPayer as string as Base58EncodedBytes, encoding: "base58" } },
        ],
      })
      .send();
    const decoder = getSessionDecoder();
    const base64 = getBase64Encoder();
    return accounts
      .filter(({ account }) => paidUntil(decoder.decode(base64.encode(account.data[0]))) <= now)
      .map(({ pubkey }) => pubkey);
  }

  /** Closes one session; throws when the close fails. "skipped": it is gone, no longer expired, or not ours to close. */
  async function closeOne(session: Address, now: bigint): Promise<"closed" | "skipped"> {
    // The listing may be old, or from another node: the gate or another instance may have closed the session since. The scan
    // endpoint may be a third party's, too: the filters it was asked for are not taken on trust, because a close costs a fee.
    const current = await fetchMaybeSession(ctx.rpc, session, { commitment: "confirmed" });
    if (!current.exists || current.data.rentPayer !== ctx.keys.rentPayer || paidUntil(current.data) > now) return "skipped";
    const stored = current.data;

    const { value: lifetime } = await ctx.rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
    const transaction = await buildCloseTransaction({
      session,
      stored,
      closer: ctx.rentPayer,
      feePayer: ctx.keys.feePayer,
      lifetime,
      kind: CloseKind.AtExpiry,
    });
    let wire: Base64EncodedWireTransaction;
    try {
      wire = await ctx.kora.signTransaction(transaction as Base64EncodedWireTransaction);
    } catch (error) {
      throw new Error(`Kora: ${message(error)}`);
    }
    const signature = getSignatureFromTransaction(getTransactionDecoder().decode(getBase64Encoder().encode(wire)));
    const settled = await submitSettlement(ctx, {
      type: "close",
      wire,
      signature,
      blockhash: lifetime.blockhash,
      payer: stored.authority,
      amount: "0",
    });
    if (!settled.success) throw new Error(describeFailure(settled));
    return "closed";
  }

  async function sweep(): Promise<SweepReport> {
    const now = BigInt(Math.floor(clock() / 1000));
    const closed: Address[] = [];
    const failed: { session: Address; error: string }[] = [];
    let expired: Address[];
    try {
      expired = await listExpired(now);
    } catch (error) {
      // The caller may log this: an RPC URL can carry an API key.
      throw new Error(redactUrls(message(error)));
    }
    for (const session of expired) {
      try {
        if ((await closeOne(session, now)) === "closed") closed.push(session);
      } catch (error) {
        failed.push({ session, error: redactUrls(message(error)) });
      }
    }
    if (closed.length > 0 || failed.length > 0) record({ event: "sweep", closed, failed });
    return { closed, failed };
  }

  // A call that arrives while a sweep is in flight gets that sweep: no close is sent twice, with no lock per session.
  let inFlight: Promise<SweepReport> | undefined;
  const sweepOnce = (): Promise<SweepReport> =>
    (inFlight ??= sweep().finally(() => {
      inFlight = undefined;
    }));

  let timer: NodeJS.Timeout | undefined;
  function start(intervalMs: number): void {
    if (timer) return;
    timer = setInterval(() => {
      sweepOnce().catch((error: unknown) => record({ event: "sweep_error", error: redactUrls(message(error)) }));
    }, intervalMs);
    timer.unref();
  }

  async function stop(): Promise<void> {
    clearInterval(timer);
    timer = undefined;
    await inFlight?.catch(() => undefined);
  }

  return { sweepOnce, start, stop };
}
