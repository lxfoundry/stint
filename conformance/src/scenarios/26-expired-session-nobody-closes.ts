import { CloseKind, fetchMaybeSession } from "@lxfoundry/stint-program-client";
import { associatedTokenAddress, lamportBalances, tokenBalanceChanges } from "@lxfoundry/stint-x402";
import { expectEqual, expectTrue } from "../assert.js";
import { awaitClose } from "../closes.js";
import { buyerClient, closePollMs, sessionSeconds } from "../helpers.js";
import { readUntil } from "../reads.js";
import type { ScenarioContext, StackControl } from "../types.js";
import { assertRentReturned } from "./22-example-agent-task.js";

/**
 * Runs `work` with the gate stopped, and starts the gate again afterwards, whatever happened. The gate is the run's common
 * one: spec §12.2 gives scenario 26 a stack of its own, and stopping the common gate is safe only because the runner runs
 * one scenario at a time. When the runner runs scenarios concurrently, scenario 26 needs a stack of its own.
 */
export async function whileGateStopped<T>(stack: StackControl, work: () => Promise<T>): Promise<T> {
  await stack.stopGate();
  try {
    return await work();
  } finally {
    await stack.startGate();
  }
}

/**
 * Scenario 26 (spec §12.7): an expired session that nobody closes, because the gate is stopped. The sweeper closes it with
 * `AtExpiry`: the receiver is paid, and the rent returns to the rent payer.
 */
export async function expiredSessionNobodyCloses(context: ScenarioContext): Promise<void> {
  const stack = context.stack;
  if (!stack) throw new Error("scenario 26 needs a target that provides stack control");
  const buyer = await context.newBuyer(100_000n); // the session costs 12,000 (22,000 on devnet): the funding key lends no more than that
  const openedAt = Date.now();
  const session = await buyerClient(buyer).open(context.gateUrl, { seconds: sessionSeconds(context.target, 12) });
  const readSession = () => fetchMaybeSession(context.rpc, session.id, { commitment: "confirmed" });
  const account = await readUntil(context.readRetry, readSession, (read) => read.exists);
  expectTrue(account.exists, "the session exists on-chain after the open");
  const stored = account.data;
  expectEqual(stored.deposited, session.cost, "the deposit credited at open");
  expectEqual(stored.rentPayer, stack.rentPayer, "the session names the facilitator's rent payer: the sweeper's to close");
  const vault = await associatedTokenAddress(session.id, stored.mint);
  const paidUntilMs = session.paidUntil * 1_000;
  // Were the gate still running at paid_until it would close the session itself, which is not what this scenario is about.
  // The gate's end timer compares paid_until with its own clock, as this check does.
  expectTrue(paidUntilMs - Date.now() > 3_000, "the gate is stopped at least 3 s before paid_until: the open took too long");
  // Nor may the gate close it for want of a connection: the test offer's idleCloseSeconds is 10, counted on the gate's clock
  // from when the open settled, which is after openedAt. The chain's startedAt would not do: the chain's clock can lag.
  expectTrue(Date.now() < openedAt + 7_000, "the gate is stopped at least 3 s before its idle close: the open took too long");

  // The sweeper lists every 2 s on the local target and every 5 s on the devnet target, and a sweep takes a few seconds to close: 30 s after
  // paid_until covers both. The wait starts when the gate is down, so it also counts the time left until paid_until.
  const found = await whileGateStopped(stack, () =>
    awaitClose(
      context.rpc,
      session.id,
      context.readRetry,
      Math.max(0, paidUntilMs - Date.now()) + 30_000,
      "the sweeper closes the session within 30 s of paid_until",
      closePollMs(context.target),
    ),
  );
  const { event } = found;
  expectEqual(event.kind, CloseKind.AtExpiry, "the sweeper closes with AtExpiry");
  expectEqual(event.closedBy, stack.rentPayer, "the close was signed by the facilitator's rent payer, as the sweeper does");
  expectTrue(event.at >= event.paidUntil, "the chain's clock had reached paid_until at the close");
  // 12 s at 1,000 a second is 12,000: all of it is earned at paid_until, so the receiver is paid it all and nothing is refunded.
  expectEqual(event.claimed + event.owed, stored.deposited, "the receiver is paid the whole deposit");
  expectEqual(event.refunded + event.redirected, 0n, "nothing is refunded");
  const changes = await tokenBalanceChanges(context.rpc, found.signature, context.readRetry);
  const receiverToken = await associatedTokenAddress(stored.receiver, stored.mint);
  expectEqual(changes.get(receiverToken), event.owed + event.redirected, "the receiver's gain in the close");
  assertRentReturned(await lamportBalances(context.rpc, found.signature, context.readRetry), {
    rentPayer: stack.rentPayer,
    session: session.id,
    vault,
  });
  expectTrue(!(await readUntil(context.readRetry, readSession, (read) => !read.exists)).exists, "the session account is closed");
}
