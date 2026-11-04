import type {
  CloseAllOutput,
  CloseInput,
  CloseOutput,
  OpenInput,
  OpenOutput,
  ReceiveInput,
  ReceiveOutput,
  SendInput,
  SessionTools,
  StatusInput,
  StatusOutput,
  Tool,
  TopUpInput,
  TopUpOutput,
} from "@lxfoundry/stint-client";
import type { ElapsedRequirements } from "@lxfoundry/stint-x402";
import { describe, expect, it } from "vitest";
import type { DemoChain, FoundClose } from "../src/chain.js";
import { CLOSE_LOOKUP_EVERY_MS, STATE_READ_CAP_MS, createDemo, type Demo } from "../src/demo.js";
import { explorerAddress, explorerTx } from "../src/links.js";
import { READ_CALL_TIMEOUT_MS } from "../src/owner.js";
import { AGENT_USDC, FEE_PAYER, SELLER, SESSION, offer, signatureOf } from "./fixtures.js";

const START_MS = 1_800_000_000_000;
const OPEN_TX = signatureOf(1);
const TOP_UP_TX = signatureOf(2);
const CLOSE_TX = signatureOf(3);
/** An RPC URL that carries a key, as a failing request quotes it. */
const KEYED = "https://rpc.example/v2?api-key=secret-marker";

const tool = <I, O>(name: string, run: (input: I) => Promise<O>): Tool<I, O> => ({ name, description: name, inputSchema: {}, run });
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

/** What a test changes in the fakes, after the demo is built. */
interface Behave {
  /** The transaction the gate settles an open with, as the recorder reports it: not checked by the recorder. */
  openTx: string;
  topUpTx: string;
  /** The open waits for this before it answers. */
  hold?: Promise<void>;
  /** The offer the recorder reports for the open; `null` reports none. */
  offer?: ElapsedRequirements | null;
  /** The close waits for this before it answers. */
  holdClose?: Promise<void>;
  /** The balance read waits for this before it answers. */
  holdBalance?: Promise<void>;
  /** The close lookup waits for this before it answers. */
  holdLookup?: Promise<void>;
  /** The stream connection never opens: a send never settles. */
  hangSend?: boolean;
  /** The address of the session the next open returns. */
  sessionId?: string;
  openFails?: Error;
  topUpFails?: Error;
  closeFails?: Error;
  receiveFails?: Error;
  balanceFails?: Error;
  lookupFails?: Error;
}

