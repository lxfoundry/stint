import type { KeyPairSigner } from "@solana/kit";
import { CloseKind, fetchMaybeSession } from "@lxfoundry/stint-program-client";
import { fetchClosedEvent, lamportBalances, tokenBalanceChanges } from "@lxfoundry/stint-x402";
import { expectEqual, expectTrue, sleep } from "../assert.js";
import { sessionSeconds } from "../helpers.js";
import { readUntil } from "../reads.js";
import type { DirectChain, DirectSession, ScenarioContext } from "../types.js";
import { assertRentReturned } from "./22-example-agent-task.js";

/** Whether the attempt is refused: it rejects. */
async function isRefused(attempt: Promise<unknown>): Promise<boolean> {
  try {
    await attempt;
    return false;
  } catch {
    return true;
  }
}

/** Sends the close until the program accepts it: the chain's clock can trail the wall clock, so `paid_until` may not have passed there yet. */
async function closeOnceAllowed(direct: DirectChain, opened: DirectSession, closer: KeyPairSigner): Promise<string> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      return await direct.close(opened, closer);
    } catch (error) {
      if (Date.now() >= deadline) throw new Error("the program refused the close for 30 s after paid_until", { cause: error });
      await sleep(1_000);
    }
  }
}

/**
 * Scenario 16 (spec §12.7): close by an unrelated key after `paid_until`, on a session opened directly on-chain whose receiver
 * authorizer and rent payer are harness keys, so that no gate or sweeper closes it first.
 */
export async function closeAfterPaidUntil(context: ScenarioContext): Promise<void> {
  const direct = context.direct;
  if (!direct) throw new Error("scenario 16 needs a target that provides direct chain access");
  const buyer = await context.newBuyer(100_000n); // the deposit is 10,250 (20,250 on devnet): the funding key lends no more than that
  const seconds = sessionSeconds(context.target, 10);
  // 250 base units above the rate × seconds, which is below the rate (1,000): the paid time stays `seconds`, and the 250 are what a close refunds.
  const remainder = 250n;
  const opened = await direct.open({ buyer, seconds, remainder });
  const readSession = () => fetchMaybeSession(context.rpc, opened.session, { commitment: "confirmed" });
  const account = await readUntil(context.readRetry, readSession, (read) => read.exists);
  expectTrue(account.exists, "the session exists on-chain after the direct open");
  const stored = account.data;
  expectEqual(stored.rentPayer, opened.rentPayer, "the session names the harness's rent payer");
  const earned = stored.rate * BigInt(seconds); // 10 × 1,000 = 10,000 on the test offer
  expectEqual(stored.deposited, earned + remainder, "the deposit credited at open is rate × seconds + 250"); // 10,250
  expectEqual(opened.deposit, stored.deposited, "the direct session reports the whole deposit");
  if (context.stack) {
    expectTrue(stored.rentPayer !== context.stack.rentPayer, "the session is not the facilitator's, so its sweeper leaves it alone");
  }
  const paidUntilMs = Number(opened.paidUntil) * 1_000;

  // Before paid_until only the authority and the receiver authorizer may close (spec §4.3).
  const stranger = await direct.newKey();
  expectTrue(Date.now() < paidUntilMs - 2_000, "the early close is tried at least 2 s before paid_until: the open took too long");
  expectTrue(await isRefused(direct.close(opened, stranger)), "a close by an unrelated key before paid_until is refused");
  expectTrue((await readSession()).exists, "the refused close left the session open");

  await sleep(Math.max(0, paidUntilMs + 1_000 - Date.now()));
  const signature = await closeOnceAllowed(direct, opened, stranger);

  const closed = await fetchClosedEvent(context.rpc, signature, context.readRetry);
  expectTrue(closed, "the close emitted Closed");
  expectEqual(closed.kind, CloseKind.Standard, "the unrelated key's close is a Standard close");
  expectEqual(closed.closedBy, stranger.address, "the close was signed by the unrelated key");
  // From paid_until on, elapsed stops at paid_until: the whole covered time is charged, whenever the close is made. The receiver is paid
  // exactly rate × seconds (10,000), and the buyer is refunded exactly the 250 base units above it; nothing is redirected, since the buyer's account exists.
  expectEqual(closed.claimed + closed.owed, earned, "the receiver is paid rate × seconds");
  expectEqual(closed.refunded, remainder, "the buyer is refunded exactly the 250 base units above rate × seconds");
  expectEqual(closed.redirected, 0n, "nothing is redirected to the receiver");
  const changes = await tokenBalanceChanges(context.rpc, signature, context.readRetry);
  expectEqual(changes.get(opened.receiverToken), earned - closed.claimed, "the receiver's gain in the close");
  expectEqual(changes.get(opened.refundTo), remainder, "the buyer's refund in the close");
  assertRentReturned(await lamportBalances(context.rpc, signature, context.readRetry), {
    rentPayer: opened.rentPayer,
    session: opened.session,
    vault: opened.vault,
  });
  expectTrue(!(await readUntil(context.readRetry, readSession, (read) => !read.exists)).exists, "the session account is closed");
}
