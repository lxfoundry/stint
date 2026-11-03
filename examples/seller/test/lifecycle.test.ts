import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { DEVNET_GENESIS_HASH } from "../src/chain.js";
import type { SellerConfig } from "../src/config.js";
import { startSeller } from "../src/seller.js";

// What these tests check is that Kora, a process of its own, is stopped however the seller ends: it runs the seller against
// a node and a Kora that are stand-ins on 127.0.0.1, and needs neither the network nor the `kora` binary.

const PROGRAM = "5iCYPqLjCWw5KzQTU6NBUhR2hxg5SWGmS1ctUn3qESvr";
// Under the package, in a git-ignored directory: `/tmp` can be emptied at any time.
const scratch = fileURLToPath(new URL("../.cache/", import.meta.url));
const packageDirectory = fileURLToPath(new URL("..", import.meta.url));
const SEED = "ab".repeat(32);
const KEY = "SECRETKEY0123";
// Starting the stand-in for Kora, a process of its own, is quick; a busy machine can still take seconds.
const SERVICE_TIMEOUT = 30_000;

/** What one test started, ended in reverse when the test is over: the tests of a group run side by side. */
class Scope {
  private readonly cleanUps: (() => void | Promise<void>)[] = [];

  add(cleanUp: () => void | Promise<void>): void {
    this.cleanUps.push(cleanUp);
  }

  async close(): Promise<void> {
    for (const cleanUp of this.cleanUps.splice(0).reverse()) await cleanUp();
  }

  directory(prefix: string): string {
    mkdirSync(scratch, { recursive: true });
    const directory = mkdtempSync(join(scratch, prefix));
    this.add(() => rmSync(directory, { recursive: true, force: true }));
    return directory;
  }
}

/** A test with a scope that is closed whatever happens. */
const scoped = (body: (scope: Scope) => Promise<void>) => async () => {
  const scope = new Scope();
  try {
    await body(scope);
  } finally {
    vi.unstubAllEnvs();
    await scope.close();
  }
};

interface FakeRpc {
  readonly url: string;
  /** From now on, `method` is never answered. */
  hang(method: string): void;
  /** How many requests for `method` wait for an answer that never comes. */
  hung(method: string): number;
}

