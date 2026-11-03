import type { Address } from "@solana/kit";
import { decodePaymentResponseHeader, readElapsedPayload, type PaymentRequired } from "@lxfoundry/stint-x402";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NOW_MS, helpers, startHarness, type FakeTimer, type Harness } from "./harness.js";

/** What a deposit of 30,000 at 1,000 per second lasts, in the harness's sessions. */
const END_DUE = NOW_MS + 30_000;
/** The end after a top-up of 10 s. */
const EXTENDED_DUE = NOW_MS + 40_000;

describe("the gate's top-up route (spec §7.1)", () => {
  let h: Harness;
  const { open, prepareOpen, settleDown, token, connect, topUpOffers, prepareTopUp, sendTopUp } = helpers(() => h);

  beforeEach(async () => {
    h = await startHarness();
  });

  afterEach(async () => {
    expect(h.escaped).toEqual([]);
    await h.gate.close();
    h.server.closeAllConnections();
    await new Promise((resolve) => h.server.close(resolve));
  });

  const ofType = (type: string) => h.calls.settle.filter((payload) => readElapsedPayload(payload)?.type === type);
  const accepts = (body: Record<string, unknown>) => (body as unknown as PaymentRequired).accepts;
  /** The one timer still waiting that is due at `dueMs` on the session clock. */
  function pendingDue(dueMs: number): FakeTimer {
    const found = h.timers.pending.filter((timer) => timer.dueMs === dueMs);
    expect(found).toHaveLength(1);
    return found[0]!;
  }
  /** Makes the fake facilitator's settlement of a top-up or of a close wait until the returned function is called. */
  function hold(slot: "settleTopUp" | "settleClose"): () => void {
    let release!: () => void;
    h.hold[slot] = new Promise<void>((resolve) => (release = resolve));
    return release;
  }
  /** An open session with one connection: `frames` collects what the buyer's socket receives. */
  async function openConnected() {
    const { session } = await open();
    const { socket } = await connect(session, await token(session, "connect"));
    const frames: string[] = [];
    socket!.on("message", (data) => frames.push(String(data)));
    return { session, server: h.attached.at(-1)!, frames };
  }

  it("answers 402 with one top-up entry per menu duration that fits, naming the session, in the body and the header", async () => {
    const { session } = await open();

    const { status, body, header } = await topUpOffers(session);

    expect(status).toBe(402);
    expect(header).not.toBeNull();
    // The menu is 30 s and 60 s, and the session is paid for 30 s of 120: both fit.
    expect(accepts(body).map((entry) => [entry.amount, entry.extra?.action, entry.extra?.session, entry.extra?.seconds])).toEqual([
      ["30000", "topUp", session, 30],
      ["60000", "topUp", session, 60],
    ]);
    expect((body.resource as { url: string }).url).toBe(`${h.url}/sessions/${session}/top-up`);
    expect(ofType("topUp")).toEqual([]);
  });

  it("lists only the menu durations that still fit, reading the deposit from the chain", async () => {
    const { session } = await open();
    h.sessions.set(session, { ...h.sessions.get(session)!, deposited: 80_000n }); // topped up elsewhere: 40 s of 120 left

    expect(accepts((await topUpOffers(session)).body).map((entry) => entry.extra?.seconds)).toEqual([30]);
  });

  it("answers 400 invalid_duration, with the bounds, for a duration that does not fit, and when no duration fits", async () => {
    const { session } = await open();

    for (const seconds of [0, 91, 2.5]) {
      expect(await topUpOffers(session, seconds)).toMatchObject({ status: 400, body: { error: "invalid_duration", minSeconds: 1, maxSeconds: 90 } });
    }
    // 1 s is below minSeconds (5), which a top-up does not have to meet.
    expect((await topUpOffers(session, 1)).status).toBe(402);
    h.sessions.set(session, { ...h.sessions.get(session)!, deposited: 120_000n });
    expect(await topUpOffers(session)).toMatchObject({ status: 400, body: { error: "invalid_duration", minSeconds: 1, maxSeconds: 0 } });
    expect(ofType("topUp")).toEqual([]);
  });

  it("with a payment, answers 400 invalid_duration, before verifying it, only for a duration outside 1 to maxSeconds", async () => {
    const { session } = await open();
    const payload = await prepareTopUp(session, 10);
    const verifications = h.calls.verify.length;

    // The bounds that hold whatever the deposit, not the 90 s that this session's deposit leaves.
    for (const seconds of [0, 121, 2.5]) {
      expect(await sendTopUp(session, payload, seconds)).toMatchObject({ status: 400, body: { error: "invalid_duration", minSeconds: 1, maxSeconds: 120 } });
    }
    expect(h.calls.verify).toHaveLength(verifications);
    expect(ofType("topUp")).toEqual([]);
  });

  it("answers 404 for a session it does not track, for one whose account is gone, and for an id that is not an address", async () => {
    const { session: untracked } = await prepareOpen(); // on the fake chain, but never opened through this gate
    expect(await topUpOffers(untracked)).toMatchObject({ status: 404, body: { error: "unknown_session" } });

    const { session } = await open();
    h.sessions.delete(session);
    expect(await topUpOffers(session)).toMatchObject({ status: 404, body: { error: "unknown_session" } });

    expect(await topUpOffers("1".repeat(44) as Address)).toMatchObject({ status: 404, body: { error: "unknown_session" } });
  });

  it("answers 503, not 402, when the top-up's verification or settlement answers already_processed, and moves no timer", async () => {
    const { session } = await open();

    h.verifyAnswer = { isValid: false, invalidReason: "already_processed" };
    expect(await sendTopUp(session, await prepareTopUp(session))).toMatchObject({ status: 503, body: { error: "already_processed" } });
    expect(ofType("topUp")).toEqual([]);

    h.verifyAnswer = { isValid: true };
    h.settleAnswer = () => ({ success: false, errorReason: "already_processed", transaction: "", network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" });
    const unsettled = await sendTopUp(session, await prepareTopUp(session));
    expect(unsettled.status).toBe(503);
    expect(unsettled.body).toEqual({ error: "already_processed" });
    expect(unsettled.paymentResponse).not.toBeNull();
    // The end timer is still the one the open armed.
    expect(pendingDue(END_DUE)).toBeDefined();
  });

  it("takes the payment: verifies and settles it, answers 200 with the new paid_until, and moves the end timer there", async () => {
    const { session } = await open();
    const payload = await prepareTopUp(session, 10);

    const { status, body, paymentResponse } = await sendTopUp(session, payload, 10);

    expect(status).toBe(200);
    expect(body).toEqual({ paidUntil: EXTENDED_DUE / 1000 });
    expect(decodePaymentResponseHeader(paymentResponse!)).toMatchObject({ success: true });
    expect(h.calls.verify.at(-1)).toEqual(payload);
    expect(ofType("topUp")).toEqual([payload]);
    expect(pendingDue(EXTENDED_DUE)).toBeDefined();
    expect(h.timers.pending.filter((timer) => timer.dueMs === END_DUE)).toEqual([]);
  });

  it("keeps forwarding past the old end of the paid time", async () => {
    const { session, server, frames } = await openConnected();
    await sendTopUp(session, await prepareTopUp(session, 10), 10);

    h.clock.now = END_DUE + 1_000;
    server.send("tick:extended");

    await expect.poll(() => frames).toContain("tick:extended");
    expect(h.timers.pending.map((timer) => timer.dueMs)).toEqual([EXTENDED_DUE]);
    expect(h.calls.teardown).toEqual([]);
  });

  it("hands a connection attached after the top-up the new paid_until", async () => {
    const { session } = await open();
    await sendTopUp(session, await prepareTopUp(session, 10), 10);

    await connect(session, await token(session, "connect"));

    expect(h.calls.attach.at(-1)?.paidUntil).toBe(BigInt(EXTENDED_DUE / 1000));
  });

  it("refuses a top-up once the end timer has fired: 402 session_expired, with offers for a new session", async () => {
    const { session } = await openConnected();
    h.fail.settleClose = true; // the end close fails, as an AtExpiry close does while the chain's clock lags
    h.timers.fire(pendingDue(END_DUE));
    await expect.poll(() => h.timers.pending.map((timer) => timer.delayMs)).toEqual([3_000]);

    const { status, body } = await topUpOffers(session, 10);

    expect(status).toBe(402);
    expect(body.error).toBe("session_expired");
    expect(accepts(body).map((entry) => entry.extra?.action)).toEqual(["open", "open"]);
    expect(ofType("topUp")).toEqual([]);
  });

  it("answers 402 with the facilitator's reason when it refuses the top-up, settles nothing, and leaves the end timer", async () => {
    const { session } = await open();
    const payload = await prepareTopUp(session, 10);
    h.verifyAnswer = { isValid: false, invalidReason: "invalid_amount" };

    const { status, body } = await sendTopUp(session, payload, 10);

    expect(status).toBe(402);
    expect(body.error).toBe("invalid_amount");
    expect(accepts(body).map((entry) => [entry.extra?.action, entry.extra?.seconds])).toEqual([["topUp", 10]]);
    expect(ofType("topUp")).toEqual([]);
    expect(pendingDue(END_DUE)).toBeDefined();
  });

  it("leaves the fit of a new payment to the facilitator, and answers its invalid_amount with the offers that fit the deposit", async () => {
    const { session } = await open();
    const payload = await prepareTopUp(session, 60);
    h.sessions.set(session, { ...h.sessions.get(session)!, deposited: 80_000n }); // topped up elsewhere: 40 s of 120 left
    h.verifyAnswer = { isValid: false, invalidReason: "invalid_amount" };

    // From the menu: only 30 s still fits.
    const fromMenu = await sendTopUp(session, payload, null);
    expect(fromMenu).toMatchObject({ status: 402, body: { error: "invalid_amount" } });
    expect(accepts(fromMenu.body).map((entry) => [entry.extra?.action, entry.extra?.seconds])).toEqual([["topUp", 30]]);
    // Asked for by its duration: no offer for 60 s fits.
    expect(await sendTopUp(session, payload, 60)).toMatchObject({ status: 402, body: { error: "invalid_amount", accepts: [] } });

    expect(h.calls.verify.slice(-2)).toEqual([payload, payload]);
    expect(ofType("topUp")).toEqual([]);
    expect(pendingDue(END_DUE)).toBeDefined();
  });

  it("answers the facilitator's session_expired with offers for a new session", async () => {
    const { session } = await open();
    const payload = await prepareTopUp(session, 10);
    h.verifyAnswer = { isValid: false, invalidReason: "session_expired" };

    const { status, body } = await sendTopUp(session, payload, 10);

    expect(status).toBe(402);
    expect(body.error).toBe("session_expired");
    expect(accepts(body).map((entry) => entry.extra?.action)).toEqual(["open", "open"]);
  });

  it("answers 402 with the reason when the settlement fails, and leaves the session as it was", async () => {
    const { session } = await open();
    const payload = await prepareTopUp(session, 10);
    h.settleAnswer = () => ({ success: false, errorReason: "simulation_failed", transaction: "", network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" });

    const { status, body } = await sendTopUp(session, payload, 10);

    expect(status).toBe(402);
    expect(body.error).toBe("simulation_failed");
    expect(h.sessions.get(session)?.deposited).toBe(30_000n);
    expect(pendingDue(END_DUE)).toBeDefined();
  });

  it("answers 202 with the transaction while the settlement is pending, and leaves the end timer", async () => {
    const { session } = await open();
    const payload = await prepareTopUp(session, 10);
    h.settleAnswer = () => ({ success: false, errorReason: "settlement_pending", transaction: "pending-sig", network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" });

    const { status, body, paymentResponse } = await sendTopUp(session, payload, 10);

    expect(status).toBe(202);
    expect(body).toEqual({ transaction: "pending-sig" });
    expect(decodePaymentResponseHeader(paymentResponse!)).toMatchObject({ success: false, errorReason: "settlement_pending" });
    expect(pendingDue(END_DUE)).toBeDefined();
  });

  it("refuses a payment that does not accept a top-up of this session for the duration asked, before verifying it", async () => {
    const { session } = await open();
    const other = await open();
    const verifications = h.calls.verify.length;
    const { payload: anOpen } = await prepareOpen();

    for (const payload of [anOpen, await prepareTopUp(session, 30), await prepareTopUp(other.session, 10)]) {
      expect(await sendTopUp(session, payload, 10)).toMatchObject({ status: 402, body: { error: "invalid_payment_requirements" } });
    }
    expect(h.calls.verify).toHaveLength(verifications);
    expect(ofType("topUp")).toEqual([]);
  });

  it("resumes forwarding, and keeps the new end timer, when its end timer fires while the top-up settles", async () => {
    const { session, server, frames } = await openConnected();
    const releaseTopUp = hold("settleTopUp");
    const releaseClose = hold("settleClose");
    const paying = sendTopUp(session, await prepareTopUp(session, 10), 10);
    await expect.poll(() => ofType("topUp")).toHaveLength(1); // the top-up's settlement is in flight
    h.fail.settleClose = true; // the end close will fail: by then the top-up has moved paid_until
    h.timers.fire(pendingDue(END_DUE)); // forwarding stops; the end close waits in the facilitator
    await expect.poll(() => ofType("close")).toHaveLength(1);

    releaseTopUp();
    expect((await paying).status).toBe(200);
    server.send("tick:resumed");
    await expect.poll(() => frames).toContain("tick:resumed");
    releaseClose(); // the end close fails now, after the top-up resumed the session
    await settleDown();

    expect(h.timers.pending.map((timer) => timer.dueMs)).toEqual([EXTENDED_DUE]);
    expect(h.calls.teardown).toEqual([]);
  });

  it("leaves an idle close that failed alone: a top-up moves the end timer and arms no idle timer", async () => {
    const { session } = await open();
    h.fail.settleClose = true;
    h.timers.fire(pendingDue(NOW_MS + 10_000)); // the idle timer: its close fails, and the session runs on to its end
    await expect.poll(() => ofType("close")).toHaveLength(1);
    await settleDown();
    h.fail.settleClose = false;

    expect((await sendTopUp(session, await prepareTopUp(session, 10), 10)).status).toBe(200);

    expect(h.timers.pending.map((timer) => timer.dueMs)).toEqual([EXTENDED_DUE]);
  });

  it("answers the same top-up sent again after it landed with the end the chain holds: no second credit, and the end timer moves no further", async () => {
    const { session } = await open();
    const payload = await prepareTopUp(session, 10);
    expect((await sendTopUp(session, payload, 10)).body).toEqual({ paidUntil: EXTENDED_DUE / 1000 });

    // Sent again: the facilitator answers success from its record, and the chain credits nothing more.
    const again = await sendTopUp(session, payload, 10);

    expect(again.status).toBe(200);
    expect(again.body).toEqual({ paidUntil: EXTENDED_DUE / 1000 });
    expect(decodePaymentResponseHeader(again.paymentResponse!)).toMatchObject({ success: true });
    expect(ofType("topUp")).toEqual([payload, payload]);
    expect(h.sessions.get(session)?.deposited).toBe(40_000n);
    expect(pendingDue(EXTENDED_DUE)).toBeDefined();
    expect(h.timers.pending.filter((timer) => timer.dueMs > EXTENDED_DUE)).toEqual([]);
  });

  it.each([
    ["90 s, asked for by its duration, which fills maxSeconds", 90, 90],
    ["60 s, from the menu", 60, null],
  ] as const)(
    "answers a top-up of %s, sent again after it landed, from the facilitator's record, though the deposit no longer leaves room for it",
    async (_, seconds, asked) => {
      const { session } = await open(); // paid for 30 s of 120
      const payload = await prepareTopUp(session, seconds);
      const untilMs = END_DUE + seconds * 1000;
      expect((await sendTopUp(session, payload, asked)).body).toEqual({ paidUntil: untilMs / 1000 });

      // Sent again: the deposit read now holds the first, and the facilitator answers success from its record.
      const again = await sendTopUp(session, payload, asked);

      expect(again).toMatchObject({ status: 200, body: { paidUntil: untilMs / 1000 } });
      expect(ofType("topUp")).toEqual([payload, payload]);
      expect(h.sessions.get(session)?.deposited).toBe(30_000n + BigInt(seconds) * 1_000n);
      expect(pendingDue(untilMs)).toBeDefined();
      expect(h.timers.pending.filter((timer) => timer.dueMs > untilMs)).toEqual([]);
    },
  );

  it("takes the new end from the session as the chain holds it once the top-up's transaction shows, a top-up made elsewhere included", async () => {
    const { session } = await open();
    const releaseTopUp = hold("settleTopUp");
    const paying = sendTopUp(session, await prepareTopUp(session, 10), 10);
    await expect.poll(() => ofType("topUp")).toHaveLength(1);
    h.sessions.set(session, { ...h.sessions.get(session)!, deposited: 50_000n }); // 20 s more, topped up on-chain meanwhile

    releaseTopUp();

    expect(await paying).toMatchObject({ status: 200, body: { paidUntil: NOW_MS / 1000 + 60 } });
    expect(h.calls.readAfter).toEqual(["sig"]); // the settlement's transaction
    expect(pendingDue(NOW_MS + 60_000)).toBeDefined();
    expect(h.timers.pending.filter((timer) => timer.dueMs === END_DUE || timer.dueMs === EXTENDED_DUE)).toEqual([]);
  });

  it("reads the session again while the node does not show the top-up's transaction yet", async () => {
    const { session } = await open();
    h.missing.after = 2;

    expect(await sendTopUp(session, await prepareTopUp(session, 10), 10)).toMatchObject({ status: 200, body: { paidUntil: EXTENDED_DUE / 1000 } });

    expect(h.calls.readAfter).toEqual(["sig", "sig", "sig"]);
    expect(pendingDue(EXTENDED_DUE)).toBeDefined();
  });

  it("answers 502, and moves no timer, when the node still does not show the top-up's transaction after the re-reads", async () => {
    const { session } = await open();
    h.missing.after = Number.POSITIVE_INFINITY;

    const { status, body } = await sendTopUp(session, await prepareTopUp(session, 10), 10);

    expect(status).toBe(502);
    expect(body.error).toBe("upstream_error");
    expect(h.calls.readAfter).toHaveLength(3); // the harness's readRetry
    expect(pendingDue(END_DUE)).toBeDefined();
  });

  it.each([
    ["is gone", (session: Address) => void h.sessions.delete(session)],
    ["holds another session", (session: Address) => void h.sessions.set(session, { ...h.sessions.get(session)!, startedAt: BigInt(NOW_MS / 1000) + 5n })],
  ])("answers 404, moves no timer and ends nothing itself, when the account %s once the top-up's transaction shows", async (_, change) => {
    const { session } = await open();
    const releaseTopUp = hold("settleTopUp");
    const paying = sendTopUp(session, await prepareTopUp(session, 10), 10);
    await expect.poll(() => ofType("topUp")).toHaveLength(1);
    change(session); // closed by another party after the top-up landed, and perhaps opened again at the address

    releaseTopUp();

    expect(await paying).toMatchObject({ status: 404, body: { error: "unknown_session" } });
    expect(pendingDue(END_DUE)).toBeDefined();
    expect(h.calls.teardown).toEqual([]);
  });

  it("without a read after the settlement, adds the amount to the deposit read before the payment, and answers the later end it knows", async () => {
    delete h.chain.readSessionAfter;
    const { session } = await openConnected();
    const releaseTopUp = hold("settleTopUp");
    const paying = sendTopUp(session, await prepareTopUp(session, 10), 10);
    await expect.poll(() => ofType("topUp")).toHaveLength(1);
    h.sessions.set(session, { ...h.sessions.get(session)!, deposited: 70_000n }); // 40 s more, topped up on-chain meanwhile
    h.timers.fire(pendingDue(END_DUE)); // the end timer's re-read finds it: the session runs on to +70 s
    await expect.poll(() => h.timers.pending.map((timer) => timer.dueMs)).toEqual([NOW_MS + 70_000]);

    releaseTopUp();

    expect((await paying).body).toEqual({ paidUntil: NOW_MS / 1000 + 70 });
    expect(h.timers.pending.map((timer) => timer.dueMs)).toEqual([NOW_MS + 70_000]);
  });
});
