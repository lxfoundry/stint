import { generateKeyPairSigner } from "@solana/kit";
import {
  USDC_DEVNET,
  buildTopUpTransaction,
  encodePaymentSignatureHeader,
  type ElapsedRequirements,
  type PaymentPayload,
} from "@lxfoundry/stint-x402";
import { expectEqual } from "../assert.js";
import { openOffers, sendPayment } from "../payments.js";
import type { ScenarioContext } from "../types.js";

/**
 * Scenario 17 (spec §12.7): a top-up for a session that does not exist. The gate answers `404 unknown_session`, without a
 * payment and with one: it looks at no payment for a session it does not track (spec §7.1). The payment is a top-up of
 * 5 s built from the gate's own offer, for an address that holds nothing. With the facilitator's API, the facilitator
 * refuses that payment as `unknown_session` too (spec §5.4). Nothing is funded: the payment is never settled.
 */
export async function topUpUnknownSession(context: ScenarioContext): Promise<void> {
  const noSession = (await generateKeyPairSigner()).address; // an address that holds no session
  const url = `${context.gateUrl}/sessions/${noSession}/top-up?seconds=5`;

  const asked = await fetch(url, { method: "POST" });
  expectEqual(asked.status, 404, "a top-up for an unknown session is answered 404");
  expectEqual(((await asked.json()) as { error?: unknown }).error, "unknown_session", "as unknown_session");

  const { offer } = await openOffers(context.gateUrl);
  const entry = {
    ...offer,
    amount: (BigInt(offer.extra.rate) * 5n).toString(),
    extra: { ...offer.extra, action: "topUp", session: noSession, seconds: 5 },
  } as ElapsedRequirements;
  const authority = await generateKeyPairSigner();
  const transaction = await buildTopUpTransaction({ requirements: entry, authority, decimals: USDC_DEVNET.decimals });
  const payload: PaymentPayload = { x402Version: 2, resource: { url }, accepted: entry, payload: { type: "topUp", transaction } };
  const paid = await sendPayment(url, encodePaymentSignatureHeader(payload));
  expectEqual(paid.status, 404, "a paid top-up for an unknown session is answered 404");
  expectEqual(paid.body.error, "unknown_session", "as unknown_session");

  if (context.facilitator) {
    const verified = await context.facilitator.verify(payload, entry);
    expectEqual(verified.isValid, false, "the facilitator refuses a top-up for an unknown session");
    expectEqual(verified.invalidReason, "unknown_session", "as unknown_session");
  }
}
