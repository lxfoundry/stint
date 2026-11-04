import type { ElapsedRequirements } from "@lxfoundry/stint-x402";
import { expectEqual } from "../assert.js";
import { expectNoSession, openOffers, openPayment } from "../payments.js";
import type { ScenarioContext } from "../types.js";

/**
 * Scenario 18 (spec §12.7): the facilitator's keys where spec §5.3 forbids them, each refused by `/verify` as
 * `payer_misuse`, and neither leaving a session on-chain. The fee payer may be the fee payer only: here it also funds the
 * vault and is `stint.open`'s rent payer. The rent payer may fund the session's accounts, never be paid by one: here it is
 * the session's receiver. Each open is verified against the offer as the gate issued it.
 */
export async function payerMisuse(context: ScenarioContext): Promise<void> {
  const facilitator = context.facilitator;
  if (!facilitator) throw new Error("scenario 18 needs a target that provides the facilitator's API");
  const { required, offer } = await openOffers(context.gateUrl);
  const buyer = await context.newBuyer(BigInt(offer.amount));
  const cases: readonly { readonly what: string; readonly buildFrom: ElapsedRequirements }[] = [
    { what: "the fee payer as the vault's funder and the open's rent payer", buildFrom: { ...offer, extra: { ...offer.extra, rentPayer: offer.extra.feePayer } } },
    { what: "the rent payer as the session's receiver", buildFrom: { ...offer, payTo: offer.extra.rentPayer } },
  ];
  for (const { what, buildFrom } of cases) {
    const payment = await openPayment(buyer, required, offer, { buildFrom });
    const verified = await facilitator.verify(payment.payload, offer);
    expectEqual(verified.isValid, false, `${what}: refused`);
    expectEqual(verified.invalidReason, "payer_misuse", `${what}: refused as payer_misuse`);
    await expectNoSession(context, payment, what);
  }
}
