import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { USDC_DEVNET, redactUrls } from "@lxfoundry/stint-x402";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  KORA_ALLOWED_PROGRAMS,
  KORA_LOG_TAIL,
  appendTail,
  readableTail,
  renderKoraConfig,
  renderSignersConfig,
  startKora,
  type KoraOptions,
} from "../src/kora.js";

const PROGRAM = "5iCYPqLjCWw5KzQTU6NBUhR2hxg5SWGmS1ctUn3qESvr";
// Under the package, in a git-ignored directory: `/tmp` can be emptied at any time.
const scratch = fileURLToPath(new URL("../.cache/", import.meta.url));

// What a Kora that has printed a lot ends with: the last 64 KiB begin right after the `://` of an RPC URL it quoted, so
// the kept text holds `host/path` and a key, and no `scheme://` for `redactUrls` to find.
const KEY = "SECRETKEY0123";
const HOST = "rpc.example.invalid";
const AFTER_SCHEME = `${HOST}/v2/${KEY} unreachable\n`;
const END = "END\n";
const PADDING_LINE = "padding line\n";
const PADDING_LENGTH = KORA_LOG_TAIL - AFTER_SCHEME.length - END.length;
const PADDING = PADDING_LINE.repeat(Math.ceil(PADDING_LENGTH / PADDING_LINE.length)).slice(0, PADDING_LENGTH);
const CUT_OUTPUT = `earlier line\nGET https://${AFTER_SCHEME}${PADDING}${END}`;

const fakes: string[] = [];
afterEach(() => {
  for (const directory of fakes.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** An executable standing in for Kora: it prints `output`, then exits with status 1, or serves `GET /liveness` on its `--port`. */
function fakeKora(output: string, serve: boolean): string {
  mkdirSync(scratch, { recursive: true });
  const directory = mkdtempSync(join(scratch, "fake-kora-"));
  fakes.push(directory);
  const binary = join(directory, "kora");
  const print = `process.stdout.write(${JSON.stringify(output)}`;
  const source = serve
    ? `import { createServer } from "node:http";\n${print});\ncreateServer((_, response) => response.end()).listen(Number(process.argv[process.argv.indexOf("--port") + 1]));\nprocess.on("SIGINT", () => process.exit(0));`
    : `${print}, () => process.exit(1));`;
  writeFileSync(binary, `#!/usr/bin/env node\n${source}\n`, { mode: 0o755 });
  return binary;
}

/** Options for a Kora that cannot start, its working directory under the scratch folder. */
function options(binary: string): KoraOptions {
  mkdirSync(scratch, { recursive: true });
  return {
    rpcUrl: "http://127.0.0.1:9",
    config: { allowedPrograms: [...KORA_ALLOWED_PROGRAMS], allowedTokens: [USDC_DEVNET.mint], maxAllowedLamports: 1_000_000 },
    feePayerSecretKey: new Uint8Array(64),
    apiKey: "key",
    binary,
    workDir: scratch,
  };
}

describe("Kora's configuration", () => {
  it("allows only the programs and the token it is given, and no action of the fee payer's own", () => {
    const text = renderKoraConfig({ allowedPrograms: [...KORA_ALLOWED_PROGRAMS, PROGRAM], allowedTokens: [USDC_DEVNET.mint], maxAllowedLamports: 1_000_000 });
    expect(text).toContain(
      `allowed_programs = ["11111111111111111111111111111111", "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", "ComputeBudget111111111111111111111111111111", "${PROGRAM}"]`,
    );
    expect(text).toContain('allowed_tokens = ["4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"]');
    expect(text).toContain("max_allowed_lamports = 1000000");
    expect(text).toContain("sign_and_send_transaction = false");
    expect(text).not.toMatch(/^allow_\w+ = true$/m);
  });

  it("refuses a configuration with no token", () => {
    expect(() => renderKoraConfig({ allowedPrograms: [], allowedTokens: [], maxAllowedLamports: 1 })).toThrow(/at least one allowed token/);
  });

  it("reads the fee payer's key from Kora's environment, not from a file", () => {
    expect(renderSignersConfig()).toContain('private_key_env = "KORA_PRIVATE_KEY"');
  });
});

describe("starting Kora", () => {
  it("says so when its binary cannot be started", async () => {
    await expect(startKora(options("/nonexistent/kora"))).rejects.toThrow(/Could not start Kora \(\/nonexistent\/kora\)/);
  });

  it("says so when it exits before it is ready", async () => {
    // `false` takes any arguments and exits at once with status 1.
    await expect(startKora(options("false"))).rejects.toThrow(/Kora exited during startup/);
  });

  it("shows nothing of an RPC URL the output was cut through, in the error of a start that fails", async () => {
    const message = await startKora(options(fakeKora(CUT_OUTPUT, false))).then(
      () => "Kora started",
      (error: Error) => error.message,
    );
    expect(message).toMatch(/^Kora exited during startup:/);
    expect(message).toContain("padding line");
    expect(message).not.toContain(HOST);
    expect(message).not.toContain(KEY);
  });

  it("shows nothing of an RPC URL the output was cut through, in the log of a Kora that runs", async () => {
    const kora = await startKora(options(fakeKora(CUT_OUTPUT, true)));
    try {
      await vi.waitFor(() => expect(kora.logs()).toContain(END));
      expect(kora.logs()).not.toContain(HOST);
      expect(kora.logs()).not.toContain(KEY);
      expect(kora.logs().length).toBeLessThan(KORA_LOG_TAIL);
    } finally {
      await kora.stop();
    }
  });
});

describe("Kora's log", () => {
  it("keeps the latest 64 KiB of what Kora prints, however long it runs", () => {
    expect(appendTail("abc", "def", 4)).toBe("cdef");
    expect(appendTail("ab", "c", 4)).toBe("abc");
    expect(appendTail("", "x".repeat(KORA_LOG_TAIL + 10))).toHaveLength(KORA_LOG_TAIL);
  });

  it("drops the first line of a tail that was cut, as it may begin inside a URL that redactUrls cannot see", () => {
    const tail = appendTail("", CUT_OUTPUT);
    // The cut falls after `://`: redacting the tail as it is would leave the host, the path and the key.
    expect(tail.startsWith(AFTER_SCHEME)).toBe(true);
    expect(redactUrls(tail)).toContain(KEY);
    const shown = redactUrls(readableTail(tail, true));
    expect(shown).not.toContain(HOST);
    expect(shown).not.toContain(KEY);
    expect(shown.startsWith("padding line")).toBe(true);
    expect(shown.endsWith(END)).toBe(true);
  });

  it("shows a tail that was never cut whole, and a cut one with no line break as nothing", () => {
    expect(readableTail("first\nsecond\n", false)).toBe("first\nsecond\n");
    expect(readableTail("first\nsecond\n", true)).toBe("second\n");
    expect(readableTail("no line break", true)).toBe("");
  });
});
