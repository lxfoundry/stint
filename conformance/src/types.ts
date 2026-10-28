import type { Address, KeyPairSigner, Rpc, SolanaRpcApi } from "@solana/kit";

/**
 * What a target offers a scenario (spec section 12.2). `facilitatorApi` is the ability to call
 * the facilitator's `/verify` with an API key: always on `local` and `devnet`, and on `external`
 * only with `--facilitator` and `--facilitator-key` (scenarios 18 and 19).
 */
export type Capability = "chain" | "stack" | "allowance" | "facilitatorApi";

/** Where a scenario runs (spec section 12.2, "Isolation"). */
export type IsolationGroup = "shared" | "ownStack" | "ownNetwork";

export type ScenarioStatus = "required" | "pending";

export type ScenarioResult = "pass" | "fail" | "pending" | "not applicable";

export interface Target {
  readonly name: "local" | "devnet" | "external";
  readonly capabilities: ReadonlySet<Capability>;
}

/** A fresh buyer key: USDC in its associated token account, and no SOL (spec §9.1, §12.2). */
export interface Buyer {
  readonly signer: KeyPairSigner;
  readonly usdcAccount: Address;
}

/** What a scenario receives when it runs. */
export interface ScenarioContext {
  readonly target: Target;
  /** The gate's URL, which the session client opens sessions on. */
  readonly gateUrl: string;
  /** The network's RPC, for reading what the scenario's own transactions did (spec §12.2). */
  readonly rpc: Rpc<SolanaRpcApi>;
  newBuyer(usdc: bigint): Promise<Buyer>;
  /**
   * Sends USDC from a buyer's token account to any token account, and returns the transaction's
   * signature. The harness pays the fee: a buyer holds no SOL (spec §9.1, §12.6).
   */
  sendUsdc(from: Buyer, to: Address, amount: bigint): Promise<string>;
  /**
   * Milliseconds a scenario waits after subscribing before it causes the change it expects to hear
   * about. The stream acknowledges a subscription with nothing, so the wait is the only evidence that
   * the node has it; how long that takes is the target's to say, not the scenario's (spec §12.2).
   */
  readonly subscriptionSettleMs: number;
}

export interface Scenario {
  readonly id: number;
  readonly title: string;
  readonly needs: readonly Capability[];
  readonly group: IsolationGroup;
  readonly status: ScenarioStatus;
  /** Absent until the scenario is built. */
  readonly run?: (context: ScenarioContext) => Promise<void>;
}

export interface ScenarioOutcome {
  readonly id: number;
  readonly title: string;
  readonly target: Target["name"];
  readonly status: ScenarioStatus;
  readonly result: ScenarioResult;
  readonly durationMs: number;
  /** A pending scenario that passed: it must be made required in the same change. */
  readonly passesWhilePending: boolean;
  readonly error?: string;
}
