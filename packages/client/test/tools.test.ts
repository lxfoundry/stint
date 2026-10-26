import { generateKeyPairSigner } from "@solana/kit";
import { afterEach, describe, expect, it } from "vitest";
import { createSessionTools, createStintClient } from "../src/index.js";
import { startTestGate, type TestGate } from "./gate.js";

describe("session tools (spec §9.5)", () => {
  let gate: TestGate | undefined;

  afterEach(async () => {
    await gate?.stop();
    expect(gate?.escaped ?? []).toEqual([]);
    gate = undefined;
  });

  it("opens, sends, receives the messages that match, and closes", async () => {
    const buyer = await generateKeyPairSigner();
    gate = await startTestGate(buyer.address, (socket) => {
      socket.on("message", () => {
        socket.send(JSON.stringify({ type: "slot", slot: "1" }));
        socket.send(JSON.stringify({ type: "account", address: "A", lamports: "5" }));
      });
    });
    const client = createStintClient({
      signer: buyer,
      policy: { maxRate: 1_000n, maxPerSession: 100_000n, budget: { amount: 100_000n, periodSeconds: 3_600 } },
    });
    const { tools, closeCode } = createSessionTools(client);

    const opened = await tools.stint_open_session.run({ url: gate.url, seconds: 30, reason: "test" });
    expect(opened).toMatchObject({ cost: "30000", remainingBudget: "70000" });
    expect(await tools.stint_send.run({ sessionId: opened.sessionId, message: { op: "subscribe", accounts: ["A"] } })).toEqual({ ok: true });

    const matched = await tools.stint_receive.run({ sessionId: opened.sessionId, timeoutSeconds: 5, match: { type: "account" } });
    expect(matched).toEqual({ messages: [{ type: "account", address: "A", lamports: "5" }], timedOut: false });
    const rest = await tools.stint_receive.run({ sessionId: opened.sessionId, timeoutSeconds: 5 });
    expect(rest).toEqual({ messages: [{ type: "slot", slot: "1" }], timedOut: false });
    const nothing = await tools.stint_receive.run({ sessionId: opened.sessionId, timeoutSeconds: 0.2 });
    expect(nothing).toEqual({ messages: [], timedOut: true });

    expect(await tools.stint_close_session.run({ sessionId: opened.sessionId })).toEqual({
      paid: "8000",
      refunded: "22000",
      transaction: "sig",
    });
    await expect.poll(() => closeCode(opened.sessionId)).toBe(4410);
  });

  it("answers an unknown session with a readable error", async () => {
    const client = createStintClient({
      signer: await generateKeyPairSigner(),
      policy: { maxRate: 1n, maxPerSession: 1n, budget: { amount: 1n, periodSeconds: 1 } },
    });
    const { tools } = createSessionTools(client);
    await expect(tools.stint_close_session.run({ sessionId: "nope" })).rejects.toThrow(/Unknown session nope/);
  });

  it("describes every tool with a strict schema", () => {
    const { tools } = createSessionTools(
      createStintClient({ signer: undefined as never, policy: { maxRate: 1n, maxPerSession: 1n, budget: { amount: 1n, periodSeconds: 1 } } }),
    );
    for (const tool of Object.values(tools)) {
      expect(tool.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
      expect(tool.description.length).toBeGreaterThan(20);
    }
    expect(tools.stint_close_session.description).toMatch(/as soon as/);
  });
});
