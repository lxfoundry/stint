import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ScenarioOutcome } from "@lxfoundry/stint-conformance";
import { describe, expect, it } from "vitest";
import { USDC_DEVNET_MINT } from "../src/fixtures/usdc.js";
import { KORA_ALLOWED_PROGRAMS } from "../src/kora/config.js";
import { startKora } from "../src/kora/process.js";
import { redactOutcomes } from "../src/redact.js";

const KEYED = "https://devnet.provider.example/v2/SECRETKEY?api-key=SECRETKEY";

describe("redactOutcomes", () => {
  it("redacts the error of each outcome and leaves the rest as it was", () => {
    const base = { id: 1, title: "T", target: "devnet", status: "required", durationMs: 1, passesWhilePending: false } as const;
    const outcomes: ScenarioOutcome[] = [
      { ...base, result: "fail", error: `Kora: failed to reach ${KEYED}` },
      { ...base, id: 2, result: "pass" },
    ];
    const redacted = redactOutcomes(outcomes);
    expect(redacted[0]!.error).toBe("Kora: failed to reach https://devnet.provider.example");
    expect(redacted[1]).toEqual(outcomes[1]);
  });
});

describe("startKora", () => {
  it("does not let the RPC URL's key out in the error of a Kora that exits during start-up", async () => {
    const directory = mkdtempSync(join(tmpdir(), "stint-fake-kora-"));
    const binary = join(directory, "kora");
    writeFileSync(binary, `#!/bin/sh\necho "error sending request for url (${KEYED})" >&2\nexit 1\n`);
    chmodSync(binary, 0o755);

    const error = await startKora({
      binary,
      rpcUrl: KEYED,
      config: { allowedPrograms: [...KORA_ALLOWED_PROGRAMS], allowedTokens: [USDC_DEVNET_MINT], maxAllowedLamports: 1 },
      feePayerSecretKey: new Uint8Array(64),
      apiKey: "k",
    }).then(
      () => undefined,
      (caught: unknown) => caught as Error,
    );

    expect(error?.message).toMatch(/exited during startup/);
    expect(error?.message).toContain("https://devnet.provider.example");
    expect(error?.message).not.toContain("SECRETKEY");
  });
});
