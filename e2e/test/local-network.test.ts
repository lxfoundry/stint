import { fetchMint, fetchToken } from "@solana-program/token";
import { address, some } from "@solana/kit";
import { fetchSysvarClock } from "@solana/sysvars";
import { STINT_PROGRAM_ADDRESS } from "@lxfoundry/stint-program-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newHarnessKey, fundSol, type HarnessKey } from "../src/fixtures/keys.js";
import {
  SUBSCRIPTIONS_PROGRAM_ADDRESS,
  deployStintProgram,
  deploySubscriptionsProgram,
} from "../src/fixtures/programs.js";
import { USDC_DECIMALS, USDC_DEVNET_MINT, mintUsdc, writeUsdcMint } from "../src/fixtures/usdc.js";
import { startLocalNetwork, waitForNewSlot, type LocalNetwork } from "../src/network/surfnet.js";
import { simulateInstruction } from "../src/network/transactions.js";

describe("local network", () => {
  let network: LocalNetwork;
  let mintAuthority: HarnessKey;
  let freezeAuthority: HarnessKey;

  beforeAll(async () => {
    network = startLocalNetwork();
    mintAuthority = await newHarnessKey();
    freezeAuthority = await newHarnessKey();
    fundSol(network, mintAuthority.signer.address, 10);
    await writeUsdcMint(network, {
      mintAuthority: mintAuthority.signer.address,
      freezeAuthority: freezeAuthority.signer.address,
    });
    deployStintProgram(network);
    deploySubscriptionsProgram(network);
    await waitForNewSlot(network.rpc);
  });

  afterAll(() => network?.stop());

  it("produces blocks on a clock, so the chain's time moves without transactions (T3)", async () => {
    const before = await fetchSysvarClock(network.rpc);
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    const after = await fetchSysvarClock(network.rpc);
    expect(after.unixTimestamp - before.unixTimestamp).toBeGreaterThanOrEqual(2n);
  });

  it("writes USDC at its devnet address, with harness keys as its authorities", async () => {
    const mint = await fetchMint(network.rpc, USDC_DEVNET_MINT);
    expect(mint.data.decimals).toBe(USDC_DECIMALS);
    expect(mint.data.mintAuthority).toEqual(some(mintAuthority.signer.address));
    expect(mint.data.freezeAuthority).toEqual(some(freezeAuthority.signer.address));
  });

  it("mints USDC with an ordinary transaction", async () => {
    const owner = await newHarnessKey();
    const account = await mintUsdc(network.rpc, mintAuthority.signer, owner.signer.address, 1_000_000n);
    const token = await fetchToken(network.rpc, account);
    expect(token.data.amount).toBe(1_000_000n);
    expect(token.data.mint).toBe(USDC_DEVNET_MINT);
  });

  it("runs the Stint program at its program ID", async () => {
    const result = await simulateInstruction(network.rpc, mintAuthority.signer, STINT_PROGRAM_ADDRESS);
    expect(result.logs.some((line) => line.startsWith(`Program ${STINT_PROGRAM_ADDRESS} consumed`))).toBe(true);
  });

  it("runs the Subscriptions program from its devnet copy (spec section 14, question 6)", async () => {
    const result = await simulateInstruction(network.rpc, mintAuthority.signer, SUBSCRIPTIONS_PROGRAM_ADDRESS);
    expect(result.logs.some((line) => line.startsWith(`Program ${SUBSCRIPTIONS_PROGRAM_ADDRESS} consumed`))).toBe(true);
  });

  it("keeps the Subscriptions program at its devnet address", () => {
    expect(SUBSCRIPTIONS_PROGRAM_ADDRESS).toBe(address("De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44"));
  });
});
