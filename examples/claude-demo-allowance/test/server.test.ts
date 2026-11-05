import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";
import type { CallHandler } from "../../claude-demo/src/owner.js";
import { TOOL } from "../../claude-demo/src/state.js";
import { ALLOWANCE_TOOL, PANEL_URI } from "../src/names.js";
import { createAllowanceServer, SERVER_INFO } from "../src/server.js";

const HTML = "<!doctype html><title>panel</title>";

describe("the allowance demo's MCP server", () => {
  let client: Client | undefined;
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  afterEach(async () => {
    await client?.close();
    client = undefined;
    calls.length = 0;
  });

  async function connect(call: CallHandler): Promise<Client> {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await createAllowanceServer({ html: HTML, call, log: () => {} }).connect(serverTransport);
    client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(clientTransport);
    return client;
  }
  const answering: CallHandler = async (name, args) => {
    calls.push({ name, args });
    return { content: [{ type: "text", text: name }] };
  };

  it("names itself and tells the model the sessions are pulled from the owner's allowance", async () => {
    const c = await connect(answering);
    expect(SERVER_INFO.name).toBe("stint-claude-demo-allowance");
    expect(c.getServerVersion()?.name).toBe("stint-claude-demo-allowance");
    expect(c.getInstructions()).toMatch(/pulled from the owner's USDC account/);
    expect(c.getInstructions()).toMatch(/Refused on-chain/);
    expect(c.getInstructions()).toContain("The state's ledger lists every movement, those made with the panel's buttons included.");
  });

  it("offers its own tool names, and runs each as the first demo's tool", async () => {
    const c = await connect(answering);
    const { tools } = await c.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(Object.values(ALLOWANCE_TOOL).sort());
    expect(tools.find((tool) => tool.name === ALLOWANCE_TOOL.launch)?.description).toContain(
      `Open the panel first with ${ALLOWANCE_TOOL.demo}: the panel shows the session, and this tool does not open it.`,
    );
    expect(tools.find((tool) => tool.name === ALLOWANCE_TOOL.demo)?._meta).toMatchObject({ ui: { resourceUri: PANEL_URI } });
    expect(tools.find((tool) => tool.name === ALLOWANCE_TOOL.state)?._meta).toMatchObject({ ui: { visibility: ["app"] } });
    await c.callTool({ name: ALLOWANCE_TOOL.demo, arguments: {} });
    await c.callTool({ name: ALLOWANCE_TOOL.state, arguments: { refreshBalance: true } });
    await c.callTool({ name: ALLOWANCE_TOOL.launch, arguments: {} });
    await c.callTool({ name: ALLOWANCE_TOOL.topUp, arguments: {} });
    await c.callTool({ name: ALLOWANCE_TOOL.close, arguments: {} });
    expect(calls).toEqual([
      { name: TOOL.demo, args: {} },
      { name: TOOL.state, args: { refreshBalance: true } },
      { name: TOOL.launch, args: {} },
      { name: TOOL.topUp, args: {} },
      { name: TOOL.close, args: {} },
    ]);
  });

  it("serves the panel at its own URI", async () => {
    const c = await connect(answering);
    const resource = await c.readResource({ uri: PANEL_URI });
    expect((resource.contents[0] as { text: string }).text).toBe(HTML);
  });

  it("answers a call that fails as a tool error, each URL in it cut to its host", async () => {
    const c = await connect(async () => {
      throw new Error("no answer from https://node.example/secret-key");
    });
    const result = await c.callTool({ name: ALLOWANCE_TOOL.launch, arguments: {} });
    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0]!.text).not.toContain("secret-key");
  });
});
