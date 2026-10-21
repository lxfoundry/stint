import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderKoraConfig, renderSignersConfig, type KoraConfigInput } from "./config.js";

export interface KoraOptions {
  readonly rpcUrl: string;
  readonly config: KoraConfigInput;
  readonly feePayerSecretKey: Uint8Array;
  readonly apiKey: string;
  /** The `kora` binary: `KORA_BIN`, or `kora` on the PATH. */
  readonly binary?: string;
}

export interface KoraProcess {
  readonly url: string;
  readonly apiKey: string;
  logs(): string;
  stop(): Promise<void>;
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
 * Runs Kora in a fresh working directory: Kora reads a `.env` file from its working directory, so
 * a clean one keeps the developer's environment out. Its key reaches it only through its
 * environment.
 */
export async function startKora(options: KoraOptions): Promise<KoraProcess> {
  const directory = mkdtempSync(join(tmpdir(), "stint-kora-"));
  writeFileSync(join(directory, "kora.toml"), renderKoraConfig(options.config));
  writeFileSync(join(directory, "signers.toml"), renderSignersConfig());
  const port = await freePort();

  const child = spawn(
    options.binary ?? process.env.KORA_BIN ?? "kora",
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
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  let exited = false;
  const exit = new Promise<void>((resolve) => child.once("exit", () => ((exited = true), resolve())));

  const url = `http://127.0.0.1:${port}`;
  const stop = async () => {
    if (!exited) {
      child.kill("SIGINT"); // Kora 2.0.5 shuts down on Ctrl-C only.
      const timeout = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 5_000));
      if ((await Promise.race([exit, timeout])) === "timeout") child.kill("SIGKILL");
      await exit;
    }
    rmSync(directory, { recursive: true, force: true });
  };

  // Readiness: GET /liveness, backing off from 50 ms to 1 s, for up to 30 s.
  const deadline = Date.now() + 30_000;
  let delay = 50;
  while (Date.now() < deadline) {
    if (exited) throw new Error(`Kora exited during startup:\n${output}`);
    try {
      const response = await fetch(`${url}/liveness`);
      if (response.ok) return { url, apiKey: options.apiKey, logs: () => output, stop };
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(delay * 2, 1_000);
  }
  await stop();
  throw new Error(`Kora was not ready within 30 s:\n${output}`);
}
