import { once } from "node:events";
import { CloseKind, STINT_PROGRAM_ADDRESS, parseCloseInstruction } from "@lxfoundry/stint-program-client";
import { inspectTransaction, readElapsedPayload, type PaymentPayload } from "@lxfoundry/stint-x402";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WebSocket } from "ws";
import { NOW_MS, helpers, startHarness, type FakeTimer, type Harness } from "./harness.js";

/** The harness's `idleCloseSeconds`. */
const IDLE_MS = 10_000;
const IDLE_DUE = NOW_MS + IDLE_MS;
/** What a deposit of 30,000 at 1,000 per second lasts, in the harness's sessions. */
const PAID_MS = 30_000;
const END_DUE = NOW_MS + PAID_MS;

/** The `CloseKind` of the `stint.close` in a close payload, read from the transaction's instruction data. */
function closeKindOf(payload: PaymentPayload): CloseKind {
  const tx = inspectTransaction(readElapsedPayload(payload)!.transaction)!;
  const close = tx.instructions.find((instruction) => instruction.programAddress === STINT_PROGRAM_ADDRESS)!;
  return parseCloseInstruction(close as Parameters<typeof parseCloseInstruction>[0]).data.kind;
}

/** Closes the buyer's socket and waits until the gate's side of it has closed too. */
async function drop(client: WebSocket, server: WebSocket): Promise<void> {
  const closed = once(server, "close");
  client.close();
  await closed;
}

