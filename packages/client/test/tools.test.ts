import { EventEmitter } from "node:events";
import { generateKeyPairSigner, type Address } from "@solana/kit";
import type { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { ToolError, createSessionTools, createStintClient, type CloseReceipt, type StintClient } from "../src/index.js";
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

  const ENDED: [number, string][] = [
    [4402, "The session has ended: the paid time ran out (4402)"],
    [4410, "The session was closed (4410)"],
  ];

  /** Opens a session and connects it. `dropWith` closes the connection from the gate's side, as the gate does when it ends a session. */
  async function connected() {
    const buyer = await generateKeyPairSigner();
    const attached: WebSocket[] = [];
    gate = await startTestGate(buyer.address, (socket) => {
      attached.push(socket);
    });
    const client = createStintClient({
      signer: buyer,
      policy: { maxRate: 1_000n, maxPerSession: 100_000n, budget: { amount: 100_000n, periodSeconds: 3_600 } },
    });
    const runtime = createSessionTools(client);
    const { sessionId } = await runtime.tools.stint_open_session.run({ url: gate.url, seconds: 30, reason: "test" });
    await runtime.tools.stint_send.run({ sessionId, message: "hello" });
    await expect.poll(() => attached.length).toBe(1);
    return {
      ...runtime,
      sessionId,
      /** The settlements the gate has sent to its facilitator: the open, then every close. */
      settlements: () => gate?.payments.length ?? 0,
      async dropWith(code: number) {
        attached[0]?.close(code, "test");
        await expect.poll(() => runtime.closeCode(sessionId)).toBe(code);
      },
    };
  }

  it.each(ENDED)("leaves a session the gate ended with %s alone: closeAll sends no close, and reports no failure", async (code) => {
    const session = await connected();
    const before = session.settlements();
    await session.dropWith(code);

    expect(await session.closeAll()).toEqual({ closed: [], failed: [] });

    expect(session.settlements()).toBe(before);
  });

  it.each(ENDED)("answers a close of a session the gate ended with %s by naming the code, and sends no close", async (code, text) => {
    const session = await connected();
    const before = session.settlements();
    await session.dropWith(code);

    const refused = session.tools.stint_close_session.run({ sessionId: session.sessionId });

    await expect(refused).rejects.toBeInstanceOf(ToolError);
    await expect(refused).rejects.toThrow(text);
    expect(session.settlements()).toBe(before);
  });

  /**
   * A session whose close the test holds in flight, over a socket the test can drop with a code.
   * `settle` answers the oldest close the tools sent. The gate is not used: it cannot hold a settlement.
   */
  async function heldSession() {
    const id = (await generateKeyPairSigner()).address;
    const socket = Object.assign(new EventEmitter(), { OPEN: 1, readyState: 1, send: () => {}, close: () => {} });
    const pending: ((receipt: CloseReceipt) => void)[] = [];
    let sent = 0;
    const client: StintClient = {
      remainingBudget: () => 0n,
      async open() {
        return {
          id,
          gateUrl: "http://seller.test",
          paidUntil: 0,
          wsUrl: "ws://seller.test",
          cost: 0n,
          connect: async () => socket as unknown as WebSocket,
          status: () => Promise.reject(new Error("not used")),
          close: () =>
            new Promise<CloseReceipt>((resolve) => {
              sent++;
              pending.push(resolve);
            }),
          [Symbol.asyncDispose]: async () => {},
        };
      },
    };
    const runtime = createSessionTools(client);
    const { sessionId } = await runtime.tools.stint_open_session.run({ url: "http://seller.test", reason: "test" });
    await runtime.tools.stint_send.run({ sessionId, message: "hello" });
    return {
      ...runtime,
      sessionId,
      /** The closes the tools have sent to the session, answered or not. */
      closesSent: () => sent,
      settle: () => pending.shift()?.({ transaction: "sig" }),
      async dropWith(code: number) {
        socket.emit("close", code, "test");
        await expect.poll(() => runtime.closeCode(sessionId)).toBe(code);
      },
    };
  }

  it("does not refuse a close of the buyer's own still in flight, though the gate's 4410 has arrived", async () => {
    const session = await heldSession();
    const closing = session.tools.stint_close_session.run({ sessionId: session.sessionId });
    await session.dropWith(4410);

    const second = session.tools.stint_close_session.run({ sessionId: session.sessionId });
    session.settle();

    expect(await closing).toEqual({ transaction: "sig" });
    expect(await second).toEqual({ transaction: "sig" });
    expect(session.closesSent()).toBe(1);
  });

  it("makes closeAll wait for the buyer's own close in flight, though the gate's 4410 has arrived, and reports neither", async () => {
    const session = await heldSession();
    const closing = session.tools.stint_close_session.run({ sessionId: session.sessionId });
    await session.dropWith(4410);

    let finished = false;
    const all = session.closeAll().then((outcome) => {
      finished = true;
      return outcome;
    });
    await tick();
    expect(finished).toBe(false);

    session.settle();
    expect(await all).toEqual({ closed: [], failed: [] });
    expect(await closing).toEqual({ transaction: "sig" });
    expect(session.closesSent()).toBe(1);
  });

  it("names 4410 when a second close follows the buyer's own close, and sends no second close", async () => {
    const session = await heldSession();
    const closing = session.tools.stint_close_session.run({ sessionId: session.sessionId });
    session.settle();
    expect(await closing).toEqual({ transaction: "sig" });
    await session.dropWith(4410);

    await expect(session.tools.stint_close_session.run({ sessionId: session.sessionId })).rejects.toThrow("The session was closed (4410)");
    expect(session.closesSent()).toBe(1);
  });

  it("still treats a session whose connection dropped with another code as open: closeAll closes it", async () => {
    const session = await connected();
    const before = session.settlements();
    await session.dropWith(1001);

    expect(await session.closeAll()).toEqual({ closed: [session.sessionId], failed: [] });

    expect(session.settlements()).toBe(before + 1);
  });

  it("still treats a session whose connection dropped with another code as open: stint_close_session closes it", async () => {
    const session = await connected();
    const before = session.settlements();
    await session.dropWith(1001);

    expect(await session.tools.stint_close_session.run({ sessionId: session.sessionId })).toEqual({
      paid: "8000",
      refunded: "22000",
      transaction: "sig",
    });

    expect(session.settlements()).toBe(before + 1);
  });

  it("keeps asking the gate for the status of a session it ended", async () => {
    const session = await connected();
    await session.dropWith(4402);

    const status = await session.tools.stint_session_status.run({ sessionId: session.sessionId });

    expect(status.timeLeftSeconds).toBeGreaterThan(0);
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
