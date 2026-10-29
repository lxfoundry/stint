import { generateKeyPairSigner, type Address } from "@solana/kit";
import type { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { createSessionTools, createStintClient, type CloseReceipt, type StintClient } from "../src/index.js";
import { startTestGate, type TestGate } from "./gate.js";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** A client whose sessions close only when the test settles the close, so that the test decides what is in flight. */
async function controlledClient(count: number) {
  const ids = await Promise.all(Array.from({ length: count }, async () => (await generateKeyPairSigner()).address));
  const closes: { id: Address; settle: (error?: Error) => void }[] = [];
  let next = 0;
  const client: StintClient = {
    remainingBudget: () => 0n,
    async open() {
      const id = ids[next++] as Address;
      return {
        id,
        gateUrl: "http://seller.test",
        paidUntil: 0,
        wsUrl: "ws://seller.test",
        cost: 0n,
        connect: () => Promise.reject(new Error("not used")),
        status: () => Promise.reject(new Error("not used")),
        close: () =>
          new Promise<CloseReceipt>((resolve, reject) => {
            closes.push({ id, settle: (error) => (error ? reject(error) : resolve({ transaction: `close-of-${id}` })) });
          }),
        [Symbol.asyncDispose]: async () => {},
      };
    },
  };
  return { client, closes };
}

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

  it("shares one connection between concurrent first sends", async () => {
    const buyer = await generateKeyPairSigner();
    const attached: WebSocket[] = [];
    gate = await startTestGate(buyer.address, (socket) => {
      attached.push(socket);
      // Every message is broadcast to every attached connection, so a second connection would double the replies.
      socket.on("message", (data) => {
        for (const peer of attached) peer.send(JSON.stringify({ type: "echo", text: String(data) }));
      });
    });
    const client = createStintClient({
      signer: buyer,
      policy: { maxRate: 1_000n, maxPerSession: 100_000n, budget: { amount: 100_000n, periodSeconds: 3_600 } },
    });
    const { tools } = createSessionTools(client);
    const opened = await tools.stint_open_session.run({ url: gate.url, seconds: 30, reason: "test" });

    await Promise.all([
      tools.stint_send.run({ sessionId: opened.sessionId, message: "a" }),
      tools.stint_send.run({ sessionId: opened.sessionId, message: "b" }),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const { messages } = await tools.stint_receive.run({ sessionId: opened.sessionId, timeoutSeconds: 0, max: 10 });

    expect(attached).toHaveLength(1);
    expect(messages).toHaveLength(2);
    expect(messages.map((message) => (message as { text: string }).text).sort()).toEqual(["a", "b"]);
  });

  it("closes a session whose amounts the gate could not read, without an error", async () => {
    const buyer = await generateKeyPairSigner();
    gate = await startTestGate(buyer.address);
    const client = createStintClient({
      signer: buyer,
      policy: { maxRate: 1_000n, maxPerSession: 100_000n, budget: { amount: 100_000n, periodSeconds: 3_600 } },
    });
    const { tools } = createSessionTools(client);
    const opened = await tools.stint_open_session.run({ url: gate.url, seconds: 30, reason: "test" });
    gate.hideClosedEvent = true;
    expect(await tools.stint_close_session.run({ sessionId: opened.sessionId })).toEqual({ transaction: "sig" });
  });

  it("reports the status of an open session, and refuses it once the session is closed", async () => {
    const buyer = await generateKeyPairSigner();
    gate = await startTestGate(buyer.address);
    const client = createStintClient({
      signer: buyer,
      policy: { maxRate: 1_000n, maxPerSession: 100_000n, budget: { amount: 100_000n, periodSeconds: 3_600 } },
    });
    const { tools } = createSessionTools(client);
    const opened = await tools.stint_open_session.run({ url: gate.url, seconds: 30, reason: "test" });

    const status = await tools.stint_session_status.run({ sessionId: opened.sessionId });

    expect(status.paidUntil).toBe(opened.paidUntil);
    expect(status.timeLeftSeconds).toBeGreaterThanOrEqual(20);
    expect(status.timeLeftSeconds).toBeLessThanOrEqual(30);
    // Under minSeconds the charge is the minimum: 5 s at 1,000 per second.
    expect(status).toMatchObject({ spent: "5000", refundable: "25000" });

    await tools.stint_close_session.run({ sessionId: opened.sessionId });
    await expect(tools.stint_session_status.run({ sessionId: opened.sessionId })).rejects.toThrow(/closed/);
  });

  it("closes every session still open, and reports what it closed", async () => {
    const buyer = await generateKeyPairSigner();
    gate = await startTestGate(buyer.address);
    const client = createStintClient({
      signer: buyer,
      policy: { maxRate: 1_000n, maxPerSession: 100_000n, budget: { amount: 100_000n, periodSeconds: 3_600 } },
    });
    const { tools, closeAll, closeCode } = createSessionTools(client);
    const first = await tools.stint_open_session.run({ url: gate.url, seconds: 30, reason: "test" });
    const second = await tools.stint_open_session.run({ url: gate.url, seconds: 30, reason: "test" });
    await tools.stint_send.run({ sessionId: second.sessionId, message: "hello" });
    await tools.stint_close_session.run({ sessionId: first.sessionId });

    expect(await closeAll()).toEqual({ closed: [second.sessionId], failed: [] });
    await expect.poll(() => closeCode(second.sessionId)).toBe(4410);
    expect(await closeAll()).toEqual({ closed: [], failed: [] });
  });

  it("reports a session that could not be closed instead of throwing", async () => {
    const buyer = await generateKeyPairSigner();
    gate = await startTestGate(buyer.address);
    const client = createStintClient({
      signer: buyer,
      policy: { maxRate: 1_000n, maxPerSession: 100_000n, budget: { amount: 100_000n, periodSeconds: 3_600 } },
    });
    const { tools, closeAll } = createSessionTools(client);
    const opened = await tools.stint_open_session.run({ url: gate.url, seconds: 30, reason: "test" });
    // The gate goes away before the close; `afterEach` then has nothing left to stop.
    const stopping = gate;
    gate = undefined;
    await stopping.stop();

    const outcome = await closeAll();

    expect(outcome.closed).toEqual([]);
    expect(outcome.failed).toHaveLength(1);
    expect(outcome.failed[0]?.sessionId).toBe(opened.sessionId);
  });

  it("waits for an open that is still in flight, and closes its session", async () => {
    const buyer = await generateKeyPairSigner();
    gate = await startTestGate(buyer.address);
    const client = createStintClient({
      signer: buyer,
      policy: { maxRate: 1_000n, maxPerSession: 100_000n, budget: { amount: 100_000n, periodSeconds: 3_600 } },
    });
    const { tools, closeAll } = createSessionTools(client);

    const opening = tools.stint_open_session.run({ url: gate.url, seconds: 30, reason: "test" });
    const outcome = await closeAll();

    expect(outcome).toEqual({ closed: [(await opening).sessionId], failed: [] });
  });

  it("waits for a close that is still in flight, and does not close its session a second time", async () => {
    const buyer = await generateKeyPairSigner();
    gate = await startTestGate(buyer.address);
    const client = createStintClient({
      signer: buyer,
      policy: { maxRate: 1_000n, maxPerSession: 100_000n, budget: { amount: 100_000n, periodSeconds: 3_600 } },
    });
    const { tools, closeAll } = createSessionTools(client);
    const opened = await tools.stint_open_session.run({ url: gate.url, seconds: 30, reason: "test" });

    const closing = tools.stint_close_session.run({ sessionId: opened.sessionId });
    const outcome = await closeAll();

    expect(outcome).toEqual({ closed: [], failed: [] });
    expect((await closing).transaction).toEqual(expect.any(String));
  });

  it("does not close a session a second time when its close starts while closeAll is already closing others", async () => {
    const { client, closes } = await controlledClient(2);
    const { tools, closeAll } = createSessionTools(client);
    const first = await tools.stint_open_session.run({ url: "http://seller.test", reason: "test" });
    const second = await tools.stint_open_session.run({ url: "http://seller.test", reason: "test" });

    const closingFirst = tools.stint_close_session.run({ sessionId: first.sessionId });
    const all = closeAll();
    await tick();
    const closingSecond = tools.stint_close_session.run({ sessionId: second.sessionId });
    await tick();
    closes[0]?.settle();
    await tick();
    // One close for each session, whoever asked for it and whenever.
    expect(closes.map((close) => close.id).sort()).toEqual([first.sessionId, second.sessionId].sort());
    for (const close of closes) close.settle();

    expect((await all).failed).toEqual([]);
    await Promise.all([closingFirst, closingSecond]);
  });

  it("tries a close again, and reports its outcome, when the close that was in flight fails", async () => {
    const { client, closes } = await controlledClient(1);
    const { tools, closeAll } = createSessionTools(client);
    const opened = await tools.stint_open_session.run({ url: "http://seller.test", reason: "test" });

    const closing = tools.stint_close_session.run({ sessionId: opened.sessionId });
    const refused = expect(closing).rejects.toThrow("gate down");
    const all = closeAll();
    await tick();
    closes[0]?.settle(new Error("gate down"));
    await refused;
    await tick();
    expect(closes).toHaveLength(2);
    closes[1]?.settle();

    expect(await all).toEqual({ closed: [opened.sessionId], failed: [] });
  });

  it("refuses to open a session once closeAll has run", async () => {
    const buyer = await generateKeyPairSigner();
    gate = await startTestGate(buyer.address);
    const client = createStintClient({
      signer: buyer,
      policy: { maxRate: 1_000n, maxPerSession: 100_000n, budget: { amount: 100_000n, periodSeconds: 3_600 } },
    });
    const { tools, closeAll } = createSessionTools(client);

    await closeAll();

    await expect(tools.stint_open_session.run({ url: gate.url, seconds: 30, reason: "test" })).rejects.toThrow(/shutting down/);
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