/** A demo over fake session tools, whose open reports to the sink as the recorder would, and over a fake chain. */
function setup(options: { balance?: bigint; stateReadCapMs?: number; launchSeconds?: number } = {}) {
  let clock = START_MS;
  let paidUntil = 0;
  /** The seconds each open asked for. */
  const opened: (number | undefined)[] = [];
  const sent: unknown[] = [];
  const inbox: unknown[] = [];
  const logs: string[] = [];
  const closeCodes = new Map<string, number>();
  const closes = new Map<string, FoundClose>();
  const counts = { open: 0, topUp: 0, close: 0, closeAll: 0, lookups: 0, balances: 0 };
  const behave: Behave = { openTx: OPEN_TX, topUpTx: TOP_UP_TX };
  let demo: Demo | undefined;
  const sink = () => demo!.sink;
  const tools: SessionTools = {
    tools: {
      stint_open_session: tool<OpenInput, OpenOutput>("stint_open_session", async (input) => {
        counts.open++;
        opened.push(input.seconds);
        sink().row({ kind: "request", at: clock, label: "POST /sessions?seconds=100" });
        if (behave.openFails) throw behave.openFails;
        if (behave.offer !== null) sink().offer("open", behave.offer ?? offer("open"));
        sink().settled("open", behave.openTx);
        paidUntil = Math.floor(clock / 1000) + 100;
        await behave.hold;
        return { sessionId: behave.sessionId ?? SESSION, paidUntil, cost: "100000", remainingBudget: "500000" };
      }),
      stint_session_status: tool<StatusInput, StatusOutput>("stint_session_status", async () => {
        throw new Error("not used by the demo");
      }),
      stint_top_up: tool<TopUpInput, TopUpOutput>("stint_top_up", async () => {
        counts.topUp++;
        if (behave.topUpFails) throw behave.topUpFails;
        sink().settled("topUp", behave.topUpTx);
        paidUntil += 100;
        return { paidUntil, cost: "100000" };
      }),
      stint_send: tool<SendInput, { ok: true }>("stint_send", async (input) => {
        sent.push(input.message);
        if (behave.hangSend) await new Promise<never>(() => {});
        return { ok: true };
      }),
      stint_receive: tool<ReceiveInput, ReceiveOutput>("stint_receive", async () => {
        if (behave.receiveFails) throw behave.receiveFails;
        const messages = inbox.splice(0);
        return { messages, timedOut: messages.length === 0 };
      }),
      stint_close_session: tool<CloseInput, CloseOutput>("stint_close_session", async () => {
        counts.close++;
        await behave.holdClose;
        if (behave.closeFails) throw behave.closeFails;
        return { paid: "12000", refunded: "88000", transaction: CLOSE_TX };
      }),
    },
    closeCode: (sessionId) => closeCodes.get(sessionId),
    closeAll: async (): Promise<CloseAllOutput> => {
      counts.closeAll++;
      return { closed: [SESSION], failed: [] };
    },
  };
  let balance = options.balance ?? 1_000_000n;
  const chain: DemoChain = {
    usdcAccount: AGENT_USDC,
    usdcBalance: async () => {
      counts.balances++;
      // The node answers with the balance it held when it was asked.
      const asked = balance;
      await behave.holdBalance;
      if (behave.balanceFails) throw behave.balanceFails;
      return asked;
    },
    findClose: async (session) => {
      counts.lookups++;
      await behave.holdLookup;
      if (behave.lookupFails) throw behave.lookupFails;
      return closes.get(session);
    },
  };
  demo = createDemo({
    address: "AgentWallet",
    gateUrl: "https://gate.example",
    tools,
    chain,
    now: () => clock,
    log: (line) => void logs.push(line),
    ...(options.stateReadCapMs === undefined ? {} : { stateReadCapMs: options.stateReadCapMs }),
    ...(options.launchSeconds === undefined ? {} : { launchSeconds: options.launchSeconds }),
  });
  return {
    demo,
    opened,
    sent,
    inbox,
    logs,
    behave,
    closeCodes,
    closes,
    counts,
    advance: (ms: number) => void (clock += ms),
    setBalance: (value: bigint) => void (balance = value),
    paidUntil: () => paidUntil,
  };
}

