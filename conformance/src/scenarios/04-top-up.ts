import type { Address } from "@solana/kit";
import { StintError, type StintSession } from "@lxfoundry/stint-client";
import { CloseKind, fetchMaybeSession, paidUntil, type Session } from "@lxfoundry/stint-program-client";
import { associatedTokenAddress, tokenBalanceChanges } from "@lxfoundry/stint-x402";
import { expectEqual, expectTrue, sleep, waitFor } from "../assert.js";
import { awaitClose } from "../closes.js";
import { buyerClient, closePollMs, sessionSeconds } from "../helpers.js";
import { readUntil } from "../reads.js";
import type { ScenarioContext } from "../types.js";
import { watchWhilePaying } from "../watch.js";

/**
 * The top-up before expiry, made right after the open, and what it changed: the session's deposit and its new end. It comes
 * before the connection that watches the session and its subscription wait, so it is well outside the facilitator's 10 s
 * margin whatever the target; the chain's clock, which set the end, can lag the facilitator's.
 */
async function topUpBeforeExpiry(
  context: ScenarioContext,
  session: StintSession,
  stored: Session,
  seconds: number,
): Promise<{ readonly deposited: bigint; readonly endMs: number }> {
  const firstEndMs = session.paidUntil * 1_000;
  expectTrue(firstEndMs - Date.now() > 12_000, "the first top-up is more than 12 s before the end: the open took too long");
  const extended = await session.topUp({ seconds });
  expectEqual(extended.cost, stored.rate * BigInt(seconds), "the top-up costs rate x seconds");
  expectEqual(extended.paidUntil * 1_000, firstEndMs + seconds * 1_000, "the top-up moves paid_until by the seconds it bought");
  expectEqual(session.paidUntil, extended.paidUntil, "the session reports the new paid_until");
  const readSession = () => fetchMaybeSession(context.rpc, session.id, { commitment: "confirmed" });
  const toppedUp = await readUntil(context.readRetry, readSession, (read) => read.exists && read.data.deposited > stored.deposited);
  expectTrue(toppedUp.exists, "the session is still open after the top-up");
  expectEqual(toppedUp.data.deposited, stored.deposited + extended.cost, "the top-up is credited to the deposit");
  expectEqual(toppedUp.data.startedAt, stored.startedAt, "the session keeps its start");
  expectEqual(paidUntil(toppedUp.data), BigInt(extended.paidUntil), "the chain's paid_until is the one the gate answered");
  return { deposited: toppedUp.data.deposited, endMs: extended.paidUntil * 1_000 };
}

/** How a top-up was refused: the gate's HTTP status and the reason its body gives; undefined if it went through. */
async function refusalOf(attempt: Promise<unknown>): Promise<{ readonly status?: number; readonly reason?: unknown } | undefined> {
  try {
    await attempt;
    return undefined;
  } catch (error) {
    if (!(error instanceof StintError)) throw error;
    return { status: error.status, reason: (error.body as { error?: unknown } | undefined)?.error };
  }
}

/**
 * Scenario 4 (spec §12.7): a top-up before expiry extends the session; after expiry, a top-up is refused. Once topped up,
 * the buyer stays connected while a payer keeps changing a watched account, so the frames show how long the gate serves
 * the session. A top-up within the facilitator's 10 s margin before the end is refused too. Neither refusal costs the
 * buyer anything.
 */
