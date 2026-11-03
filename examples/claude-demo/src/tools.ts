import type { CallToolResult } from "@modelcontextprotocol/server";
import { redactUrls } from "@lxfoundry/stint-x402";
import type { Demo } from "./demo.js";
import type { CallHandler } from "./owner.js";
import { LAUNCH_SECONDS, TOOL, TOP_UP_SECONDS, type DemoState, type ToolName } from "./state.js";

export const TOOL_DESCRIPTIONS: Readonly<Record<ToolName, string>> = {
  [TOOL.demo]:
    "Shows the Stint demo panel and returns the demo's state. Call it when the person asks to start, open or see the Stint demo.",
  [TOOL.state]:
    "The demo's state, for the panel: the agent's wallet, the session, the x402 exchange. Set refreshBalance to read the wallet's USDC again.",
  [TOOL.launch]: `Opens a ${LAUNCH_SECONDS} s Stint session at the demo's gate: pays 0.100 devnet USDC over x402 into the session's escrow, then watches the agent's own USDC account on the stream. The panel shows it.`,
  [TOOL.topUp]: `Buys ${TOP_UP_SECONDS} s more on the running session, before its paid time runs out. What is not used is still refunded at the close.`,
  [TOOL.close]: "Closes the running session now: the seller is paid for the time used, and the rest of the deposit is refunded.",
};

/** What the model is told about the server (MCP `instructions`). */
export const INSTRUCTIONS = [
  "This server shows a Stint session in a panel: an agent rents time on a live Solana account stream, pays in devnet USDC over x402, and gets back what it does not use.",
  `${TOOL.demo} shows the panel: call it when the person asks to start or see the Stint demo.`,
  `The panel's buttons and the tools ${TOOL.launch}, ${TOOL.topUp} and ${TOOL.close} act on the same session, so a result saying that a session is already running, is closed or has ended may mean that the person used the panel: say what the result says.`,
  "The panel shows the time left as it runs: do not poll for it.",
].join(" ");

export function stateResult(state: DemoState): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(state) }], structuredContent: state as unknown as Record<string, unknown> };
}

export function errorResult(message: string, state: DemoState): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }], structuredContent: state as unknown as Record<string, unknown> };
}

/**
 * The owner's handler for every tool: the result carries the state whatever happened, so the panel can draw it, and a
 * failure is a tool error with its message (each URL in it cut to its host: a failed request quotes the one it called),
 * so a policy refusal is readable. One line per call goes to `log`, but for a state read that succeeds: the panel makes
 * one every 2 s. The handler never rejects, a `log` that throws included.
 */
export function createCallHandler(demo: Demo, log: (line: string) => void): CallHandler {
  async function answer(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    switch (name) {
      case TOOL.demo:
        return stateResult(await demo.state());
      case TOOL.state:
        return stateResult(await demo.state({ refreshBalance: args.refreshBalance === true }));
      case TOOL.launch:
        return stateResult(await demo.launch());
      case TOOL.topUp:
        return stateResult(await demo.topUp());
      case TOOL.close:
        return stateResult(await demo.close());
      default:
        throw new Error(`Unknown tool ${name}`);
    }
  }
  return async (name, args) => {
    const started = Date.now();
    let result: CallToolResult;
    try {
      result = await answer(name, args);
    } catch (error) {
      const message = redactUrls(error instanceof Error ? error.message : String(error));
      // The state is read again for the panel; if that fails too, the error goes alone.
      const state = await demo.state().catch(() => undefined);
      result = state ? errorResult(message, state) : { isError: true, content: [{ type: "text", text: message }] };
    }
    if (result.isError || name !== TOOL.state) {
      try {
        log(redactUrls(`${name} ${result.isError ? "error" : "ok"} in ${Date.now() - started} ms`).replace(/\s+/g, " "));
      } catch {
        // A log that fails must not fail the call it reports on, and has nowhere left to say so.
      }
    }
    return result;
  };
}
