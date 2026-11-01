import { CloseKind, fetchMaybeSession } from "@lxfoundry/stint-program-client";
import { associatedTokenAddress, lamportBalances, tokenBalanceChanges } from "@lxfoundry/stint-x402";
import { expectEqual, expectTrue, sleep, waitFor } from "../assert.js";
import { awaitClose } from "../closes.js";
import { buyerClient, closePollMs, sessionSeconds } from "../helpers.js";
import { readUntil } from "../reads.js";
import type { ScenarioContext } from "../types.js";
import { assertRentReturned, receivedAmount } from "./22-example-agent-task.js";

/**
 * Scenario 3 (spec §12.7): expiry. The paid time runs out while the buyer is connected: forwarding stops within 5 s of `paidUntil`,
 * and the close is confirmed and `4402` sent within 30 s. The session is closed with `AtExpiry`, which pays the receiver all of the deposit.
 */
export async function expiry(context: ScenarioContext): Promise<void> {
  const buyer = await context.newBuyer(100_000n); // the session costs 10,000 (20,000 on devnet)
  const payer = await context.newBuyer(1_000n);
  // The watched account exists before the subscription: the node then sends one message per change (scenario 22).
  const watched = await context.newBuyer(0n);
  const session = await buyerClient(buyer).open(context.gateUrl, { seconds: sessionSeconds(context.target, 10) });
  const readSession = () => fetchMaybeSession(context.rpc, session.id, { commitment: "confirmed" });
  const account = await readUntil(context.readRetry, readSession, (read) => read.exists);
  expectTrue(account.exists, "the session exists on-chain after the open");
  const stored = account.data;
  expectEqual(stored.deposited, session.cost, "the deposit credited at open");
  const vault = await associatedTokenAddress(session.id, stored.mint);
  const paidUntilMs = session.paidUntil * 1_000;

  const seen = { frames: [] as number[], closeCode: undefined as number | undefined, paymentFailure: undefined as unknown };
  const socket = await session.connect();
  socket.on("message", (data) => {
    try {
      if (receivedAmount(JSON.parse(String(data)), watched.usdcAccount) !== undefined) seen.frames.push(Date.now());
    } catch {
      // not JSON, so not a frame about the account
    }
  });
  socket.on("close", (code) => {
    seen.closeCode = code;
  });
  socket.on("error", () => {});
  socket.send(JSON.stringify({ op: "subscribe", accounts: [watched.usdcAccount] }));
  await sleep(context.subscriptionSettleMs); // the subscription is in place before the first payment

  // Keep the watched account changing until the connection ends: whatever the gate forwards after paid_until shows up as a frame.
  let paying = true;
  const payments = (async () => {
    try {
      while (paying) {
        await context.sendUsdc(payer, watched.usdcAccount, 1n);
        await sleep(500);
      }
    } catch (error) {
      seen.paymentFailure = error;
    }
  })();
  try {
    await waitFor(
      () => seen.closeCode !== undefined,
      Math.max(1_000, paidUntilMs + 30_000 - Date.now()),
      "the connection is closed within 30 s of paid_until",
    );
  } finally {
    paying = false;
    await payments;
    socket.terminate();
  }
  expectEqual(seen.closeCode, 4402, "the connection is dropped with 4402");
  expectTrue(seen.paymentFailure === undefined, "every payment that changed the watched account went through");
  expectTrue(
    seen.frames.some((at) => at <= paidUntilMs),
    "frames about the watched account arrived before paid_until",
  );
  expectEqual(seen.frames.filter((at) => at > paidUntilMs + 5_000).length, 0, "no frame arrived more than 5 s after paid_until");

  const found = await awaitClose(context.rpc, session.id, context.readRetry, 15_000, "the expiry close is on-chain", closePollMs(context.target));
  const { event } = found;
  expectEqual(event.kind, CloseKind.AtExpiry, "the session is closed with AtExpiry");
  expectEqual(event.paidUntil, BigInt(session.paidUntil), "the close's paid_until is the one the open reported");
  expectTrue(event.at >= event.paidUntil, "the chain's clock had reached paid_until at the close");
  expectTrue(event.at - event.paidUntil <= 30n, "the close confirmed within 30 s of paid_until");
  // 10 s at 1,000 a second is 10,000: all of it is earned at paid_until, so the receiver is paid it all and nothing is refunded.
  expectEqual(event.claimed + event.owed, stored.deposited, "the receiver is paid the whole deposit");
  expectEqual(event.refunded + event.redirected, 0n, "nothing is refunded");
  const changes = await tokenBalanceChanges(context.rpc, found.signature, context.readRetry);
  const receiverToken = await associatedTokenAddress(stored.receiver, stored.mint);
  expectEqual(changes.get(receiverToken), event.owed + event.redirected, "the receiver's gain in the close");
  expectEqual(changes.get(buyer.usdcAccount) ?? 0n, 0n, "the buyer gains nothing in the close");
  assertRentReturned(await lamportBalances(context.rpc, found.signature, context.readRetry), {
    rentPayer: stored.rentPayer,
    session: session.id,
    vault,
  });
  expectTrue(!(await readUntil(context.readRetry, readSession, (read) => !read.exists)).exists, "the session account is closed");
}
