import type { Address } from "@solana/kit";
import { CloseKind, type ClosedEvent, type Session } from "@lxfoundry/stint-program-client";
import { readElapsedPayload } from "@lxfoundry/stint-x402";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NOW_MS, helpers, startHarness, type FakeTimer, type Harness } from "./harness.js";

/** What a deposit of 30,000 at 1,000 per second lasts, in the harness's sessions. */
const END_DUE = NOW_MS + 30_000;
/** The end once 10 s more have been paid for. */
const EXTENDED_DUE = NOW_MS + 40_000;

describe("the gate's subscription to the session account (spec §7.3)", () => {
  let h: Harness;
  const { open, prepareOpen, send, closeWith, settleDown, token, connect, topUpOffers, prepareTopUp, sendTopUp } = helpers(() => h);

  beforeEach(async () => {
    h = await startHarness();
  });

  afterEach(async () => {
    expect(h.escaped).toEqual([]);
    await h.gate.close();
    h.server.closeAllConnections();
    await new Promise((resolve) => h.server.close(resolve));
  });

  /** The one timer still waiting that is due at `dueMs` on the session clock. */
  function pendingDue(dueMs: number): FakeTimer {
    const found = h.timers.pending.filter((timer) => timer.dueMs === dueMs);
    expect(found).toHaveLength(1);
    return found[0]!;
  }
  /** Reports a change to the session's account as the chain would: the account as it now stands, or none. */
  function notify(session: Address, change: Partial<Session> | "gone"): void {
    const watcher = h.watchers.get(session);
    if (!watcher) throw new Error(`no subscription to ${session}`);
    const now = change === "gone" ? undefined : { ...h.sessions.get(session)!, ...change };
    if (now) h.sessions.set(session, now);
    else h.sessions.delete(session);
    watcher.onChange(now);
  }
  /** An open session with one connection: `frames` collects what the buyer's socket receives, `dropped` its close code. */
  async function openConnected() {
    const { session } = await open();
    const { socket } = await connect(session, await token(session, "connect"));
    const frames: string[] = [];
    socket!.on("message", (data) => frames.push(String(data)));
    const dropped = new Promise<number>((resolve) => socket!.once("close", (code) => resolve(code)));
    return { session, server: h.attached.at(-1)!, frames, dropped };
  }

  it("subscribes once when an open settles, and ends the subscription when the session ends", async () => {
    const { session, payload } = await prepareOpen();
    expect((await send(payload)).status).toBe(201);
    expect((await send(payload)).status).toBe(201); // a repeated open finds the session tracked

    expect(h.calls.watch).toEqual([session]);
    expect((await closeWith(session)).status).toBe(200);
    expect(h.unwatched).toEqual([session]);
    expect(h.watchers.size).toBe(0);
  });

  it("moves the end timer when a top-up made elsewhere shows on the account, and hands later connections the new end", async () => {
    const { session } = await open();

    notify(session, { deposited: 40_000n });

    expect(pendingDue(EXTENDED_DUE)).toBeDefined();
    expect(h.timers.pending.filter((timer) => timer.dueMs === END_DUE)).toEqual([]);
    await connect(session, await token(session, "connect"));
    expect(h.calls.attach.at(-1)?.paidUntil).toBe(BigInt(EXTENDED_DUE / 1000));
  });

  it("resumes forwarding at once when the top-up shows after the end timer fired", async () => {
    const { session, server, frames } = await openConnected();
    h.fail.settleClose = true; // the end close fails, as an AtExpiry close does before the chain's clock reaches the end
    h.timers.fire(pendingDue(END_DUE));
    await expect.poll(() => h.timers.pending.map((timer) => timer.delayMs)).toEqual([3_000]);

    notify(session, { deposited: 40_000n });

    expect(h.timers.pending.map((timer) => timer.dueMs)).toEqual([EXTENDED_DUE]);
    server.send("tick:resumed");
    await expect.poll(() => frames).toContain("tick:resumed");
    expect(h.calls.teardown).toEqual([]);
  });

  it("leaves the session as it is on a notification of the same end", async () => {
    const { session } = await open();

    notify(session, { claimed: 8_000n });

    expect(pendingDue(END_DUE)).toBeDefined();
    expect(h.calls.teardown).toEqual([]);
  });

  it("logs a subscription that fails, and keeps the session and its end timer", async () => {
    const { session } = await open();

    h.watchers.get(session)!.onError(new Error("socket closed"));

    expect(h.logs).toContainEqual({ event: "subscription_error", session, error: "socket closed" });
    expect(pendingDue(END_DUE)).toBeDefined();
  });

  it("ends every subscription when the gate stops", async () => {
    const first = await open();
    const second = await open();

    await h.gate.close();

    expect([...h.unwatched].sort()).toEqual([first.session, second.session].sort());
  });

  it("sends no close when the top-up shows on the account while the end timer's re-read is in flight", async () => {
    const { session, server, frames } = await openConnected();
    const reads = h.reads.session;
    let release!: () => void;
    h.hold.readSession = new Promise<void>((resolve) => (release = resolve));
    h.timers.fire(pendingDue(END_DUE)); // forwarding stops; the end timer's re-read waits
    await expect.poll(() => h.reads.session).toBe(reads + 1);

    notify(session, { deposited: 40_000n }); // the session resumes while the re-read is in flight
    release();
    await settleDown();

    expect(h.calls.settle.filter((payload) => readElapsedPayload(payload)?.type === "close")).toEqual([]);
    expect(h.timers.pending.map((timer) => timer.dueMs)).toEqual([EXTENDED_DUE]);
    server.send("tick:resumed");
    await expect.poll(() => frames).toContain("tick:resumed");
    expect(h.calls.teardown).toEqual([]);
  });

  it("starts no subscription for a session provisioned after the gate stopped", async () => {
    let release!: () => void;
    h.hold.provision = new Promise<void>((resolve) => (release = resolve));
    const { payload } = await prepareOpen();
    const opening = send(payload);
    await expect.poll(() => h.calls.provision).toHaveLength(1);

    await h.gate.close();
    release();
    await opening;

    expect(h.calls.watch).toEqual([]);
  });

  it("logs a subscription that cannot start, and still opens the session with its timers", async () => {
    h.fail.watch = true;

    const { session, status } = await open();

    expect(status).toBe(201);
    expect(h.logs).toContainEqual({ event: "subscription_error", session, error: "subscriptions down" });
    expect(pendingDue(END_DUE)).toBeDefined();
  });

  describe("when another party closes the session (spec §7.3)", () => {
    /** On the chain's clock: 8 s after the open, and the end of the paid time. */
    const EARLY = BigInt(NOW_MS / 1000) + 8n;
    const AT_END = BigInt(END_DUE / 1000);

    /** The `Closed` event of a close that the gate did not send, `at` on the chain's clock. */
    const closedAt = (session: Address, at: bigint): ClosedEvent => ({
      session,
      kind: CloseKind.Standard,
      claimed: 0n,
      owed: 8_000n,
      refunded: 22_000n,
      redirected: 0n,
      closedBy: h.buyer.address,
      paidUntil: AT_END,
      at,
    });
    const closesSent = () => h.calls.settle.filter((payload) => readElapsedPayload(payload)?.type === "close");
    /** A promise that a test resolves when it chooses, to hold a call of the fakes in flight. */
    function latch(): { promise: Promise<void>; release: () => void } {
      let release!: () => void;
      const promise = new Promise<void>((resolve) => (release = resolve));
      return { promise, release };
    }
    /** Replaces the harness with one whose gate reads with `readRetry`; the outer `afterEach` stops it. */
    async function restartWithReadRetry(readRetry: { attempts: number; delayMs: number }): Promise<void> {
      await h.gate.close();
      h.server.closeAllConnections();
      await new Promise((resolve) => h.server.close(resolve));
      h = await startHarness({ readRetry });
    }

    it("drops the connections with 4410, sends no close, and ends the session, when the close came before paid_until", async () => {
      const { session, dropped } = await openConnected();
      h.closes.set(session, closedAt(session, EARLY));

      notify(session, "gone");

      expect(await dropped).toBe(4410);
      expect(h.calls.teardown).toEqual(["closedElsewhere"]);
      expect(closesSent()).toEqual([]);
      expect(h.unwatched).toEqual([session]);
      expect(h.timers.pending).toEqual([]);
      expect(h.logs).toContainEqual({ event: "closed_elsewhere", session, found: true });
    });

    it("drops them with 4402 when the close came at or after paid_until: the paid time ran out, whoever closed it", async () => {
      const { session, dropped } = await openConnected();
      h.closes.set(session, closedAt(session, AT_END));

      notify(session, "gone");

      expect(await dropped).toBe(4402);
      expect(h.calls.teardown).toEqual(["closedElsewhere"]);
    });

    it("looks the close up again while none shows, then goes by its session clock: 4410 before paid_until", async () => {
      const { session, dropped } = await openConnected();

      notify(session, "gone");

      expect(await dropped).toBe(4410);
      expect(h.reads.lastClose).toBe(3); // the harness's readRetry allows 3 looks, well within the lookup's 2 s
      expect(h.logs).toContainEqual({ event: "closed_elsewhere", session, found: false });
    });

    it("gives the lookup up after 2 s, however many looks readRetry allows, and goes by its session clock", async () => {
      await restartWithReadRetry({ attempts: 1_000, delayMs: 700 });
      const { session, dropped } = await openConnected();

      notify(session, "gone");

      expect(await dropped).toBe(4410);
      expect(h.reads.lastClose).toBe(3); // at 0, 0.7 and 1.4 s: a fourth look would start past the 2 s bound
    });

    it("gives up a look that never answers at the end of the 2 s, and goes by its session clock", async () => {
      const { session, dropped } = await openConnected();
      h.hold.lastClose = new Promise<void>(() => {});

      notify(session, "gone");

      expect(await dropped).toBe(4410);
      expect(h.reads.lastClose).toBe(1);
    });

    it("goes by its session clock without a close to read: 4402 once the clock has reached paid_until", async () => {
      const { session, dropped } = await openConnected();
      h.clock.now = END_DUE;

      notify(session, "gone");

      expect(await dropped).toBe(4402);
    });

    it("goes by its session clock when the lookup fails, and logs the failure", async () => {
      const { session, dropped } = await openConnected();
      h.fail.lastClose = true;

      notify(session, "gone");

      expect(await dropped).toBe(4410);
      expect(h.reads.lastClose).toBe(1); // a look that throws is not repeated
      expect(h.logs).toContainEqual({ event: "error", error: "rpc down" });
    });

    it("stops forwarding while it looks the close up", async () => {
      const { session, server, frames, dropped } = await openConnected();
      const held = latch();
      h.hold.lastClose = held.promise;
      h.closes.set(session, closedAt(session, EARLY));

      notify(session, "gone");
      server.send("tick:after-close");
      await settleDown();

      expect(frames).not.toContain("tick:after-close");
      held.release();
      expect(await dropped).toBe(4410);
    });

    it("refuses a new connection, a close and a top-up, and disarms its end timer, while it looks the close up", async () => {
      const { session, dropped } = await openConnected();
      const held = latch();
      h.hold.lastClose = held.promise;
      h.closes.set(session, closedAt(session, EARLY));

      notify(session, "gone");
      await expect.poll(() => h.reads.lastClose).toBe(1);

      expect((await connect(session, await token(session, "connect"))).status).toBe(404);
      expect((await closeWith(session)).status).toBe(404);
      expect((await topUpOffers(session)).status).toBe(404);
      expect(h.timers.pending.filter((timer) => timer.dueMs === END_DUE)).toEqual([]);
      expect(closesSent()).toEqual([]);
      held.release();
      expect(await dropped).toBe(4410);
    });

    it("does not resume forwarding when a top-up that was settling confirms while it looks the close up", async () => {
      const { session, server, frames, dropped } = await openConnected();
      const payload = await prepareTopUp(session);
      const settling = latch();
      h.hold.settleTopUp = settling.promise;
      const toppingUp = sendTopUp(session, payload);
      await expect.poll(() => h.calls.settle.some((sent) => readElapsedPayload(sent)?.type === "topUp")).toBe(true);
      const looking = latch();
      h.hold.lastClose = looking.promise;
      h.closes.set(session, closedAt(session, EARLY));

      notify(session, "gone"); // the top-up landed before the close, and its confirmation is still on its way
      settling.release();
      await toppingUp;
      server.send("tick:after-close");
      await settleDown();

      expect(frames).not.toContain("tick:after-close");
      expect(h.timers.pending).toEqual([]);
      looking.release();
      expect(await dropped).toBe(4410);
    });

    it("sends no end close while it looks the close up, when an end-timer pass already running fails its re-read", async () => {
      const { session, dropped } = await openConnected();
      let failRead!: (error: Error) => void;
      h.hold.readSession = new Promise<void>((_, reject) => (failRead = reject));
      const reads = h.reads.session;
      h.timers.fire(pendingDue(END_DUE)); // the pass mutes the session and starts its re-read
      await expect.poll(() => h.reads.session).toBe(reads + 1);
      const looking = latch();
      h.hold.lastClose = looking.promise;
      h.closes.set(session, closedAt(session, AT_END));

      notify(session, "gone");
      failRead(new Error("rpc down"));
      await settleDown();

      expect(closesSent()).toEqual([]);
      expect(h.timers.pending).toEqual([]);
      looking.release();
      expect(await dropped).toBe(4402);
      expect(h.calls.teardown).toEqual(["closedElsewhere"]);
    });

    it.each<[string, (stored: Session) => Session | undefined]>([
      ["a later paid_until, from a node that lags", (stored) => ({ ...stored, deposited: stored.deposited + 10_000n })],
      ["the account gone", () => undefined],
    ])("leaves the session to the lookup when an end-timer pass already running re-reads %s", async (_, reread) => {
      const { session, server, frames, dropped } = await openConnected();
      const stored = h.sessions.get(session)!;
      const reading = latch();
      h.hold.readSession = reading.promise;
      const reads = h.reads.session;
      h.timers.fire(pendingDue(END_DUE)); // the pass mutes the session and starts its re-read
      await expect.poll(() => h.reads.session).toBe(reads + 1);
      const looking = latch();
      h.hold.lastClose = looking.promise;
      h.closes.set(session, closedAt(session, EARLY));

      notify(session, "gone");
      const found = reread(stored);
      if (found) h.sessions.set(session, found); // what the re-read, answering after the notification, finds
      reading.release();
      await settleDown();
      server.send("tick:after-close");
      await settleDown();

      expect(frames).not.toContain("tick:after-close");
      expect(h.timers.pending).toEqual([]);
      looking.release();
      expect(await dropped).toBe(4410); // from the Closed event, not the end timer's 4402
      expect(h.calls.teardown).toEqual(["closedElsewhere"]);
    });

    it("lets a close of its own in flight decide: once confirmed, that close ends the session with its own reason and code", async () => {
      const { session, dropped } = await openConnected();
      const held = latch();
      h.hold.settleClose = held.promise;
      const closing = closeWith(session);
      await expect.poll(() => closesSent()).toHaveLength(1);

      notify(session, "gone"); // the buyer's close through the gate landed; its confirmation is still on its way
      held.release();

      expect((await closing).status).toBe(200);
      expect(await dropped).toBe(4410);
      expect(h.calls.teardown).toEqual(["closed"]);
      expect(h.reads.lastClose).toBe(0);
    });

    it("looks the close up once a close of its own in flight fails: another party closed the account", async () => {
      const { session, dropped } = await openConnected();
      const held = latch();
      h.hold.settleClose = held.promise;
      h.fail.settleClose = true;
      h.closes.set(session, closedAt(session, EARLY));
      const closing = closeWith(session);
      await expect.poll(() => closesSent()).toHaveLength(1);

      notify(session, "gone");
      held.release();

      expect((await closing).status).toBe(502);
      expect(await dropped).toBe(4410);
      expect(h.calls.teardown).toEqual(["closedElsewhere"]);
      expect(h.reads.lastClose).toBe(1);
    });

    it("ends the session once, after one look, when a second notification comes during the look", async () => {
      const { session, dropped } = await openConnected();
      const held = latch();
      h.hold.lastClose = held.promise;
      h.closes.set(session, closedAt(session, EARLY));

      notify(session, "gone");
      notify(session, "gone"); // a later transfer of lamports to the closed address (S12)
      held.release();

      expect(await dropped).toBe(4410);
      await settleDown();
      expect(h.reads.lastClose).toBe(1);
      expect(h.calls.teardown).toEqual(["closedElsewhere"]);
    });

    it.each<[string, Partial<Session>]>([
      ["another session opened at the address", { startedAt: BigInt(NOW_MS / 1000) + 5n, deposited: 90_000n }],
      ["a session with other terms", { rate: 2_000n, deposited: 120_000n }],
    ])("ends the session when the account holds %s: the tracked one was closed", async (_, change) => {
      const { session, dropped } = await openConnected();
      h.closes.set(session, closedAt(session, EARLY));

      notify(session, change);

      expect(await dropped).toBe(4410);
      expect(h.calls.teardown).toEqual(["closedElsewhere"]);
    });

    it("ends with 4402, and retries no more, a session whose end close keeps failing when another party closes it", async () => {
      const { session, dropped } = await openConnected();
      h.fail.settleClose = true; // the end close fails, as an AtExpiry close does before the chain's clock reaches the end
      h.timers.fire(pendingDue(END_DUE));
      await expect.poll(() => h.timers.pending.map((timer) => timer.delayMs)).toEqual([3_000]);
      h.closes.set(session, closedAt(session, AT_END + 1n)); // the sweeper's AtExpiry close, say

      notify(session, "gone");

      expect(await dropped).toBe(4402);
      expect(h.calls.teardown).toEqual(["closedElsewhere"]);
      expect(h.timers.pending).toEqual([]);
    });
  });
});
