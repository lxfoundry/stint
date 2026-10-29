import type { Tool } from "@lxfoundry/stint-client";
import { McpServer, fromJsonSchema } from "@modelcontextprotocol/server";

export const SERVER_INFO = { name: "stint", version: "0.1.0" } as const;

/**
 * Serves the session tools over MCP (spec §9.6). The SDK checks every call's arguments against the
 * tool's JSON Schema before the tool runs; a failure a tool throws reaches the model as a tool
 * error with its message, so a policy refusal is readable.
 */
export function createMcpServer(tools: Readonly<Record<string, Tool<any, unknown>>>): McpServer {
  const server = new McpServer(SERVER_INFO);
  for (const tool of Object.values(tools)) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: fromJsonSchema<Record<string, unknown>>(tool.inputSchema as never) },
      async (input) => ({ content: [{ type: "text" as const, text: JSON.stringify(await tool.run(input)) }] }),
    );
  }
  return server;
}
