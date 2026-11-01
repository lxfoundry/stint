import type { Address, KeyPairSigner, Rpc, SolanaRpcApi } from "@solana/kit";
import type { RetryOptions } from "@lxfoundry/stint-x402";

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

/** What a scenario may do to the services that the target runs (spec §12.2). */
export interface StackControl {
  /** The facilitator's rent payer: its sweeper signs closes as this key, and a session that names it as rent payer is the sweeper's. */
  readonly rentPayer: Address;
  /** Stops the gate and its connections. The facilitator, its sweeper and Kora keep running. */
  stopGate(): Promise<void>;
  /** Starts the gate again on the port it had, so that `gateUrl` stays valid. The new gate has no memory of earlier sessions. */
  startGate(): Promise<void>;
}

/** A session opened straight on the program, with no gate and no facilitator: nothing of the stack holds it. */
export interface DirectSession {
  readonly session: Address;
  readonly vault: Address;
  /** A harness key that is not the facilitator's: the rent of the session account and its vault returns to it at the close. */
  readonly rentPayer: Address;
  /** The seller's token account, which a close pays. */
  readonly receiverToken: Address;
  /** The buyer's USDC account, which a close refunds. */
  readonly refundTo: Address;
  /** The whole deposit, the remainder included: the session account's `deposited`. */
  readonly deposit: bigint;
  /** The chain's clock when the session opened, in seconds. */
  readonly startedAt: bigint;
  /** On the chain's clock, in seconds. */
  readonly paidUntil: bigint;
}

/** Opens and closes sessions straight on the program (spec §12.2). */
export interface DirectChain {
  /**
   * Opens a session: the buyer funds the vault, and the rent payer and the receiver authorizer are harness keys, not the
   * stack's. `seconds` is a whole number between the offer's minimum and maximum. `remainder` (default 0) is a number of base
   * units, below the rate, that the buyer adds to the vault: the deposit is `rate x seconds + remainder`, the session is paid
   * for `seconds`, and a close from the paid time on pays `rate x seconds` and refunds the remainder.
   */
  open(options: { readonly buyer: Buyer; readonly seconds: number; readonly remainder?: bigint }): Promise<DirectSession>;
  /**
   * A `Standard` close signed by `closer`, which may be any key and needs no SOL: a harness key pays the fee. Returns the
   * transaction's signature, and rejects if the program refuses the close.
   */
  close(session: DirectSession, closer: KeyPairSigner): Promise<string>;
  /** A new key that holds nothing. */
  newKey(): Promise<KeyPairSigner>;
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
  /**
   * How patiently a scenario reads the chain for what its own transaction just did: a node behind a load
   * balancer can answer from behind right after it reported the transaction `confirmed`. One attempt
   * where the node is ours; several on a network that is not (spec §12.2).
   */
  readonly readRetry: RetryOptions;
  /** Control of the gate that the target runs. Absent on a target whose services the harness does not run. */
  readonly stack?: StackControl;
  /** Sessions opened and closed straight on the program. Absent where the harness holds none of the keys to do it with. */
  readonly direct?: DirectChain;
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