describe("the demo's session", () => {
  it("launches a 100 s session, with its terms and links, and subscribes to the agent's own USDC account", async () => {
    const t = setup();
    const state = await t.demo.launch();
    expect(state.session).toMatchObject({
      state: "open",
      sessionId: SESSION,
      paidUntil: t.paidUntil(),
      startedAt: t.paidUntil() - 100,
      deposited: "100000",
      rate: "1000",
      maxSeconds: 300,
      topUpMarginSeconds: 10,
      frames: 0,
    });
    expect(state.session.links).toEqual({ session: explorerAddress(SESSION), open: explorerTx(OPEN_TX), topUps: [], seller: explorerAddress(SELLER) });
    expect(t.sent).toEqual([{ op: "subscribe", accounts: [AGENT_USDC] }]);
    expect(state.busy).toBeUndefined();
    expect(state.exchange).toEqual({ current: [], last: { action: "launch", rows: [{ kind: "request", at: START_MS, label: "POST /sessions?seconds=100" }] } });
    expect(state.wallet).toMatchObject({ address: "AgentWallet", usdc: "1000000" });
  });

  it("asks for a 100 s session, or for the length it is given", async () => {
    const standard = setup();
    await standard.demo.launch();
    const short = setup({ launchSeconds: 20 });
    await short.demo.launch();
    expect([standard.opened, short.opened]).toEqual([[100], [20]]);
  });

  it("refuses a launch the wallet cannot pay for, and a second one while a session runs", async () => {
    const poor = setup({ balance: 99_999n });
    await expect(poor.demo.launch()).rejects.toThrow(/needs 0\.100 USDC/);
    expect(poor.counts.open).toBe(0);
    expect((await poor.demo.state()).error).toMatchObject({ action: "launch" });
    const t = setup();
    await t.demo.launch();
    await expect(t.demo.launch()).rejects.toThrow(/already running/);
    expect(t.counts.open).toBe(1);
  });

  it("closes the session now, with what was paid and refunded, and the close's link", async () => {
    const t = setup();
    await t.demo.launch();
    t.advance(12_000);
    const state = await t.demo.close();
    expect(state.session).toMatchObject({ state: "closed", paid: "12000", refunded: "88000", endedAt: Math.floor(START_MS / 1000) + 12 });
    expect(state.session.links.close).toBe(explorerTx(CLOSE_TX));
    // A close sends no paid request to the gate: the panel keeps showing the launch's exchange.
    expect(state.exchange.last?.action).toBe("launch");
    await expect(t.demo.close()).rejects.toThrow(/is closed/);
    expect(t.counts.close).toBe(1);
    expect((await t.demo.state()).exchange.last?.action).toBe("launch");
  });

  it("tops up by 100 s, and refuses past the longest session and near the end of the paid time", async () => {
    const t = setup();
    await t.demo.launch();
    let state = await t.demo.topUp();
    expect(state.session).toMatchObject({ paidUntil: t.paidUntil(), deposited: "200000" });
    expect(state.session.links.topUps).toEqual([explorerTx(TOP_UP_TX)]);
    state = await t.demo.topUp();
    expect(state.session.deposited).toBe("300000");
    await expect(t.demo.topUp()).rejects.toThrow(/at most 300 s/);
    const late = setup();
    await late.demo.launch();
    late.advance(87_000);
    await expect(late.demo.topUp()).rejects.toThrow(/Too close to the end/);
    expect(late.counts.topUp).toBe(0);
    expect((await late.demo.state()).exchange.last?.action).toBe("launch");
  });

  it("counts the stream's account messages at each state read (optional)", async () => {
    const t = setup();
    await t.demo.launch();
    t.inbox.push({ type: "account", address: AGENT_USDC }, { type: "error", code: "subscription_failed" }, { type: "account", address: AGENT_USDC });
    expect((await t.demo.state()).session.frames).toBe(2);
  });

  it("sends the subscription again while the session runs, at most every 15 s", async () => {
    const t = setup();
    await t.demo.launch();
    await t.demo.state();
    expect(t.sent).toHaveLength(1);
    t.advance(15_000);
    await t.demo.state();
    expect(t.sent).toHaveLength(2);
  });

  it("follows a session to its expiry: the gate closing it, then the seller paid in full, with the close's link", async () => {
    const t = setup();
    await t.demo.launch();
    t.advance(100_000);
    expect((await t.demo.state()).session.state).toBe("open");
    t.closes.set(SESSION, { signature: CLOSE_TX, at: t.paidUntil() + 1, paidUntil: t.paidUntil(), paid: "100000", refunded: "0" });
    t.advance(4_000);
    const state = await t.demo.state();
    expect(state.session).toMatchObject({ state: "expired", paid: "100000", refunded: "0" });
    expect(state.session.links.close).toBe(explorerTx(CLOSE_TX));
  });

  it("marks a session the gate dropped with 4410 as ended, with the close found on the chain and the refund in the balance", async () => {
    const t = setup();
    await t.demo.launch();
    t.advance(61_000);
    t.closeCodes.set(SESSION, 4410);
    t.closes.set(SESSION, { signature: CLOSE_TX, at: t.paidUntil() - 39, paidUntil: t.paidUntil(), paid: "61000", refunded: "39000" });
    t.setBalance(939_000n);
    const state = await t.demo.state();
    expect(state.session).toMatchObject({ state: "ended", closeCode: 4410, paid: "61000", refunded: "39000" });
    expect(state.wallet.usdc).toBe("939000");
  });

  it("closes a running session at shutdown, opens none after, and leaves alone one whose paid time is over", async () => {
    const t = setup();
    await t.demo.launch();
    expect(await t.demo.shutdown()).toEqual({ closed: [SESSION], failed: [] });
    await expect(t.demo.launch()).rejects.toThrow(/shutting down/);
    const over = setup();
    await over.demo.launch();
    over.advance(100_000);
    expect(await over.demo.shutdown()).toEqual({ closed: [], failed: [] });
    expect(over.counts.closeAll).toBe(0);
  });
});

