import { pbkdf2Sync } from "node:crypto";

/** The seller's configuration, from environment variables (`examples/seller/README.md`). */
export interface SellerConfig {
  /**
   * The bytes every key of the deployment derives from (`deriveSellerKeys`): 32 from a hexadecimal seed, or 64 from a
   * recovery phrase, as BIP-39 turns a phrase into a seed.
   */
  readonly seed: Uint8Array;
  readonly rpcUrl: string;
  readonly wsUrl: string;
  /** An endpoint that lists the program's accounts, if `rpcUrl` refuses that. */
  readonly scanRpcUrl?: string;
  readonly host: string;
  readonly port: number;
  /** The origin buyers reach the stream at: the gate's origin (spec §7.2). */
  readonly publicOrigin: string;
}

/** Every problem with the environment, so that one start shows them all. */
export class SellerConfigError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Invalid configuration:\n${problems.map((problem) => `- ${problem}`).join("\n")}`);
    this.name = "SellerConfigError";
  }
}

type Env = Readonly<Record<string, string | undefined>>;

const text = (env: Env, name: string) => env[name]?.trim() || undefined;

/** A URL that parses, has one of the schemes and no credentials. Never quoted in a message: it can carry an API key. */
function isUrl(value: string, protocols: readonly string[]): boolean {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return protocols.includes(url.protocol) && url.username === "" && url.password === "";
}

const PHRASE_LENGTHS = [12, 15, 18, 21, 24];

/**
 * The seed of a recovery phrase as BIP-39 defines it: PBKDF2-HMAC-SHA512 over the phrase, 2048 rounds, the salt
 * "mnemonic", 64 bytes. The words are not checked against the word list or its checksum: a mistyped phrase gives other
 * keys, and the `keys` command shows the addresses it gives.
 */
function phraseSeed(words: readonly string[]): Uint8Array {
  return Uint8Array.from(pbkdf2Sync(words.join(" ").normalize("NFKD"), "mnemonic", 2048, 64, "sha512"));
}

/** 64 hexadecimal characters, or a recovery phrase of 12 to 24 words, as the devnet harness reads its own seed. Never quoted. */
function readSeed(env: Env, problems: string[]): Uint8Array | undefined {
  const seed = text(env, "STINT_SELLER_SEED");
  if (!seed) {
    problems.push("STINT_SELLER_SEED is required: a recovery phrase of 12 to 24 words, or 64 hexadecimal characters (openssl rand -hex 32)");
    return undefined;
  }
  if (/^[0-9a-fA-F]{64}$/.test(seed)) return Uint8Array.from(Buffer.from(seed, "hex"));
  const words = seed.toLowerCase().split(/\s+/);
  if (PHRASE_LENGTHS.includes(words.length) && words.every((word) => /^[a-z]+$/.test(word))) return phraseSeed(words);
  problems.push("STINT_SELLER_SEED must be a recovery phrase of 12 to 24 words, or 64 hexadecimal characters");
  return undefined;
}

/** The seed alone, for the `keys` command. */
export function loadSeed(env: Env): Uint8Array {
  const problems: string[] = [];
  const seed = readSeed(env, problems);
  if (!seed) throw new SellerConfigError(problems);
  return seed;
}

export function loadSellerConfig(env: Env): SellerConfig {
  const problems: string[] = [];
  const seed = readSeed(env, problems);

  const rpcUrl = text(env, "STINT_SELLER_RPC_URL");
  if (!rpcUrl) problems.push("STINT_SELLER_RPC_URL is required");
  else if (!isUrl(rpcUrl, ["http:", "https:"])) problems.push("STINT_SELLER_RPC_URL must be an http or https URL");
  const wsUrl = text(env, "STINT_SELLER_WS_URL");
  if (wsUrl && !isUrl(wsUrl, ["ws:", "wss:"])) problems.push("STINT_SELLER_WS_URL must be a ws or wss URL");
  const scanRpcUrl = text(env, "STINT_SELLER_SCAN_RPC_URL");
  if (scanRpcUrl && !isUrl(scanRpcUrl, ["http:", "https:"])) problems.push("STINT_SELLER_SCAN_RPC_URL must be an http or https URL");

  const portText = text(env, "PORT") ?? "8080";
  const port = Number(portText);
  if (!/^\d{1,5}$/.test(portText) || port > 65_535) problems.push(`PORT must be a port number from 0 to 65535, got "${portText}"`);
  const host = text(env, "HOST") ?? "0.0.0.0";

  const originText = text(env, "PUBLIC_ORIGIN");
  let publicOrigin: string | undefined;
  if (!originText) {
    problems.push("PUBLIC_ORIGIN is required: the http or https origin buyers reach the stream at, such as https://stream.example.com");
  } else {
    const url = isUrl(originText, ["http:", "https:"]) ? new URL(originText) : undefined;
    if (!url || url.pathname !== "/" || url.search !== "" || url.hash !== "") {
      problems.push("PUBLIC_ORIGIN must be an http or https origin, with no path, query or credentials");
    } else {
      publicOrigin = url.origin;
    }
  }

  if (problems.length > 0 || !seed || !rpcUrl || !publicOrigin) throw new SellerConfigError(problems);
  return {
    seed,
    rpcUrl,
    wsUrl: wsUrl ?? rpcUrl.replace(/^http/, "ws"),
    ...(scanRpcUrl ? { scanRpcUrl } : {}),
    host,
    port,
    publicOrigin,
  };
}
