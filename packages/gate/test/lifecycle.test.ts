import { once } from "node:events";
import { CloseKind, STINT_PROGRAM_ADDRESS, parseCloseInstruction } from "@lxfoundry/stint-program-client";
import { inspectTransaction, readElapsedPayload, type PaymentPayload } from "@lxfoundry/stint-x402";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WebSocket } from "ws";
import { NOW_MS, helpers, startHarness, type FakeTimer, type Harness } from "./harness.js";

/** The harness's `idleCloseSeconds`. */
const IDLE_MS = 10_000;
const IDLE_DUE = NOW_MS + IDLE_MS;

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
});
