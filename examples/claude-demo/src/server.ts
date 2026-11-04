import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { EXTENSION_ID, RESOURCE_MIME_TYPE, registerAppResource, registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { redactUrls } from "@lxfoundry/stint-x402";
import * as z from "zod";
import type { CallHandler } from "./owner.js";
import { PANEL_URI, TOOL } from "./state.js";
import { INSTRUCTIONS, TOOL_DESCRIPTIONS } from "./tools.js";

export const SERVER_INFO = { name: "stint-claude-demo", version: "0.1.0" } as const;

export interface DemoServerOptions {
  readonly html: string;
  readonly call: CallHandler;
  /** Where a call that `call` rejects is reported, in one line. Default: stderr, as stdout carries the protocol. */
  readonly log?: (line: string) => void;
}

function toStderr(line: string): void {
  process.stderr.write(`stint-claude-demo: ${line}\n`);
}

/**
 * The MCP server. `serveStdio` may call its factory more than once (a protocol probe), so this holds no state: every
 * call goes to `call`. `stint_demo` shows the panel; `stint_demo_state` is for the panel only; the three actions are
 * for the model and the panel alike. Every schema is strict: an argument a tool does not name is refused, as a tool
 * error that names it, never dropped (a launch passed a length would otherwise open the usual session without a word).
 * A call that `call` rejects (a router that has shut down, an owner that cannot be reached) reaches the model as a
 * tool error with its message, each URL in it cut to its host.
 */
export function createDemoServer(options: DemoServerOptions): McpServer {
  const report = options.log ?? toStderr;
  async function run(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    try {
      return await options.call(name, args);
    } catch (error) {
      const message = redactUrls(error instanceof Error ? error.message : String(error));
      try {
        report(`${name} failed: ${message.replace(/\s+/g, " ").trim()}`);
      } catch {
        // Nothing is left to report to.
      }
      return { isError: true, content: [{ type: "text", text: message }] };
    }
  }

  const server = new McpServer(SERVER_INFO, { capabilities: { extensions: { [EXTENSION_ID]: {} } }, instructions: INSTRUCTIONS });
  registerAppTool(
    server,
    TOOL.demo,
    { description: TOOL_DESCRIPTIONS[TOOL.demo], inputSchema: z.strictObject({}), _meta: { ui: { resourceUri: PANEL_URI } } },
    async () => run(TOOL.demo, {}),
  );
  registerAppResource(server, "Stint demo panel", PANEL_URI, { description: "The Stint demo's panel: the wallet, the session, the x402 exchange" }, async () => ({
    contents: [{ uri: PANEL_URI, mimeType: RESOURCE_MIME_TYPE, text: options.html }],
  }));
  server.registerTool(
    TOOL.state,
    {
      description: TOOL_DESCRIPTIONS[TOOL.state],
      inputSchema: z.strictObject({ refreshBalance: z.boolean().optional() }),
      _meta: { ui: { visibility: ["app"] } },
    },
    async (args) => run(TOOL.state, args),
  );
  for (const name of [TOOL.launch, TOOL.topUp, TOOL.close]) {
    server.registerTool(
      name,
      { description: TOOL_DESCRIPTIONS[name], inputSchema: z.strictObject({}), _meta: { ui: { visibility: ["model", "app"] } } },
      async () => run(name, {}),
    );
  }
  return server;
}
