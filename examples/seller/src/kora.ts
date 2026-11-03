import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { address } from "@solana/kit";
import { redactUrls } from "@lxfoundry/stint-x402";

/** The Subscriptions & Allowances program (spec §10): an open may pull from an allowance. */
export const SUBSCRIPTIONS_PROGRAM_ADDRESS = address("De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44");

/** Programs every transaction may use: System, SPL Token, Associated Token Account, Compute Budget. */
export const KORA_ALLOWED_PROGRAMS = [
  "11111111111111111111111111111111",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  "ComputeBudget111111111111111111111111111111",
] as const;

export interface KoraConfigInput {
  readonly allowedPrograms: readonly string[];
  readonly allowedTokens: readonly string[];
  readonly maxAllowedLamports: number;
}

const list = (values: readonly string[]) => `[${values.map((value) => `"${value}"`).join(", ")}]`;

const SPL_TOKEN_POLICY_KEYS = [
  "allow_transfer",
  "allow_burn",
  "allow_close_account",
  "allow_approve",
  "allow_revoke",
  "allow_set_authority",
  "allow_mint_to",
  "allow_initialize_mint",
  "allow_initialize_account",
  "allow_initialize_multisig",
  "allow_freeze_account",
  "allow_thaw_account",
];

/**
 * Kora 2.0.5's `kora.toml`: free pricing with the `Mock` price source, so Kora asks no outside service for prices;
 * Lighthouse off (spec §6.2); a fee-payer policy that forbids every action but paying fees, each flag written out. In
 * Kora 2.0.5, once a section exists, all of its keys are required.
 */
export function renderKoraConfig(input: KoraConfigInput): string {
  if (input.allowedTokens.length === 0) throw new Error("Kora needs at least one allowed token");
  return [
    "[kora]",
    "rate_limit = 100",
    "",
    "[kora.auth]",
    "",
    "[kora.lighthouse]",
    "enabled = false",
    "",
    "[kora.enabled_methods]",
    "liveness = true",
    "estimate_transaction_fee = true",
    "get_supported_tokens = true",
    "get_payer_signer = true",
    "sign_transaction = true",
    "sign_and_send_transaction = false",
    "transfer_transaction = false",
    "get_blockhash = true",
    "get_config = true",
    "",
    "[validation]",
    `max_allowed_lamports = ${input.maxAllowedLamports}`,
    "max_signatures = 10",
    'price_source = "Mock"',
    "allow_durable_transactions = false",
    `allowed_programs = ${list(input.allowedPrograms)}`,
    `allowed_tokens = ${list(input.allowedTokens)}`,
    "allowed_spl_paid_tokens = []",
    "disallowed_accounts = []",
    "",
    "[validation.price]",
    'type = "free"',
    "",
    "[validation.fee_payer_policy.system]",
    "allow_transfer = false",
    "allow_assign = false",
    "allow_create_account = false",
    "allow_allocate = false",
    "",
    "[validation.fee_payer_policy.spl_token]",
    ...SPL_TOKEN_POLICY_KEYS.map((key) => `${key} = false`),
    "",
    "[validation.fee_payer_policy.token_2022]",
    ...SPL_TOKEN_POLICY_KEYS.map((key) => `${key} = false`),
    "",
  ].join("\n");
}

/** One memory signer whose key comes from `KORA_PRIVATE_KEY`, a JSON array of 64 bytes. */
export function renderSignersConfig(): string {
  return ["[signer_pool]", 'strategy = "round_robin"', "", "[[signers]]", 'name = "fee_payer"', 'type = "memory"', 'private_key_env = "KORA_PRIVATE_KEY"', ""].join("\n");
}

export interface KoraOptions {
  readonly rpcUrl: string;
  readonly config: KoraConfigInput;
  readonly feePayerSecretKey: Uint8Array;
  readonly apiKey: string;
  /** The `kora` binary: `KORA_BIN`, or `kora` on the PATH. */
  readonly binary?: string;
  /** Where Kora's working directory is made. Default: the system's temporary directory. */
  readonly workDir?: string;
}

export interface KoraProcess {
  readonly url: string;
  readonly apiKey: string;
  /** Settles when Kora exits, with its exit code (`null` when a signal ended it): whoever started it can watch it. */
  readonly exit: Promise<number | null>;
  /**
   * What Kora printed, within the latest `KORA_LOG_TAIL` characters, every URL cut to its scheme and host. Once the log
   * is that long, its first line, which the cut may have begun in the middle, is left out.
   */
  logs(): string;
  stop(): Promise<void>;
}

/** How much of Kora's output is kept: the latest 64 KiB, for a process that may run for weeks. */
export const KORA_LOG_TAIL = 64 * 1024;

