import { readFileSync } from "node:fs";
import { createKeyPairSignerFromBytes, isAddress, type Address, type KeyPairSigner } from "@solana/kit";
import type { Asset, Policy } from "@lxfoundry/stint-client";

/** Every problem with the environment, so that one run of the server shows them all. */
export class ConfigError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Invalid configuration:\n${problems.map((problem) => `- ${problem}`).join("\n")}`);
    this.name = "ConfigError";
  }
}

export interface McpConfig {
  readonly signer: KeyPairSigner;
  readonly policy: Policy;
}

/** The server's configuration from environment variables (spec §9.6). */
export async function loadConfig(
  env: Readonly<Record<string, string | undefined>>,
  readKeyFile: (path: string) => string = (path) => readFileSync(path, "utf8"),
): Promise<McpConfig> {
  const problems: string[] = [];
  const text = (name: string) => env[name]?.trim() || undefined;
  const required = (name: string): string | undefined => {
    const value = text(name);
    if (value === undefined) problems.push(`${name} is required`);
    return value;
  };
  const integer = (name: string, value: string | undefined, min: bigint): bigint | undefined => {
    if (value === undefined) return undefined;
    if (!/^\d+$/.test(value) || BigInt(value) < min) {
      problems.push(`${name} must be an integer of at least ${min}, got "${value}"`);
      return undefined;
    }
    return BigInt(value);
  };
  const list = (name: string): string[] | undefined => {
    const value = text(name);
    return value === undefined ? undefined : value.split(",").map((item) => item.trim()).filter(Boolean);
  };
  const addresses = (name: string): Address[] | undefined => {
    const items = list(name);
    if (items === undefined) return undefined;
    const bad = items.filter((item) => !isAddress(item));
    if (bad.length > 0) problems.push(`${name} holds invalid addresses: ${bad.join(", ")}`);
    return items.filter((item): item is Address => isAddress(item));
  };
  const assets = (): Asset[] | undefined => {
    const items = list("STINT_ASSETS");
    if (items === undefined) return undefined;
    const parsed: Asset[] = [];
    for (const item of items) {
      const [mint, decimals] = item.split(":");
      if (mint === undefined || !isAddress(mint) || decimals === undefined || !/^\d{1,2}$/.test(decimals)) {
        problems.push(`STINT_ASSETS entries are mint:decimals, got "${item}"`);
        continue;
      }
      parsed.push({ mint, decimals: Number(decimals) });
    }
    return parsed;
  };

  const keyPath = required("STINT_KEYPAIR_PATH");
  const maxRate = integer("STINT_MAX_RATE", required("STINT_MAX_RATE"), 1n);
  const maxPerSession = integer("STINT_MAX_PER_SESSION", required("STINT_MAX_PER_SESSION"), 1n);
  const budgetAmount = integer("STINT_BUDGET_AMOUNT", required("STINT_BUDGET_AMOUNT"), 1n);
  const budgetPeriod = integer("STINT_BUDGET_PERIOD_SECONDS", required("STINT_BUDGET_PERIOD_SECONDS"), 1n);
  const maxMinSeconds = integer("STINT_MAX_MIN_SECONDS", text("STINT_MAX_MIN_SECONDS"), 1n);
  const sellers = addresses("STINT_SELLERS");
  const programs = addresses("STINT_PROGRAMS");
  const networks = list("STINT_NETWORKS");
  const allowedAssets = assets();

  let signer: KeyPairSigner | undefined;
  if (keyPath !== undefined) {
    let failure: string | undefined;
    try {
      const bytes = JSON.parse(readKeyFile(keyPath)) as unknown;
      if (Array.isArray(bytes) && bytes.length === 64 && bytes.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)) {
        signer = await createKeyPairSignerFromBytes(Uint8Array.from(bytes as number[]));
      } else {
        failure = "a keypair file holds a JSON array of 64 bytes";
      }
    } catch {
      // Nothing is taken from the error: a parser's message quotes the start of the text it was given,
      // and the contents of a key file never reach a log.
      failure = "the file cannot be read, is not JSON, or its public half is not its seed's";
    }
    if (failure !== undefined) problems.push(`STINT_KEYPAIR_PATH ${keyPath}: ${failure}`);
  }

  if (problems.length > 0 || !signer || maxRate === undefined || maxPerSession === undefined || budgetAmount === undefined || budgetPeriod === undefined) {
    throw new ConfigError(problems);
  }
  return {
    signer,
    policy: {
      maxRate,
      maxPerSession,
      budget: { amount: budgetAmount, periodSeconds: Number(budgetPeriod) },
      ...(maxMinSeconds === undefined ? {} : { maxMinSeconds: Number(maxMinSeconds) }),
      ...(sellers === undefined ? {} : { sellers }),
      ...(programs === undefined ? {} : { programs }),
      ...(networks === undefined ? {} : { networks }),
      ...(allowedAssets === undefined ? {} : { assets: allowedAssets }),
    },
  };
}
