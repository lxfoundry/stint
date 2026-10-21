import { fetchToken } from "@solana-program/token";
import { catalogue, exitCodeFor, runScenarios } from "@lxfoundry/stint-conformance";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startLocalStack, type LocalStack } from "../src/targets/local.js";

describe("local target", () => {
  let stack: LocalStack;

  beforeAll(async () => {
    stack = await startLocalStack();
  });

  afterAll(async () => {
    await stack?.stop();
  });

  it("offers chain control, stack control and the facilitator's API, but not allowance funding yet", () => {
    expect([...stack.target.capabilities].sort()).toEqual(["chain", "facilitatorApi", "stack"]);
  });

  it("creates the seller's USDC account", async () => {
    const account = await fetchToken(stack.network.rpc, stack.keys.sellerUsdcAccount);
    expect(account.data.owner).toBe(stack.keys.seller.signer.address);
  });

  it("reports every scenario of the catalogue, and passes while all are pending", async () => {
    const outcomes = await runScenarios(catalogue, stack.target, () => ({ target: stack.target }));
    expect(outcomes).toHaveLength(35);
    expect(outcomes.find((outcome) => outcome.id === 12)?.result).toBe("not applicable");
    expect(outcomes.filter((outcome) => outcome.result === "pending")).toHaveLength(34);
    expect(exitCodeFor(outcomes)).toBe(0);
  });
});
