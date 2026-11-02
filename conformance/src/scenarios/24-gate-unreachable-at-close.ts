import { expectEqual, sleep } from "../assert.js";
import { buyerClient, sessionSeconds } from "../helpers.js";
import { expectRefunded, readOpenedSession } from "../sessions.js";
import type { ScenarioContext } from "../types.js";
import { whileGateStopped } from "./26-expired-session-nobody-closes.js";

/**
 * Scenario 24 (spec §12.7): the gate cannot be reached when the buyer closes. The client's close fallback (spec §9.3)
 * closes through the offer's `closeUrl`: the facilitator's sponsored close, which the client builds from `GET /close` and
 * signs as the session's authority. The buyer holds no SOL and its client has no node, so no other step could close it.
 * Refund as in scenario 1.
 */
export async function gateUnreachableAtClose(context: ScenarioContext): Promise<void> {
  const stack = context.stack;
  if (!stack) throw new Error("scenario 24 needs a target that provides stack control");
  const buyer = await context.newBuyer(100_000n); // the session costs 30,000 (40,000 on devnet)
  const session = await buyerClient(buyer).open(context.gateUrl, { seconds: sessionSeconds(context.target, 30) });
  // A connection keeps the gate's idle timer from closing the session before the gate stops (spec §7.3); the stop drops it.
  const socket = await session.connect();
  socket.on("error", () => {});
  const stored = await readOpenedSession(context, session.id);
  expectEqual(stored.deposited, session.cost, "the deposit credited at open");

  const receipt = await whileGateStopped(stack, async () => {
    // Past the minimum, as in scenario 1, so that the charge is normally the time used rather than minSeconds.
    await sleep((stored.minSeconds + 2) * 1_000);
    return session.close();
  });
  socket.terminate();

  expectEqual(receipt.via, "sponsored", "the client closed through closeUrl, the gate being unreachable");
  const event = await expectRefunded(context, { signature: receipt.transaction, session: session.id, stored, buyer, reported: receipt });
  expectEqual(event.closedBy, buyer.signer.address, "the close was signed by the buyer, as the session's authority");
}
