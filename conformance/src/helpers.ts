import { SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM, isSolanaError, type Rpc, type SolanaRpcApi } from "@solana/kit";
import { createStintClient, type StintClient } from "@lxfoundry/stint-client";
import type { Buyer, Target } from "./types.js";

/**
 * A client for the buyer's key with the limits the scenarios use: at most 1 USDC a session and an hour, 10,000 base units a
 * second. With `rpc`, the client can close a session on the chain itself, if the buyer holds SOL (spec §9.3).
 */
export function buyerClient(buyer: Buyer, options: { readonly rpc?: Rpc<SolanaRpcApi> } = {}): StintClient {
  return createStintClient({
    signer: buyer.signer,
    policy: { maxRate: 10_000n, maxPerSession: 1_000_000n, budget: { amount: 1_000_000n, periodSeconds: 3_600 } },
    ...(options.rpc === undefined ? {} : { rpc: options.rpc }),
  });
}

/**
 * How long a session lasts when a scenario must act on it while it still has time left. A real network takes seconds to
 * confirm an open and every step after it, so the scenario buys ten seconds more there; the amounts it expects follow from the length it buys.
 */
export function sessionSeconds(target: Target, local: number): number {
  return target.name === "devnet" ? local + 10 : local;
}

/** How often a scenario looks for a close that someone else sent: devnet's public node rate-limits, so it is asked half as often. */
export function closePollMs(target: Target): number {
  return target.name === "devnet" ? 2_000 : 1_000;
}

/**
 * Whether a rejection carries the custom error `code` of a program's instruction. A transaction refused in preflight
 * rejects with a kit `SolanaError` whose `cause` chain holds the instruction error; one that lands and fails is reported
 * by the harness as text, `Transaction … failed: {"InstructionError":[0,{"Custom":6006}]}`. Anything else, a network error
 * or another code included, is not the program refusing.
 */
export function rejectedWithProgramError(error: unknown, code: number): boolean {
  const failedTransaction = new RegExp(String.raw`"InstructionError":\[\d+,\{"Custom":${code}\}\]`);
  // The chain is short; the bound keeps a chain that loops from running for ever.
  for (let depth = 0, current = error; current instanceof Error && depth < 10; depth++, current = current.cause) {
    if (isSolanaError(current, SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM) && current.context.code === code) return true;
    if (failedTransaction.test(current.message)) return true;
  }
  return false;
}
