import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { EXTENSION_ID, RESOURCE_MIME_TYPE, registerAppResource, registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { TOP_UP_MARGIN_SECONDS, redactUrls } from "@lxfoundry/stint-x402";
import * as z from "zod";
import { formatUsdc } from "../../claude-demo/app/model.js";
import type { CallHandler } from "../../claude-demo/src/owner.js";
import { LAUNCH_AMOUNT, LAUNCH_SECONDS, TOP_UP_SECONDS } from "../../claude-demo/src/state.js";
import { ALLOWANCE_TOOL, PANEL_URI, TO_HANDLER, type AllowanceToolName } from "./names.js";

export const SERVER_INFO = { name: "stint-claude-demo-allowance", version: "0.1.0" } as const;

/** As the first demo's: the facilitator's margin and 3 s more. */
const TOP_UP_REFUSED_WITHIN_SECONDS = TOP_UP_MARGIN_SECONDS + 3;

export const TOOL_DESCRIPTIONS: Readonly<Record<AllowanceToolName, string>> = {
  [ALLOWANCE_TOOL.demo]:
    "Shows the Stint allowance demo panel and returns the demo's state, with the owner's allowance. Call it when the person asks to start, open or see the Stint allowance demo.",
  [ALLOWANCE_TOOL.state]:
    "The demo's state, for the panel: the owner's account, the allowance, the session, the x402 exchange. Set refreshBalance to read the owner's USDC again.",
  [ALLOWANCE_TOOL.launch]: `Opens a ${LAUNCH_SECONDS} s Stint session at the demo's gate, paid ${formatUsdc(LAUNCH_AMOUNT)} on devnet over x402, pulled from the owner's allowance on the Solana Foundation's Subscriptions & Allowances program into the session's escrow. The agent's key holds nothing. Past the allowance's cap for the period, the chain refuses the payment. Open the panel first with ${ALLOWANCE_TOOL.demo}: the panel shows the session, and this tool does not open it.`,
  [ALLOWANCE_TOOL.topUp]: `Buys ${TOP_UP_SECONDS} s more on the running session, pulled from the owner's allowance like the launch. Refused when ${TOP_UP_REFUSED_WITHIN_SECONDS} s or less of paid time is left, when ${TOP_UP_SECONDS} s more would pass the seller's longest session, and by the chain past the allowance's cap.`,
  [ALLOWANCE_TOOL.close]:
    "Closes the running session now: the seller is paid for the time used, and the rest of the deposit is refunded to the owner's account. A refund does not restore the allowance.",
};

/** What the model is told about the server (MCP `instructions`). */
export const INSTRUCTIONS = [
  "This server shows a Stint session in a panel, funded by an allowance: an owner granted this agent a cap per period on the Solana Foundation's Subscriptions & Allowances program, and every launch and top-up is pulled from the owner's USDC account. The agent's own key holds nothing, and it cannot raise the allowance.",
  `${ALLOWANCE_TOOL.demo} shows the panel: call it when the person asks to start or see the Stint allowance demo.`,
  `The panel's buttons and the tools ${ALLOWANCE_TOOL.launch}, ${ALLOWANCE_TOOL.topUp} and ${ALLOWANCE_TOOL.close} act on the same session, so a result saying that a session is already running, is closed or has ended may mean that the person used the panel: say what the result says.`,
  "The first line of a launch, top-up or close that succeeds is its line of the owner's USDC log: the balance before, the amount pulled or refunded, and the balance after. Tell the person what the action did and quote it as it is. The state's ledger lists every movement, those made with the panel's buttons included.",
  "A failure that starts with 'Refused on-chain' was refused by the chain, not by this server: say so, and quote its first sentence.",
  "The panel shows the time left and the allowance as they change: do not poll for them.",
].join(" ");

function toStderr(line: string): void {
  process.stderr.write(`stint-claude-demo-allowance: ${line}\n`);
}

/**
 * The MCP server, as the first demo's (`examples/claude-demo/src/server.ts`), with this extension's names: each tool runs
 * `call` with the call handler's name for it (`TO_HANDLER`). It holds no state: `serveStdio` may build it more than once.
 */
export function createAllowanceServer(options: { readonly html: string; readonly call: CallHandler; readonly log?: (line: string) => void }): McpServer {
  const report = options.log ?? toStderr;
  async function run(name: AllowanceToolName, args: Record<string, unknown>): Promise<CallToolResult> {
    try {
      return await options.call(TO_HANDLER[name], args);
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
    ALLOWANCE_TOOL.demo,
    { description: TOOL_DESCRIPTIONS[ALLOWANCE_TOOL.demo], inputSchema: z.strictObject({}), _meta: { ui: { resourceUri: PANEL_URI } } },
    async () => run(ALLOWANCE_TOOL.demo, {}),
  );
  registerAppResource(
    server,
    "Stint allowance demo panel",
    PANEL_URI,
    { description: "The Stint allowance demo's panel: the owner, the allowance, the session, the x402 exchange" },
    async () => ({ contents: [{ uri: PANEL_URI, mimeType: RESOURCE_MIME_TYPE, text: options.html }] }),
  );
  server.registerTool(
    ALLOWANCE_TOOL.state,
    {
      description: TOOL_DESCRIPTIONS[ALLOWANCE_TOOL.state],
      inputSchema: z.strictObject({ refreshBalance: z.boolean().optional() }),
      _meta: { ui: { visibility: ["app"] } },
    },
    async (args) => run(ALLOWANCE_TOOL.state, args),
  );
  for (const name of [ALLOWANCE_TOOL.launch, ALLOWANCE_TOOL.topUp, ALLOWANCE_TOOL.close]) {
    server.registerTool(
      name,
      { description: TOOL_DESCRIPTIONS[name], inputSchema: z.strictObject({}), _meta: { ui: { visibility: ["model", "app"] } } },
      async () => run(name, {}),
    );
  }
  return server;
}
