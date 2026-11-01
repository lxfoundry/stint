import { address } from "@solana/kit";

export const SCHEME = "elapsed";
export const X402_VERSION = 2;

/** CAIP-2 network identifiers (spec §5.1). The local target uses devnet's (spec §12.3). */
export const SOLANA_DEVNET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
export const SOLANA_MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";

/** Devnet USDC (spec §3.4). */
export const USDC_DEVNET = { mint: address("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"), decimals: 6 } as const;

/** The x402 v2 HTTP headers. Node lower-cases incoming header names. */
export const HEADERS = {
  paymentRequired: "PAYMENT-REQUIRED",
  paymentSignature: "PAYMENT-SIGNATURE",
  paymentResponse: "PAYMENT-RESPONSE",
} as const;

/**
 * A top-up is refused when its session's paid time ends within this many seconds, on the facilitator's clock, so that the
 * transaction lands before the end (spec §5.4): from `paid_until` on, the program refuses it.
 */
export const TOP_UP_MARGIN_SECONDS = 10;
