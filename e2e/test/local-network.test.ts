import { fetchMint, fetchToken } from "@solana-program/token";
import { address, generateKeyPairSigner, some, type Address } from "@solana/kit";
import { fetchSysvarClock } from "@solana/sysvars";
import { rejectedWithProgramError } from "@lxfoundry/stint-conformance";
import { STINT_PROGRAM_ADDRESS } from "@lxfoundry/stint-program-client";
import {
  allowanceAccounts,
  allowancePullInstruction,
  fetchMaybeRecurringDelegation,
  grantInstructions,
} from "@lxfoundry/stint-subscriptions-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newHarnessKey, fundSol, type HarnessKey } from "../src/fixtures/keys.js";
import {
  SUBSCRIPTIONS_PROGRAM_ADDRESS,
  deployStintProgram,
  deploySubscriptionsProgram,
} from "../src/fixtures/programs.js";
import { USDC_DECIMALS, USDC_DEVNET_MINT, createUsdcAccount, mintUsdc, writeUsdcMint } from "../src/fixtures/usdc.js";
import { startLocalNetwork, waitForNewSlot, type LocalNetwork } from "../src/network/surfnet.js";
import { sendInstructions, simulateInstruction } from "../src/network/transactions.js";

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

  it("runs the Subscriptions program from its devnet copy: a pull lands, and one over the cap is refused (spec section 14, question 6)", async () => {
    const rpc = network.rpc;
    const owner = await newHarnessKey();
    const agent = await generateKeyPairSigner();
    fundSol(network, owner.signer.address, 1);
    await waitForNewSlot(rpc);
    const ownerToken = await mintUsdc(rpc, mintAuthority.signer, owner.signer.address, 100_000n);
    const clock = await fetchSysvarClock(rpc, { commitment: "confirmed" });
    await sendInstructions(
      rpc,
      owner.signer,
      await grantInstructions({
        owner: owner.signer,
        agent: agent.address,
        mint: USDC_DEVNET_MINT,
        perPeriod: 50_000n,
        periodSeconds: 3_600n,
        expiresAt: BigInt(clock.unixTimestamp) + 3_600n,
        nonce: 0n,
      }),
    );
    const destination = await createUsdcAccount(rpc, mintAuthority.signer, (await generateKeyPairSigner()).address);
    // The agent signs as the delegatee; a harness key pays the fee.
    const pull = (amount: bigint) =>
      allowancePullInstruction({ owner: owner.signer.address, agent, mint: USDC_DEVNET_MINT, nonce: 0n, destination, amount });
    await sendInstructions(rpc, mintAuthority.signer, [await pull(10_000n)]);
    const balance = async (account: Address) => (await rpc.getTokenAccountBalance(account, { commitment: "confirmed" }).send()).value.amount;
    expect(await balance(destination)).toBe("10000");
    expect(await balance(ownerToken)).toBe("90000");
    const { delegation } = await allowanceAccounts({ owner: owner.signer.address, agent: agent.address, mint: USDC_DEVNET_MINT, nonce: 0n });
    const stored = await fetchMaybeRecurringDelegation(rpc, delegation, { commitment: "confirmed" });
    expect(stored.exists && stored.data.amountPulledInPeriod).toBe(10_000n);

    const over = await sendInstructions(rpc, mintAuthority.signer, [await pull(45_000n)]).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(rejectedWithProgramError(over, 400)).toBe(true);
  });

  it("keeps the Subscriptions program at its devnet address", () => {
    expect(SUBSCRIPTIONS_PROGRAM_ADDRESS).toBe(address("De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44"));
  });
});
