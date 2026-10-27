import type { Address } from "@solana/kit";
import type { PaymentRequirements } from "@x402/core/types";

export type {
  Network,
  PaymentPayload,
  PaymentRequired,
  PaymentRequirements,
  SettleResponse,
  SupportedResponse,
  VerifyResponse,
} from "@x402/core/types";

export type ElapsedAction = "open" | "topUp" | "close";

/** `extra` of an `elapsed` entry (spec §5.1): `u64` values as decimal strings, `u32` as numbers. */
export interface ElapsedExtra {
  readonly paymentFlow: "escrow";
  readonly action: ElapsedAction;
  /** Set for `topUp` and `close`. */
  readonly session?: string;
  readonly programId: string;
  readonly rate: string;
  readonly seconds: number;
  readonly minSeconds: number;
  readonly maxSeconds: number;
  readonly receiverAuthorizer: string;
  readonly feePayer: string;
  readonly rentPayer: string;
  readonly closeUrl: string;
  readonly recentBlockhash: string;
  readonly lastValidBlockHeight: string;
  readonly idleCloseSeconds: number;
  readonly closeOnOutage: boolean;
}

export type ElapsedRequirements = PaymentRequirements & {
  readonly scheme: "elapsed";
  readonly extra: ElapsedExtra & Record<string, unknown>;
};

/** A resource's terms (spec §4.1): rate in base units per second. */
export interface Terms {
  readonly rate: bigint;
  readonly minSeconds: number;
  readonly maxSeconds: number;
}

/** Everything a session must match to be served by a seller (spec §7.2, check 4). */
export interface SellerTerms {
  readonly programId: Address;
  readonly asset: Address;
  readonly payTo: Address;
  readonly receiverAuthorizer: Address;
  readonly terms: Terms;
}

/** What a facilitator publishes in `/supported` (spec §6.1). */
export interface FacilitatorExtra {
  readonly feePayer: string;
  readonly rentPayer: string;
  readonly programId: string;
  readonly closeUrl: string;
}

export interface OpenPayload {
  readonly type: "open";
  readonly transaction: string;
  /** Informative: the facilitator derives the address itself (spec §5.3). */
  readonly session: string;
}

export interface ClosePayload {
  readonly type: "close";
  readonly transaction: string;
}

export type ElapsedPayload = OpenPayload | ClosePayload;

/** Refusal reasons (spec §5.4). */
export type InvalidReason =
  | "invalid_x402_version"
  | "invalid_payload"
  | "invalid_payment_requirements"
  | "invalid_terms"
  | "invalid_amount"
  | "unexpected_instruction"
  | "payer_misuse"
  | "blockhash_expired"
  | "session_expired"
  | "simulation_failed"
  | "unknown_session"
  | "already_processed";

export type Check<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: InvalidReason; readonly message: string };

export const refuse = (reason: InvalidReason, message: string) => ({ ok: false, reason, message }) as const;
