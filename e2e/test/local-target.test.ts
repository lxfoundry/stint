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

  it("passes scenarios 1 and 22, now required, and reports every other scenario", async () => {
    const outcomes = await runScenarios(catalogue, stack.target, () => stack.context());
    expect(outcomes).toHaveLength(35);
    expect(outcomes.find((outcome) => outcome.id === 1)).toMatchObject({ status: "required", result: "pass" });
    expect(outcomes.find((outcome) => outcome.id === 22)).toMatchObject({ status: "required", result: "pass" });
    expect(outcomes.find((outcome) => outcome.id === 12)?.result).toBe("not applicable");
    expect(outcomes.filter((outcome) => outcome.result === "pending")).toHaveLength(32);
    expect(exitCodeFor(outcomes)).toBe(0);
  });

  it("gives scenarios control of the gate and sessions opened straight on the program", async () => {
    const context = stack.context();
    const url = context.gateUrl;
    expect(context.stack?.rentPayer).toBe(stack.facilitator.rentPayer);
    expect(context.stack?.rentPayer).toBe(stack.keys.rentPayer.signer.address);
    // One of each per stack: every context it makes shares them.
    expect(stack.context().stack).toBe(context.stack);
    expect(stack.context().direct).toBe(context.direct);

    await context.stack!.stopGate();
    await context.stack!.startGate();

    expect(stack.stream.url).toBe(url);
    expect((await fetch(`${url}/health`)).status).toBe(200);

    const buyer = await context.newBuyer(1_000_000n);
    const opened = await context.direct!.open({ buyer, seconds: 30 });
    expect(opened.rentPayer).not.toBe(stack.facilitator.rentPayer);
    expect(opened.receiverToken).toBe(stack.keys.sellerUsdcAccount);
    expect(opened.refundTo).toBe(buyer.usdcAccount);
  });
});