describe("the session's end", () => {
  it("marks a session the gate dropped with 4402 as expired at once, the seller paid in full, and takes the chain's figures once found", async () => {
    const t = setup();
    await t.demo.launch();
    t.advance(100_000);
    t.closeCodes.set(SESSION, 4402);
    let state = await t.demo.state();
    expect(state.session).toMatchObject({ state: "expired", closeCode: 4402, endedAt: t.paidUntil(), paid: "100000", refunded: "0" });
    expect(state.session.links.close).toBeUndefined();
    t.closes.set(SESSION, { signature: CLOSE_TX, at: t.paidUntil() + 2, paidUntil: t.paidUntil(), paid: "100000", refunded: "0" });
    t.advance(4_000);
    state = await t.demo.state();
    expect(state.session).toMatchObject({ state: "expired", endedAt: t.paidUntil() + 2 });
    expect(state.session.links.close).toBe(explorerTx(CLOSE_TX));
  });

  it("asks the chain for a close at most every 4 s", async () => {
    const t = setup();
    await t.demo.launch();
    t.advance(100_000);
    await t.demo.state();
    await t.demo.state();
    expect(t.counts.lookups).toBe(1);
    t.advance(3_999);
    await t.demo.state();
    expect(t.counts.lookups).toBe(1);
    t.advance(1);
    await t.demo.state();
    expect(t.counts.lookups).toBe(2);
  });

  it("logs a lookup that failed, and asks again at the next state read after 4 s", async () => {
    const t = setup();
    await t.demo.launch();
    t.advance(100_000);
    t.behave.lookupFails = new Error(`the node is down: ${KEYED}`);
    expect((await t.demo.state()).session.state).toBe("open");
    expect(t.logs).toHaveLength(1);
    expect(t.logs[0]).toMatch(/looking up the close of .* failed: the node is down: https:\/\/rpc\.example$/);
    t.behave.lookupFails = undefined;
    t.closes.set(SESSION, { signature: CLOSE_TX, at: t.paidUntil() + 1, paidUntil: t.paidUntil(), paid: "100000", refunded: "0" });
    t.advance(4_000);
    expect((await t.demo.state()).session).toMatchObject({ state: "expired", links: { close: explorerTx(CLOSE_TX) } });
  });

  it("follows a failed close to the chain: the session another party closed is ended, and the failure is reported", async () => {
    const t = setup();
    await t.demo.launch();
    t.advance(39_000);
    t.behave.closeFails = new Error("404 unknown_session");
    t.closes.set(SESSION, { signature: CLOSE_TX, at: t.paidUntil() - 61, paidUntil: t.paidUntil(), paid: "39000", refunded: "61000" });
    t.setBalance(961_000n);
    await expect(t.demo.close()).rejects.toThrow("404 unknown_session");
    const state = await t.demo.state();
    expect(state.session).toMatchObject({ state: "ended", paid: "39000", refunded: "61000" });
    expect(state.session.links.close).toBe(explorerTx(CLOSE_TX));
    expect(state.error).toEqual({ action: "close", message: "404 unknown_session", at: START_MS + 39_000 });
    expect(state.wallet.usdc).toBe("961000");
  });

  it("looks the close up after a failed top-up too, and keeps a session still open that the chain has not closed", async () => {
    const t = setup();
    await t.demo.launch();
    t.behave.topUpFails = new Error("the gate does not know the session");
    await expect(t.demo.topUp()).rejects.toThrow(/does not know/);
    expect(t.counts.lookups).toBe(1);
    const state = await t.demo.state();
    expect(state.session).toMatchObject({ state: "open", deposited: "100000" });
    expect(state.session.links.topUps).toEqual([]);
    expect(state.error).toMatchObject({ action: "top-up", message: "the gate does not know the session" });
  });
});

