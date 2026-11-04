import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { PANEL_URI, TOOL } from "../src/state.js";

const cwd = fileURLToPath(new URL("..", import.meta.url));
const tsx = fileURLToPath(new URL("../../../node_modules/.bin/tsx", import.meta.url));
const bundle = fileURLToPath(new URL("../dist/claude-demo.cjs", import.meta.url));
// Under the package, in a git-ignored directory: `/tmp` can be emptied at any time.
const scratch = fileURLToPath(new URL("../.cache/", import.meta.url));

/** Nothing listens on port 9: the server reads no balance and opens no session, and nothing leaves the machine. */
const environment = (home: string): Record<string, string> => ({
  PATH: process.env.PATH ?? "",
  HOME: process.env.HOME ?? home,
  STINT_DEMO_HOME: home,
  STINT_DEMO_GATE_URL: "http://127.0.0.1:9",
  STINT_DEMO_RPC_URL: "http://127.0.0.1:9",
});

async function start(home: string) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [bundle], cwd, env: environment(home), stderr: "pipe" });
  const client = new Client({ name: "test", version: "1.0.0" });
  let stderr = "";
  await client.connect(transport);
  transport.stderr?.on("data", (chunk) => (stderr += chunk));
  return { client, pid: transport.pid!, stderr: () => stderr };
}

/** What `read()` holds once it matches `pattern`: a pipe delivers a process's stderr when it can, not when it is written. */
async function eventually(read: () => string, pattern: RegExp, timeoutMs = 10_000): Promise<RegExpExecArray> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = pattern.exec(read());
    if (found) return found;
    if (Date.now() >= deadline) throw new Error(`stderr never showed ${pattern}:\n${read()}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function exited(pid: number): Promise<boolean> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
  }
  return false;
}

describe("the bundled server on stdio", () => {
  let home: string | undefined;
  beforeAll(() => {
    execFileSync(tsx, ["scripts/build.ts"], { cwd, stdio: "pipe" });
  }, 120_000);
  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true });
    home = undefined;
  });
  const freshHome = () => {
    mkdirSync(scratch, { recursive: true });
    home = mkdtempSync(join(scratch, "stdio-"));
    return home;
  };

  it("starts on a folder that does not exist yet, serves the five tools and the panel, creates the wallet, and leaves when the client goes away", async () => {
    // STINT_DEMO_HOME itself is missing: the server creates it, and its stint-demo folder.
    const folder = join(freshHome(), "not-yet");
    const files = join(folder, "stint-demo");
    const { client, pid, stderr } = await start(folder);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(Object.values(TOOL).sort());
    const { contents } = await client.readResource({ uri: PANEL_URI });
    expect(contents[0]).toMatchObject({ mimeType: "text/html;profile=mcp-app" });
    expect(String((contents[0] as { text?: unknown }).text)).toContain('id="launch"');
    expect(existsSync(join(files, "agent.json"))).toBe(true);
    expect(existsSync(join(files, "owner.json"))).toBe(true);
    // Beside the key: a repository around the folder never commits it.
    expect(readFileSync(join(files, ".gitignore"), "utf8")).toBe("*\n");
    await eventually(stderr, /stint-claude-demo: created the agent's wallet [1-9A-HJ-NP-Za-km-z]{32,44}/);
    await eventually(stderr, /stint-claude-demo: this copy holds the demo's state/);

    await client.close();
    expect(await exited(pid)).toBe(true);
    expect(existsSync(join(files, "owner.json"))).toBe(false);
  }, 60_000);

  it("makes a second copy on the same folder forward its calls to the first", async () => {
    const folder = freshHome();
    const first = await start(folder);
    const second = await start(folder);
    // `stint_demo` is logged in each copy that handles it (a state read that succeeds is not).
    const result = await second.client.callTool({ name: TOOL.demo, arguments: {} });
    const address = (await eventually(first.stderr, /created the agent's wallet ([1-9A-HJ-NP-Za-km-z]{32,44})/))[1];
    expect(result.structuredContent).toMatchObject({ wallet: { address }, session: { state: "none" } });
    await eventually(second.stderr, /forwarding to the copy that holds the demo's state/);
    await eventually(second.stderr, /stint_demo forwarded/);
    await eventually(first.stderr, /stint_demo ok in \d+ ms/);

    await second.client.close();
    await first.client.close();
    expect(await exited(second.pid)).toBe(true);
    expect(await exited(first.pid)).toBe(true);
    expect(existsSync(join(folder, "stint-demo", "owner.json"))).toBe(false);
  }, 60_000);

  it("leaves on SIGTERM with the exit code 0 and takes its owner.json away", async () => {
    const folder = freshHome();
    const child = spawn(process.execPath, [bundle], { cwd, env: environment(folder), stdio: ["pipe", "pipe", "pipe"] });
    const code = new Promise<number | null>((resolve) => child.once("exit", resolve));
    let stderr = "";
    let owned = false;
    // The line says the copy can be stopped: the signal goes as soon as it arrives, from the handler, with no poll's delay.
    const sent = new Promise<void>((resolve, reject) => {
      child.once("exit", () => reject(new Error(`the server left before it said it holds the demo's state:\n${stderr}`)));
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
        if (child.killed || !/this copy holds the demo's state/.test(stderr)) return;
        owned = existsSync(join(folder, "stint-demo", "owner.json"));
        child.kill("SIGTERM");
        resolve();
      });
    });
    await sent;
    expect(owned).toBe(true);
    expect(await code).toBe(0);
    expect(existsSync(join(folder, "stint-demo", "owner.json"))).toBe(false);
  }, 60_000);

  it("exits with the list of problems, and writes nothing to stdout, when it is not configured", () => {
    const result = spawnSync(process.execPath, [bundle], { cwd, env: { PATH: process.env.PATH ?? "" }, encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/^stint-claude-demo: Invalid configuration:\nstint-claude-demo: - STINT_DEMO_HOME is required/);
  }, 30_000);
});
