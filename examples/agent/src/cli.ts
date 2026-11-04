import { existsSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { createNodeRpc, createSessionTools, createStintClient } from "@lxfoundry/stint-client";
import { ConfigError, loadConfig } from "@lxfoundry/stint-mcp";
import { runAgent } from "./agent.js";

/**
 * Runs the example agent once, reading the repository's `.env` if there is one: `ANTHROPIC_API_KEY` for the model, `STINT_GATE_URL` and
 * `STINT_WATCH_ACCOUNT` for the task, and the same `STINT_*` variables as the MCP server for the key and
 * the spending limits. The answer goes to stdout; what the agent does goes to stderr.
 */
async function main(): Promise<void> {
  const envFile = new URL("../../../.env", import.meta.url); // the repository's, three levels above this file
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const missing = ["ANTHROPIC_API_KEY", "STINT_GATE_URL", "STINT_WATCH_ACCOUNT"].filter((name) => !process.env[name]?.trim());
  if (missing.length > 0) throw new Error(`Missing environment variables: ${missing.join(", ")}`);
  const config = await loadConfig(process.env);
  const client = createStintClient({
    signer: config.signer,
    policy: config.policy,
    ...(config.allowance ? { allowance: config.allowance } : {}),
    ...(config.rpcUrl ? { rpc: createNodeRpc(config.rpcUrl) } : {}),
  });
  const { tools, closeAll, closeCode } = createSessionTools(client);
  const result = await runAgent({
    client: new Anthropic(),
    tools: { tools, closeAll, closeCode },
    gateUrl: process.env.STINT_GATE_URL!.trim(),
    account: process.env.STINT_WATCH_ACCOUNT!.trim(),
    log: (line) => console.error(`agent: ${line}`),
  });
  process.stdout.write(`${result.outcome}: ${result.text}\n`);
}

main().catch((error: unknown) => {
  console.error(error instanceof ConfigError ? error.message : error);
  process.exit(1);
});
