import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createSessionTools, createStintClient, type SessionTools } from "@lxfoundry/stint-client";
import {
  DEMO_POLICY,
  TOOL,
  createCallHandler,
  createDemo,
  createDemoServer,
  createRpcDemoChain,
  recordExchanges,
  type DemoState,
} from "@lxfoundry/stint-claude-demo";
import { findClose, type Buyer } from "@lxfoundry/stint-conformance";
import { CloseKind, fetchMaybeSession } from "@lxfoundry/stint-program-client";
import type { Address, Signature } from "@solana/kit";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { startLocalStack, type LocalStack } from "../src/targets/local.js";

// The Claude Desktop example (`examples/claude-demo`) as the copy that holds its state runs it, with no Claude: its MCP
// server over an in-memory transport, its session on the client's session tools with the example's own policy, its
// x402 exchange recorded from the client's requests to the gate by its wrapper around `fetch`, and its reads of the
// chain on the local node. The local stack's longest session is 120 s: a launch of 20 s leaves room for the example's
// top-up of 100 s.

/** The node is ours: a read right after a write is not answered from behind, but a close lands a moment after it is sent. */
const READ_RETRY = { attempts: 20, delayMs: 100 };
const LAUNCH_SECONDS = 20;

interface Result {
  readonly isError: boolean;
  readonly text: string;
  readonly state: DemoState;
}

interface RunningDemo {
  readonly buyer: Buyer;
  /** The client's session tools the demo runs on. */
  readonly tools: SessionTools;
  call(name: string, args?: Record<string, unknown>): Promise<Result>;
  stop(): Promise<void>;
}

/** The signature an Explorer link of the example names. */
const signatureIn = (link: string | undefined): Signature => {
  const match = /\/tx\/(\w+)\?/.exec(link ?? "");
  if (!match) throw new Error(`no transaction in ${link}`);
  return match[1] as Signature;
};

