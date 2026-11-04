import { generateKeyPairSigner } from "@solana/kit";
import { fetchSysvarClock } from "@solana/sysvars";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  allowanceAccounts,
  fetchMaybeRecurringDelegation,
  fetchMaybeSubscriptionAuthority,
  grantInstructions,
} from "@lxfoundry/stint-subscriptions-client";
import { revokeHeldAllowances } from "../src/devnet/allowances.js";
import { GRANT_LAMPORTS, createAllowanceControl } from "../src/fixtures/allowance.js";
import { newBuyer } from "../src/fixtures/buyers.js";
import { fundSol, newHarnessKey } from "../src/fixtures/keys.js";
import { USDC_DEVNET_MINT, mintUsdc } from "../src/fixtures/usdc.js";
import { waitForNewSlot } from "../src/network/surfnet.js";
import { sendInstructions } from "../src/network/transactions.js";
import { startLocalChain, type LocalChain } from "../src/targets/chain.js";

describe("allowances on the local network (spec §10.1, §12.3)", () => {
  let chain: LocalChain;

  beforeAll(async () => {
    chain = await startLocalChain();
  }, 60_000);
  afterAll(() => chain?.stop());

  it("grants a recurring delegation that starts now, and revokes it with the owner's authority", async () => {
    const rpc = chain.network.rpc;
    const control = createAllowanceControl({
      rpc,
      newOwner: async (usdc) => {
        const owner = await newBuyer(rpc, chain.keys.mintAuthority.signer, usdc);
        chain.network.surfnet.fundSol(owner.signer.address, Number(GRANT_LAMPORTS));
        await waitForNewSlot(rpc);
        return owner;
      },
      newAgent: () => generateKeyPairSigner(),
    });
    const grant = await control.grant({ usdc: 100_000n, perPeriod: 50_000n, periodSeconds: 3_600 });
    const stored = await fetchMaybeRecurringDelegation(rpc, grant.delegation, { commitment: "confirmed" });
    expect(stored.exists && stored.data).toMatchObject({ amountPerPeriod: 50_000n, periodLengthS: 3_600n, amountPulledInPeriod: 0n });
    const accounts = await allowanceAccounts({ owner: grant.owner.signer.address, agent: grant.agent.address, mint: USDC_DEVNET_MINT, nonce: 0n });
    expect(accounts.delegation).toBe(grant.delegation);

    await control.revoke(grant);
    expect((await fetchMaybeRecurringDelegation(rpc, grant.delegation, { commitment: "confirmed" })).exists).toBe(false);
    expect((await fetchMaybeSubscriptionAuthority(rpc, accounts.subscriptionAuthority, { commitment: "confirmed" })).exists).toBe(false);
  });

  it("finds and revokes what a held key granted, as the devnet clean-up does", async () => {
    const rpc = chain.network.rpc;
    const owner = await newHarnessKey();
    const agent = await newHarnessKey();
    fundSol(chain.network, owner.signer.address, 1);
    await waitForNewSlot(rpc);
    await mintUsdc(rpc, chain.keys.mintAuthority.signer, owner.signer.address, 100_000n);
    const clock = await fetchSysvarClock(rpc, { commitment: "confirmed" });
    const grant = await grantInstructions({
      owner: owner.signer,
      agent: agent.signer.address,
      mint: USDC_DEVNET_MINT,
      perPeriod: 50_000n,
      periodSeconds: 3_600n,
      expiresAt: BigInt(clock.unixTimestamp) + 3_600n,
      nonce: 0n,
    });
    await sendInstructions(rpc, owner.signer, grant);
    const accounts = await allowanceAccounts({ owner: owner.signer.address, agent: agent.signer.address, mint: USDC_DEVNET_MINT, nonce: 0n });
    const holders = new Map([
      [owner.signer.address, owner.signer],
      [agent.signer.address, agent.signer],
    ]);

    expect(await revokeHeldAllowances(rpc, rpc, chain.keys.mintAuthority.signer, holders, {})).toEqual([]);
    expect((await fetchMaybeRecurringDelegation(rpc, accounts.delegation, { commitment: "confirmed" })).exists).toBe(false);
    expect((await fetchMaybeSubscriptionAuthority(rpc, accounts.subscriptionAuthority, { commitment: "confirmed" })).exists).toBe(false);
  });
});
