import { address } from "@solana/kit";
import { fetchMaybeSession } from "@lxfoundry/stint-program-client";
import { createSessionTools, createStintClient } from "@lxfoundry/stint-client";
import { associatedTokenAddress, fetchClosedEvent, tokenBalanceChanges } from "@lxfoundry/stint-x402";
import { expectEqual, expectTrue, sleep, waitFor } from "../assert.js";
import type { ScenarioContext } from "../types.js";

/**
 * Scenario 1 (spec §12.7): open, connect, close early. Refund = deposit − due; the receiver
 * receives due, across claims and the close. Amounts are read from the session's own
 * transactions (spec §12.2, "Measuring money").
 */
export async function openConnectCloseEarly(context: ScenarioContext): Promise<void> {
  const buyer = await context.newBuyer(1_000_000n);
  const client = createStintClient({
    signer: buyer.signer,
    policy: { maxRate: 10_000n, maxPerSession: 1_000_000n, budget: { amount: 1_000_000n, periodSeconds: 3_600 } },
  });
  const { tools, closeCode } = createSessionTools(client);

  const opened = await tools.stint_open_session.run({ url: context.gateUrl, seconds: 30, reason: "conformance scenario 1" });
  const session = address(opened.sessionId);
  const account = await fetchMaybeSession(context.rpc, session, { commitment: "confirmed" });
  expectTrue(account.exists, "the session exists on-chain after the open");
  const stored = account.data;
  const deposit = BigInt(opened.cost);
  expectEqual(stored.deposited, deposit, "the deposit credited at open");

  await tools.stint_send.run({ sessionId: opened.sessionId, message: { op: "subscribe", accounts: [buyer.usdcAccount] } });
  // Past the minimum, so the charge is normally the elapsed time rather than minSeconds
  // (scenario 2's case). The chain's clock can lag the wall clock, so `due` is computed, not assumed.
  await sleep((stored.minSeconds + 2) * 1000);
  const receipt = await tools.stint_close_session.run({ sessionId: opened.sessionId });

  const closed = await fetchClosedEvent(context.rpc, receipt.transaction);
  expectTrue(closed, "the close emitted Closed");
  // Spec §4.2: elapsed stops at paid_until, and a close charges at least minSeconds.
  const covered = stored.deposited / stored.rate;
  const elapsed = closed.at - stored.startedAt;
  const used = elapsed < 0n ? 0n : elapsed > covered ? covered : elapsed;
  const charged = used > BigInt(stored.minSeconds) ? used : BigInt(stored.minSeconds);
  const due = stored.rate * charged;
  expectEqual(BigInt(receipt.paid), due, "paid = due");
  expectEqual(BigInt(receipt.refunded), deposit - due, "refunded = deposit − due");

  const changes = await tokenBalanceChanges(context.rpc, receipt.transaction);
  const receiverToken = await associatedTokenAddress(stored.receiver, stored.mint);
  expectEqual(changes.get(receiverToken), due, "the receiver's gain in the close");
  expectEqual(changes.get(buyer.usdcAccount), deposit - due, "the buyer's refund in the close");

  expectTrue(!(await fetchMaybeSession(context.rpc, session, { commitment: "confirmed" })).exists, "the session account is closed");
  await waitFor(() => closeCode(opened.sessionId) === 4410, 5_000, "the connection is dropped with 4410");
}
