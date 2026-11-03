import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";
import type { CallHandler } from "../src/owner.js";
import { createDemoServer } from "../src/server.js";
import { PANEL_URI, TOOL } from "../src/state.js";

const HTML = "<!doctype html><title>panel</title>";

describe("the demo's MCP server", () => {
  let client: Client | undefined;
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const lines: string[] = [];
  const answering: CallHandler = async (name, args) => {
    calls.push({ name, args });
    return { content: [{ type: "text", text: name }], structuredContent: { name } };
  };
  /** What the server's tools call: a test swaps it between two calls, as a router changes between two of its states. */
  let call: CallHandler = answering;
  afterEach(async () => {
    await client?.close();
    client = undefined;
    calls.length = 0;
    lines.length = 0;
    call = answering;
  });

  async function connect(handler: CallHandler = answering): Promise<Client> {
    call = handler;
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await createDemoServer({ html: HTML, call: (name, args) => call(name, args), log: (line) => lines.push(line) }).connect(serverTransport);
    client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(clientTransport);
    return client;
  }
  const text = (result: { content?: unknown }) => (result.content as { text: string }[])[0]!.text;

  it("declares the MCP Apps extension, and tells the model how the panel and the tools share one session", async () => {
    const c = await connect();
    expect(c.getServerCapabilities()?.extensions).toEqual({ "io.modelcontextprotocol/ui": {} });
    expect(c.getInstructions()).toMatch(/stint_demo shows the panel/);
    expect(c.getInstructions()).toMatch(/stint_demo_launch, stint_demo_top_up and stint_demo_close/);
    expect(c.getInstructions()).toMatch(/do not poll for it/);
  });

  it("lists the five tools, each with who may call it, and the panel the first one shows", async () => {
    const { tools } = await (await connect()).listTools();
    const meta = Object.fromEntries(tools.map((tool) => [tool.name, tool._meta]));
    expect(Object.keys(meta).sort()).toEqual(Object.values(TOOL).sort());
    expect(meta[TOOL.demo]).toMatchObject({ ui: { resourceUri: PANEL_URI }, "ui/resourceUri": PANEL_URI });
    expect(meta[TOOL.state]).toEqual({ ui: { visibility: ["app"] } });
    for (const name of [TOOL.launch, TOOL.topUp, TOOL.close]) expect(meta[name]).toEqual({ ui: { visibility: ["model", "app"] } });
  });

  it("serves the panel as an MCP App resource", async () => {
    const c = await connect();
    const { resources } = await c.listResources();
    expect(resources.map((resource) => resource.uri)).toContain(PANEL_URI);
    const { contents } = await c.readResource({ uri: PANEL_URI });
    expect(contents).toHaveLength(1);
    expect(contents[0]).toMatchObject({ uri: PANEL_URI, mimeType: "text/html;profile=mcp-app", text: HTML });
  });

  it("hands every call to the handler, with its arguments", async () => {
    const c = await connect();
    const result = await c.callTool({ name: TOOL.state, arguments: { refreshBalance: true } });
    await c.callTool({ name: TOOL.launch, arguments: {} });
    await c.callTool({ name: TOOL.demo, arguments: {} });
    expect(result.structuredContent).toEqual({ name: TOOL.state });
    expect(calls).toEqual([
      { name: TOOL.state, args: { refreshBalance: true } },
      { name: TOOL.launch, args: {} },
      { name: TOOL.demo, args: {} },
    ]);
  });

  it("hands every tool to the handler, the panel's and the model's alike", async () => {
    const c = await connect();
    for (const name of Object.values(TOOL)) await c.callTool({ name, arguments: {} });
    expect(calls.map((entry) => entry.name)).toEqual(Object.values(TOOL));
  });

  it("answers a handler that rejects as a tool error with its message, for each tool, and goes on serving", async () => {
    const c = await connect(async () => {
      throw new Error("This copy of the server has shut down");
    });
    for (const name of Object.values(TOOL)) {
      const result = await c.callTool({ name, arguments: {} });
      expect(result.isError).toBe(true);
      expect(text(result)).toBe("This copy of the server has shut down");
    }
    expect(lines).toHaveLength(Object.values(TOOL).length);
    call = answering;
    const result = await c.callTool({ name: TOOL.demo, arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ name: TOOL.demo });
  });

  it("cuts every URL in a rejection to its host, in the result and in the log", async () => {
    const c = await connect(async () => {
      throw new Error("fetch https://owner.example/path?token=secret-key failed");
    });
    const result = await c.callTool({ name: TOOL.launch, arguments: {} });
    expect(text(result)).toBe("fetch https://owner.example failed");
    expect(JSON.stringify(result)).not.toContain("secret-key");
    expect(lines.join("\n")).not.toContain("secret-key");
    expect(lines).toEqual([`${TOOL.launch} failed: fetch https://owner.example failed`]);
  });

  it("answers a handler that rejects with something that is not an Error as a tool error", async () => {
    const c = await connect(async () => {
      throw "plain text";
    });
    const result = await c.callTool({ name: TOOL.close, arguments: {} });
    expect(result.isError).toBe(true);
    expect(text(result)).toBe("plain text");
  });

  it("refuses arguments the schema does not allow, before the handler runs", async () => {
    const c = await connect();
    const wrongType = await c.callTool({ name: TOOL.state, arguments: { refreshBalance: "yes" } });
    expect(wrongType.isError).toBe(true);
    expect(calls).toEqual([]);
  });

  it("refuses a tool it does not list, with the protocol's own error, before the handler runs", async () => {
    const c = await connect();
    await expect(c.callTool({ name: "stint_other", arguments: {} })).rejects.toThrow(/Tool stint_other not found/);
    expect(calls).toEqual([]);
  });
});
