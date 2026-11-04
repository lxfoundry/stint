import { expectNoSession, expectRefused, openOffers, openPayment, openUrl, sendPayment, type OpenPaymentOptions } from "../payments.js";
import type { ScenarioContext } from "../types.js";

/**
 * Scenario 13 (spec §12.7): a payment whose `accepted` entry differs from the offer by one byte, and one of `x402Version`
 * 1, each refused with 402 and its reason, and neither leaving a session on-chain. The byte is the last character of
 * `extra.closeUrl`, an ASCII field that a fresh offer does not change (spec §5.5); the transaction is the one the offer
 * itself calls for, so only the echo is wrong.
 */
export async function mismatchedPayload(context: ScenarioContext): Promise<void> {
  const { required, offer } = await openOffers(context.gateUrl);
  const buyer = await context.newBuyer(BigInt(offer.amount));
  const closeUrl = offer.extra.closeUrl;
  const oneByteOff = { ...offer, extra: { ...offer.extra, closeUrl: `${closeUrl.slice(0, -1)}${closeUrl.endsWith("x") ? "y" : "x"}` } };
  const cases: readonly { readonly reason: string; readonly what: string; readonly options: OpenPaymentOptions }[] = [
    { reason: "invalid_payment_requirements", what: "a payment whose accepted entry is one byte off the offer", options: { accepted: oneByteOff } },
    { reason: "invalid_x402_version", what: "a payment of x402Version 1", options: { x402Version: 1 } },
  ];
  for (const { reason, what, options } of cases) {
    const payment = await openPayment(buyer, required, offer, options);
    expectRefused(await sendPayment(openUrl(context.gateUrl, offer), payment.header), reason, what);
    await expectNoSession(context, payment, what);
  }
}
