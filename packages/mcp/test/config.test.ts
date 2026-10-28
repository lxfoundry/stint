import { createKeyPairSignerFromPrivateKeyBytes, getAddressEncoder } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/index.js";

const MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const SELLER = "5iCYPqLjCWw5KzQTU6NBUhR2hxg5SWGmS1ctUn3qESvr";

/** A keypair file as the Solana CLI writes it: the 32-byte seed, then the 32-byte public key. */
async function keyFile(): Promise<{ readonly json: string; readonly address: string }> {
  const seed = crypto.getRandomValues(new Uint8Array(32));
  const signer = await createKeyPairSignerFromPrivateKeyBytes(seed);
  return { json: JSON.stringify([...seed, ...getAddressEncoder().encode(signer.address)]), address: signer.address };
}

const required = {
  STINT_KEYPAIR_PATH: "/keys/agent.json",
  STINT_MAX_RATE: "5000",
  STINT_MAX_PER_SESSION: "600000",
  STINT_BUDGET_AMOUNT: "2000000",
  STINT_BUDGET_PERIOD_SECONDS: "3600",
};

async function problemsOf(env: Record<string, string>, json?: string): Promise<readonly string[]> {
  const file = json ?? (await keyFile()).json;
  try {
    await loadConfig(env, () => file);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as ConfigError).problems;
  }
  throw new Error("loadConfig accepted a bad configuration");
}

describe("loadConfig", () => {
  it("reads the key and the required caps, and leaves the rest to the policy's defaults", async () => {
    const file = await keyFile();
    const config = await loadConfig(required, () => file.json);
    expect(config.signer.address).toBe(file.address);
    expect(config.policy).toEqual({
      maxRate: 5_000n,
      maxPerSession: 600_000n,
      budget: { amount: 2_000_000n, periodSeconds: 3_600 },
    });
  });

  it("reads the optional limits and allowlists", async () => {
    const file = await keyFile();
    const config = await loadConfig(
      {
        ...required,
        STINT_MAX_MIN_SECONDS: "60",
        STINT_SELLERS: ` ${SELLER}, ${MINT} `,
        STINT_PROGRAMS: SELLER,
        STINT_NETWORKS: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
        STINT_ASSETS: `${MINT}:6`,
      },
      () => file.json,
    );
    expect(config.policy).toMatchObject({
      maxMinSeconds: 60,
      sellers: [SELLER, MINT],
      programs: [SELLER],
      networks: ["solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"],
      assets: [{ mint: MINT, decimals: 6 }],
    });
  });

  it("names every missing required variable at once", async () => {
    const problems = await problemsOf({});
    expect(problems).toEqual([
      "STINT_KEYPAIR_PATH is required",
      "STINT_MAX_RATE is required",
      "STINT_MAX_PER_SESSION is required",
      "STINT_BUDGET_AMOUNT is required",
      "STINT_BUDGET_PERIOD_SECONDS is required",
    ]);
  });

  it("refuses malformed numbers, addresses and assets", async () => {
    const problems = await problemsOf({
      ...required,
      STINT_MAX_RATE: "fast",
      STINT_BUDGET_PERIOD_SECONDS: "0",
      STINT_SELLERS: `${SELLER},nope`,
      STINT_ASSETS: `${MINT},${MINT}:x`,
    });
    expect(problems).toHaveLength(5);
    expect(problems.join("\n")).toMatch(/STINT_MAX_RATE must be an integer of at least 1, got "fast"/);
    expect(problems.join("\n")).toMatch(/STINT_BUDGET_PERIOD_SECONDS must be an integer of at least 1, got "0"/);
    expect(problems.join("\n")).toMatch(/STINT_SELLERS holds invalid addresses: nope/);
  });

  it("refuses a key file that does not hold 64 bytes, or is not JSON", async () => {
    expect((await problemsOf(required, "[1,2,3]"))[0]).toMatch(/STINT_KEYPAIR_PATH \/keys\/agent.json: .*64 bytes/);
    expect((await problemsOf(required, "not json"))[0]).toMatch(/STINT_KEYPAIR_PATH/);
  });

  it("never quotes the key file in a problem", async () => {
    // A JSON parser's error message quotes the start of its input.
    const problems = await problemsOf(required, "hunter2-looks-like-a-secret");
    expect(problems.join("\n")).not.toContain("hunter2");
    expect(problems.join("\n")).toContain("STINT_KEYPAIR_PATH /keys/agent.json");
  });

  it("refuses a key file whose public half is not the seed's", async () => {
    const seed = crypto.getRandomValues(new Uint8Array(32));
    const other = await keyFile();
    const mismatched = JSON.stringify([...seed, ...JSON.parse(other.json).slice(32)]);
    expect((await problemsOf(required, mismatched))[0]).toMatch(/STINT_KEYPAIR_PATH/);
  });
});
