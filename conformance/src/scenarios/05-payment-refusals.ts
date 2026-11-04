import { address } from "@solana/kit";
import { expectNoSession, expectRefused, openOffers, openPayment, openUrl, sendPayment, type OpenPaymentOptions } from "../payments.js";
import type { ScenarioContext } from "../types.js";

/** The SPL Memo program: its instruction is outside the layout of an open (spec §5.3). */
const MEMO_PROGRAM_ADDRESS = address("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

/**
 * Scenario 5 (spec §12.7): three payments that do not match the offer they accept, each refused with 402 and its reason,
 * and none leaving a session on-chain. The first is built from another rate than the offer's, the second deposits one
 * base unit less than the offer's amount, and the third adds a Memo instruction after `stint.open`. The buyer holds what
 * the offer costs, so no refusal is for want of funds.
 */
export async function paymentRefusals(context: ScenarioContext): Promise<void> {
  const { required, offer } = await openOffers(context.gateUrl);
  const buyer = await context.newBuyer(BigInt(offer.amount));
  const cases: readonly { readonly reason: string; readonly what: string; readonly options: OpenPaymentOptions }[] = [
    {
      reason: "invalid_terms",
      what: "a payment built from another rate than the offer's",
      options: { buildFrom: { ...offer, extra: { ...offer.extra, rate: (BigInt(offer.extra.rate) + 1n).toString() } } },
    },
    {
      reason: "invalid_amount",
      what: "a payment that deposits one base unit less than the offer's amount",
      options: { buildFrom: { ...offer, amount: (BigInt(offer.amount) - 1n).toString() } },
    },
    {
      reason: "unexpected_instruction",
      what: "a payment with a Memo instruction after stint.open",
      options: { append: [{ programAddress: MEMO_PROGRAM_ADDRESS, data: new TextEncoder().encode("stint scenario 5") }] },
    },
  ];
  for (const { reason, what, options } of cases) {
    const payment = await openPayment(buyer, required, offer, options);
    expectRefused(await sendPayment(openUrl(context.gateUrl, offer), payment.header), reason, what);
    await expectNoSession(context, payment, what);
  }
}
