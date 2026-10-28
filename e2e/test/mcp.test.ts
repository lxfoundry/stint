import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createSessionTools, createStintClient } from "@lxfoundry/stint-client";
import { createMcpServer } from "@lxfoundry/stint-mcp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newBuyer } from "../src/fixtures/buyers.js";
import { startLocalStack, type LocalStack } from "../src/targets/local.js";

describe("the MCP server on the local stack", () => {
  let stack: LocalStack;

  beforeAll(async () => {
    stack = await startLocalStack();
  });

  afterAll(async () => {
    await stack?.stop();
  });

  it("serves a whole session through the protocol, and reports a refusal as a readable error", async () => {
    const buyer = await newBuyer(stack.network.rpc, stack.keys.mintAuthority.signer, 1_000_000n);
    const { tools, closeAll } = createSessionTools(
      createStintClient({
        signer: buyer.signer,
        policy: { maxRate: 10_000n, maxPerSession: 1_000_000n, budget: { amount: 1_000_000n, periodSeconds: 3_600 } },
      }),
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await createMcpServer(tools).connect(serverTransport);
    const client = new Client({ name: "e2e", version: "1.0.0" });
    await client.connect(clientTransport);
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      const text = (result.content as { text: string }[])[0]!.text;
      return { isError: result.isError === true, text, json: result.isError ? undefined : JSON.parse(text) };
    };

    const opened = await call("stint_open_session", { url: stack.stream.url, seconds: 30, reason: "mcp end-to-end test" });
    expect(opened.isError, opened.text).toBe(false);
    const sessionId: string = opened.json.sessionId;

    const status = await call("stint_session_status", { sessionId });
    expect(status.isError, status.text).toBe(false);
    expect(status.json.timeLeftSeconds).toBeGreaterThan(0);
    expect(BigInt(status.json.spent) + BigInt(status.json.refundable)).toBe(30_000n);

    const sent = await call("stint_send", { sessionId, message: { op: "subscribe", accounts: [buyer.usdcAccount] } });
    expect(sent.json).toEqual({ ok: true });

    // A duration the seller does not sell is refused by the gate: the model reads why.
    const refused = await call("stint_open_session", { url: stack.stream.url, seconds: 100_000, reason: "too long" });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/invalid_duration/);
    // (Before `closeAll`: once it has run, no session can be opened.)

    const closed = await call("stint_close_session", { sessionId });
    expect(closed.isError, closed.text).toBe(false);
    expect(BigInt(closed.json.paid) + BigInt(closed.json.refunded)).toBe(30_000n);
    expect(await closeAll()).toEqual({ closed: [], failed: [] });
    await client.close();
  });
});
