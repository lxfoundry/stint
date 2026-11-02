import type { Address } from "@solana/kit";
import type { Session } from "@lxfoundry/stint-program-client";
import { readElapsedPayload } from "@lxfoundry/stint-x402";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NOW_MS, helpers, startHarness, type FakeTimer, type Harness } from "./harness.js";

/** What a deposit of 30,000 at 1,000 per second lasts, in the harness's sessions. */
const END_DUE = NOW_MS + 30_000;
/** The end once 10 s more have been paid for. */
const EXTENDED_DUE = NOW_MS + 40_000;

describe("the gate's subscription to the session account (spec §7.3)", () => {
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
  /** An open session with one connection: `frames` collects what the buyer's socket receives. */
  async function openConnected() {
    const { session } = await open();
    const { socket } = await connect(session, await token(session, "connect"));
    const frames: string[] = [];
    socket!.on("message", (data) => frames.push(String(data)));
    return { session, server: h.attached.at(-1)!, frames };
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

  it.each<[string, Partial<Session> | "gone"]>([
    ["the same end", { claimed: 8_000n }],
    ["an account that is gone", "gone"],
    ["another session opened at the address", { startedAt: BigInt(NOW_MS / 1000) + 5n, deposited: 90_000n }],
    ["a session with other terms", { rate: 2_000n, deposited: 120_000n }],
  ])("leaves the session as it is on a notification of %s", async (_, change) => {
    const { session } = await open();

    notify(session, change);

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
});
