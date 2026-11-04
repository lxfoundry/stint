import { openConnectCloseEarly } from "./scenarios/01-open-connect-close.js";
import { closeBeforeMinSeconds } from "./scenarios/02-close-before-min-seconds.js";
import { expiry } from "./scenarios/03-expiry.js";
import { topUpBeforeAndAfterExpiry } from "./scenarios/04-top-up.js";
import { paymentRefusals } from "./scenarios/05-payment-refusals.js";
import { failedPayment } from "./scenarios/06-failed-payment.js";
import { unilateralClose } from "./scenarios/07-unilateral-close.js";
import { disconnectAndGrace } from "./scenarios/09-disconnect-and-grace.js";
import { allowanceFunding } from "./scenarios/12-allowance-funding.js";
import { mismatchedPayload } from "./scenarios/13-mismatched-payload.js";
import { samePaymentTwice } from "./scenarios/14-same-payment-twice.js";
import { sponsoredClose } from "./scenarios/15-sponsored-close.js";
import { closeAfterPaidUntil } from "./scenarios/16-close-after-paid-until.js";
import { topUpUnknownSession } from "./scenarios/17-top-up-unknown-session.js";
import { payerMisuse } from "./scenarios/18-payer-misuse.js";
import { verifyValidOpen } from "./scenarios/19-verify-valid-open.js";
import { exampleAgentTask } from "./scenarios/22-example-agent-task.js";
import { gateUnreachableAtClose } from "./scenarios/24-gate-unreachable-at-close.js";
import { gateAndFacilitatorUnreachableAtClose } from "./scenarios/25-gate-and-facilitator-unreachable-at-close.js";
import { expiredSessionNobodyCloses } from "./scenarios/26-expired-session-nobody-closes.js";
import { durationsOutOfBounds } from "./scenarios/32-durations-out-of-bounds.js";
import { topUpWhileClosingAtExpiry } from "./scenarios/34-top-up-while-closing.js";
import type { Capability, IsolationGroup, Scenario } from "./types.js";

/** The scenarios of spec section 12.7. Each is pending until a stage builds it. */
function pending(
  id: number,
  title: string,
  needs: readonly Capability[] = [],
  group: IsolationGroup = "shared",
  run?: Scenario["run"],
): Scenario {
  return { id, title, needs, group, status: "pending", ...(run ? { run } : {}) };
}

function required(
  id: number,
  title: string,
  run: Scenario["run"],
  needs: readonly Capability[] = [],
  group: IsolationGroup = "shared",
): Scenario {
  return { id, title, needs, group, status: "required", run };
}

export const catalogue: readonly Scenario[] = [
  required(1, "Open, connect, close early", openConnectCloseEarly),
  required(2, "Close before minSeconds", closeBeforeMinSeconds),
  required(3, "Expiry", expiry),
  required(4, "Top-up before and after expiry", topUpBeforeAndAfterExpiry),
  required(5, "Payment with wrong terms, a wrong amount, or a Memo instruction", paymentRefusals),
  required(6, "Failed payment", failedPayment),
  required(7, "Unilateral on-chain close", unilateralClose),
  pending(8, "Token: expired, wrong aud, wrong purpose, replayed"),
  required(9, "Disconnect past the grace period; reconnect within it; never connect", disconnectAndGrace),
  pending(10, "Resource outage", ["stack"], "ownStack"),
  pending(11, "Two gate instances, reconnecting elsewhere", ["stack"], "ownStack"),
  required(12, "Allowance funding", allowanceFunding, ["allowance"]),
  required(13, "Payment whose accepted differs by one byte; x402Version 1", mismatchedPayload),
  required(14, "The same payment sent twice", samePaymentTwice),
  required(15, "Sponsored close through closeUrl", sponsoredClose),
  required(16, "Close by an unrelated key after paid_until", closeAfterPaidUntil),
  required(17, "Top-up for an unknown session", topUpUnknownSession),
  required(18, "Fee payer or rent payer in a forbidden position", payerMisuse, ["facilitatorApi"]),
  required(19, "/verify of a valid open", verifyValidOpen, ["facilitatorApi"]),
  pending(20, "Session opened on-chain with the gate's terms but another mint"),
  pending(21, "Refund account closed, a stray base unit, then expiry"),
  required(22, "The example agent's task, scripted", exampleAgentTask, ["stack"]),
  pending(23, "The gate restarts with a session open", ["stack"], "ownStack"),
  required(24, "The gate is unreachable when the buyer closes", gateUnreachableAtClose, ["stack"], "ownStack"),
  required(25, "The gate and the facilitator are unreachable when the buyer closes", gateAndFacilitatorUnreachableAtClose, ["stack"], "ownStack"),
  required(26, "An expired session that nobody closes", expiredSessionNobodyCloses, ["stack"], "ownStack"),
  pending(27, "The seller has closed its receiver_token before a close that pays it", ["stack"], "ownStack"),
  pending(28, "A payout account, then the vault, frozen", ["chain", "stack"], "ownStack"),
  pending(29, "The buyer's process restarts with a session open"),
  pending(30, "The resource closes a session through the admin port", ["stack"]),
  pending(31, "Network time moved forward to the end of maxSeconds", ["chain", "stack"], "ownNetwork"),
  required(32, "Durations out of bounds", durationsOutOfBounds),
  pending(33, "A settlement reply lost after the transaction lands", ["stack"], "ownStack"),
  required(34, "A top-up lands while the gate is closing at expiry", topUpWhileClosingAtExpiry, ["stack"], "ownStack"),
  pending(35, "A session opened on-chain with the gate's terms is adopted"),
];
