import { generateKeyPairSigner, type KeyPairSigner } from "@solana/kit";
import { inspectTransaction } from "@lxfoundry/stint-x402";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StintError, createStintClient, type Policy, type StintSession } from "../src/index.js";
import { NETWORK, startTestGate, type TestGate } from "./gate.js";

const policy: Policy = {
  maxRate: 1_000n,
  maxPerSession: 100_000n,
  budget: { amount: 100_000n, periodSeconds: 3_600 },
  closeWaitSeconds: 5,
};
/** What the test gate's facilitator answers a sponsored close with, by default, as the client reports it. */
const SPONSORED = { paid: 8_000n, refunded: 22_000n, transaction: "sponsored-sig", via: "sponsored" };

describe("the close fallback chain (spec §9.3)", () => {
  let buyer: KeyPairSigner;
  let gate: TestGate;

  beforeEach(async () => {
    buyer = await generateKeyPairSigner();
    gate = await startTestGate(buyer.address);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await gate.stop();
    expect(gate.escaped).toEqual([]);
  });

  /**
   * A 30 s session on the test gate, for a client that reads a pending close's status every 20 ms, gives a read up after
   * 200 ms, and a request that sends a close after 300 ms.
   */
  async function openSession(overrides: Partial<Policy> = {}): Promise<StintSession> {
    const client = createStintClient({
      signer: buyer,
      policy: { ...policy, ...overrides },
      closePollMs: 20,
      requestTimeoutMs: 200,
      closeRequestTimeoutMs: 300,
    });
    return client.open(gate.url, { seconds: 30 });
  }
  /** The gate's close settles as pending: its signature is known, its confirmation is not. */
  const PENDING = { success: false, errorReason: "settlement_pending", transaction: "pending-sig", network: NETWORK } as const;

  /** Answers the gate's close with `status` and `body`; every other request goes through. */
  function gateCloseAnswers(session: StintSession, status: number, body: unknown): void {
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) =>
      String(input) === `${gate.url}/sessions/${session.id}/close`
        ? Promise.resolve(Response.json(body, { status }))
        : realFetch(input, init),
    );
  }

  it("closes through the gate when the gate answers, and asks the facilitator nothing", async () => {
    const session = await openSession();

    expect(await session.close()).toEqual({ paid: 8_000n, refunded: 22_000n, transaction: "sig", via: "gate" });
    expect(gate.sponsored).toEqual([]);
  });

  it("closes through closeUrl when the gate cannot be reached: a close it built itself, signed only as the authority, the facilitator's fee payer left to sign", async () => {
    const session = await openSession();
    gate.gateDown = true;

    expect(await session.close()).toEqual(SPONSORED);

    expect(gate.sponsored).toHaveLength(1);
    const close = inspectTransaction(gate.sponsored[0]!)!;
    expect(close.feePayer).toBe(gate.feePayer);
    expect([...close.signed]).toEqual([buyer.address]);
    expect(close.accounts).toContain(session.id);
  });

  it("closes through closeUrl when the gate answers 404: it does not track the session, as after a restart", async () => {
    const session = await openSession();
    gateCloseAnswers(session, 404, { error: "unknown_session" });

    expect(await session.close()).toEqual(SPONSORED);
  });

  it("closes through closeUrl when the gate's close fails with a 5xx", async () => {
    const session = await openSession();
    gate.closeSettlement = { success: false, errorReason: "simulation_failed", transaction: "", network: NETWORK };

    expect(await session.close()).toEqual(SPONSORED);
  });

  it("waits for a close the gate reports pending, and returns it once the gate reports the session gone", async () => {
    const session = await openSession({ closeWaitSeconds: 60 });
    gate.closeSettlement = PENDING;
    const closing = gate; // not `gate`, which names the next test's gate by the time a late timer fires
    setTimeout(() => (closing.sessionOpen = false), 100);
    const started = Date.now();

    expect(await session.close()).toEqual({ transaction: "pending-sig", via: "gate" });
    expect(Date.now() - started).toBeLessThan(2_000); // at the gate's 404, not at the end of the wait
    expect(gate.sponsored).toEqual([]);
  });

  it("moves on to closeUrl once the gate's pending close outlasts closeWaitSeconds", async () => {
    const session = await openSession({ closeWaitSeconds: 0.2 });
    gate.closeSettlement = PENDING;

    expect(await session.close()).toEqual(SPONSORED);
  });

  it("returns a close the gate reported pending when closeUrl then finds the session closed: that close may be the one that landed", async () => {
    const session = await openSession({ closeWaitSeconds: 0.2 });
    gate.closeSettlement = PENDING;
    gate.facilitatorSessionOpen = false; // the gate's node still shows the session; the facilitator's no longer does

    expect(await session.close()).toEqual({ transaction: "pending-sig", via: "gate" });
    expect(gate.sponsored).toEqual([]);
  });

  it("names a close that may still land when no step closes the session", async () => {
    const session = await openSession({ closeWaitSeconds: 0.2 });
    gate.closeSettlement = PENDING;
    gate.facilitatorDown = true;

    await expect(session.close()).rejects.toThrow(/may still land: pending-sig \(gate\)[\s\S]*runs to the end of its paid time/);
  });

  it("reports a session that closeUrl finds closed, sends no close, and counts it as closed", async () => {
    const session = await openSession();
    gate.gateDown = true;
    gate.sessionOpen = false;

    await expect(session.close()).rejects.toMatchObject({ status: 404, message: "The session is already closed" });

    expect(gate.sponsored).toEqual([]);
    await session[Symbol.asyncDispose](); // counted as closed: disposing it does not close it again
  });

  it("says the session runs to the end of its paid time when neither the gate nor the facilitator can close it, and closes it once one can", async () => {
    const session = await openSession();
    gate.gateDown = true;
    gate.facilitatorDown = true;

    const error = await session.close().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(StintError);
    expect((error as Error).message).toMatch(/the gate cannot be reached/);
    expect((error as Error).message).toMatch(/sponsored close failed/);
    expect((error as Error).message).toMatch(/runs to the end of its paid time/);
    gate.gateDown = false;
    expect(await session.close()).toMatchObject({ via: "gate" });
  });

  it("moves past a sponsored close that the facilitator refuses, and names the refusal", async () => {
    const session = await openSession();
    gate.gateDown = true;
    gate.sponsoredAnswer = { success: false, errorReason: "simulation_failed", errorMessage: "custom program error: 0x1774", transaction: "" };

    await expect(session.close()).rejects.toThrow(/simulation_failed[\s\S]*runs to the end of its paid time/);
    expect(gate.sponsored).toHaveLength(1);
  });

  it.each<[number, unknown]>([
    [401, { error: "unauthorized" }],
    [409, { error: "refund_account_closed" }],
  ])("moves on to closeUrl when the gate refuses its close with %i: the later steps judge the close for themselves", async (status, body) => {
    const session = await openSession();
    gateCloseAnswers(session, status, body);

    expect(await session.close()).toEqual(SPONSORED);
  });

  it("names the gate's refusal when no later step closes the session either", async () => {
    const session = await openSession();
    gateCloseAnswers(session, 409, { error: "refund_account_closed" });
    gate.sponsoredAnswer = { success: false, errorReason: "simulation_failed", errorMessage: "custom program error: 0x1772", transaction: "" };

    await expect(session.close()).rejects.toThrow(/the gate answered 409[\s\S]*refund_account_closed[\s\S]*simulation_failed/);
  });

  it("passes over a gate that takes the close and never answers, after closeRequestTimeoutMs, and says its close may still land", async () => {
    const session = await openSession();
    gate.gateSilent = true;
    gate.sponsoredAnswer = { success: false, errorReason: "simulation_failed", errorMessage: "custom program error: 0x1772", transaction: "" };

    await expect(session.close()).rejects.toThrow(/the gate did not answer its close within 300 ms, and that close may still land[\s\S]*simulation_failed/);
    expect(gate.sponsored).toHaveLength(1);
  });

  it("passes over a closeUrl that never answers, after requestTimeoutMs, and says why", async () => {
    const session = await openSession();
    gate.gateDown = true;
    gate.facilitatorSilent = true;

    await expect(session.close()).rejects.toThrow(/sponsored close failed \(.*timeout[\s\S]*runs to the end of its paid time/);
  });

  it("passes over a closeUrl that takes the close and never answers, after closeRequestTimeoutMs, and says that close may still land", async () => {
    const session = await openSession();
    gate.gateDown = true;
    gate.sponsoredSilent = true;

    await expect(session.close()).rejects.toThrow(
      /the facilitator did not answer its close within 300 ms, and that close may still land[\s\S]*unless that close lands or a later close succeeds/,
    );
  });

  it("says that close may still land when closeUrl starts its answer to the close and never finishes it", async () => {
    const session = await openSession();
    gate.gateDown = true;
    gate.sponsoredStalls = true;

    await expect(session.close()).rejects.toThrow(/the facilitator did not answer its close within 300 ms, and that close may still land/);
  });

  it("gives up a read of the gate's status that never answers, and moves on once closeWaitSeconds have gone by", async () => {
    const session = await openSession({ closeWaitSeconds: 0.5 });
    gate.closeSettlement = PENDING;
    gate.statusSilent = true;

    expect(await session.close()).toEqual(SPONSORED);
  });

  it("takes only the gate's own 404 for a closed session: another 404 on its status, a proxy's say, is waited out", async () => {
    const session = await openSession({ closeWaitSeconds: 0.2 });
    gate.closeSettlement = PENDING;
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) =>
      String(input) === `${gate.url}/sessions/${session.id}` ? Promise.resolve(new Response("Not Found", { status: 404 })) : realFetch(input, init),
    );

    expect(await session.close()).toEqual(SPONSORED);
  });

  it("refuses a time limit that is not a whole number of milliseconds that Node's timers keep", () => {
    expect(() => createStintClient({ signer: buyer, policy, requestTimeoutMs: Infinity })).toThrow(RangeError);
    expect(() => createStintClient({ signer: buyer, policy, closeRequestTimeoutMs: 1.5 })).toThrow(RangeError);
    expect(() => createStintClient({ signer: buyer, policy, closeRequestTimeoutMs: 2 ** 31 })).toThrow(RangeError);
    expect(() => createStintClient({ signer: buyer, policy, requestTimeoutMs: 2 ** 31 - 1 })).not.toThrow();
  });

  it("shares one chain between overlapping calls: one close is sent, and both get its receipt", async () => {
    const session = await openSession();
    gate.gateDown = true;

    const [first, second] = await Promise.all([session.close(), session.close()]);

    expect(first).toEqual(SPONSORED);
    expect(second).toEqual(SPONSORED);
    expect(gate.sponsored).toHaveLength(1);
  });
});
