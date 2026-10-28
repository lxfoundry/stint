import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { ToolError, type Tool } from "@lxfoundry/stint-client";
import { afterEach, describe, expect, it } from "vitest";
import { createMcpServer } from "../src/index.js";

const strict = (properties: Record<string, unknown>, required: string[]) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

const calls: unknown[] = [];
const tools: Record<string, Tool<any, unknown>> = {
  echo: {
    name: "echo",
    description: "Returns what it is given, with a count",
    inputSchema: strict({ text: { type: "string" }, times: { type: "integer", minimum: 1 } }, ["text"]),
    async run(input: { text: string; times?: number }) {
      calls.push(input);
      return { echoed: input.text.repeat(input.times ?? 1), count: BigInt(input.times ?? 1).toString() };
    },
  },
  refuse: {
    name: "refuse",
    description: "Always refuses, as a policy would",
    inputSchema: strict({}, []),
    async run() {
      throw new ToolError("Policy refuses the offer: rate 5 exceeds maxRate 1");
    },
  },
};

describe("the session tools over MCP", () => {
  let client: Client | undefined;

  afterEach(async () => {
    await client?.close();
    calls.length = 0;
  });

  async function connect(): Promise<Client> {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await createMcpServer(tools).connect(serverTransport);
    client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(clientTransport);
    return client;
  }
  const text = (result: { content?: unknown }) => (result.content as { text: string }[])[0]!.text;

  it("lists every tool with its description and its strict schema", async () => {
    const { tools: listed } = await (await connect()).listTools();
    expect(listed.map((tool) => tool.name).sort()).toEqual(["echo", "refuse"]);
    const echo = listed.find((tool) => tool.name === "echo")!;
    expect(echo.description).toBe("Returns what it is given, with a count");
    expect(echo.inputSchema).toMatchObject({ type: "object", required: ["text"], additionalProperties: false });
  });

  it("returns a tool's output as JSON text", async () => {
    const result = await (await connect()).callTool({ name: "echo", arguments: { text: "ab", times: 2 } });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(text(result))).toEqual({ echoed: "abab", count: "2" });
  });

  it("returns a thrown failure as a readable tool error", async () => {
    const result = await (await connect()).callTool({ name: "refuse", arguments: {} });
    expect(result.isError).toBe(true);
    expect(text(result)).toBe("Policy refuses the offer: rate 5 exceeds maxRate 1");
  });

  it("refuses arguments the schema does not allow, before the tool runs", async () => {
    const c = await connect();
    const missing = await c.callTool({ name: "echo", arguments: {} });
    const extra = await c.callTool({ name: "echo", arguments: { text: "a", surprise: 1 } });
    const wrongType = await c.callTool({ name: "echo", arguments: { text: "a", times: "2" } });
    const belowMinimum = await c.callTool({ name: "echo", arguments: { text: "a", times: 0 } });
    for (const result of [missing, extra, wrongType, belowMinimum]) expect(result.isError).toBe(true);
    expect(text(missing)).toMatch(/required property 'text'/);
    expect(text(extra)).toMatch(/must NOT have additional properties/);
    expect(calls).toEqual([]);
  });
});