/** A node on 127.0.0.1 that answers what a start needs when nothing is owed: devnet (or `genesis`), the program, the accounts, `balance`. */
async function fakeRpc(scope: Scope, options: { genesis?: string; balance?: number } = {}): Promise<FakeRpc> {
  const account = { data: [Buffer.alloc(40).toString("base64"), "base64"], executable: true, lamports: 1_000_000_000, owner: "11111111111111111111111111111111", rentEpoch: 0, space: 40 };
  const results: Record<string, unknown> = {
    getGenesisHash: options.genesis ?? DEVNET_GENESIS_HASH,
    getAccountInfo: { context: { slot: 1 }, value: account },
    getBalance: { context: { slot: 1 }, value: options.balance ?? 10_000_000_000 },
    getProgramAccounts: [],
  };
  const hanging = new Map<string, number>();
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += String(chunk)));
    request.on("end", () => {
      const { id, method } = JSON.parse(body) as { id: unknown; method: string };
      if (hanging.has(method)) return void hanging.set(method, hanging.get(method)! + 1);
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(method in results ? { jsonrpc: "2.0", id, result: results[method] } : { jsonrpc: "2.0", id, error: { code: -32601, message: `no ${method} here` } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  scope.add(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    hang: (method) => void hanging.set(method, 0),
    hung: (method) => hanging.get(method) ?? 0,
  };
}

interface FakeKora {
  readonly binary: string;
  /** Whether the file named `name` is in the stand-in's directory. */
  has(name: string): boolean;
  /** Makes the file named `name`. */
  put(name: string): void;
  remove(name: string): void;
  /** Whether the process that was Kora still runs. */
  alive(): boolean;
}

/**
 * An executable standing in for Kora. It writes its process id to `pid`, serves `GET /liveness` and answers `getPayerSigner`
 * (it writes `asked` first, and waits while a `hold` file exists); on SIGINT it writes `stopped` and exits; it exits with
 * status 7 once a `die` file exists.
 */
function fakeKora(scope: Scope): FakeKora {
  const directory = scope.directory("fake-kora-");
  const source = `import { createServer } from "node:http";
import { existsSync, writeFileSync } from "node:fs";
const at = (name) => ${JSON.stringify(directory)} + "/" + name;
writeFileSync(at("pid"), String(process.pid));
const server = createServer((request, response) => {
  if (request.method === "GET") return response.end();
  let body = "";
  request.on("data", (chunk) => (body += chunk));
  request.on("end", async () => {
    writeFileSync(at("asked"), "");
    while (existsSync(at("hold"))) await new Promise((resolve) => setTimeout(resolve, 25));
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ jsonrpc: "2.0", id: JSON.parse(body).id, result: { signer_address: ${JSON.stringify(PROGRAM)}, payment_address: ${JSON.stringify(PROGRAM)} } }));
  });
});
server.listen(Number(process.argv[process.argv.indexOf("--port") + 1]), "127.0.0.1");
process.on("SIGINT", () => {
  writeFileSync(at("stopped"), "");
  process.exit(0);
});
setInterval(() => existsSync(at("die")) && process.exit(7), 25);
`;
  const binary = join(directory, "kora");
  writeFileSync(binary, `#!/usr/bin/env node\n${source}`, { mode: 0o755 });
  const has = (name: string) => existsSync(join(directory, name));
  const pid = () => (has("pid") ? Number(readFileSync(join(directory, "pid"), "utf8")) : undefined);
  const alive = () => {
    const id = pid();
    if (id === undefined) return false;
    try {
      process.kill(id, 0);
      return true;
    } catch {
      return false;
    }
  };
  // Whatever a failing test leaves running is ended, after the checks.
  scope.add(() => {
    const id = pid();
    if (id !== undefined && alive()) process.kill(id, "SIGKILL");
  });
  return { binary, has, put: (name) => writeFileSync(join(directory, name), ""), remove: (name) => rmSync(join(directory, name), { force: true }), alive };
}

function config(rpc: FakeRpc, port = 0): SellerConfig {
  return {
    seed: Uint8Array.from(Buffer.from(SEED, "hex")),
    rpcUrl: rpc.url,
    wsUrl: rpc.url.replace(/^http/, "ws"),
    host: "127.0.0.1",
    port,
    publicOrigin: "https://seller.example",
  };
}

describe("starting the seller", { timeout: SERVICE_TIMEOUT }, () => {
  it(
    "refuses a node that is not devnet's, before it starts Kora",
    scoped(async (scope) => {
      const kora = fakeKora(scope);
      vi.stubEnv("KORA_BIN", kora.binary);
      const rpc = await fakeRpc(scope, { genesis: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d" });
      await expect(startSeller(config(rpc), () => {})).rejects.toThrow(/not devnet's/);
      expect(kora.has("pid")).toBe(false);
    }),
  );

  it(
    "names the funding key when it cannot pay what the start sends, before it starts Kora",
    scoped(async (scope) => {
      const kora = fakeKora(scope);
      vi.stubEnv("KORA_BIN", kora.binary);
      const rpc = await fakeRpc(scope, { balance: 0 });
      await expect(startSeller(config(rpc), () => {})).rejects.toThrow(/The funding key \w+ holds 0 lamports and needs \d+: send it devnet SOL/);
      expect(kora.has("pid")).toBe(false);
    }),
  );

  it(
    "stops Kora when the rest of the start fails",
    scoped(async (scope) => {
      const kora = fakeKora(scope);
      const work = scope.directory("kora-work-");
      vi.stubEnv("KORA_BIN", kora.binary);
      vi.stubEnv("TMPDIR", work);
      // The stream's port is taken, so the stream, the last to start, fails to.
      const taken = createServer();
      await new Promise<void>((resolve) => taken.listen(0, "127.0.0.1", resolve));
      scope.add(() => new Promise<void>((resolve) => taken.close(() => resolve())));
      const rpc = await fakeRpc(scope);
      await expect(startSeller(config(rpc, (taken.address() as AddressInfo).port), () => {})).rejects.toThrow(/EADDRINUSE/);
      expect(kora.has("asked")).toBe(true);
      expect(kora.has("stopped")).toBe(true);
      expect(kora.alive()).toBe(false);
      expect(readdirSync(work)).toEqual([]);
    }),
  );
});

describe("a running seller", { timeout: SERVICE_TIMEOUT }, () => {
  it(
    "stops Kora and its working directory on stop, and does not call that a failure",
    scoped(async (scope) => {
      const kora = fakeKora(scope);
      const work = scope.directory("kora-work-");
      vi.stubEnv("KORA_BIN", kora.binary);
      vi.stubEnv("TMPDIR", work);
      const entries: Record<string, unknown>[] = [];
      const seller = await startSeller(config(await fakeRpc(scope)), (entry) => entries.push(entry));
      let failure: string | undefined;
      void seller.failed.then((reason) => (failure = reason));
      expect(kora.alive()).toBe(true);
      expect((await fetch(`${seller.url}/health`)).status).toBe(200);
      expect(entries.map((entry) => entry.event)).toContain("ready");

      await seller.stop();
      expect(kora.has("stopped")).toBe(true);
      expect(kora.alive()).toBe(false);
      expect(readdirSync(work)).toEqual([]);
      await expect(fetch(`${seller.url}/health`)).rejects.toThrow();
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(failure).toBeUndefined();
    }),
  );

  it(
    "settles `failed`, and logs what Kora printed, when Kora exits on its own",
    scoped(async (scope) => {
      const kora = fakeKora(scope);
      vi.stubEnv("KORA_BIN", kora.binary);
      vi.stubEnv("TMPDIR", scope.directory("kora-work-"));
      const entries: Record<string, unknown>[] = [];
      const seller = await startSeller(config(await fakeRpc(scope)), (entry) => entries.push(entry));
      try {
        kora.put("die");
        await expect(seller.failed).resolves.toBe("Kora exited (status 7)");
        expect(entries).toContainEqual(expect.objectContaining({ event: "kora_exited", code: 7 }));
      } finally {
        await seller.stop();
      }
    }),
  );
});

interface Run {
  /** What the process wrote to stdout and to stderr so far. */
  stdout(): string;
  stderr(): string;
  signal(name: NodeJS.Signals): void;
  exited: Promise<number | null>;
}

/** The entry point as a process of its own, against the stand-ins. `preload` is a module it imports first. */
function runEntryPoint(scope: Scope, rpc: FakeRpc, kora: FakeKora, preload?: string): Run {
  const child = spawn(process.execPath, ["--import", "tsx", ...(preload ? ["--import", preload] : []), "src/main.ts"], {
    cwd: packageDirectory,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: scope.directory("kora-work-"),
      KORA_BIN: kora.binary,
      STINT_SELLER_SEED: SEED,
      STINT_SELLER_RPC_URL: rpc.url,
      HOST: "127.0.0.1",
      PORT: "0",
      PUBLIC_ORIGIN: "https://seller.example",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  scope.add(() => void child.kill("SIGKILL"));
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += String(chunk)));
  child.stderr.on("data", (chunk) => (stderr += String(chunk)));
  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  return { stdout: () => stdout, stderr: () => stderr, signal: (name) => void child.kill(name), exited };
}

const READY = '"event":"ready"';
// Booting the entry point takes about 10 s on a slow disk; waiting for a stop that hangs takes 15 s more.
const BOOT_TIMEOUT = 60_000;
const TEST_TIMEOUT = 90_000;

describe.concurrent("the entry point", () => {
  it(
    "stops Kora and exits with status 0 on SIGTERM",
    scoped(async (scope) => {
      const kora = fakeKora(scope);
      const run = runEntryPoint(scope, await fakeRpc(scope), kora);
      await vi.waitFor(() => expect(run.stdout()).toContain(READY), { timeout: BOOT_TIMEOUT, interval: 100 });
      run.signal("SIGTERM");
      expect(await run.exited).toBe(0);
      expect(kora.has("stopped")).toBe(true);
      expect(kora.alive()).toBe(false);
    }),
    TEST_TIMEOUT,
  );

  it(
    "stops Kora and exits with status 0 on a SIGTERM that arrives while it is still starting",
    scoped(async (scope) => {
      const kora = fakeKora(scope);
      kora.put("hold");
      const run = runEntryPoint(scope, await fakeRpc(scope), kora);
      // Kora is up, and the facilitator waits for its answer.
      await vi.waitFor(() => expect(kora.has("asked")).toBe(true), { timeout: BOOT_TIMEOUT, interval: 100 });
      run.signal("SIGTERM");
      kora.remove("hold");
      expect(await run.exited).toBe(0);
      expect(kora.has("stopped")).toBe(true);
      expect(kora.alive()).toBe(false);
    }),
    TEST_TIMEOUT,
  );

  it(
    "stops what is left and exits with status 1, saying why, when Kora exits on its own",
    scoped(async (scope) => {
      const kora = fakeKora(scope);
      const run = runEntryPoint(scope, await fakeRpc(scope), kora);
      await vi.waitFor(() => expect(run.stdout()).toContain(READY), { timeout: BOOT_TIMEOUT, interval: 100 });
      kora.put("die");
      expect(await run.exited).toBe(1);
      expect(run.stderr()).toContain("Kora exited (status 7)");
      expect(run.stdout()).toContain('"event":"kora_exited"');
      expect(kora.alive()).toBe(false);
    }),
    TEST_TIMEOUT,
  );

  it(
    "exits with status 1 even when stopping hangs, as the facilitator's does while a sweep waits for a node that never answers",
    scoped(async (scope) => {
      const kora = fakeKora(scope);
      const rpc = await fakeRpc(scope);
      const run = runEntryPoint(scope, rpc, kora);
      await vi.waitFor(() => expect(run.stdout()).toContain(READY), { timeout: BOOT_TIMEOUT, interval: 100 });
      // The sweeper's first listing of the program's sessions comes one interval after the start.
      rpc.hang("getProgramAccounts");
      await vi.waitFor(() => expect(rpc.hung("getProgramAccounts")).toBeGreaterThan(0), { timeout: 30_000, interval: 100 });
      kora.put("die");
      expect(await run.exited).toBe(1);
      expect(run.stderr()).toContain("Kora exited (status 7)");
    }),
    TEST_TIMEOUT,
  );

  it(
    "stops Kora and exits with status 1, with no URL shown whole, on an error nobody handles",
    scoped(async (scope) => {
      const kora = fakeKora(scope);
      const trigger = join(scope.directory("trigger-"), "crash");
      // Imported before the entry point: throws, from a timer, once `trigger` exists.
      const preload = join(scope.directory("preload-"), "crash.mjs");
      writeFileSync(
        preload,
        `import { existsSync } from "node:fs";\nsetInterval(() => { if (existsSync(${JSON.stringify(trigger)})) setTimeout(() => { throw new Error("failed at https://rpc.example.invalid/v2/${KEY}"); }, 0); }, 25).unref();\n`,
      );
      const run = runEntryPoint(scope, await fakeRpc(scope), kora, preload);
      await vi.waitFor(() => expect(run.stdout()).toContain(READY), { timeout: BOOT_TIMEOUT, interval: 100 });
      writeFileSync(trigger, "");
      expect(await run.exited).toBe(1);
      expect(run.stderr()).toContain("failed at https://rpc.example.invalid");
      expect(run.stderr()).not.toContain(KEY);
      expect(kora.has("stopped")).toBe(true);
      expect(kora.alive()).toBe(false);
    }),
    TEST_TIMEOUT,
  );
});
