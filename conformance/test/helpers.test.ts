import { generateKeyPairSigner } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { buyerClient, closePollMs, sessionSeconds } from "../src/helpers.js";
import type { Target } from "../src/types.js";

describe("buyerClient", () => {
  it("is a client for the buyer's key whose period budget is 1 USDC", async () => {
    const signer = await generateKeyPairSigner();
    expect(buyerClient({ signer, usdcAccount: signer.address }).remainingBudget()).toBe(1_000_000n);
  });
});

describe("sessionSeconds", () => {
  const target = (name: Target["name"]): Target => ({ name, capabilities: new Set() });

  it("is as long as asked on a network of ours, and ten seconds longer on devnet, where each step takes seconds", () => {
    expect(sessionSeconds(target("local"), 8)).toBe(8);
    expect(sessionSeconds(target("external"), 8)).toBe(8);
    expect(sessionSeconds(target("devnet"), 8)).toBe(18);
  });

  it("is polled for a close every second on a network of ours, and every two seconds on devnet, which rate-limits", () => {
    expect(closePollMs(target("local"))).toBe(1_000);
    expect(closePollMs(target("external"))).toBe(1_000);
    expect(closePollMs(target("devnet"))).toBe(2_000);
  });
});
