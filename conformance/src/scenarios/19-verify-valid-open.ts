import { expectEqual, sleep } from "../assert.js";
import { usdcBalance } from "../helpers.js";
import { expectNoSession, openOffers, openPayment } from "../payments.js";
import type { ScenarioContext } from "../types.js";

/** How long the scenario waits after `/verify` before it reads the chain: several slots on any target. */
const AFTER_VERIFY_MS = 3_000;

/**
 * Scenario 19 (spec §12.7): `/verify` of a valid open changes nothing on-chain. The facilitator finds the open valid and
 * names the buyer as its payer; it simulates and never submits (spec §5.4), so a few slots later neither the session nor
 * its vault exists, and the buyer's USDC has not moved.
 */
export async function verifyValidOpen(context: ScenarioContext): Promise<void> {
  const facilitator = context.facilitator;
  if (!facilitator) throw new Error("scenario 19 needs a target that provides the facilitator's API");
  const { required, offer } = await openOffers(context.gateUrl);
  const buyer = await context.newBuyer(BigInt(offer.amount));
  const before = await usdcBalance(context.rpc, buyer.usdcAccount);
  const payment = await openPayment(buyer, required, offer);

  const verified = await facilitator.verify(payment.payload, offer);
  expectEqual(verified.isValid, true, "the facilitator finds the open valid");
  expectEqual(verified.payer, buyer.signer.address, "and names the buyer, the session's authority, as its payer");

  await sleep(AFTER_VERIFY_MS);
  await expectNoSession(context, payment, "after /verify");
  expectEqual(await usdcBalance(context.rpc, buyer.usdcAccount), before, "the buyer's USDC has not moved");
}
