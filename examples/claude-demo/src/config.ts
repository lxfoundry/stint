import { isAbsolute, join } from "node:path";
import type { Policy } from "@lxfoundry/stint-client";
import { SOLANA_DEVNET, USDC_DEVNET } from "@lxfoundry/stint-x402";

/** The example seller deployment's gate (`examples/seller`). */
export const DEFAULT_GATE_URL = "https://stint-demo.lxfoundry.ai";
/** Where the balance and a session's close are read: devnet's public node. */
export const DEFAULT_RPC_URL = "https://api.devnet.solana.com";
/** The folder inside `STINT_DEMO_HOME` that holds the demo's files, so that a home folder given as is stays tidy. */
export const DEMO_DIR = "stint-demo";

/**
 * The limits every action passes (spec §9.2): the example seller's rate, a session of the 100 s an open buys and nine
 * top-ups of 100 s each (the example seller's longest session, 1000 s), and 2.000 USDC an hour across sessions; devnet
 * and devnet USDC only, and the Stint program (the default).
 */
export const DEMO_POLICY: Policy = {
  networks: [SOLANA_DEVNET],
  assets: [USDC_DEVNET],
  maxRate: 1_000n,
  maxPerSession: 1_000_000n,
  budget: { amount: 2_000_000n, periodSeconds: 3_600 },
};

export interface DemoConfig {
  /** `STINT_DEMO_HOME`, as given. */
  readonly home: string;
  /** `home/stint-demo`: the folder that holds `agent.json` and `owner.json`, created at start if it is missing. */
  readonly dir: string;
  readonly gateUrl: string;
  readonly rpcUrl: string;
  readonly policy: Policy;
}

export class ConfigError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Invalid configuration:\n${problems.map((problem) => `- ${problem}`).join("\n")}`);
    this.name = "ConfigError";
  }
}

/** An http or https URL with no credentials, or undefined. Never quoted in a message: it can carry an API key. */
function httpUrl(value: string): URL | undefined {
  if (!URL.canParse(value)) return undefined;
  const url = new URL(value);
  return (url.protocol === "http:" || url.protocol === "https:") && url.username === "" && url.password === "" ? url : undefined;
}

/** The demo's configuration from environment variables (`examples/claude-demo/README.md`). An empty value is a default. */
export function loadConfig(env: Readonly<Record<string, string | undefined>>): DemoConfig {
  const problems: string[] = [];
  const text = (name: string) => env[name]?.trim() || undefined;
  const home = text("STINT_DEMO_HOME");
  if (!home) problems.push("STINT_DEMO_HOME is required: the folder that holds the agent's wallet");
  else if (!isAbsolute(home)) problems.push(`STINT_DEMO_HOME must be an absolute path, got "${home}"`);
  const gate = httpUrl(text("STINT_DEMO_GATE_URL") ?? DEFAULT_GATE_URL);
  const gateOk = gate !== undefined && gate.search === "" && gate.hash === "";
  if (!gateOk) problems.push("STINT_DEMO_GATE_URL must be an http or https URL, with no credentials, query or fragment");
  const rpcUrl = text("STINT_DEMO_RPC_URL") ?? DEFAULT_RPC_URL;
  if (!httpUrl(rpcUrl)) problems.push("STINT_DEMO_RPC_URL must be an http or https URL, with no credentials");
  if (problems.length > 0 || !home || !gate || !gateOk) throw new ConfigError(problems);
  return { home, dir: join(home, DEMO_DIR), gateUrl: `${gate.origin}${gate.pathname.replace(/\/+$/, "")}`, rpcUrl, policy: DEMO_POLICY };
}
