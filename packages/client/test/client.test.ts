import { generateKeyPairSigner, type KeyPairSigner } from "@solana/kit";
import { inspectTransaction, readElapsedPayload } from "@lxfoundry/stint-x402";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStintClient, type Policy } from "../src/index.js";
import { startTestGate, type TestGate } from "./gate.js";

const policy: Policy = { maxRate: 1_000n, maxPerSession: 100_000n, budget: { amount: 40_000n, periodSeconds: 3_600 } };

describe("session client (spec §9.3, §9.4)", () => {
  let buyer: KeyPairSigner;
  let gate: TestGate;

  beforeEach(async () => {
    buyer = await generateKeyPairSigner();
    gate = await startTestGate(buyer.address);
  });

  afterEach(async () => {
    await gate.stop();
    expect(gate.escaped).toEqual([]);
  });

  it("pays the offer it asked for: echoes it, builds the transaction itself, signs only as the authority", async () => {
    const client = createStintClient({ signer: buyer, policy });
    const session = await client.open(gate.url, { seconds: 30 });
    expect(session.cost).toBe(30_000n);
    const [payment] = gate.payments;
    expect(payment?.accepted.extra).toMatchObject({ seconds: 30, rate: "1000" });
    const tx = inspectTransaction(readElapsedPayload(payment!)!.transaction)!;
    expect([...tx.signed]).toEqual([buyer.address]);
    expect(readElapsedPayload(payment!)).toMatchObject({ type: "open", session: session.id });
  });

  it("refuses an offer its policy does not allow, before signing anything", async () => {
    const client = createStintClient({ signer: buyer, policy: { ...policy, maxRate: 999n } });
    await expect(client.open(gate.url, { seconds: 30 })).rejects.toThrow(/maxRate/);
    expect(gate.payments).toHaveLength(0);
  });

  it("keeps to the period budget", async () => {
    const client = createStintClient({ signer: buyer, policy });
    await client.open(gate.url, { seconds: 30 });
    expect(client.remainingBudget()).toBe(10_000n);
    await expect(client.open(gate.url, { seconds: 30 })).rejects.toThrow(/budget/);
  });

  it("reserves the budget before it awaits, so concurrent opens cannot overspend", async () => {
    const client = createStintClient({ signer: buyer, policy });
    const results = await Promise.allSettled([client.open(gate.url, { seconds: 30 }), client.open(gate.url, { seconds: 30 })]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const refused = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(refused).toHaveLength(1);
    expect(String(refused[0]?.reason)).toMatch(/budget/);
    expect(gate.payments).toHaveLength(1);
    expect(client.remainingBudget()).toBe(10_000n);
  });

  it("connects with a connect token, and closes with a close token", async () => {
    const client = createStintClient({ signer: buyer, policy });
    const session = await client.open(gate.url, { seconds: 30 });
    const socket = await session.connect();
    const dropped = new Promise<number>((resolve) => socket.once("close", (code) => resolve(code)));
    expect(await session.close()).toEqual({ paid: 8_000n, refunded: 22_000n, transaction: "sig", via: "gate" });
    expect(await dropped).toBe(4410);
  });

  it("treats a confirmed close as closed when the gate could not read its amounts", async () => {
    const client = createStintClient({ signer: buyer, policy });
    const session = await client.open(gate.url, { seconds: 30 });
    gate.hideClosedEvent = true;
    expect(await session.close()).toEqual({ transaction: "sig", via: "gate" });
    // Disposing a closed session must not close it again.
    await session[Symbol.asyncDispose]();
  });

  it("tops up: pays the top-up offer it asked for, built by itself and signed only as the authority, and moves paidUntil", async () => {
    const client = createStintClient({ signer: buyer, policy });
    const session = await client.open(gate.url, { seconds: 30 });
    const before = session.paidUntil;

    expect(await session.topUp({ seconds: 5 })).toEqual({ paidUntil: before + 5, cost: 5_000n });

    expect(session.paidUntil).toBe(before + 5);
    expect(session.cost).toBe(35_000n);
    expect(client.remainingBudget()).toBe(5_000n);
    const payment = gate.payments.at(-1)!;
    expect(payment.accepted.extra).toMatchObject({ action: "topUp", session: session.id, seconds: 5 });
    expect(readElapsedPayload(payment)).toMatchObject({ type: "topUp" });
    expect([...inspectTransaction(readElapsedPayload(payment)!.transaction)!.signed]).toEqual([buyer.address]);
  });

  it("refuses a top-up its policy does not allow, before signing anything, and locks nothing", async () => {
    const client = createStintClient({ signer: buyer, policy });
    const session = await client.open(gate.url, { seconds: 30 });
    await expect(session.topUp({ seconds: 11 })).rejects.toThrow(/budget/); // 11,000 of the 10,000 left
    const capped = createStintClient({ signer: buyer, policy: { ...policy, maxPerSession: 34_000n } });
    const other = await capped.open(gate.url, { seconds: 30 });
    await expect(other.topUp({ seconds: 5 })).rejects.toThrow(/maxPerSession/); // 35,000 in all

    expect(gate.payments).toHaveLength(2); // the two opens
    expect(client.remainingBudget()).toBe(10_000n);
    expect(session.cost).toBe(30_000n);
  });

  it("unlocks what it locked when the gate refuses the top-up, and reports the gate's status and reason", async () => {
    const client = createStintClient({ signer: buyer, policy });
    const session = await client.open(gate.url, { seconds: 30 });
    const before = session.paidUntil;
    gate.verifyAnswer = { isValid: false, invalidReason: "session_expired" };

    await expect(session.topUp({ seconds: 5 })).rejects.toMatchObject({ status: 402, body: { error: "session_expired" } });

    expect(client.remainingBudget()).toBe(10_000n);
    expect(session.cost).toBe(30_000n);
    expect(session.paidUntil).toBe(before);
  });

  it("reports a duration the gate does not offer without locking anything", async () => {
    const client = createStintClient({ signer: buyer, policy });
    const session = await client.open(gate.url, { seconds: 30 });

    await expect(session.topUp({ seconds: 91 })).rejects.toMatchObject({ status: 400, body: { error: "invalid_duration", maxSeconds: 90 } });
    expect(client.remainingBudget()).toBe(10_000n);
  });

  it("reserves before it awaits, so concurrent top-ups cannot take a session past maxPerSession", async () => {
    const client = createStintClient({ signer: buyer, policy: { ...policy, maxPerSession: 40_000n, budget: { amount: 100_000n, periodSeconds: 3_600 } } });
    const session = await client.open(gate.url, { seconds: 30 });

    const results = await Promise.allSettled([session.topUp({ seconds: 6 }), session.topUp({ seconds: 6 })]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const refused = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(String(refused[0]?.reason)).toMatch(/maxPerSession/);
    expect(gate.payments).toHaveLength(2);
    expect(session.cost).toBe(36_000n);
  });

  it("refuses to top up a session it has closed, without asking the gate", async () => {
    const client = createStintClient({ signer: buyer, policy });
    const session = await client.open(gate.url, { seconds: 30 });
    await session.close();

    await expect(session.topUp({ seconds: 5 })).rejects.toThrow(/closed/);
    expect(gate.payments).toHaveLength(2); // the open and the close
  });

  it("reports a gate's 402 that offers no top-up with its status and reason, and signs nothing", async () => {
    const client = createStintClient({ signer: buyer, policy });
    const session = await client.open(gate.url, { seconds: 30 });
    const realFetch = globalThis.fetch;
    // What the gate answers once its end timer has fired: a 402 offering a new session only.
    vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) =>
      String(input).includes("/top-up")
        ? Promise.resolve(Response.json({ x402Version: 2, error: "session_expired", resource: { url: `${gate.url}/sessions` }, accepts: [] }, { status: 402 }))
        : realFetch(input, init),
    );
    try {
      await expect(session.topUp({ seconds: 5 })).rejects.toMatchObject({
        message: "The session's paid time has run out: it cannot be extended",
        status: 402,
        body: { error: "session_expired" },
      });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(gate.payments).toHaveLength(1);
    expect(client.remainingBudget()).toBe(10_000n);
  });
});
