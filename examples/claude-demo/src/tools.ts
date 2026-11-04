import type { CallToolResult } from "@modelcontextprotocol/server";
import { TOP_UP_MARGIN_SECONDS, redactUrls } from "@lxfoundry/stint-x402";
import { formatUsdc, ledgerLine } from "../app/model.js";
import type { Demo } from "./demo.js";
import type { CallHandler } from "./owner.js";
import { LAUNCH_AMOUNT, LAUNCH_SECONDS, TOOL, TOP_UP_SECONDS, type DemoState, type LedgerKind, type ToolName } from "./state.js";

/** A top-up is refused with this many seconds of paid time left or fewer: the facilitator's margin and 3 s more, as `topUpRefusal` has it. */
const TOP_UP_REFUSED_WITHIN_SECONDS = TOP_UP_MARGIN_SECONDS + 3;

export const TOOL_DESCRIPTIONS: Readonly<Record<ToolName, string>> = {
  [TOOL.demo]:
    "Shows the Stint demo panel and returns the demo's state. Call it when the person asks to start, open or see the Stint demo.",
  [TOOL.state]:
    "The demo's state, for the panel: the agent's wallet, the session, the x402 exchange. Set refreshBalance to read the wallet's USDC again.",
  [TOOL.launch]: `Opens a ${LAUNCH_SECONDS} s Stint session at the demo's gate: pays ${formatUsdc(LAUNCH_AMOUNT)} on devnet over x402 into the session's escrow, then watches the agent's own USDC account on the stream. Open the panel first with ${TOOL.demo}: the panel shows the session, and this tool does not open it.`,
  [TOOL.topUp]: `Buys ${TOP_UP_SECONDS} s more on the running session. Refused when ${TOP_UP_REFUSED_WITHIN_SECONDS} s or less of paid time is left, and when ${TOP_UP_SECONDS} s more would pass the seller's longest session. What is not used is still refunded at the close.`,
  [TOOL.close]: "Closes the running session now: the seller is paid for the time used, and the rest of the deposit is refunded.",
};

/** What the model is told about the server (MCP `instructions`). */
export const INSTRUCTIONS = [
  "This server shows a Stint session in a panel: an agent rents time on a live Solana account stream, pays in devnet USDC over x402, and gets back what it does not use.",
  `${TOOL.demo} shows the panel: call it when the person asks to start or see the Stint demo.`,
  `The panel's buttons and the tools ${TOOL.launch}, ${TOOL.topUp} and ${TOOL.close} act on the same session, so a result saying that a session is already running, is closed or has ended may mean that the person used the panel: say what the result says.`,
  "The first line of a launch, top-up or close that succeeds is its line of the wallet's log: the balance before, the amount paid or refunded, and the balance after. Tell the person what the action did and quote it as it is. The state's ledger lists every movement, those made with the panel's buttons included.",
  "The panel shows the time left as it runs: do not poll for it.",
].join(" ");

export function stateResult(state: DemoState): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(state) }], structuredContent: state as unknown as Record<string, unknown> };
}

/** The movement each action logs. */
const ACTION_KINDS: Readonly<Partial<Record<string, LedgerKind>>> = { [TOOL.launch]: "launch", [TOOL.topUp]: "top-up", [TOOL.close]: "close" };

/**
 * An action's result: its line of the wallet's log first, for the model to quote, then the state. The line is the latest
 * movement, if the action logged it: of its kind, and of the session the state holds.
 */
export function actionResult(name: string, state: DemoState): CallToolResult {
  const result = stateResult(state);
  const latest = state.ledger.at(-1);
  if (!latest || latest.kind !== ACTION_KINDS[name] || latest.sessionId !== state.session.sessionId) return result;
  return { ...result, content: [{ type: "text", text: ledgerLine(latest) }, ...result.content] };
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
        return actionResult(name, await demo.launch());
      case TOOL.topUp:
        return actionResult(name, await demo.topUp());
      case TOOL.close:
        return actionResult(name, await demo.close());
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
