import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEMO_POLICY } from "../../claude-demo/src/config.js";
import { ALLOWANCE_DIR, ConfigError, loadConfig } from "../src/config.js";

const OWNER = "CciCZMJsih7NY5pet9kc1siPSj7169WSFZoTTQ5dGezx";
const HOME = "/home/someone";
const base = { STINT_DEMO_HOME: HOME, STINT_DEMO_ALLOWANCE_OWNER: OWNER };

const problemsOf = (env: Record<string, string | undefined>): readonly string[] => {
  try {
    loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return error.problems;
    throw error;
  }
  throw new Error("no problem was found");
};

describe("the allowance demo's settings", () => {
  it("keeps its files in its own folder, with the first demo's defaults and policy, and nonce 0", () => {
    const config = loadConfig(base);
    expect(config).toMatchObject({
      home: HOME,
      dir: join(HOME, ALLOWANCE_DIR),
      gateUrl: "https://stint-demo.lxfoundry.ai",
      rpcUrl: "https://api.devnet.solana.com",
      owner: OWNER,
      nonce: 0n,
    });
    expect(ALLOWANCE_DIR).toBe("stint-demo-allowance");
    expect(config.policy).toBe(DEMO_POLICY);
  });

  it("takes a nonce, and treats an empty one as 0", () => {
    expect(loadConfig({ ...base, STINT_DEMO_ALLOWANCE_NONCE: "3" }).nonce).toBe(3n);
    expect(loadConfig({ ...base, STINT_DEMO_ALLOWANCE_NONCE: " " }).nonce).toBe(0n);
    expect(loadConfig({ ...base, STINT_DEMO_ALLOWANCE_NONCE: "18446744073709551615" }).nonce).toBe(18_446_744_073_709_551_615n);
  });

  it("names every problem at once, the first demo's included", () => {
    const problems = problemsOf({ STINT_DEMO_GATE_URL: "ftp://x" });
    expect(problems).toContain("STINT_DEMO_HOME is required: the folder that holds the agent's wallet");
    expect(problems).toContain("STINT_DEMO_ALLOWANCE_OWNER is required: the address of the owner whose allowance funds the sessions");
    expect(problems.some((problem) => problem.startsWith("STINT_DEMO_GATE_URL"))).toBe(true);
  });

  it("refuses an owner that is not an address", () => {
    expect(problemsOf({ ...base, STINT_DEMO_ALLOWANCE_OWNER: "not-an-address" })).toEqual([
      "STINT_DEMO_ALLOWANCE_OWNER must be a Solana address (a base58 public key)",
    ]);
  });

  it.each(["-1", "1.5", "x", "18446744073709551616"])("refuses the nonce %s", (nonce) => {
    expect(problemsOf({ ...base, STINT_DEMO_ALLOWANCE_NONCE: nonce })).toEqual([
      `STINT_DEMO_ALLOWANCE_NONCE must be a whole number from 0 to 18446744073709551615, got "${nonce}"`,
    ]);
  });
});