describe("the Claude Desktop example on the local stack", () => {
  let stack: LocalStack;
  const realFetch = globalThis.fetch;
  let running: RunningDemo | undefined;

  beforeAll(async () => {
    stack = await startLocalStack();
  });

  afterEach(async () => {
    try {
      await running?.stop();
    } finally {
      running = undefined;
      // A start that failed after it wrapped `fetch` left no running demo to restore it.
      globalThis.fetch = realFetch;
    }
  });

  afterAll(async () => {
    globalThis.fetch = realFetch;
    await stack?.stop();
  });

  /** The example for a new agent wallet that holds 1 USDC and no SOL, as the example's own wallet does. */
  async function startDemo(launchSeconds = LAUNCH_SECONDS): Promise<RunningDemo> {
    const buyer = await stack.context().newBuyer(1_000_000n);
    const tools: SessionTools = createSessionTools(createStintClient({ signer: buyer.signer, policy: DEMO_POLICY }));
    const chain = await createRpcDemoChain(stack.network.rpcUrl, buyer.signer.address);
    const gateUrl = stack.stream.url;
    const demo = createDemo({ address: buyer.signer.address, gateUrl, tools, chain, launchSeconds, log: () => {} });
    // Before the client sends anything: it calls the global `fetch` at each request.
    globalThis.fetch = recordExchanges(gateUrl, demo.sink, realFetch);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await createDemoServer({ html: "<!doctype html><title>panel</title>", call: createCallHandler(demo, () => {}), log: () => {} }).connect(serverTransport);
    const client = new Client({ name: "e2e", version: "1.0.0" });
    await client.connect(clientTransport);
    running = {
      buyer,
      tools,
      async call(name, args = {}) {
        const result = await client.callTool({ name, arguments: args });
        return { isError: result.isError === true, text: (result.content as { text: string }[])[0]!.text, state: result.structuredContent as unknown as DemoState };
      },
      async stop() {
        await demo.shutdown();
        await client.close();
        globalThis.fetch = realFetch;
      },
    };
    return running;
  }

  /** The agent's USDC, as the node holds it. */
  const usdcOf = async (buyer: Buyer) =>
    (await stack.network.rpc.getTokenAccountBalance(buyer.usdcAccount as Address, { commitment: "confirmed" }).send()).value.amount;

  it("launches through its tool with the x402 exchange recorded from the client's own requests, and closes early with the refund the chain shows", async () => {
    const demo = await startDemo();

    const launched = await demo.call(TOOL.launch);

    expect(launched.isError, launched.text).toBe(false);
    const { session, exchange } = launched.state;
    expect(session).toMatchObject({ state: "open", deposited: "20000", rate: "1000", maxSeconds: 120 });
    expect(exchange.last?.action).toBe("launch");
    const rows = exchange.last!.rows;
    expect(rows.map(({ kind, label }) => [kind, label])).toEqual([
      ["request", `POST /sessions?seconds=${LAUNCH_SECONDS}`],
      ["payment-required", "402 Payment Required"],
      ["payment", "PAYMENT-SIGNATURE"],
      ["settled", "201 Created"],
    ]);
    expect(rows[1]!.detail).toMatch(new RegExp(`^elapsed · 0\\.001 USDC/s · ${LAUNCH_SECONDS} s · min 5 s · max 120 s · seller `));
    expect(rows[2]!.detail).toBe("one transaction: 0.020 USDC → vault + open");
    // The settled row names the open's transaction, which the chain confirms, and the session it opened holds the deposit.
    const open = signatureIn(rows[3]!.link);
    expect(session.links.open).toBe(rows[3]!.link);
    const [status] = (await stack.network.rpc.getSignatureStatuses([open]).send()).value;
    expect(status?.err).toBeNull();
    const stored = await fetchMaybeSession(stack.network.rpc, session.sessionId as Address, { commitment: "confirmed" });
    expect(stored.exists && stored.data.deposited).toBe(20_000n);

    const closed = await demo.call(TOOL.close);

    expect(closed.isError, closed.text).toBe(false);
    const ended = closed.state.session;
    expect(ended.state).toBe("closed");
    expect(BigInt(ended.paid!) + BigInt(ended.refunded!)).toBe(20_000n);
    expect(BigInt(ended.refunded!)).toBeGreaterThan(0n);
    // The client closes through the gate's close route: the gate's receiver authorizer signs the close.
    const found = await findClose(stack.network.rpc, session.sessionId as Address, READ_RETRY);
    expect(found?.event).toMatchObject({ kind: CloseKind.Standard, closedBy: stack.keys.receiverAuthorizer.signer.address, refunded: BigInt(ended.refunded!) });
    expect(signatureIn(ended.links.close)).toBe(found!.signature);
    // The wallet's balance is read again after the action, from the node.
    const seen = await demo.call(TOOL.state, { refreshBalance: true });
    expect(seen.state.wallet.usdc).toBe(await usdcOf(demo.buyer));
    expect(seen.state.wallet.usdc).toBe((1_000_000n - BigInt(ended.paid!)).toString());
  });

  it("tops the session up through its tool, with the top-up's exchange recorded, and refuses a top-up past the seller's longest session", async () => {
    const demo = await startDemo();
    const launched = await demo.call(TOOL.launch);
    expect(launched.isError, launched.text).toBe(false);
    const id = launched.state.session.sessionId!;

    const topped = await demo.call(TOOL.topUp);

    expect(topped.isError, topped.text).toBe(false);
    expect(topped.state.session).toMatchObject({ state: "open", deposited: "120000", paidUntil: launched.state.session.paidUntil! + 100 });
    expect(topped.state.exchange.last?.action).toBe("top-up");
    const rows = topped.state.exchange.last!.rows;
    expect(rows.map(({ kind, label }) => [kind, label])).toEqual([
      ["request", `POST /sessions/${id}/top-up?seconds=100`],
      ["payment-required", "402 Payment Required"],
      ["payment", "PAYMENT-SIGNATURE"],
      ["settled", "200 OK"],
    ]);
    expect(rows[2]!.detail).toBe("one transaction: 0.100 USDC → vault + top-up");
    expect(topped.state.session.links.topUps).toEqual([rows[3]!.link]);
    const stored = await fetchMaybeSession(stack.network.rpc, id as Address, { commitment: "confirmed" });
    expect(stored.exists && stored.data.deposited).toBe(120_000n);

    // 120 s is the local seller's longest session: no room is left for 100 s more.
    const refused = await demo.call(TOOL.topUp);
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/at most 120 s/);
    expect((await demo.call(TOOL.close)).isError).toBe(false);
  });

  it("ends a session left to its paid time, its stream connection closed by the gate (4402), the seller paid in full and the close found on the chain", async () => {
    const demo = await startDemo(6);
    const launched = await demo.call(TOOL.launch);
    expect(launched.isError, launched.text).toBe(false);
    const id = launched.state.session.sessionId!;

    // What the panel reads every 2 s, until the gate has closed the connection at the paid time and the close is found.
    let state: DemoState | undefined;
    await vi.waitFor(
      async () => {
        state = (await demo.call(TOOL.state)).state;
        expect(state.session.state).toBe("expired");
        expect(state.session.links.close).toBeDefined();
      },
      { timeout: 45_000, interval: 1_000 },
    );

    expect(state!.session).toMatchObject({ paid: "6000", refunded: "0" });
    // Either the gate's close of the connection at the paid time (4402) is seen first, or the close on the chain, found by
    // a state read after paid_until, is: then no close code is kept.
    expect([4402, undefined]).toContain(state!.session.closeCode);
    // The demo opened the session's stream connection (the subscription to the agent's USDC account), and the gate closed
    // it at the paid time: the client keeps that close code whichever path the demo took.
    await vi.waitFor(() => expect(demo.tools.closeCode(id)).toBe(4402), { timeout: 10_000, interval: 200 });
    const found = await findClose(stack.network.rpc, id as Address, READ_RETRY);
    expect(signatureIn(state!.session.links.close)).toBe(found!.signature);
    // At the paid time, whichever of the gate and the sweeper closed it.
    expect(found!.event.kind).toBe(CloseKind.AtExpiry);
    expect(found!.event.claimed + found!.event.owed).toBe(6_000n);
    expect(found!.event.refunded + found!.event.redirected).toBe(0n);
  }, 60_000);
});
