import { createStintClient, type StintClient } from "@lxfoundry/stint-client";
import type { Buyer, Target } from "./types.js";

/** A client for the buyer's key with the limits the scenarios use: at most 1 USDC a session and an hour, 10,000 base units a second. */
export function buyerClient(buyer: Buyer): StintClient {
  return createStintClient({
    signer: buyer.signer,
    policy: { maxRate: 10_000n, maxPerSession: 1_000_000n, budget: { amount: 1_000_000n, periodSeconds: 3_600 } },
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
