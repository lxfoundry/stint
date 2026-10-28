import Anthropic from "@anthropic-ai/sdk";
import { ToolError, type SessionTools } from "@lxfoundry/stint-client";
import { describe, expect, it } from "vitest";
import { FALLBACK_MODEL, MODEL, runAgent } from "../src/index.js";

const message = (content: unknown[], stopReason: string, extra: Record<string, unknown> = {}) => ({
  id: "msg_test",
  type: "message",
  role: "assistant",
  model: MODEL,
  content,
  stop_reason: stopReason,
  stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 },
  ...extra,
});
const toolUse = (id: string, name: string, input: unknown) => ({ type: "tool_use", id, name, input });
const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

interface Sent {
  readonly body: Record<string, any>;
  readonly headers: Headers;
}

/** A client whose requests are answered in order by `responses`, and recorded. */
function mockedClient(responses: unknown[]): { client: Anthropic; sent: Sent[] } {
  const sent: Sent[] = [];
  const fetch = async (_url: unknown, init?: RequestInit) => {
    sent.push({ body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) });
    const next = responses.shift();
    if (next === undefined) throw new Error("no more mocked responses");
    return reply(next);
  };
  return { client: new Anthropic({ apiKey: "test-key", fetch: fetch as typeof globalThis.fetch, maxRetries: 0 }), sent };
}

/** The five session tools, recording each call; `failing` names a tool that throws a policy refusal. */
function fakeTools(calls: string[], failing?: string): SessionTools {
  const tool = (name: string, output: unknown) => ({
    name,
    description: `The ${name} tool, described at length for the model`,
    inputSchema: { type: "object", properties: {}, additionalProperties: true },
    async run() {
      calls.push(name);
      if (name === failing) throw new ToolError("Policy refuses the offer: rate 5 exceeds maxRate 1");
      return output;
    },
  });
  return {
    tools: {
      stint_open_session: tool("stint_open_session", { sessionId: "S1", paidUntil: 1, cost: "120000", remainingBudget: "880000" }),
      stint_session_status: tool("stint_session_status", { paidUntil: 1, timeLeftSeconds: 100, spent: "5000", refundable: "115000" }),
      stint_send: tool("stint_send", { ok: true }),
      stint_receive: tool("stint_receive", { messages: [{ type: "account", slot: "42" }], timedOut: false }),
      stint_close_session: tool("stint_close_session", { paid: "5000", refunded: "115000", transaction: "sig" }),
    } as never,
    closeCode: () => undefined,
    closeAll: async () => {
      calls.push("closeAll");
      return { closed: [], failed: [] };
    },
  };
}

describe("runAgent", () => {
  it("lets the model use the tools in turn, asks for low effort and a fallback, and ends with the model's answer", async () => {
    const calls: string[] = [];
    const { client, sent } = mockedClient([
      message([toolUse("t1", "stint_open_session", { url: "http://gate", seconds: 120, reason: "watch" })], "tool_use"),
      message([toolUse("t2", "stint_receive", { sessionId: "S1", timeoutSeconds: 30 })], "tool_use"),
      message([toolUse("t3", "stint_close_session", { sessionId: "S1" })], "tool_use"),
      message([{ type: "text", text: "Received 250000 at slot 42." }], "end_turn"),
    ]);

    const result = await runAgent({ client, tools: fakeTools(calls), gateUrl: "http://gate", account: "WATCHED" });

    expect(result).toEqual({ outcome: "answered", text: "Received 250000 at slot 42." });
    expect(calls).toEqual(["stint_open_session", "stint_receive", "stint_close_session", "closeAll"]);
    const first = sent[0]!;
    expect(first.body.model).toBe(MODEL);
    expect(first.body.output_config).toMatchObject({ effort: "low" });
    expect(first.body.tool_choice).toMatchObject({ type: "auto" });
    expect(first.body.fallbacks).toEqual([expect.objectContaining({ model: FALLBACK_MODEL })]);
    expect(first.headers.get("anthropic-beta")).toContain("server-side-fallback-2026-07-01");
    expect(first.body.tools.map((tool: { name: string }) => tool.name).sort()).toEqual([
      "stint_close_session",
      "stint_open_session",
      "stint_receive",
      "stint_send",
      "stint_session_status",
    ]);
    expect(JSON.stringify(first.body.system)).toMatch(/Open a session first/);
    expect(JSON.stringify(first.body.messages)).toMatch(/WATCHED/);
  });

  it("gives a tool's failure back to the model as an error it can read", async () => {
    const calls: string[] = [];
    const { client, sent } = mockedClient([
      message([toolUse("t1", "stint_open_session", { url: "http://gate", reason: "watch" })], "tool_use"),
      message([{ type: "text", text: "My policy refuses this seller." }], "end_turn"),
    ]);

    const result = await runAgent({ client, tools: fakeTools(calls, "stint_open_session"), gateUrl: "http://gate", account: "WATCHED" });

    expect(result.outcome).toBe("answered");
    const toolResult = JSON.stringify(sent[1]!.body.messages);
    expect(toolResult).toMatch(/Policy refuses the offer: rate 5 exceeds maxRate 1/);
    expect(toolResult).toMatch(/"is_error":true/);
  });

  it("reports a refusal that the fallback did not resolve, and closes every session", async () => {
    const calls: string[] = [];
    const { client } = mockedClient([
      message([], "refusal", { stop_details: { type: "refusal", category: null, explanation: "The request was declined." } }),
    ]);

    const result = await runAgent({ client, tools: fakeTools(calls), gateUrl: "http://gate", account: "WATCHED" });

    expect(result.outcome).toBe("refused");
    expect(result.text).toMatch(/declined/);
    expect(calls).toEqual(["closeAll"]);
  });

  it("closes every session even when the API fails", async () => {
    const calls: string[] = [];
    const client = new Anthropic({
      apiKey: "test-key",
      fetch: (async () => new Response("overloaded", { status: 529 })) as typeof globalThis.fetch,
      maxRetries: 0,
    });

    await expect(runAgent({ client, tools: fakeTools(calls), gateUrl: "http://gate", account: "WATCHED" })).rejects.toThrow();
    expect(calls).toEqual(["closeAll"]);
  });
});
