import { CloseKind, fetchMaybeSession, paidUntil } from "@lxfoundry/stint-program-client";
import { associatedTokenAddress, tokenBalanceChanges } from "@lxfoundry/stint-x402";
import { expectEqual, expectTrue, sleep, waitFor } from "../assert.js";
import { awaitClose } from "../closes.js";
import { buyerClient, closePollMs, sessionSeconds } from "../helpers.js";
import { readUntil } from "../reads.js";
import type { ScenarioContext, StackControl } from "../types.js";
import { watchWhilePaying } from "../watch.js";

/** How far ahead of the wall clock the gate's session clock runs (spec §12.7): its end timer fires this long before paid_until. */
const GATE_AHEAD_MS = 5_000;
/** How long before paid_until the authority tops up: after the gate's end timer has fired, early enough to land before the end. */
const TOP_UP_LEAD_MS = 2_500;
/** How long after forwarding stops a frame may still arrive: one the gate forwarded just before. */
const IN_FLIGHT_MS = 1_000;
/** What the authority buys on-chain. */
const TOP_UP_SECONDS = 12;

/**
 * Runs `work` on a gate whose session clock runs `aheadMs` ahead of the wall clock, and starts an ordinary gate again
 * afterwards, whatever happened. The gate is the run's common one, as in scenario 26: spec §12.2 gives scenario 34 a stack
 * of its own, and restarting the common gate is safe only because the runner runs one scenario at a time.
 */
export async function withGateClockAhead<T>(stack: StackControl, aheadMs: number, work: () => Promise<T>): Promise<T> {
  await stack.stopGate();
  try {
    await stack.startGate({ sessionClockAheadMs: aheadMs });
    return await work();
  } finally {
    await stack.stopGate();
    await stack.startGate();
  }
}

/**
 * Scenario 34 (spec §12.7): a top-up lands while the gate is closing at expiry. The gate's session clock runs 5 s ahead, so
 * its end timer fires 5 s before paid_until: it stops forwarding, and its AtExpiry close fails with NotExpired, since the
 * chain's clock has not reached paid_until. Meanwhile the authority tops up on-chain, through neither the gate nor the
 * facilitator. The gate resumes forwarding and sets its end timer for the new paid_until, and the session runs on to it;
 * the close then counts the top-up.
 */
export async function topUpWhileClosingAtExpiry(context: ScenarioContext): Promise<void> {
  const stack = context.stack;
  if (!stack) throw new Error("scenario 34 needs a target that provides stack control");
  const direct = context.direct;
  if (!direct) throw new Error("scenario 34 needs a target that provides direct chain access");
  await withGateClockAhead(stack, GATE_AHEAD_MS, async () => {
    const buyer = await context.newBuyer(100_000n); // at most 30 s, then 12 s more: 42,000
    const payer = await context.newBuyer(1_000n);
    const watched = await context.newBuyer(0n);
    // The connection and its subscription wait come before the gate's end timer fires, 5 s before the end: the session
    // lasts that wait longer (17 s locally, 30 s on devnet, where the wait is 5 s).
    const seconds = sessionSeconds(context.target, 15) + Math.ceil(context.subscriptionSettleMs / 1_000);
    const session = await buyerClient(buyer).open(context.gateUrl, { seconds });
    const readSession = () => fetchMaybeSession(context.rpc, session.id, { commitment: "confirmed" });
    const opened = await readUntil(context.readRetry, readSession, (read) => read.exists);
    expectTrue(opened.exists, "the session exists on-chain after the open");
    const stored = opened.data;
    const endMs = session.paidUntil * 1_000;
    /** When the gate's end timer fires, on the wall clock. */
    const firedAtMs = endMs - GATE_AHEAD_MS;
    let newEndMs = endMs;
    let deposited = stored.deposited;

    const watch = await watchWhilePaying(context, session, payer, watched);
    try {
      expectTrue(firedAtMs - Date.now() > 3_000, "frames flow for 3 s before the gate's end timer fires: the open took too long");
      // The gate's end timer fires 5 s before paid_until: forwarding stops, and its AtExpiry close fails with NotExpired.
      await sleep(Math.max(0, endMs - TOP_UP_LEAD_MS - Date.now()));
      expectTrue(watch.frames.some((at) => at < firedAtMs), "frames arrived before the gate's end timer fired");
      expectEqual(
        watch.frames.filter((at) => at >= firedAtMs + IN_FLIGHT_MS).length,
        0,
        "the gate stopped forwarding when its end timer fired, before paid_until",
      );

      // Meanwhile the authority tops up on-chain.
      await direct.topUp({ buyer, session: session.id, seconds: TOP_UP_SECONDS });
      const toppedUp = await readUntil(context.readRetry, readSession, (read) => read.exists && read.data.deposited > stored.deposited);
      expectTrue(toppedUp.exists, "the session is still open after the top-up");
      expectEqual(toppedUp.data.deposited, stored.deposited + stored.rate * BigInt(TOP_UP_SECONDS), "the top-up is credited to the deposit");
      newEndMs = Number(paidUntil(toppedUp.data)) * 1_000;
      expectEqual(newEndMs, endMs + TOP_UP_SECONDS * 1_000, "the top-up moves paid_until by the seconds it bought");
      deposited = toppedUp.data.deposited;

      // The gate resumes: changes to the account are forwarded again after the first paid_until, before its end timer fires
      // again, 5 s before the new paid_until.
      await waitFor(
        () => watch.frames.some((at) => at > endMs),
        Math.max(1_000, newEndMs - GATE_AHEAD_MS - Date.now()),
        "the gate forwards again after the first paid_until: it resumed when the top-up landed",
      );
      // The session runs on to its new end: the gate closes it with AtExpiry and drops the connection with 4402.
      await waitFor(
        () => watch.closeCode !== undefined,
        Math.max(1_000, newEndMs + 30_000 - Date.now()),
        "the connection is closed within 30 s of the new paid_until",
      );
    } finally {
      await watch.stop();
    }
    expectEqual(watch.closeCode, 4402, "the connection is dropped with 4402");
    expectTrue(watch.paymentFailure === undefined, "every payment that changed the watched account went through");
    expectEqual(
      watch.frames.filter((at) => at >= newEndMs - GATE_AHEAD_MS + IN_FLIGHT_MS).length,
      0,
      "the gate stopped forwarding again when its end timer fired before the new paid_until",
    );

    const found = await awaitClose(context.rpc, session.id, context.readRetry, 15_000, "the expiry close is on-chain", closePollMs(context.target));
    const { event } = found;
    expectEqual(event.kind, CloseKind.AtExpiry, "the session is closed with AtExpiry");
    expectEqual(event.paidUntil * 1_000n, BigInt(newEndMs), "the close's paid_until is the one the top-up moved it to");
    expectTrue(event.at >= event.paidUntil, "the chain's clock had reached the new paid_until at the close");
    expectEqual(event.claimed + event.owed, deposited, "the receiver is paid the opening deposit and the top-up: the top-up counts");
    expectEqual(event.refunded + event.redirected, 0n, "nothing is refunded");
    const changes = await tokenBalanceChanges(context.rpc, found.signature, context.readRetry);
    const receiverToken = await associatedTokenAddress(stored.receiver, stored.mint);
    expectEqual(changes.get(receiverToken), event.owed + event.redirected, "the receiver's gain in the close");
  });
}
