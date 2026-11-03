import { fetchToken } from "@solana-program/token";
import { catalogue, exitCodeFor, runScenarios } from "@lxfoundry/stint-conformance";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startLocalStack, type LocalStack } from "../src/targets/local.js";

/**
 * The required scenarios, all passing on `local`. Together they take about three minutes: scenario 1 sleeps 7 s, 3 runs
 * about 25 s, 4 about 35 s, 5, 6 and 13 about 1 s each, 7 about 3 s, 9 about 15 s, 14 about 12 s, 16 about 15 s, 17 about 1 s, 18 about 1 s, 19 about 4 s, 24 about 9 s, 25 about 20 s, 26 about 20 s, 32 about 3 s and 34 about 35 s, so the test's limit is generous.
 */
const REQUIRED = [1, 2, 3, 4, 5, 6, 7, 9, 13, 14, 15, 16, 17, 18, 19, 22, 24, 25, 26, 32, 34];

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

  it("passes every required scenario, and reports the others", async () => {
    const outcomes = await runScenarios(catalogue, stack.target, () => stack.context());
    expect(outcomes).toHaveLength(35);
    for (const id of REQUIRED) {
      expect(outcomes.find((outcome) => outcome.id === id), `scenario ${id}`).toMatchObject({ status: "required", result: "pass" });
    }
    // Scenario 12 needs allowance funding, which `local` lacks; every other scenario that is not required is pending.
    expect(outcomes.find((outcome) => outcome.id === 12)?.result).toBe("not applicable");
    expect(outcomes.filter((outcome) => outcome.result === "pending")).toHaveLength(35 - 1 - REQUIRED.length);
    expect(exitCodeFor(outcomes)).toBe(0);
  }, 540_000);

  it("gives scenarios control of the gate and sessions opened straight on the program", async () => {
    const context = stack.context();
    const url = context.gateUrl;
    expect(context.stack?.rentPayer).toBe(stack.facilitator.rentPayer);
    expect(context.stack?.rentPayer).toBe(stack.keys.rentPayer.signer.address);
    // One of each per stack: every context it makes shares them.
    expect(stack.context().stack).toBe(context.stack);
    expect(stack.context().direct).toBe(context.direct);
    expect(stack.context().facilitator).toBe(context.facilitator);
    // The stack's API key is accepted: the payload is judged, not refused as unauthorised.
    expect(await context.facilitator!.verify({ x402Version: 1, accepted: {} as never, payload: {} }, {} as never)).toMatchObject({
      isValid: false,
      invalidReason: "invalid_x402_version",
    });

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
