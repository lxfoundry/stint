import { address } from "@solana/kit";
import { CloseKind, fetchMaybeSession } from "@lxfoundry/stint-program-client";
import { createSessionTools } from "@lxfoundry/stint-client";
import { associatedTokenAddress, fetchClosedEvent, tokenBalanceChanges } from "@lxfoundry/stint-x402";
import { expectEqual, expectTrue } from "../assert.js";
import { buyerClient } from "../helpers.js";
import { readUntil } from "../reads.js";
import type { ScenarioContext } from "../types.js";

/**
 * Scenario 2 (spec §12.7): close before `minSeconds`. The buyer closes at once, so what is charged is the minimum,
 * `rate × minSeconds` (spec §4.2), and the rest of the deposit is refunded. Amounts are read from the close's own transaction.
 */
export async function closeBeforeMinSeconds(context: ScenarioContext): Promise<void> {
  const buyer = await context.newBuyer(100_000n); // the session costs 30,000
  const { tools } = createSessionTools(buyerClient(buyer));

  const opened = await tools.stint_open_session.run({ url: context.gateUrl, seconds: 30, reason: "conformance scenario 2" });
  const session = address(opened.sessionId);
  const readSession = () => fetchMaybeSession(context.rpc, session, { commitment: "confirmed" });
  const account = await readUntil(context.readRetry, readSession, (read) => read.exists);
  expectTrue(account.exists, "the session exists on-chain after the open");
  const stored = account.data;
  const deposit = BigInt(opened.cost);
  expectEqual(stored.deposited, deposit, "the deposit credited at open");

  const receipt = await tools.stint_close_session.run({ sessionId: opened.sessionId });
  const closed = await fetchClosedEvent(context.rpc, receipt.transaction, context.readRetry);
  expectTrue(closed, "the close emitted Closed");
  expectEqual(closed.kind, CloseKind.Standard, "the buyer's close is a Standard close");
  // The scenario means what it says only if the minimum had not passed when the close was made, on the chain's clock. The terms are
  // the stored ones, not 5 s and 1,000: a target whose offer has a longer minimum changes nothing here.
  expectTrue(closed.at - stored.startedAt < BigInt(stored.minSeconds), "the close came before minSeconds had passed");

  const minimum = stored.rate * BigInt(stored.minSeconds); // 5 × 1,000 = 5,000 on the local test offer
  const { paid, refunded } = receipt;
  expectTrue(paid !== undefined && refunded !== undefined, "the gate reported the close's amounts");
  expectEqual(BigInt(paid), minimum, "paid = rate × minSeconds");
  expectEqual(BigInt(refunded), deposit - minimum, "refunded = deposit − rate × minSeconds");

  const changes = await tokenBalanceChanges(context.rpc, receipt.transaction, context.readRetry);
  const receiverToken = await associatedTokenAddress(stored.receiver, stored.mint);
  expectEqual(changes.get(receiverToken), minimum, "the receiver's gain in the close");
  expectEqual(changes.get(buyer.usdcAccount), deposit - minimum, "the buyer's refund in the close");
  expectTrue(!(await readUntil(context.readRetry, readSession, (read) => !read.exists)).exists, "the session account is closed");
}
