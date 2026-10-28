import { pbkdf2Sync } from "node:crypto";
import type { Rpc, SolanaRpcApi } from "@solana/kit";
import { STINT_PROGRAM_ADDRESS } from "@lxfoundry/stint-program-client";

/** Devnet's genesis hash. The network identifier `solana:EtWT…` is its first 32 characters (spec §5.1). */
export const DEVNET_GENESIS_HASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

export interface DevnetConfig {
  readonly rpcUrl: string;
  readonly wsUrl: string;
  /**
   * The bytes that every key of the devnet target derives from, the funding key included: 32 from a
   * hexadecimal seed, or 64 from a recovery phrase, as BIP-39 turns a phrase into a seed.
   */
  readonly seed: Uint8Array;
}

export class DevnetConfigError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Invalid configuration:\n${problems.map((problem) => `- ${problem}`).join("\n")}`);
    this.name = "DevnetConfigError";
  }
}

const PHRASE_LENGTHS = [12, 15, 18, 21, 24];

/**
 * The seed of a recovery phrase as BIP-39 defines it: PBKDF2-HMAC-SHA512 over the phrase, 2048 rounds, the
 * salt "mnemonic", 64 bytes. The words are not checked against the word list or its checksum: a mistyped
 * phrase gives other keys, and `pnpm e2e:devnet funds` shows the funding address it gives.
 */
function phraseSeed(words: readonly string[]): Uint8Array {
  return Uint8Array.from(pbkdf2Sync(words.join(" ").normalize("NFKD"), "mnemonic", 2048, 64, "sha512"));
}

/** The devnet target's configuration from environment variables (see `.env.example`). */
export function loadDevnetConfig(env: Readonly<Record<string, string | undefined>>): DevnetConfig {
  const problems: string[] = [];
  const rpcUrl = env.STINT_DEVNET_RPC_URL?.trim();
  const seedText = env.STINT_DEVNET_SEED?.trim();
  if (!rpcUrl) problems.push("STINT_DEVNET_RPC_URL is required");
  // The URL may carry an API key, and the seed is a secret, so no message quotes either.
  else if (!/^https?:\/\/\S+$/.test(rpcUrl)) problems.push("STINT_DEVNET_RPC_URL must be an http or https URL");
  let seed: Uint8Array | undefined;
  if (!seedText) problems.push("STINT_DEVNET_SEED is required: a recovery phrase of 12 to 24 words, or 64 hexadecimal characters (openssl rand -hex 32)");
  else if (/^[0-9a-fA-F]{64}$/.test(seedText)) seed = Uint8Array.from(Buffer.from(seedText, "hex"));
  else {
    const words = seedText.toLowerCase().split(/\s+/);
    if (PHRASE_LENGTHS.includes(words.length) && words.every((word) => /^[a-z]+$/.test(word))) seed = phraseSeed(words);
    else problems.push("STINT_DEVNET_SEED must be a recovery phrase of 12 to 24 words, or 64 hexadecimal characters");
  }
  if (problems.length > 0 || !rpcUrl || !seed) throw new DevnetConfigError(problems);
  return { rpcUrl, wsUrl: env.STINT_DEVNET_WS_URL?.trim() || rpcUrl.replace(/^http/, "ws"), seed };
}

/** Refuses to go on unless the RPC is devnet's: no transaction of this harness may reach another network. */
export async function assertDevnet(rpc: Rpc<SolanaRpcApi>): Promise<void> {
  const genesis = await rpc.getGenesisHash().send();
  if (genesis !== DEVNET_GENESIS_HASH) throw new Error(`The RPC reports genesis hash ${genesis}, which is not devnet's: refusing to run`);
}

export async function assertProgramDeployed(rpc: Rpc<SolanaRpcApi>): Promise<void> {
  const account = await rpc.getAccountInfo(STINT_PROGRAM_ADDRESS, { encoding: "base64" }).send();
  if (!account.value?.executable) {
    throw new Error(`The Stint program ${STINT_PROGRAM_ADDRESS} is not deployed on this network: run scripts/deploy-devnet.sh`);
  }
}
