import { generateKeyPairSigner, type KeyPairSigner } from "@solana/kit";
import { inspectTransaction, readElapsedPayload } from "@lxfoundry/stint-x402";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
    expect(await session.close()).toEqual({ paid: 8_000n, refunded: 22_000n, transaction: "sig" });
    expect(await dropped).toBe(4410);
  });

  it("treats a confirmed close as closed when the gate could not read its amounts", async () => {
    const client = createStintClient({ signer: buyer, policy });
    const session = await client.open(gate.url, { seconds: 30 });
    gate.hideClosedEvent = true;
    expect(await session.close()).toEqual({ transaction: "sig" });
    // Disposing a closed session must not close it again.
    await session[Symbol.asyncDispose]();
  });
});
