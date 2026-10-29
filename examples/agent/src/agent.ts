import type Anthropic from "@anthropic-ai/sdk";
import type { BetaRunnableTool } from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool";
import type { SessionTools, Tool } from "@lxfoundry/stint-client";
import { fromJsonSchema } from "@modelcontextprotocol/server";
import { SYSTEM_PROMPT, taskPrompt } from "./prompt.js";

export const MODEL = "claude-opus-5-5";
/** The beta header under which a request may ask for the API's default server-side fallback. It names the feature, not a schedule. */
export const FALLBACK_BETA = "server-side-fallback-2026-07-01";

export interface AgentOptions {
  readonly client: Anthropic;
  /**
   * The session tools the model uses. `runAgent` closes every session still open before it returns, and
   * the tools refuse to open one afterwards: they serve this run only.
   */
  readonly tools: SessionTools;
  readonly gateUrl: string;
  /** The token account to watch. */
  readonly account: string;
  readonly model?: string;
  /** Most model turns. Default 20. */
  readonly maxIterations?: number;
  readonly log?: (line: string) => void;
}

export interface AgentResult {
  readonly outcome: "answered" | "refused";
  /** The model's answer, or the refusal's explanation. */
  readonly text: string;
}

/**
 * A session tool in the form the SDK's tool runner takes. What the model sends is checked against the
 * tool's JSON Schema before the tool runs, as the MCP server does: an input that does not match is given back
 * to the model as an error result and the tool is not run. A failure the tool throws is given back too.
 */
function runnable(tool: Tool<any, unknown>, log: (line: string) => void): BetaRunnableTool<unknown> {
  const schema = fromJsonSchema<unknown>(tool.inputSchema as never);
  return {
    name: tool.name,
    description: tool.description,
    // The SDK types a tool's schema as an object schema; the session tools' schemas all are.
    input_schema: tool.inputSchema as { type: "object" },
    parse: (content) => content,
    async run(input) {
      log(`${tool.name} ${JSON.stringify(input)}`);
      const checked = await schema["~standard"].validate(input);
      if (checked.issues) {
        throw new Error(`Invalid input for ${tool.name}: ${checked.issues.map((issue) => issue.message).join("; ")}`);
      }
      return JSON.stringify(await tool.run(checked.value));
    },
  };
}

/**
 * The example agent (spec §9.7): Claude, at low effort, with the session tools and the task of watching a
 * token account. Every limit on spending is enforced by the client's policy in code, so nothing the
 * model reads can raise one. Whatever happens, every session still open is closed before this returns.
 */
export async function runAgent(options: AgentOptions): Promise<AgentResult> {
  const log = options.log ?? (() => {});
  try {
    const runner = options.client.beta.messages.toolRunner({
      model: options.model ?? MODEL,
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: taskPrompt(options.gateUrl, options.account) }],
      tools: Object.values(options.tools.tools).map((tool) => runnable(tool as Tool<any, unknown>, log)),
      tool_choice: { type: "auto" },
      output_config: { effort: "low" },
      betas: [FALLBACK_BETA],
      thread: false,
      fallbacks: "default",
      max_iterations: options.maxIterations ?? 20,
    });
    const final = await runner;
    if (final.stop_reason === "refusal") {
      const details = (final as { stop_details?: { explanation?: string } }).stop_details;
      return { outcome: "refused", text: details?.explanation ?? "The model declined the task." };
    }
    // Anything but a finished turn (the iteration limit, the token limit, a paused turn) is a failure, not an answer.
    if (final.stop_reason !== "end_turn" && final.stop_reason !== "stop_sequence") {
      throw new Error(`The model stopped before it was done (stop reason: ${final.stop_reason})`);
    }
    const text = final.content
      .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    return { outcome: "answered", text };
  } finally {
    const closed = await options.tools.closeAll();
    for (const sessionId of closed.closed) log(`closed session ${sessionId}`);
    for (const { sessionId, error } of closed.failed) log(`could not close session ${sessionId}: ${error}`);
  }
}
