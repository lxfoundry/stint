import type { Address, KeyPairSigner } from "@solana/kit";
import type { RetryOptions, Terms } from "@lxfoundry/stint-x402";
import type { WebSocket } from "ws";
import type { GateChain } from "./chain.js";
import type { FacilitatorClient } from "./facilitator.js";

/** What the gate hands the resource (spec §7.6, middleware mode). */
export interface SessionInfo {
  readonly session: Address;
  readonly authority: Address;
  /** Unix seconds. */
  readonly paidUntil: bigint;
}

export type EndReason = "closed" | "expired" | "outage" | "admin" | "closedElsewhere";

/** Spec §7.6. `provision` once when the open settles, `attach` per connection, `teardown` once. */
export interface ResourceAdapter<U = unknown> {
  provision(session: SessionInfo): Promise<U>;
  attach(session: SessionInfo, socket: WebSocket, upstream: U): void;
  teardown(session: SessionInfo, reason: EndReason): Promise<void>;
}

export interface GateConfig<U = unknown> {
  /** The gate's origin, e.g. `http://127.0.0.1:4000`: the `aud` of session tokens (spec §7.2). */
  readonly origin: string;
  readonly network: string;
  readonly asset: { readonly mint: Address; readonly decimals: number };
  /** The seller's wallet (spec §5.1). */
  readonly payTo: Address;
  /** One per resource (spec §7.1); signs closes. */
  readonly receiverAuthorizer: KeyPairSigner;
  readonly terms: Terms;
  /** Durations offered when a request names none (spec §5.2). Default: `[terms.minSeconds]`. */
  readonly durations?: readonly number[];
  /** Default 60 (spec §7.5). Announced in offers; not yet enforced by the gate. */
  readonly idleCloseSeconds?: number;
  /** Default true (spec §7.5). Announced in offers; not yet enforced by the gate. */
  readonly closeOnOutage?: boolean;
  /** Default 60. At most the time an offer's blockhash has left (spec §5.1). */
  readonly maxTimeoutSeconds?: number;
  /** A connect within this many seconds of `paidUntil` is refused (spec §7.2, check 5). Default 2. */
  readonly marginSeconds?: number;
  readonly facilitator: FacilitatorClient;
  readonly chain: GateChain;
  readonly adapter: ResourceAdapter<U>;
  /** Milliseconds. Checks token times and the `jti` cache (spec §7.3). Default `Date.now`. */
  readonly tokenClock?: () => number;
  /** Milliseconds. Runs the margin (spec §7.3). Default `Date.now`. */
  readonly sessionClock?: () => number;
  /**
   * How the session after a settled open, and the `Closed` event after a confirmed close, are
   * re-read while the node returns nothing yet. Default 5 reads, 200 ms apart.
   */
  readonly readRetry?: RetryOptions;
  /** The largest WebSocket message a buyer may send; a bigger one closes the connection with 1009. Default 65536. */
  readonly maxMessageBytes?: number;
  readonly log?: (entry: Record<string, unknown>) => void;
}