describe("what the demo reports", () => {
  it("records a failed action in the state with the time in milliseconds, until the next one starts", async () => {
    const t = setup();
    await t.demo.launch();
    t.advance(5_000);
    t.behave.closeFails = new Error("the gate answered 500");
    await expect(t.demo.close()).rejects.toThrow("the gate answered 500");
    // One line, even though the action's caller gets the error too.
    expect(t.logs).toEqual(["close failed: the gate answered 500"]);
    let state = await t.demo.state();
    expect(state.error).toEqual({ action: "close", message: "the gate answered 500", at: START_MS + 5_000 });
    // The session is open again, and a close can be tried again.
    expect(state.session.state).toBe("open");
    t.advance(1_000);
    state = await t.demo.topUp();
    expect(state.error).toBeUndefined();
  });

  it("returns to no session when the open fails, and keeps the rows the failed launch recorded", async () => {
    const t = setup();
    t.behave.openFails = new Error("Expected 402, got 502");
    await expect(t.demo.launch()).rejects.toThrow("Expected 402, got 502");
    const state = await t.demo.state();
    expect(state.session.state).toBe("none");
    expect(state.session.sessionId).toBeUndefined();
    expect(state.exchange.last).toEqual({ action: "launch", rows: [{ kind: "request", at: START_MS, label: "POST /sessions?seconds=100" }] });
    expect(state.error).toMatchObject({ action: "launch", message: "Expected 402, got 502" });
    // A launch can be tried again.
    t.behave.openFails = undefined;
    expect((await t.demo.launch()).session.state).toBe("open");
  });

  it("logs a stream read that failed, and says nothing of it in the state: it is a background read", async () => {
    const t = setup();
    await t.demo.launch();
    t.behave.receiveFails = new Error(`socket hang up (${KEYED})`);
    const state = await t.demo.state();
    expect(state.error).toBeUndefined();
    expect(state.session).toMatchObject({ state: "open", frames: 0 });
    expect(t.logs).toEqual(["reading the stream's messages failed: socket hang up (https://rpc.example)"]);
  });

  it("logs a balance read that failed, keeps the last balance, and reads again at the next state read", async () => {
    const t = setup();
    await t.demo.launch();
    t.behave.balanceFails = new Error("429 Too Many Requests");
    t.setBalance(5n);
    let state = await t.demo.state({ refreshBalance: true });
    expect(state.wallet.usdc).toBe("1000000");
    expect(t.logs).toEqual(["reading the wallet's balance failed: 429 Too Many Requests"]);
    t.behave.balanceFails = undefined;
    state = await t.demo.state();
    expect(state.wallet.usdc).toBe("5");
    expect(t.logs).toHaveLength(1);
  });

  it("logs a first balance read that failed, and tries again at the next state read", async () => {
    const t = setup();
    t.behave.balanceFails = new Error("fetch failed");
    expect((await t.demo.state()).wallet).toEqual({ address: "AgentWallet" });
    t.behave.balanceFails = undefined;
    expect((await t.demo.state()).wallet).toMatchObject({ usdc: "1000000", checkedAt: START_MS });
  });

  it("quotes no RPC URL beyond its host: not in a log line, not in the state's error, not in the error it throws", async () => {
    const t = setup();
    await t.demo.launch();
    t.behave.balanceFails = new Error(`request to ${KEYED} failed`);
    t.behave.closeFails = new Error(`could not read ${KEYED}`);
    await expect(t.demo.close()).rejects.toThrow("could not read https://rpc.example");
    const error = await t.demo.close().catch((caught: unknown) => caught);
    expect(String((error as Error).message)).not.toContain("secret-marker");
    const state = await t.demo.state();
    expect(JSON.stringify(state)).not.toContain("secret-marker");
    expect(state.error?.message).toBe("could not read https://rpc.example");
    expect(t.logs.length).toBeGreaterThan(0);
    for (const line of t.logs) expect(line).not.toContain("secret-marker");
    expect(t.logs.join("\n")).toContain("request to https://rpc.example failed");
    expect(t.logs).toContain("close failed: could not read https://rpc.example");
  });

  it("writes each log line on one line", async () => {
    const t = setup();
    t.behave.balanceFails = new Error("first line\nsecond line");
    await t.demo.state();
    expect(t.logs).toEqual(["reading the wallet's balance failed: first line second line"]);
  });
});