export async function topUpBeforeAndAfterExpiry(context: ScenarioContext): Promise<void> {
  const buyer = await context.newBuyer(100_000n); // 20 s, then 10 s more: 30,000 (50,000 on devnet)
  const payer = await context.newBuyer(1_000n);
  const watched = await context.newBuyer(0n);
  const client = buyerClient(buyer);
  const session = await client.open(context.gateUrl, { seconds: sessionSeconds(context.target, 20) });
  const readSession = () => fetchMaybeSession(context.rpc, session.id, { commitment: "confirmed" });
  const opened = await readUntil(context.readRetry, readSession, (read) => read.exists);
  expectTrue(opened.exists, "the session exists on-chain after the open");
  const stored = opened.data;
  const usdcOf = async (account: Address) =>
    BigInt((await context.rpc.getTokenAccountBalance(account, { commitment: "confirmed" }).send()).value.amount);
  const firstEndMs = session.paidUntil * 1_000;

  // Before expiry: the top-up adds its seconds to the end of the paid time, and its cost to the deposit. A connection holds
  // the session meanwhile, since the gate closes a session that has had none for 10 s (its idle close), and an open and a
  // top-up confirmed one after the other can take that long on devnet. The watching connection replaces it at once.
  const holding = await session.connect();
  holding.on("error", () => {});
  const { deposited, endMs } = await topUpBeforeExpiry(context, session, stored, sessionSeconds(context.target, 10)).finally(() =>
    holding.terminate(),
  );

  const watch = await watchWhilePaying(context, session, payer, watched);
  try {
    // 5 s before the new end, within the facilitator's 10 s margin, a top-up is refused and takes nothing.
    await sleep(Math.max(0, endMs - 5_000 - Date.now()));
    const before = await usdcOf(buyer.usdcAccount);
    const late = await refusalOf(session.topUp({ seconds: 5 }));
    expectEqual(late?.status, 402, "a top-up 5 s before the end is refused with 402");
    expectEqual(late?.reason, "session_expired", "a top-up 5 s before the end is refused as session_expired");
    expectEqual(await usdcOf(buyer.usdcAccount), before, "the refused top-up takes nothing from the buyer");

    await waitFor(
      () => watch.closeCode !== undefined,
      Math.max(1_000, endMs + 30_000 - Date.now()),
      "the connection is closed within 30 s of the new paid_until",
    );
  } finally {
    await watch.stop();
  }
  expectEqual(watch.closeCode, 4402, "the connection is dropped with 4402");
  expectTrue(watch.paymentFailure === undefined, "every payment that changed the watched account went through");
  expectTrue(
    watch.frames.some((at) => at > firstEndMs + 2_000 && at < endMs - 1_000),
    "frames arrived after the first paid_until: the top-up extended the session",
  );
  expectEqual(watch.frames.filter((at) => at > endMs + 5_000).length, 0, "no frame arrived more than 5 s after the new paid_until");

  const found = await awaitClose(context.rpc, session.id, context.readRetry, 15_000, "the expiry close is on-chain", closePollMs(context.target));
  const { event } = found;
  expectEqual(event.kind, CloseKind.AtExpiry, "the session is closed with AtExpiry");
  expectEqual(event.paidUntil * 1_000n, BigInt(endMs), "the close's paid_until is the one the top-up moved it to");
  expectEqual(event.claimed + event.owed, deposited, "the receiver is paid the opening deposit and the top-up");
  expectEqual(event.refunded + event.redirected, 0n, "nothing is refunded");
  const changes = await tokenBalanceChanges(context.rpc, found.signature, context.readRetry);
  const receiverToken = await associatedTokenAddress(stored.receiver, stored.mint);
  expectEqual(changes.get(receiverToken), event.owed + event.redirected, "the receiver's gain in the close");

  // After expiry the session is gone: a top-up is refused before anything is signed, and takes nothing.
  const afterClose = await usdcOf(buyer.usdcAccount);
  const after = await refusalOf(session.topUp({ seconds: 5 }));
  expectEqual(after?.status, 404, "a top-up after the end is refused with 404");
  expectEqual(after?.reason, "unknown_session", "a top-up after the end is refused as unknown_session");
  expectEqual(await usdcOf(buyer.usdcAccount), afterClose, "the refused top-up takes nothing from the buyer");
  expectEqual(client.remainingBudget(), 1_000_000n - deposited, "the refused top-ups lock nothing");
}
