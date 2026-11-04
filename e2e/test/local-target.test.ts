import { fetchToken } from "@solana-program/token";
import { catalogue } from "@lxfoundry/stint-conformance";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startLocalStack, type LocalStack } from "../src/targets/local.js";

/**
 * The local target itself. `pnpm e2e:local` runs the scenarios on it and exits 1 when a required one fails;
 * `conformance/test/catalogue.test.ts` pins which scenarios are required.
 */
describe("local target", () => {
  let stack: LocalStack;

  beforeAll(async () => {
    stack = await startLocalStack();
  });

  afterAll(async () => {
    await stack?.stop();
  });

  it("offers chain control, stack control, the facilitator's API and allowance funding", () => {
    expect([...stack.target.capabilities].sort()).toEqual(["allowance", "chain", "facilitatorApi", "stack"]);
    expect(stack.context().allowance).toBeDefined();
  });

  it("offers what every required scenario needs, so that a run of the scenarios runs each one", () => {
    // A scenario whose needs the target lacks is reported not applicable, which does not fail a run.
    const required = catalogue.filter((scenario) => scenario.status === "required");
    expect(required.length).toBeGreaterThan(0);
    for (const scenario of required) {
      expect(scenario.needs.filter((capability) => !stack.target.capabilities.has(capability)), `scenario ${scenario.id}`).toEqual([]);
    }
  });

  it("creates the seller's USDC account", async () => {
    const account = await fetchToken(stack.network.rpc, stack.keys.sellerUsdcAccount);
    expect(account.data.owner).toBe(stack.keys.seller.signer.address);
  });

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
