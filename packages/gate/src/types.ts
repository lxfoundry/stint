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

/** Why a session ended, as `teardown` receives it. `idle`: no connection came back within `idleCloseSeconds`. */
export type EndReason = "closed" | "expired" | "idle" | "outage" | "admin" | "closedElsewhere";

/** The close codes the gate sends on a connection it drops (spec §7.4). */
export const CLOSE_CODES = { PAID_TIME_ENDED: 4402, SESSION_CLOSED: 4410 } as const;

/** The timers the gate arms (spec §12.4). A test replaces them to fire one on demand. */
export interface Timers {
  /** Runs `callback` once, after `delayMs`; the handle goes to `clear`. */
  set(callback: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
}

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
  /**
   * Seconds a session may go without a connection, from its open or from the drop of its last connection,
   * before the gate closes it. Default 60 (spec §7.5); a value that is not a finite number gives 60, and a negative
   * one gives 0. Announced in offers.
   */
  readonly idleCloseSeconds?: number;
  /** Default true (spec §7.5). Announced in offers. The gate does not act on it: no close follows a failure of the resource. */
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
  /** Milliseconds. Runs the idle and end timers and the margin (spec §7.3). Default `Date.now`. */
  readonly sessionClock?: () => number;
  /** The idle and end timers. Default: `setTimeout` and `clearTimeout`, without keeping the process alive. */
  readonly timers?: Timers;
  /** Seconds to wait before the close at the end of the paid time is tried again, after it failed and the session was unchanged. Default 2; a value below 1 is raised to 1, and one that is not a finite number gives 2. */
  readonly endRetrySeconds?: number;
  /**
   * How the session after a settled open, and the `Closed` event after a confirmed close, are
   * re-read while the node returns nothing yet. Default 5 reads, 200 ms apart.
   */
  readonly readRetry?: RetryOptions;
  /** The largest WebSocket message a buyer may send; a bigger one closes the connection with 1009. Default 65536. */
  readonly maxMessageBytes?: number;
  readonly log?: (entry: Record<string, unknown>) => void;
}