describe("what the state links to", () => {
  it("links a transaction only when the gate's text is a valid signature", async () => {
    const t = setup();
    t.behave.openTx = "https://evil.example/not-a-signature";
    t.behave.topUpTx = "0".repeat(88);
    await t.demo.launch();
    const state = await t.demo.topUp();
    expect(state.session.links.open).toBeUndefined();
    expect(state.session.links.topUps).toEqual([]);
    expect(state.session.links.session).toBe(explorerAddress(SESSION));
    expect(JSON.stringify(state.session.links)).not.toContain("evil.example");
  });

  it("links the seller only from a valid address", async () => {
    const t = setup();
    const entry = offer("open");
    t.behave.offer = { ...entry, payTo: "not an address" } as unknown as ElapsedRequirements;
    const state = await t.demo.launch();
    expect(state.session.links.seller).toBeUndefined();
    expect(state.session).toMatchObject({ state: "open", rate: "1000" });
  });

  it("keeps a session open, without its rate and start, when the offer's rate is 0", async () => {
    const t = setup();
    const entry = offer("open");
    t.behave.offer = { ...entry, extra: { ...entry.extra, rate: "0" } };
    const state = await t.demo.launch();
    expect(state.session.state).toBe("open");
    expect(state.session.rate).toBeUndefined();
    expect(state.session.startedAt).toBeUndefined();
    expect(state.session).toMatchObject({ deposited: "100000", maxSeconds: 300 });
    await expect(t.demo.topUp().then((next) => next.session.deposited)).resolves.toBe("200000");
  });

  it("opens with what the open returned, and no terms or seller, when the recorder saw no offer", async () => {
    const t = setup();
    t.behave.offer = null;
    const state = await t.demo.launch();
    expect(state.session).toMatchObject({ state: "open", sessionId: SESSION, deposited: "100000", paidUntil: t.paidUntil() });
    expect(state.session.rate).toBeUndefined();
    expect(state.session.startedAt).toBeUndefined();
    expect(state.session.maxSeconds).toBeUndefined();
    expect(state.session.links.seller).toBeUndefined();
    expect(state.session.links.open).toBe(explorerTx(OPEN_TX));
  });
});

