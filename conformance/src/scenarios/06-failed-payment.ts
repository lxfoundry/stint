import { expectEqual } from "../assert.js";
import { usdcBalance } from "../helpers.js";
import { expectNoSession, expectRefused, openOffers, openPayment, openUrl, sendPayment } from "../payments.js";
import type { ScenarioContext } from "../types.js";

/**
 * Scenario 6 (spec §12.7): a payment that fails. The buyer pays an offer that its USDC cannot cover: every check before
 * the chain passes, and the funding transfer fails in the facilitator's simulation. The gate answers 402
 * (`simulation_failed`), no session exists, and the buyer's USDC is unchanged.
 */
export async function failedPayment(context: ScenarioContext): Promise<void> {
  const { required, offer } = await openOffers(context.gateUrl);
  const buyer = await context.newBuyer(BigInt(offer.amount) - 1n); // one base unit short of the offer
  const before = await usdcBalance(context.rpc, buyer.usdcAccount);
  const payment = await openPayment(buyer, required, offer);
  expectRefused(await sendPayment(openUrl(context.gateUrl, offer), payment.header), "simulation_failed", "a payment the buyer cannot cover");
  await expectNoSession(context, payment, "a payment the buyer cannot cover");
  expectEqual(await usdcBalance(context.rpc, buyer.usdcAccount), before, "the failed payment takes nothing from the buyer");
}
