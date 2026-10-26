import type { ElapsedPayload, PaymentPayload } from "./types.js";

export {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
  encodePaymentSignatureHeader,
} from "@x402/core/http";

/** The scheme-specific part of a payment payload (spec §5.3), or undefined if it is malformed. */
export function readElapsedPayload(payload: PaymentPayload): ElapsedPayload | undefined {
  const inner = payload.payload;
  if (typeof inner.transaction !== "string" || inner.transaction.length === 0) return undefined;
  if (inner.type === "open" && typeof inner.session === "string") {
    return { type: "open", transaction: inner.transaction, session: inner.session };
  }
  if (inner.type === "close") return { type: "close", transaction: inner.transaction };
  return undefined;
}
