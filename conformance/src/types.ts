import type { Address, KeyPairSigner, Rpc, SolanaRpcApi } from "@solana/kit";
import type { PaymentPayload, PaymentRequirements, RetryOptions, VerifyResponse } from "@lxfoundry/stint-x402";

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

/** How `StackControl.startGate` starts the gate. */
export interface GateStartOptions {
  /**
   * Milliseconds by which the gate's session clock runs ahead of the wall clock (spec §7.3): its idle and end timers fire
   * that much early, while the chain's clock still decides every amount (scenario 34). Default 0.
   */
  readonly sessionClockAheadMs?: number;
}

/** What a scenario may do to the services that the target runs (spec §12.2). */
export interface StackControl {
  /** The facilitator's rent payer: its sweeper signs closes as this key, and a session that names it as rent payer is the sweeper's. */
  readonly rentPayer: Address;
  /** Stops the gate and its connections. The facilitator, its sweeper and Kora keep running. */
  stopGate(): Promise<void>;
  /**
   * Starts the gate again on the port it had, so that `gateUrl` stays valid. The new gate has no memory of earlier sessions.
   * `options` hold for that gate only: the next start without them brings up an ordinary one.
   */
  startGate(options?: GateStartOptions): Promise<void>;
  /** Stops the facilitator, its sweeper included. Kora and the gate keep running; the gate's calls to the facilitator fail meanwhile. */
  stopFacilitator(): Promise<void>;
  /** Starts the facilitator again on the port it had, with the same keys, so that the `closeUrl` in the gate's offers stays valid. */
  startFacilitator(): Promise<void>;
}

/** A session opened straight on the program, with no gate and no facilitator: nothing of the stack holds it. */
export interface DirectSession {
  readonly session: Address;
  readonly vault: Address;
  /** The session's mint: USDC, or the harness's second mint (`DirectChain.otherMint`). */
  readonly mint: Address;
  /**
   * The session's rent payer, to which the rent of the session account and its vault returns at the close: a harness key
   * that is not the facilitator's for a session opened straight on the program, the facilitator's for one the gate's flow
   * opened (`directSessionOf`).
   */
  readonly rentPayer: Address;
  /** The seller's token account for the session's mint, which a close pays. */
  readonly receiverToken: Address;
  /** The buyer's token account for the session's mint, which a close refunds: its USDC account for a USDC session. */
  readonly refundTo: Address;
  /** The whole deposit, the remainder included: the session account's `deposited`. */
  readonly deposit: bigint;
  /** The chain's clock when the session opened, in seconds. */
  readonly startedAt: bigint;
  /** On the chain's clock, in seconds. */
  readonly paidUntil: bigint;
}

/** The harness's second mint (S5): 6 decimals, like USDC, and a mint authority that only the harness holds. */
export interface OtherMint {
  readonly mint: Address;
  /**
   * Creates `owner`'s associated token account for the mint if it has none (the harness pays its rent), mints `amount`
   * into it, and returns the account. An `amount` of 0 creates the account only.
   */
  fund(owner: Address, amount: bigint): Promise<Address>;
  /** Burns what `owner`'s account for the mint holds and closes the account, so that its rent returns to the harness. `owner` needs no SOL. */
  reclaim(owner: KeyPairSigner): Promise<void>;
}

