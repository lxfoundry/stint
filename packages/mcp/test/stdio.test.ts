import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createKeyPairSignerFromPrivateKeyBytes, getAddressEncoder } from "@solana/kit";
import { afterEach, describe, expect, it } from "vitest";

const tsx = fileURLToPath(new URL("../../../node_modules/.bin/tsx", import.meta.url));
const entry = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const cwd = fileURLToPath(new URL("..", import.meta.url));
// Under the package, in a git-ignored directory: `/tmp` can be emptied at any time.
const scratch = fileURLToPath(new URL("../.cache/", import.meta.url));

describe("the stdio entry point", () => {
  let directory: string | undefined;
  afterEach(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
    directory = undefined;
  });

  async function environment(): Promise<Record<string, string>> {
    mkdirSync(scratch, { recursive: true });
    directory = mkdtempSync(join(scratch, "stint-mcp-"));
    const seed = crypto.getRandomValues(new Uint8Array(32));
    const signer = await createKeyPairSignerFromPrivateKeyBytes(seed);
    const path = join(directory, "agent.json");
    writeFileSync(path, JSON.stringify([...seed, ...getAddressEncoder().encode(signer.address)]));
    return {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? directory,
      STINT_KEYPAIR_PATH: path,
      STINT_MAX_RATE: "5000",
      STINT_MAX_PER_SESSION: "600000",
      STINT_BUDGET_AMOUNT: "2000000",
      STINT_BUDGET_PERIOD_SECONDS: "3600",
    };
  }

  it("exits with the list of problems, and writes nothing to stdout, when it is not configured", () => {
    const result = spawnSync(tsx, [entry], { cwd, env: { PATH: process.env.PATH ?? "" }, encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/STINT_KEYPAIR_PATH is required/);
    expect(result.stderr).toMatch(/STINT_BUDGET_PERIOD_SECONDS is required/);
  }, 30_000);

  it("serves the tools, answers a call, and exits by itself when the client goes away", async () => {
    const transport = new StdioClientTransport({ command: tsx, args: [entry], cwd, env: await environment(), stderr: "pipe" });
    let stderr = "";
    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(transport);
    transport.stderr?.on("data", (chunk) => (stderr += chunk));

    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "stint_close_session",
      "stint_open_session",
      "stint_receive",
      "stint_send",
      "stint_session_status",
    ]);
    const unknown = await client.callTool({ name: "stint_close_session", arguments: { sessionId: "nope" } });
    expect(unknown.isError).toBe(true);
    expect((unknown.content as { text: string }[])[0]!.text).toMatch(/Unknown session nope/);

    const pid = transport.pid!;
    await client.close();
    const deadline = Date.now() + 10_000;
    let alive = true;
    while (alive && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
      }
    }
    expect(alive).toBe(false);
    expect(stderr).toMatch(/serving 5 tools on stdio/);
  }, 30_000);
});