describe("the gate's lifecycle", () => {
  let h: Harness;
  const { open, prepareOpen, send, closeWith, settleDown, token, connect } = helpers(() => h);

  beforeEach(async () => {
    h = await startHarness();
  });

  afterEach(async () => {
    expect(h.escaped).toEqual([]);
    await h.gate.close();
    h.server.closeAllConnections();
    await new Promise((resolve) => h.server.close(resolve));
  });

  /** The close transactions the gate sent to the facilitator. */
  const closes = () => h.calls.settle.filter((payload) => readElapsedPayload(payload)?.type === "close");
  /** The timers waiting for the idle period. */
  const idleTimers = () => h.timers.pending.filter((timer) => timer.delayMs === IDLE_MS);
  /** The one timer still waiting that is due at `dueMs` on the session clock. */
  function pendingDue(dueMs: number): FakeTimer {
    const found = h.timers.pending.filter((timer) => timer.dueMs === dueMs);
    expect(found).toHaveLength(1);
    return found[0]!;
  }
  /** Makes the fake facilitator's close wait until the returned function is called. */
  function holdClose(): () => void {
    let release!: () => void;
    h.hold.settleClose = new Promise<void>((resolve) => (release = resolve));
    return release;
  }

  /** An open session with one connection: `frames` collects what the buyer's socket receives, `closed` resolves with its close code. */
  async function openConnected() {
    const { session, payload } = await prepareOpen();
    await send(payload);
    const { socket } = await connect(session, await token(session, "connect"));
    const frames: string[] = [];
    socket!.on("message", (data) => frames.push(String(data)));
    const closed = new Promise<number>((resolve) => socket!.once("close", (code) => resolve(code)));
    return { session, payload, socket: socket!, server: h.attached.at(-1)!, frames, closed };
  }

  describe("the idle timer", () => {
    it("is armed for idleCloseSeconds when an open settles, and a repeated open arms nothing", async () => {
      const { payload } = await prepareOpen();
      expect(h.timers.all).toHaveLength(0);

      expect((await send(payload)).status).toBe(201);
      expect(h.timers.pending.map((timer) => timer.delayMs)).toContain(IDLE_MS);
      const armed = h.timers.all.length;

      expect((await send(payload)).status).toBe(201);
      expect(h.timers.all).toHaveLength(armed);
    });

    it("is cleared when a connection is accepted, and armed again when the last connection drops", async () => {
      const { session } = await open();
      const idle = pendingDue(IDLE_DUE);
      const first = await connect(session, await token(session, "connect"));
      const second = await connect(session, await token(session, "connect"));
      expect(idle.cleared).toBe(true);
      expect(idleTimers()).toEqual([]);

      h.clock.now = NOW_MS + 4_000;
      await drop(first.socket!, h.attached[0]!);
      expect(idleTimers()).toEqual([]); // one connection is left
      await drop(second.socket!, h.attached[1]!);

      expect(idleTimers().map((timer) => timer.dueMs)).toEqual([NOW_MS + 4_000 + IDLE_MS]);
    });

    it("closes an idle session with a Standard close and ends it with the reason idle", async () => {
      const { session } = await open();

      h.timers.fire(pendingDue(IDLE_DUE));

      await expect.poll(() => h.calls.teardown).toEqual(["idle"]);
      const [close, ...others] = closes();
      expect(others).toEqual([]);
      expect(closeKindOf(close!)).toBe(CloseKind.Standard);
      expect(close!.accepted.extra).toMatchObject({ action: "close", session });
      expect([...inspectTransaction(readElapsedPayload(close!)!.transaction)!.signed]).toEqual([h.authorizer.address]);
      expect(h.timers.pending).toEqual([]);
      expect((await connect(session, await token(session, "connect"))).status).toBe(404);
    });

    it("leaves the session as it is when the idle close fails", async () => {
      const { session } = await open();
      h.fail.settleClose = true;

      h.timers.fire(pendingDue(IDLE_DUE));

      await expect.poll(() => h.logs.some((entry) => entry.event === "error")).toBe(true);
      expect(h.calls.teardown).toEqual([]);
      expect(idleTimers()).toEqual([]);
      h.fail.settleClose = false;
      expect((await closeWith(session)).status).toBe(200); // the session is still tracked, and the failed close left nothing stuck
      expect(h.calls.teardown).toEqual(["closed"]);
    });

    it("shares one close with the buyer's request", async () => {
      const { session } = await open();
      const release = holdClose();

      h.timers.fire(pendingDue(IDLE_DUE));
      await expect.poll(() => closes()).toHaveLength(1);
      const buyer = closeWith(session);
      await settleDown();
      release();

      expect((await buyer).status).toBe(200);
      expect(closes()).toHaveLength(1);
      expect(h.calls.teardown).toEqual(["idle"]);
    });

    it("is cleared when the gate stops, and no connection that drops afterwards arms it again", async () => {
      await open(); // never connected: its idle timer is waiting
      expect(idleTimers()).toHaveLength(1);
      const { session } = await open();
      await connect(session, await token(session, "connect")); // connected: its idle timer is cleared

      await h.gate.close();

      expect(h.timers.pending).toEqual([]);
    });
  });

  describe("the end timer", () => {
    it.each([
      { offset: 0, delays: [10_000, 30_000] },
      { offset: 5_000, delays: [10_000, 25_000] },
      { offset: 40_000, delays: [0, 10_000] },
    ])("is set for the time left on the session clock when the open settles $offset ms into the session", async ({ offset, delays }) => {
      h.clock.now = NOW_MS + offset;

      await open();

      expect(h.timers.pending.map((timer) => timer.delayMs).sort((a, b) => a - b)).toEqual(delays);
    });

    it("stops forwarding when it fires: a frame the adapter sends afterwards does not reach the buyer", async () => {
      const { server, frames, closed } = await openConnected();
      server.send("tick:before");
      await expect.poll(() => frames).toContain("tick:before");
      const release = holdClose();

      h.timers.fire(pendingDue(END_DUE));
      await expect.poll(() => closes()).toHaveLength(1); // the close is waiting at the facilitator: forwarding has stopped
      server.send("tick:after");
      release();

      expect(await closed).toBe(4402);
      expect(frames.filter((frame) => frame.startsWith("tick:"))).toEqual(["tick:before"]);
    });

    it("settles an AtExpiry close, then drops the connection with 4402 and tears down once with the reason expired", async () => {
      const { session, closed } = await openConnected();

      h.timers.fire(pendingDue(END_DUE));

      expect(await closed).toBe(4402);
      expect(h.calls.teardown).toEqual(["expired"]);
      const [close, ...others] = closes();
      expect(others).toEqual([]);
      expect(closeKindOf(close!)).toBe(CloseKind.AtExpiry);
      expect(close!.accepted.extra).toMatchObject({ action: "close", session });
      expect([...inspectTransaction(readElapsedPayload(close!)!.transaction)!.signed]).toEqual([h.authorizer.address]);
      expect(h.timers.pending).toEqual([]);
    });

    it("refuses a connection once it has fired: 402 while the close is in flight, 404 when the session is gone", async () => {
      const { session, closed } = await openConnected();
      const release = holdClose();

      h.timers.fire(pendingDue(END_DUE));
      await expect.poll(() => closes()).toHaveLength(1);
      expect((await connect(session, await token(session, "connect"))).status).toBe(402);
      release();

      expect(await closed).toBe(4402);
      expect((await connect(session, await token(session, "connect"))).status).toBe(404);
    });

    it("shares one close with a buyer's request that arrives while it is in flight", async () => {
      const { session, closed } = await openConnected();
      const release = holdClose();

      h.timers.fire(pendingDue(END_DUE));
      await expect.poll(() => closes()).toHaveLength(1);
      const buyer = closeWith(session);
      await settleDown();
      release();

      expect((await buyer).status).toBe(200);
      expect(await closed).toBe(4402);
      expect(closes()).toHaveLength(1);
      expect(h.calls.teardown).toEqual(["expired"]);
    });

    it("joins a close already in flight instead of re-reading the session first", async () => {
      const { session, closed } = await openConnected();
      const release = holdClose();
      const buyer = closeWith(session);
      await expect.poll(() => closes()).toHaveLength(1);
      const reads = h.reads.session;

      h.timers.fire(pendingDue(END_DUE));
      await settleDown();
      expect(h.reads.session).toBe(reads);
      release();

      expect((await buyer).status).toBe(200);
      expect(await closed).toBe(4410); // the buyer's close came first, so it decides how the session ends
      expect(closes()).toHaveLength(1);
      expect(h.calls.teardown).toEqual(["closed"]);
    });

    it("ends the session as closed, with 4410, when a buyer's close starts during its re-read and lands before the read returns", async () => {
      const { session, closed } = await openConnected();
      let release!: () => void;
      h.hold.readSession = new Promise<void>((resolve) => (release = resolve));
      const reads = h.reads.session;

      h.timers.fire(pendingDue(END_DUE));
      await expect.poll(() => h.reads.session).toBe(reads + 1); // the re-read is waiting
      // The close lands on the chain, and the re-read returns while the gate still reads the close's event.
      h.missing.closedEvent = 1;
      h.onSettleClose = () => {
        h.sessions.delete(session);
        release();
      };
      const buyer = await closeWith(session);

      expect(buyer.status).toBe(200);
      expect(await closed).toBe(4410);
      expect(h.calls.teardown).toEqual(["closed"]);
      expect(closes()).toHaveLength(1);
    });

    it("does not arm the idle timer when the last connection drops while forwarding is stopped", async () => {
      const { socket } = await openConnected();
      const release = holdClose();

      h.timers.fire(pendingDue(END_DUE));
      await expect.poll(() => closes()).toHaveLength(1);
      await drop(socket, h.attached[0]!);
      expect(idleTimers()).toEqual([]);
      release();

      await expect.poll(() => h.calls.teardown).toEqual(["expired"]);
    });

    it("clears an idle timer that was waiting, so that the end close decides how the session ends", async () => {
      const { socket } = await openConnected();
      h.clock.now = NOW_MS + 25_000;
      await drop(socket, h.attached[0]!);
      const idle = pendingDue(NOW_MS + 25_000 + IDLE_MS); // it would fire at 35 s, after the paid time ran out and while the end close is retried
      h.fail.settleClose = true;

      h.timers.fire(pendingDue(END_DUE));

      await expect.poll(() => h.timers.pending.some((timer) => timer.delayMs === 3_000)).toBe(true); // the end close failed, and is tried again
      expect(closes()).toHaveLength(1);
      expect(idle.cleared).toBe(true);
      expect(idleTimers()).toEqual([]);
      h.fail.settleClose = false;
      h.timers.fire(h.timers.pending[0]!);

      await expect.poll(() => h.calls.teardown).toEqual(["expired"]);
      expect(closes().map(closeKindOf)).toEqual([CloseKind.AtExpiry, CloseKind.AtExpiry]);
    });

    it("ends the session with 4402, with no close, when the account is already gone, after a single read", async () => {
      const { session, closed } = await openConnected();
      h.sessions.delete(session);
      const reads = h.reads.session;

      h.timers.fire(pendingDue(END_DUE));

      expect(await closed).toBe(4402);
      expect(h.reads.session - reads).toBe(1); // the harness's readRetry allows 3 reads: a gone account is not read again
      expect(h.calls.teardown).toEqual(["expired"]);
      expect(closes()).toEqual([]);
    });

    it("ends the session with 4402 when the close fails and a re-read shows the account gone", async () => {
      const { session, closed } = await openConnected();
      h.fail.settleClose = true;
      h.onSettleClose = () => void h.sessions.delete(session);

      h.timers.fire(pendingDue(END_DUE));

      expect(await closed).toBe(4402);
      expect(h.calls.teardown).toEqual(["expired"]);
      expect(closes()).toHaveLength(1);
      expect(h.timers.pending).toEqual([]);
    });

    it("resumes forwarding, answers with the new end and sets the timer again when a re-read shows a later paid_until", async () => {
      const { session, payload, server, frames } = await openConnected();
      h.sessions.set(session, { ...h.sessions.get(session)!, deposited: 60_000n }); // paid for 60 s in all

      h.timers.fire(pendingDue(END_DUE));

      await expect.poll(() => h.timers.pending.map((timer) => timer.dueMs)).toEqual([NOW_MS + 60_000]);
      expect(closes()).toEqual([]);
      server.send("tick:resumed");
      await expect.poll(() => frames).toContain("tick:resumed");
      expect((await send(payload)).body.paidUntil).toBe(NOW_MS / 1000 + 60);
      expect((await connect(session, await token(session, "connect"))).socket).toBeDefined(); // 30 s from the new end: no longer refused
    });

    it("resumes forwarding and sets the timer again when the close fails and a re-read shows a later paid_until", async () => {
      const { session, server, frames } = await openConnected();
      h.fail.settleClose = true;
      h.onSettleClose = () => void h.sessions.set(session, { ...h.sessions.get(session)!, deposited: 60_000n });

      h.timers.fire(pendingDue(END_DUE));

      await expect.poll(() => h.timers.pending.map((timer) => timer.dueMs)).toEqual([NOW_MS + 60_000]);
      expect(closes()).toHaveLength(1);
      server.send("tick:resumed");
      await expect.poll(() => frames).toContain("tick:resumed");
      expect(h.calls.teardown).toEqual([]);
    });

    it.each([
      { what: "a later start", startedAfter: 20n, rate: 1_000n, deposited: 60_000n },
      { what: "other terms", startedAfter: 0n, rate: 2_000n, deposited: 120_000n },
    ])("ends the session with 4402, and does not resume, when the re-read finds another session at the address: $what", async ({ startedAfter, rate, deposited }) => {
      const { session, closed } = await openConnected();
      const stored = h.sessions.get(session)!;
      // Closed, then opened again at the same address, and paid until later than the session the gate tracks.
      h.sessions.set(session, { ...stored, startedAt: stored.startedAt + startedAfter, rate, deposited });

      h.timers.fire(pendingDue(END_DUE));

      await expect.poll(() => h.calls.teardown).toEqual(["expired"]);
      expect(await closed).toBe(4402);
      expect(closes()).toEqual([]);
      expect(h.timers.pending).toEqual([]);
    });

    it("tries the close again after endRetrySeconds when it fails and nothing changed, and stays muted meanwhile", async () => {
      const { server, frames, closed } = await openConnected();
      h.fail.settleClose = true;

      h.timers.fire(pendingDue(END_DUE));

      await expect.poll(() => h.timers.pending.map((timer) => timer.delayMs)).toEqual([3_000]);
      expect(closes()).toHaveLength(1);
      expect(h.calls.teardown).toEqual([]);
      server.send("tick:waiting");
      h.fail.settleClose = false;
      h.timers.fire(h.timers.pending[0]!);

      expect(await closed).toBe(4402);
      expect(closes().map(closeKindOf)).toEqual([CloseKind.AtExpiry, CloseKind.AtExpiry]);
      expect(h.calls.teardown).toEqual(["expired"]);
      expect(frames.filter((frame) => frame.startsWith("tick:"))).toEqual([]);
    });

    it("sets itself again, without stopping forwarding, when it fires before paid_until on the session clock", async () => {
      const { server, frames } = await openConnected();
      const early = pendingDue(END_DUE);

      h.timers.fire(early, { advance: false });

      expect(closes()).toEqual([]);
      server.send("tick:early");
      await expect.poll(() => frames).toContain("tick:early");
      const again = pendingDue(END_DUE);
      expect(again).not.toBe(early);
      expect(again.delayMs).toBe(PAID_MS);
    });

    it("caps a long wait at the longest delay setTimeout takes, and waits out the rest", async () => {
      const longest = 2_147_483_647;
      const { session, payload } = await prepareOpen();
      h.sessions.set(session, { ...h.sessions.get(session)!, deposited: 3_000_000_000_000n }); // paid for about 95 years
      await send(payload);
      const end = h.timers.pending.find((timer) => timer.delayMs === longest)!;
      expect(end).toBeDefined();

      h.timers.fire(end);

      expect(closes()).toEqual([]);
      expect(h.timers.pending.some((timer) => timer.delayMs === longest)).toBe(true);
    });

    it("is kept when an idle close fails", async () => {
      await open();
      h.fail.settleClose = true;

      h.timers.fire(pendingDue(IDLE_DUE));

      await expect.poll(() => h.logs.some((entry) => entry.event === "error")).toBe(true);
      expect(h.timers.pending.map((timer) => timer.dueMs)).toEqual([END_DUE]);
    });

    it("is cleared with the idle timer when the buyer closes the session", async () => {
      const { session } = await open();
      expect(h.timers.pending).toHaveLength(2);

      expect((await closeWith(session)).status).toBe(200);

      expect(h.timers.pending).toEqual([]);
    });

    it("is cleared with the idle timer when the gate stops", async () => {
      await open();
      expect(h.timers.pending).toHaveLength(2);

      await h.gate.close();

      expect(h.timers.pending).toEqual([]);
    });
  });

  describe("a teardown that throws", () => {
    it("is logged, and the buyer's confirmed close is still answered 200 with its amounts", async () => {
      const { session } = await open();
      const { socket } = await connect(session, await token(session, "connect"));
      const closed = new Promise<number>((resolve) => socket!.once("close", (code) => resolve(code)));
      h.fail.teardown = true;

      const response = await closeWith(session);

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ paid: "8000", refunded: "22000", transaction: "sig" });
      expect(await closed).toBe(4410);
      expect(h.calls.teardown).toEqual(["closed"]);
      expect(h.logs).toContainEqual({ event: "error", error: "teardown broke" });
    });
  });
});

describe("a gate with no timings configured", () => {
  let d: Harness;
  const { open } = helpers(() => d);

  beforeEach(async () => {
    d = await startHarness({ idleCloseSeconds: undefined, endRetrySeconds: undefined });
  });

  afterEach(async () => {
    await d.gate.close();
    d.server.closeAllConnections();
    await new Promise((resolve) => d.server.close(resolve));
  });

  it("gives a session 60 seconds to connect", async () => {
    await open();
    expect(d.timers.pending.map((timer) => timer.delayMs)).toContain(60_000);
  });

  it("tries a failed close at the end of the paid time again after 2 seconds", async () => {
    await open();
    d.fail.settleClose = true;

    d.timers.fire(d.timers.pending.find((timer) => timer.delayMs === 30_000)!);

    // The 60 s idle timer is not among them: the end timer's firing cleared it.
    await expect.poll(() => d.timers.pending.map((timer) => timer.delayMs)).toEqual([2_000]);
  });
});