/** Opens and closes sessions straight on the program (spec §12.2). */
export interface DirectChain {
  /**
   * Opens a session: the buyer funds the vault, the rent payer is a harness key, not the stack's, and so is the receiver
   * authorizer unless `receiverAuthorizer` names one. `seconds` is a whole number between the offer's minimum and
   * maximum. `remainder` (default 0) is a number of base units, below the rate, that the buyer adds to the vault: the
   * deposit is `rate x seconds + remainder`, the session is paid for `seconds`, and a close from the paid time on pays
   * `rate x seconds` and refunds the remainder.
   */
  open(options: {
    readonly buyer: Buyer;
    readonly seconds: number;
    readonly remainder?: bigint;
    /**
     * The receiver authorizer the session names. Default: a throwaway harness key, so that no gate or sweeper takes the
     * session up. A gate's own (its offer's `extra.receiverAuthorizer`) makes it a session that gate may adopt (spec §7.3).
     */
    readonly receiverAuthorizer?: Address;
    /**
     * The session's mint. Default: USDC, funded from `buyer.usdcAccount`. Another mint (`otherMint().mint`) is funded from
     * the buyer's associated token account for it, which `OtherMint.fund` fills, and a close then pays the seller's
     * associated token account for it, which must exist.
     */
    readonly mint?: Address;
  }): Promise<DirectSession>;
  /**
   * A `Standard` close signed by `closer`, which may be any key and needs no SOL: a harness key pays the fee. Returns the
   * transaction's signature, and rejects if the program refuses the close.
   */
  close(session: DirectSession, closer: KeyPairSigner): Promise<string>;
  /**
   * Tops up `session` on the program: `rate x seconds` from the buyer's USDC account into the session's vault, then
   * `top_up` signed by the buyer as the session's authority, in one transaction whose fee a harness key pays. It works on
   * a session the buyer opened in USDC, through the gate or not, and goes through neither the gate nor the facilitator.
   * Returns the transaction's signature, and rejects if the program refuses the top-up.
   */
  topUp(options: { readonly buyer: Buyer; readonly session: Address; readonly seconds: number }): Promise<string>;
  /** A new key that holds nothing. */
  newKey(): Promise<KeyPairSigner>;
  /** The harness's second mint: the same one on every call, created at the first call if it does not exist yet. */
  otherMint(): Promise<OtherMint>;
}

/** The facilitator's `/verify` for resource servers (spec §6.1), called with the target's API key. */
export interface FacilitatorApi {
  verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse>;
}

/** A recurring delegation that the harness granted for a scenario (spec §10). */
export interface AllowanceGrant {
  /** The owner: its USDC account funds the sessions and receives their refunds. It holds what its grant's fee and rent cost, in SOL. */
  readonly owner: Buyer;
  /** The agent: the delegation's delegatee, and the authority of the sessions it opens. It holds nothing. */
  readonly agent: KeyPairSigner;
  readonly nonce: bigint;
  readonly delegation: Address;
  readonly perPeriod: bigint;
  readonly periodSeconds: number;
}

/** Grants and revokes allowances on the Subscriptions & Allowances program (spec §10.1, §12.2). */
export interface AllowanceControl {
  /** A new owner holding `usdc`, a new agent key, and a delegation from one to the other that starts now and ends in a day. */
  grant(options: { readonly usdc: bigint; readonly perPeriod: bigint; readonly periodSeconds: number }): Promise<AllowanceGrant>;
  /** Revokes the delegation and closes the owner's Subscription Authority: their rent returns to the owner. */
  revoke(grant: AllowanceGrant): Promise<void>;
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
  /**
   * The facilitator's `/verify`, with an API key (spec §12.2, "Facilitator API"): present on a target with the
   * `facilitatorApi` capability (scenarios 17, 18 and 19), absent otherwise.
   */
  readonly facilitator?: FacilitatorApi;
  /** Allowances on the Subscriptions & Allowances program (spec §10): present on a target with the `allowance` capability. */
  readonly allowance?: AllowanceControl;
  /**
   * Gives `owner`, a buyer this context made, `lamports` from the harness, for a scenario whose buyer pays a fee itself
   * (scenario 25); a buyer holds no SOL otherwise (spec §9.1). Give at least the rent-exempt minimum of an empty account,
   * 890,880 lamports, or the network refuses the transfer. Absent where the harness holds no SOL to give.
   */
  fundSol?(owner: Address, lamports: bigint): Promise<void>;
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
