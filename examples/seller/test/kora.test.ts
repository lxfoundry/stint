import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { USDC_DEVNET } from "@lxfoundry/stint-x402";
import { describe, expect, it } from "vitest";
import { KORA_ALLOWED_PROGRAMS, KORA_LOG_TAIL, appendTail, renderKoraConfig, renderSignersConfig, startKora, type KoraOptions } from "../src/kora.js";

const PROGRAM = "5iCYPqLjCWw5KzQTU6NBUhR2hxg5SWGmS1ctUn3qESvr";
// Under the package, in a git-ignored directory: `/tmp` can be emptied at any time.
const scratch = fileURLToPath(new URL("../.cache/", import.meta.url));

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
});

describe("Kora's log", () => {
  it("keeps the latest 64 KiB of what Kora prints, however long it runs", () => {
    expect(appendTail("abc", "def", 4)).toBe("cdef");
    expect(appendTail("ab", "c", 4)).toBe("abc");
    expect(appendTail("", "x".repeat(KORA_LOG_TAIL + 10))).toHaveLength(KORA_LOG_TAIL);
  });
});
