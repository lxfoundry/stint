import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchMaybeSession } from "@lxfoundry/stint-program-client";
import { address } from "@solana/kit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newHarnessKey } from "../src/fixtures/keys.js";
import { mintUsdc } from "../src/fixtures/usdc.js";
import { startLocalStack, type LocalStack } from "../src/targets/local.js";

const entry = fileURLToPath(new URL("../../packages/mcp/src/cli.ts", import.meta.url));
const cwd = fileURLToPath(new URL("../../packages/mcp", import.meta.url));
// In e2e's git-ignored `.cache/` directory: `/tmp` can be emptied at any time.
const scratch = fileURLToPath(new URL("../.cache/", import.meta.url));

/** The stdio transport is one JSON-RPC message per line: enough to talk to the server without the SDK's client. */
function speak(child: ChildProcessWithoutNullStreams) {
  let buffer = "";
  let next = 0;
  const waiting = new Map<number, (message: { result?: any; error?: unknown }) => void>();
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
      const line = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      if (line) {
        const message = JSON.parse(line) as { id?: number; result?: unknown; error?: unknown };
        if (message.id !== undefined) waiting.get(message.id)?.(message);
      }
    }
  });
  const write = (message: object) => child.stdin.write(`${JSON.stringify(message)}\n`);
  return {
    request: (method: string, params: object) =>
      new Promise<{ result?: any; error?: unknown }>((resolve) => {
        const id = ++next;
        waiting.set(id, resolve);
        write({ jsonrpc: "2.0", id, method, params });
      }),
    notify: (method: string) => write({ jsonrpc: "2.0", method }),
  };
}

describe("the stdio server leaves with its sessions closed", () => {
  let stack: LocalStack;
  let directory: string;

  beforeAll(async () => {
    stack = await startLocalStack();
    mkdirSync(scratch, { recursive: true });
    directory = mkdtempSync(join(scratch, "stint-mcp-stdio-"));
  }, 120_000);

  afterAll(async () => {
    await stack?.stop();
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  it.each([
    ["its standard input ends", (child: ChildProcessWithoutNullStreams) => child.stdin.end()],
    ["it is sent SIGTERM", (child: ChildProcessWithoutNullStreams) => child.kill("SIGTERM")],
  ] as const)("closes the open session when %s", async (_name, leave) => {
    const key = await newHarnessKey();
    await mintUsdc(stack.network.rpc, stack.keys.mintAuthority.signer, key.signer.address, 1_000_000n);
    const keyPath = join(directory, `${key.signer.address}.json`);
    writeFileSync(keyPath, JSON.stringify([...key.secretKey]));

    // `--import tsx` runs the server in this process: a signal reaches it, not a wrapper around it.
    const child = spawn(process.execPath, ["--import", "tsx", entry], {
      cwd,
      env: {
        PATH: process.env.PATH ?? "",
        STINT_KEYPAIR_PATH: keyPath,
        STINT_MAX_RATE: "10000",
        STINT_MAX_PER_SESSION: "1000000",
        STINT_BUDGET_AMOUNT: "1000000",
        STINT_BUDGET_PERIOD_SECONDS: "3600",
      },
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
    const protocol = speak(child);

    // The protocol version is the one the server asks for if it does not know this one.
    const initialized = await protocol.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "e2e", version: "1.0.0" },
    });
    expect(initialized.error, JSON.stringify(initialized.error)).toBeUndefined();
    protocol.notify("notifications/initialized");

    const opened = await protocol.request("tools/call", {
      name: "stint_open_session",
      arguments: { url: stack.stream.url, seconds: 30, reason: "leaving with a session open" },
    });
    expect(opened.result?.isError, JSON.stringify(opened)).not.toBe(true);
    const sessionId: string = JSON.parse(opened.result.content[0].text).sessionId;
    expect((await fetchMaybeSession(stack.network.rpc, address(sessionId), { commitment: "confirmed" })).exists).toBe(true);

    leave(child);

    expect(await exited).toBe(0);
    expect(stderr).toContain(`closed session ${sessionId}`);
    expect((await fetchMaybeSession(stack.network.rpc, address(sessionId), { commitment: "confirmed" })).exists).toBe(false);
  }, 90_000);
});