describe("a stream connection that never opens", () => {
  it("holds neither the launch nor a state read, sends no second subscription while the first is in flight, and still follows the gate's end", async () => {
    const t = setup();
    t.behave.hangSend = true;
    const launched = await t.demo.launch();
    expect(launched).toMatchObject({ session: { state: "open" } });
    expect(launched.busy).toBeUndefined();
    expect(t.sent).toHaveLength(1);
    t.advance(15_000);
    expect((await t.demo.state()).session.state).toBe("open");
    t.advance(15_000);
    await t.demo.state();
    expect(t.sent).toHaveLength(1);
    t.closeCodes.set(SESSION, 4410);
    t.closes.set(SESSION, { signature: CLOSE_TX, at: t.paidUntil() - 70, paidUntil: t.paidUntil(), paid: "30000", refunded: "70000" });
    expect((await t.demo.state()).session).toMatchObject({ state: "ended", paid: "30000", refunded: "70000" });
  }, 1_000);

  it("lets the person close the session that was launched meanwhile, and logs nothing for a subscription still waiting", async () => {
    const t = setup();
    t.behave.hangSend = true;
    await t.demo.launch();
    t.advance(2_000);
    const state = await t.demo.close();
    expect(state.session).toMatchObject({ state: "closed", paid: "12000", refunded: "88000" });
    expect(t.counts.close).toBe(1);
    expect(t.logs).toEqual([]);
  }, 1_000);

  it("sends a new session's subscription although the last session's is still in flight", async () => {
    const t = setup();
    t.behave.hangSend = true;
    await t.demo.launch();
    await t.demo.close();
    t.behave.sessionId = FEE_PAYER;
    await t.demo.launch();
    expect(t.sent).toHaveLength(2);
  }, 1_000);
});

describe("a shutdown while a launch reads the balance", () => {
  it("opens nothing after it, and refuses the launch", async () => {
    const t = setup();
    let release!: () => void;
    t.behave.holdBalance = new Promise<void>((resolve) => (release = resolve));
    const launching = t.demo.launch();
    const refused = expect(launching).rejects.toThrow(/shutting down/);
    await tick();
    // No session runs yet: the shutdown has nothing to close.
    expect(await t.demo.shutdown()).toEqual({ closed: [], failed: [] });
    release();
    await refused;
    expect(t.counts.open).toBe(0);
    expect(t.counts.closeAll).toBe(0);
    expect((await t.demo.state()).session.state).toBe("none");
    await expect(t.demo.launch()).rejects.toThrow(/shutting down/);
    expect(t.counts.open).toBe(0);
  });
});

describe("an action under way", () => {
  it("counts the stream's messages while a close is in flight, and refuses a second action", async () => {
    const t = setup();
    await t.demo.launch();
    let release!: () => void;
    t.behave.holdClose = new Promise<void>((resolve) => (release = resolve));
    const closing = t.demo.close();
    await tick();
    t.inbox.push({ type: "account", address: AGENT_USDC });
    const state = await t.demo.state();
    expect(state).toMatchObject({ busy: "close", session: { state: "closing", frames: 1 } });
    await expect(t.demo.close()).rejects.toThrow(/close is already under way/);
    release();
    expect((await closing).session.state).toBe("closed");
  });

  it("refuses a second action while the open is in flight, and closes the session at shutdown", async () => {
    const t = setup();
    let release!: () => void;
    t.behave.hold = new Promise<void>((resolve) => (release = resolve));
    const launching = t.demo.launch();
    await tick();
    const busy = await t.demo.state();
    expect(busy).toMatchObject({ busy: "launch", session: { state: "opening" } });
    await expect(t.demo.topUp()).rejects.toThrow(/launch is already under way/);
    await expect(t.demo.launch()).rejects.toThrow(/launch is already under way/);
    // A session being opened counts as running: the shutdown closes it, and the open's end is waited for there.
    const leaving = t.demo.shutdown();
    release();
    await launching;
    expect(await leaving).toEqual({ closed: [SESSION], failed: [] });
    expect(t.counts.closeAll).toBe(1);
    expect(t.counts.open).toBe(1);
  });
});

