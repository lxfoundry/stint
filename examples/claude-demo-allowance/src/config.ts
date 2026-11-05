import { join } from "node:path";
import { isAddress, type Address } from "@solana/kit";
import { ConfigError, loadConfig as loadDemoConfig, type DemoConfig } from "../../claude-demo/src/config.js";

export { ConfigError };

/** The folder inside `STINT_DEMO_HOME` that holds this extension's files: never the first demo's `stint-demo`. */
export const ALLOWANCE_DIR = "stint-demo-allowance";

const U64_MAX = 18_446_744_073_709_551_615n;

export interface AllowanceConfig extends DemoConfig {
  /** `STINT_DEMO_ALLOWANCE_OWNER`: the owner whose allowance funds every open and top-up. */
  readonly owner: Address;
  /** `STINT_DEMO_ALLOWANCE_NONCE`: the delegation's nonce. */
  readonly nonce: bigint;
}

/** The settings (`examples/claude-demo-allowance/README.md`): the first demo's, and the owner and nonce. */
export function loadConfig(env: Readonly<Record<string, string | undefined>>): AllowanceConfig {
  const problems: string[] = [];
  let base: DemoConfig | undefined;
  try {
    base = loadDemoConfig(env);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    problems.push(...error.problems);
  }
  const owner = env.STINT_DEMO_ALLOWANCE_OWNER?.trim() || undefined;
  if (!owner) problems.push("STINT_DEMO_ALLOWANCE_OWNER is required: the address of the owner whose allowance funds the sessions");
  else if (!isAddress(owner)) problems.push(`STINT_DEMO_ALLOWANCE_OWNER must be a Solana address, got "${owner}"`);
  const nonceText = env.STINT_DEMO_ALLOWANCE_NONCE?.trim() || "0";
  const nonce = /^\d+$/.test(nonceText) && BigInt(nonceText) <= U64_MAX ? BigInt(nonceText) : undefined;
  if (nonce === undefined) problems.push(`STINT_DEMO_ALLOWANCE_NONCE must be a whole number from 0 to ${U64_MAX}, got "${nonceText}"`);
  if (problems.length > 0 || !base || !owner || nonce === undefined) throw new ConfigError(problems);
  return { ...base, dir: join(base.home, ALLOWANCE_DIR), owner: owner as Address, nonce };
}
