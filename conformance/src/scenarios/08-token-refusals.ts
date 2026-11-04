import { expectEqual, expectTrue, sleep } from "../assert.js";
import { buyerClient, sessionSeconds } from "../helpers.js";
import { closeCodeOf, connectWith, tokenFor } from "../tokens.js";
import type { ScenarioContext } from "../types.js";

/** Longer ago than a token's longest life (120 s) plus the gate's 30 s of tolerance for clock skew (spec §7.2). */
const LONG_AGO_MS = 200_000;

/** How long after the close is confirmed the gate has to drop the accepted connection (scenario 7's bound). */
const DROP_WITHIN_MS = 5_000;

/**
 * Scenario 8 (spec §12.7): a connect with an expired token, with one for another audience, with one for another purpose,
 * and with one already used, is refused with `401` each time, before the upgrade (spec §7.2, checks 2 and 3). The
 * session is untouched: a connect with a fresh token is accepted, and the buyer's close through the gate settles it.
 */
export async function tokenRefusals(context: ScenarioContext): Promise<void> {
  const buyer = await context.newBuyer(100_000n); // the deposit is 20,000 (30,000 on devnet)
  const session = await buyerClient(buyer).open(context.gateUrl, { seconds: sessionSeconds(context.target, 20) });
  const sign = (purpose: "connect" | "close", options: { readonly nowMs?: number; readonly audience?: string } = {}) =>
    tokenFor(buyer.signer, context.gateUrl, session.id, purpose, options);
  const refused = async (token: string, what: string) =>
    expectEqual((await connectWith(context.gateUrl, session.id, token)).status, 401, what);

  await refused(await sign("connect", { nowMs: Date.now() - LONG_AGO_MS }), "a connect with an expired token is refused");
  await refused(await sign("connect", { audience: "https://elsewhere.invalid" }), "a connect with a token for another audience is refused");
  await refused(await sign("close"), "a connect with a close token is refused");

  const once = await sign("connect");
  const accepted = await connectWith(context.gateUrl, session.id, once);
  expectTrue(accepted.socket, "a connect with a fresh token is accepted");
  try {
    const dropped = closeCodeOf(accepted.socket);
    await refused(once, "a connect with a token already used is refused");

    const receipt = await session.close();
    expectEqual(receipt.via, "gate", "the buyer's close goes through the gate");
    const { paid, refunded } = receipt;
    expectTrue(paid !== undefined && refunded !== undefined, "the gate reported the close's amounts");
    expectEqual(paid + refunded, session.cost, "paid and refunded add up to the deposit");
    const code = await Promise.race([dropped, sleep(DROP_WITHIN_MS).then(() => undefined)]);
    expectEqual(code, 4410, "the accepted connection is dropped with 4410 within 5 s of the close's confirmation");
  } finally {
    accepted.socket.terminate();
  }
}