describe("a chain that does not answer", () => {
  /** A short cap, so that a hung read is given up on quickly. */
  const CAP_MS = 40;
  /** A promise that settles when `release` is called, and the call. */
  const held = () => {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => (release = resolve));
    return { promise, release };
  };

  it("answers a state read within the cap while the close lookup hangs, asks the chain once, and shows what it found at the next read", async () => {
    const t = setup({ stateReadCapMs: CAP_MS });
    await t.demo.launch();
    t.advance(100_000);
    const lookup = held();
    t.behave.holdLookup = lookup.promise;
    const started = Date.now();
    expect((await t.demo.state()).session.state).toBe("open");
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(t.counts.lookups).toBe(1);
    // The lookup is still running: a read 4 s later gives up on it again, and starts no second one.
    t.advance(CLOSE_LOOKUP_EVERY_MS);
    expect((await t.demo.state()).session.state).toBe("open");
    expect(t.counts.lookups).toBe(1);
    // The chain answers while no one waits: the next read shows it, and the wallet's balance read after it.
    t.closes.set(SESSION, { signature: CLOSE_TX, at: t.paidUntil() + 1, paidUntil: t.paidUntil(), paid: "100000", refunded: "0" });
    t.setBalance(900_000n);
    lookup.release();
    await tick();
    await tick();
    const state = await t.demo.state();
    expect(state.session).toMatchObject({ state: "expired", paid: "100000", refunded: "0", links: { close: explorerTx(CLOSE_TX) } });
    expect(state.wallet.usdc).toBe("900000");
    expect(t.counts.lookups).toBe(1);
  }, 2_000);

  it("answers a state read within the cap while the balance read hangs, reads it once, and shows it at the next read", async () => {
    const t = setup({ stateReadCapMs: CAP_MS });
    const read = held();
    t.behave.holdBalance = read.promise;
    const started = Date.now();
    expect((await t.demo.state()).wallet).toEqual({ address: "AgentWallet" });
    expect(Date.now() - started).toBeLessThan(1_000);
    // Asked for again, and still running: the next read does not start another.
    expect((await t.demo.state({ refreshBalance: true })).wallet).toEqual({ address: "AgentWallet" });
    expect(t.counts.balances).toBe(1);
    read.release();
    await tick();
    expect((await t.demo.state()).wallet).toMatchObject({ usdc: "1000000", checkedAt: START_MS });
    expect(t.counts.balances).toBe(1);
  }, 2_000);

  it("keeps a balance read that answers late from replacing a newer one", async () => {
    const t = setup({ stateReadCapMs: CAP_MS });
    await t.demo.launch();
    const slow = held();
    t.behave.holdBalance = slow.promise;
    t.setBalance(1n);
    await t.demo.state({ refreshBalance: true });
    // An action ends and reads the balance again, which now answers at once.
    t.behave.holdBalance = undefined;
    t.setBalance(2n);
    expect((await t.demo.close()).wallet.usdc).toBe("2");
    slow.release();
    await tick();
    await tick();
    expect((await t.demo.state()).wallet.usdc).toBe("2");
  }, 2_000);

  it("applies a close lookup that answers late to the session it was made for only", async () => {
    const t = setup({ stateReadCapMs: CAP_MS });
    await t.demo.launch();
    t.advance(61_000);
    t.closeCodes.set(SESSION, 4410);
    const lookup = held();
    t.behave.holdLookup = lookup.promise;
    expect((await t.demo.state()).session.state).toBe("ended");
    // A new session opens meanwhile.
    t.behave.holdLookup = undefined;
    t.behave.sessionId = FEE_PAYER;
    await t.demo.launch();
    t.closes.set(SESSION, { signature: CLOSE_TX, at: t.paidUntil() - 139, paidUntil: t.paidUntil() - 100, paid: "61000", refunded: "39000" });
    lookup.release();
    await tick();
    await tick();
    const state = await t.demo.state();
    expect(state.session).toMatchObject({ state: "open", sessionId: FEE_PAYER });
    expect(state.session.links.close).toBeUndefined();
    expect(state.session.paid).toBeUndefined();
  }, 2_000);

  it("gives the owner time to answer a forwarded read", () => {
    expect(STATE_READ_CAP_MS).toBe(5_000);
    // Two RPC requests of up to 10 s each could not be waited for within a forwarded read's 15 s.
    expect(STATE_READ_CAP_MS).toBeLessThan(READ_CALL_TIMEOUT_MS);
  });
});