/** `current` and `chunk` together, cut to their last `limit` characters. */
export function appendTail(current: string, chunk: string, limit = KORA_LOG_TAIL): string {
  const next = current + chunk;
  return next.length > limit ? next.slice(next.length - limit) : next;
}

/**
 * The part of a kept tail that can be shown. A tail that has been cut may begin inside a URL, past its `scheme://`,
 * which is all `redactUrls` looks for: what is left of the URL, a key included, would pass through. So its first line is
 * dropped, everything up to and including the first line break (all of it, if there is none).
 */
export function readableTail(tail: string, truncated: boolean): string {
  if (!truncated) return tail;
  const lineBreak = tail.indexOf("\n");
  return lineBreak === -1 ? "" : tail.slice(lineBreak + 1);
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

/**
 * Runs Kora in a fresh working directory: Kora reads a `.env` from its working directory, so a clean one keeps anything
 * else out. Its key reaches it only through its environment. Kora 2.0.5 has no bind option: it listens on every
 * interface at `port`, and refuses any request without `apiKey` but `GET /liveness`; where only declared ports are
 * public, as on Fly.io, nothing outside the machine reaches it. Ready once `GET /liveness` answers. If this process
 * calls `process.exit()` while Kora runs, Kora is killed with it; a process that a signal ends cannot do that, so it
 * must handle the signals it expects and call `stop()`.
 */
export async function startKora(options: KoraOptions): Promise<KoraProcess> {
  const directory = mkdtempSync(join(options.workDir ?? tmpdir(), "stint-kora-"));
  const cleanUp = () => rmSync(directory, { recursive: true, force: true });
  const binary = options.binary ?? process.env.KORA_BIN ?? "kora";
  let stop: (() => Promise<void>) | undefined;
  try {
    writeFileSync(join(directory, "kora.toml"), renderKoraConfig(options.config));
    writeFileSync(join(directory, "signers.toml"), renderSignersConfig());
    const port = await freePort();
    const child = spawn(
      binary,
      ["--config", "kora.toml", "--rpc-url", options.rpcUrl, "rpc", "start", "--signers-config", "signers.toml", "--port", String(port)],
      {
        cwd: directory,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? directory,
          KORA_PRIVATE_KEY: JSON.stringify(Array.from(options.feePayerSecretKey)),
          KORA_API_KEY: options.apiKey,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    let truncated = false;
    const keep = (chunk: unknown) => {
      const text = String(chunk);
      const next = appendTail(output, text);
      truncated = truncated || next.length < output.length + text.length;
      output = next;
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    // Kora quotes the RPC URL in its errors, and the URL can carry a key.
    const shown = () => redactUrls(readableTail(output, truncated));
    // A process that ends without stopping Kora, on `process.exit()` as on a stop that hangs or a start that is cut short,
    // would leave it running with the fee payer's key in its environment. `exit` listeners run synchronously: the kill is.
    const killWithProcess = () => void child.kill("SIGKILL");
    process.once("exit", killWithProcess);
    const unhook = () => void process.removeListener("exit", killWithProcess);
    let exited = false;
    let spawnError: Error | undefined;
    const exit = new Promise<number | null>((resolve) => {
      child.once("exit", (code) => (unhook(), (exited = true), resolve(code)));
      // A binary that cannot be started emits "error" and never "exit".
      child.once("error", (error) => (unhook(), (spawnError = error), (exited = true), resolve(null)));
    });
    const url = `http://127.0.0.1:${port}`;
    stop = async () => {
      if (!exited) {
        child.kill("SIGINT"); // Kora 2.0.5 shuts down on Ctrl-C only.
        let timer: NodeJS.Timeout | undefined;
        const late = new Promise<"late">((resolve) => {
          timer = setTimeout(() => resolve("late"), 5_000);
        });
        try {
          if ((await Promise.race([exit, late])) === "late") child.kill("SIGKILL");
        } finally {
          clearTimeout(timer);
        }
        await exit;
      }
      cleanUp();
    };
    const deadline = Date.now() + 30_000;
    let delay = 50;
    while (Date.now() < deadline) {
      if (spawnError) throw new Error(`Could not start Kora (${binary}): ${spawnError.message}`);
      if (exited) throw new Error(`Kora exited during startup:\n${shown()}`);
      try {
        const response = await fetch(`${url}/liveness`);
        if (response.ok) return { url, apiKey: options.apiKey, exit, logs: shown, stop };
      } catch {
        // Not listening yet.
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, 1_000);
    }
    throw new Error(`Kora was not ready within 30 s:\n${shown()}`);
  } catch (error) {
    await stop?.();
    cleanUp();
    throw error;
  }
}
