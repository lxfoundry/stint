import type { StintSession } from "@lxfoundry/stint-client";
import { CloseKind, dueAt, fetchMaybeSession, type ClosedEvent, type Session } from "@lxfoundry/stint-program-client";
import {
  HEADERS,
  associatedTokenAddress,
  decodePaymentRequiredHeader,
  fetchClosedEvent,
  readElapsedRequirements,
  tokenBalanceChanges,
  type PaymentRequired,
} from "@lxfoundry/stint-x402";
import { expectEqual, expectTrue, sleep, waitFor } from "../assert.js";
import { awaitClose } from "../closes.js";
import { buyerClient, closePollMs } from "../helpers.js";
import { readUntil } from "../reads.js";
import { describeError } from "../runner.js";
import type { Buyer, ScenarioContext } from "../types.js";

type Socket = Awaited<ReturnType<StintSession["connect"]>>;

/** What the three sessions share: the gate's announced grace period, and how long each session lasts, both in seconds. */
interface Shared {
  readonly context: ScenarioContext;
  readonly grace: number;
  readonly seconds: number;
}

/** The idle close announced by the first open offer of a 402 answer (spec §5.1), in seconds. */
export function idleCloseSecondsOf(required: PaymentRequired): number | undefined {
  for (const entry of required.accepts) {
    const offer = readElapsedRequirements(entry);
    if (offer?.extra.action === "open") return offer.extra.idleCloseSeconds;
  }
  return undefined;
}

/** The grace period the gate announces: how long a session may go without a connection before the gate closes it. */
async function announcedGrace(gateUrl: string): Promise<number> {
  const response = await fetch(`${gateUrl}/sessions`, { method: "POST" });
  const header = response.headers.get(HEADERS.paymentRequired);
  const required = (header ? decodePaymentRequiredHeader(header) : await response.json()) as PaymentRequired;
  const grace = idleCloseSecondsOf(required);
  expectTrue(grace !== undefined, "the gate's offer announces its idle close");
  return grace;
}

const readAccount = (context: ScenarioContext, session: StintSession) =>
  fetchMaybeSession(context.rpc, session.id, { commitment: "confirmed" });

/** Opens a session of `seconds` for the buyer, and reads what the chain stored. */
async function openSession({ context, seconds }: Shared, buyer: Buyer) {
  const session = await buyerClient(buyer).open(context.gateUrl, { seconds });
  const openedAt = Date.now();
  const account = await readUntil(context.readRetry, () => readAccount(context, session), (read) => read.exists);
  expectTrue(account.exists, "the session exists on-chain after the open");
  expectEqual(account.data.deposited, session.cost, "the deposit credited at open");
  return { session, stored: account.data, openedAt };
}

/** Connects, and records the close code the gate gives the connection. */
async function connection(session: StintSession) {
  const socket = await session.connect();
  const seen: { code?: number } = {};
  socket.on("close", (code) => {
    seen.code = code;
  });
  socket.on("error", () => {});
  return { socket, seen };
}

/** Drops a connection from the client's side, waits until it is closed, and returns when. */
async function drop(socket: Socket): Promise<number> {
  const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
  socket.close();
  await closed;
  return Date.now();
}

/**
 * A `Standard` close against spec §4.2 and the transaction itself: `max(minSeconds, elapsed)` is charged, `elapsed` counted to the
 * close on the chain's clock; the receiver gains `owed`, the buyer gets the rest of the deposit.
 */
async function expectStandardClose({ context }: Shared, buyer: Buyer, stored: Session, signature: string, closed: ClosedEvent): Promise<void> {
  expectEqual(closed.kind, CloseKind.Standard, "the close is a Standard close");
  const due = dueAt(stored, closed.at);
  expectEqual(closed.claimed + closed.owed, due, "paid = rate × max(minSeconds, elapsed)");
  expectEqual(closed.refunded, stored.deposited - due, "refunded = deposit − paid");
  expectTrue(closed.refunded > 0n, "part of the deposit is refunded");
  const changes = await tokenBalanceChanges(context.rpc, signature, context.readRetry);
  const receiverToken = await associatedTokenAddress(stored.receiver, stored.mint);
  expectEqual(changes.get(receiverToken), closed.owed, "the receiver's gain in the close");
  expectEqual(changes.get(buyer.usdcAccount), closed.refunded, "the buyer's refund in the close");
}

