import { describe, expect, it } from "vitest";
import {
  buildOpenOffer,
  decodePaymentRequiredHeader,
  encodePaymentRequiredHeader,
  readElapsedPayload,
  type PaymentPayload,
} from "../src/index.js";
import { offerInput } from "./fixtures.js";

const input = offerInput();

describe("wire format", () => {
  it("round-trips a 402 through the PAYMENT-REQUIRED header", () => {
    const required = { x402Version: 2, resource: { url: "http://127.0.0.1:1/sessions" }, accepts: [buildOpenOffer(input)] };
    expect(decodePaymentRequiredHeader(encodePaymentRequiredHeader(required))).toEqual(required);
  });

  it("reads open and close payloads, and nothing else", () => {
    const base = { x402Version: 2, accepted: buildOpenOffer(input) } as const;
    const open: PaymentPayload = { ...base, payload: { type: "open", transaction: "AQ==", session: "x" } };
    expect(readElapsedPayload(open)).toEqual({ type: "open", transaction: "AQ==", session: "x" });
    expect(readElapsedPayload({ ...base, payload: { type: "close", transaction: "AQ==" } })).toEqual({
      type: "close",
      transaction: "AQ==",
    });
    expect(readElapsedPayload({ ...base, payload: { type: "open", transaction: 1 } })).toBeUndefined();
    expect(readElapsedPayload({ ...base, payload: { type: "topUp", transaction: "AQ==" } })).toBeUndefined();
  });
});
