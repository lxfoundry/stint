import { expectEqual, expectTrue, sleep } from "../assert.js";
import { awaitClose } from "../closes.js";
import { usdcBalance } from "../helpers.js";
import { openOffers, openPayment, openUrl, sendPayment } from "../payments.js";
import { expectRefunded, readOpenedSession } from "../sessions.js";
import type { ScenarioContext } from "../types.js";

/**
 * How long before the first idle timer fires the second payment is sent: long enough for the gate to answer it before
 * that timer's close lands, short enough to leave that close most of `idleCloseSeconds` to be found. It does not change
 * what the check catches: a timer started by the second answer cannot fire before `idleCloseSeconds` after it, whatever
 * this is.
 */
const SECOND_BEFORE_IDLE_MS = 2_000;
/** How often the scenario looks for the idle close: every second on any target, so that the close is found in its window. */
const CLOSE_POLL_MS = 1_000;

/**
 * Scenario 14 (spec §12.7): the same payment sent twice. Both answers report the one session, from the one transaction,
 * and the buyer is charged once. The second answer changes nothing at the gate (spec §7.3): nobody connects, so the idle
 * timer that the first open started closes the session `idleCloseSeconds` after the first answer, 2 s after the second
 * payment. A timer started again by the second answer could not fire before `idleCloseSeconds` after that payment was
 * sent: the close must be found before then.
 */
export async function samePaymentTwice(context: ScenarioContext): Promise<void> {
  const { required, offer } = await openOffers(context.gateUrl);
  const idleMs = offer.extra.idleCloseSeconds * 1_000;
  if (idleMs < 8_000) throw new Error("scenario 14 needs an offer whose idleCloseSeconds is at least 8 s, to tell one idle timer from two");
  const buyer = await context.newBuyer(BigInt(offer.amount));
  const before = await usdcBalance(context.rpc, buyer.usdcAccount);
  const payment = await openPayment(buyer, required, offer);
  const url = openUrl(context.gateUrl, offer);

  const first = await sendPayment(url, payment.header);
  const answeredAt = Date.now();
  expectEqual(first.status, 201, "the first payment opens the session");
  expectEqual(first.body.session, payment.session, "the first answer reports the payment's session");
  const stored = await readOpenedSession(context, payment.session);

  await sleep(Math.max(0, answeredAt + idleMs - SECOND_BEFORE_IDLE_MS - Date.now()));
  const secondSentAt = Date.now();
  const second = await sendPayment(url, payment.header);
  expectEqual(second.status, 201, "the same payment sent again is answered as the first");
  expectEqual(second.body.session, payment.session, "the second answer reports the same session");
  expectEqual(second.body.paidUntil, first.body.paidUntil, "the second answer reports the same paid_until");
  expectTrue(first.paymentResponse?.transaction, "the first answer names its transaction");
  expectEqual(second.paymentResponse?.transaction, first.paymentResponse.transaction, "both answers name the one transaction");
  expectEqual(await usdcBalance(context.rpc, buyer.usdcAccount), before - BigInt(offer.amount), "the buyer is charged once");

  // The earliest a timer started by the second answer could fire. A look that began before it and found the close after
  // it is not enough: the close must be found by then.
  const secondTimerMs = secondSentAt + idleMs;
  const found = await awaitClose(
    context.rpc,
    payment.session,
    context.readRetry,
    Math.max(0, secondTimerMs - Date.now()),
    "the session is closed by the idle timer of the first answer, before one started by the second could fire",
    CLOSE_POLL_MS,
  );
  expectTrue(Date.now() < secondTimerMs, "the close is found before a timer started by the second answer could fire");
  await expectRefunded(context, { signature: found.signature, session: payment.session, stored, buyer });
}