/** (a) Connect, drop, stay away past the grace period: the gate closes the session, no sooner than the grace period after the drop. */
async function disconnectedPastGrace(shared: Shared, buyer: Buyer): Promise<void> {
  const { context, grace } = shared;
  const { session, stored } = await openSession(shared, buyer);
  const { socket } = await connection(session);
  const droppedAt = await drop(socket);
  await sleep(2_000);
  expectTrue((await readAccount(context, session)).exists, "the session is still open while the grace period runs");
  const found = await awaitClose(
    context.rpc,
    session.id,
    context.readRetry,
    (grace + 30) * 1_000,
    "the gate closes the session after the grace period",
    closePollMs(context.target),
  );
  expectTrue(Date.now() - droppedAt >= (grace - 1) * 1_000, "the gate waited out the grace period before closing");
  // On the chain's clock, which follows the wall clock or lags behind it: a lag can only make `at` smaller, so it cannot fail this bound.
  expectTrue(
    found.event.at - BigInt(Math.floor(droppedAt / 1_000)) <= BigInt(grace + 5),
    "the gate closed within 5 s of the end of the grace period",
  );
  await expectStandardClose(shared, buyer, stored, found.signature, found.event);
}

/** (b) Connect, drop, reconnect within the grace period: the session is kept until the buyer closes it. */
async function reconnectedWithinGrace(shared: Shared, buyer: Buyer): Promise<void> {
  const { context, grace } = shared;
  const { session, stored } = await openSession(shared, buyer);
  const first = await connection(session);
  const droppedAt = await drop(first.socket);
  await sleep(Math.ceil(grace / 3) * 1_000); // well inside the grace period
  const second = await connection(session);
  // Six seconds past the end of the first grace period: a session that the gate wrongly closed then would be gone.
  await sleep(Math.max(0, droppedAt + (grace + 6) * 1_000 - Date.now()));
  expectTrue((await readAccount(context, session)).exists, "the session is kept after the first grace period");
  expectTrue(second.socket.readyState === second.socket.OPEN, "the second connection is still open");

  const receipt = await session.close();
  const closed = await fetchClosedEvent(context.rpc, receipt.transaction, context.readRetry);
  expectTrue(closed, "the close emitted Closed");
  expectEqual(receipt.paid, closed.claimed + closed.owed + closed.redirected, "paid, as the gate reported it");
  expectEqual(receipt.refunded, closed.refunded, "refunded, as the gate reported it");
  await expectStandardClose(shared, buyer, stored, receipt.transaction, closed);
  await waitFor(() => second.seen.code === 4410, 5_000, "the connection is dropped with 4410");
}

/** (c) Never connect: the gate closes the session, no sooner than the grace period after the open. */
async function neverConnected(shared: Shared, buyer: Buyer): Promise<void> {
  const { context, grace } = shared;
  const { session, stored, openedAt } = await openSession(shared, buyer);
  const found = await awaitClose(
    context.rpc,
    session.id,
    context.readRetry,
    (grace + 30) * 1_000,
    "the gate closes a session that was never connected, after the grace period",
    closePollMs(context.target),
  );
  expectTrue(Date.now() - openedAt >= (grace - 1) * 1_000, "the gate waited out the grace period before closing");
  expectTrue(
    found.event.at - BigInt(Math.floor(openedAt / 1_000)) <= BigInt(grace + 5),
    "the gate closed a never-connected session within 5 s of the end of the grace period",
  );
  await expectStandardClose(shared, buyer, stored, found.signature, found.event);
}

/**
 * Scenario 9 (spec §12.7): disconnect past the grace period; reconnect within it; never connect. Closed and refunded;
 * kept; closed and refunded. The three sessions run at the same time, each with its own buyer.
 */
export async function disconnectAndGrace(context: ScenarioContext): Promise<void> {
  const grace = await announcedGrace(context.gateUrl);
  expectTrue(grace >= 5 && grace <= 20, `the gate announces an idle close of ${grace} s: the test offer of spec §12.6 needs 5 to 20 s`);
  const shared: Shared = { context, grace, seconds: 4 * grace + 20 };
  const branches: readonly (readonly [string, (shared: Shared, buyer: Buyer) => Promise<void>])[] = [
    ["disconnected past the grace period", disconnectedPastGrace],
    ["reconnected within the grace period", reconnectedWithinGrace],
    ["never connected", neverConnected],
  ];
  const buyers: Buyer[] = [];
  for (let index = 0; index < branches.length; index++) buyers.push(await context.newBuyer(100_000n)); // a session costs 60,000

  const results = await Promise.allSettled(branches.map(([, branch], index) => branch(shared, buyers[index]!)));
  const failures = results.flatMap((result, index) =>
    result.status === "rejected" ? [`${branches[index]![0]}: ${describeError(result.reason)}`] : [],
  );
  if (failures.length > 0) throw new Error(failures.join("; "));
}
