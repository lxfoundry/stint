import { openConnectCloseEarly } from "./scenarios/01-open-connect-close.js";
import { closeBeforeMinSeconds } from "./scenarios/02-close-before-min-seconds.js";
import { closeAfterPaidUntil } from "./scenarios/16-close-after-paid-until.js";
import { exampleAgentTask } from "./scenarios/22-example-agent-task.js";
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
  pending(3, "Expiry"),
  pending(4, "Top-up before and after expiry"),
  pending(5, "Payment with wrong terms, a wrong amount, or a Memo instruction"),
  pending(6, "Failed payment"),
  pending(7, "Unilateral on-chain close"),
  pending(8, "Token: expired, wrong aud, wrong purpose, replayed"),
  pending(9, "Disconnect past the grace period; reconnect within it; never connect"),
  pending(10, "Resource outage", ["stack"], "ownStack"),
  pending(11, "Two gate instances, reconnecting elsewhere", ["stack"], "ownStack"),
  pending(12, "Allowance funding", ["allowance"]),
  pending(13, "Payment whose accepted differs by one byte; x402Version 1"),
  pending(14, "The same payment sent twice"),
  pending(15, "Sponsored close through closeUrl"),
  required(16, "Close by an unrelated key after paid_until", closeAfterPaidUntil),
  pending(17, "Top-up for an unknown session"),
  pending(18, "Fee payer or rent payer in a forbidden position", ["facilitatorApi"]),
  pending(19, "/verify of a valid open", ["facilitatorApi"]),
  pending(20, "Session opened on-chain with the gate's terms but another mint"),
  pending(21, "Refund account closed, a stray base unit, then expiry"),
  required(22, "The example agent's task, scripted", exampleAgentTask, ["stack"]),
  pending(23, "The gate restarts with a session open", ["stack"], "ownStack"),
  pending(24, "The gate is unreachable when the buyer closes", ["stack"], "ownStack"),
  pending(25, "The gate and the facilitator are unreachable when the buyer closes", ["stack"], "ownStack"),
  pending(26, "An expired session that nobody closes", ["stack"], "ownStack"),
  pending(27, "The seller has closed its receiver_token before a close that pays it", ["stack"], "ownStack"),
  pending(28, "A payout account, then the vault, frozen", ["chain", "stack"], "ownStack"),
  pending(29, "The buyer's process restarts with a session open"),
  pending(30, "The resource closes a session through the admin port", ["stack"]),
  pending(31, "Network time moved forward to the end of maxSeconds", ["chain", "stack"], "ownNetwork"),
  pending(32, "Durations out of bounds"),
  pending(33, "A settlement reply lost after the transaction lands", ["stack"], "ownStack"),
  pending(34, "A top-up lands while the gate is closing at expiry", ["stack"], "ownStack"),
  pending(35, "A session opened on-chain with the gate's terms is adopted"),
];
