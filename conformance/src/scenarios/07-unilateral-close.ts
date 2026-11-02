import { fetchClosedEvent } from "@lxfoundry/stint-x402";
import { expectEqual, expectTrue, sleep, waitFor } from "../assert.js";
import { buyerClient, sessionSeconds } from "../helpers.js";
import { directSessionOf, readOpenedSession } from "../sessions.js";
import type { ScenarioContext } from "../types.js";

/** How soon after the close is confirmed the gate must have dropped the connection (spec §12.7). */
const DROP_WITHIN_MS = 5_000;

/**
 * Scenario 7 (spec §12.7): a unilateral on-chain close. While a connection is open, the buyer closes its session on the
 * program, past the gate and the facilitator. The gate sees the account go through its subscription to it, and drops the
 * connection with 4410 within 5 s: the close came before the paid time ran out (spec §7.3). The buyer holds no SOL, so a
 * harness key pays the fee; the gate sees the same whoever pays it.
 */
export async function unilateralClose(context: ScenarioContext): Promise<void> {
  const direct = context.direct;
  if (!direct) throw new Error("scenario 7 needs a target that provides direct chain access");
  const buyer = await context.newBuyer(100_000n); // the session costs 30,000 (40,000 on devnet)
  const session = await buyerClient(buyer).open(context.gateUrl, { seconds: sessionSeconds(context.target, 30) });
  const socket = await session.connect();
  let code: number | undefined;
  socket.on("close", (closeCode) => {
    code = closeCode;
  });
  socket.on("error", () => {});
  try {
    const stored = await readOpenedSession(context, session.id);
    // The gate subscribes to the account when the open settles; the node takes a moment to have the subscription.
    await sleep(context.subscriptionSettleMs);
    expectTrue(code === undefined, "the connection is open before the close");

    const signature = await direct.close(await directSessionOf(session.id, stored), buyer.signer);

    await waitFor(() => code !== undefined, DROP_WITHIN_MS, "the gate drops the connection within 5 s of the close's confirmation");
    expectEqual(code, 4410, "the connection is dropped with 4410: the session was closed before its paid time ran out");
    const closed = await fetchClosedEvent(context.rpc, signature, context.readRetry);
    expectTrue(closed, "the close emitted Closed");
    expectEqual(closed.closedBy, buyer.signer.address, "the buyer closed the session itself");
    expectTrue(closed.at < closed.paidUntil, "the close came before paid_until");
  } finally {
    socket.terminate();
  }
}
