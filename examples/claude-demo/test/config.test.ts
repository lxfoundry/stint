import { SOLANA_DEVNET, USDC_DEVNET } from "@lxfoundry/stint-x402";
import { describe, expect, it } from "vitest";
import { ConfigError, DEFAULT_GATE_URL, DEFAULT_RPC_URL, DEMO_POLICY, loadConfig } from "../src/config.js";

function problemsOf(env: Record<string, string>): string[] {
  try {
    loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return [...error.problems];
    throw error;
  }
  throw new Error("expected a configuration error");
}

describe("the demo's configuration", () => {
  it("needs only the folder, keeps its files in a stint-demo folder inside it, and takes the example gate and devnet's public node by default", () => {
    expect(loadConfig({ STINT_DEMO_HOME: "/home/someone" })).toEqual({
      home: "/home/someone",
      dir: "/home/someone/stint-demo",
      gateUrl: DEFAULT_GATE_URL,
      rpcUrl: DEFAULT_RPC_URL,
      policy: DEMO_POLICY,
    });
  });

  it("takes another gate, without its trailing slash, and another node; an empty value is the default", () => {
    expect(
      loadConfig({ STINT_DEMO_HOME: "/h", STINT_DEMO_GATE_URL: "http://127.0.0.1:8080/", STINT_DEMO_RPC_URL: "https://devnet.example/?api-key=k" }),
    ).toMatchObject({ gateUrl: "http://127.0.0.1:8080", rpcUrl: "https://devnet.example/?api-key=k" });
    expect(loadConfig({ STINT_DEMO_HOME: "/h", STINT_DEMO_GATE_URL: "" }).gateUrl).toBe(DEFAULT_GATE_URL);
  });

  it("refuses a missing or relative folder, and URLs it cannot use, quoting no URL", () => {
    expect(problemsOf({})).toEqual(["STINT_DEMO_HOME is required: the folder that holds the agent's wallet"]);
    expect(problemsOf({ STINT_DEMO_HOME: "stint-demo", STINT_DEMO_GATE_URL: "https://user:pw@gate.example", STINT_DEMO_RPC_URL: "ws://devnet.example" })).toEqual([
      'STINT_DEMO_HOME must be an absolute path, got "stint-demo"',
      "STINT_DEMO_GATE_URL must be an http or https URL, with no credentials, query or fragment",
      "STINT_DEMO_RPC_URL must be an http or https URL, with no credentials",
    ]);
  });

  it("spends within the demo's limits, on devnet, in devnet USDC", () => {
    expect(DEMO_POLICY).toEqual({
      networks: [SOLANA_DEVNET],
      assets: [USDC_DEVNET],
      maxRate: 1_000n,
      maxPerSession: 300_000n,
      budget: { amount: 2_000_000n, periodSeconds: 3_600 },
    });
  });
});
