import { fetchToken } from "@solana-program/token";
import { generateKeyPairSigner, isNone, isSome, type Address, type Rpc, type SolanaRpcApi } from "@solana/kit";
import { fetchSysvarClock } from "@solana/sysvars";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  allowanceAccounts,
  fetchMaybeRecurringDelegation,
  fetchMaybeSubscriptionAuthority,
  grantInstructions,
} from "@lxfoundry/stint-subscriptions-client";
import type { RetryOptions } from "@lxfoundry/stint-x402";
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

  /** The grant fixture on the local chain, reading through `rpc`; `onPair` sees each owner and agent the fixture makes. */
  const controlOver = (
    rpc: Rpc<SolanaRpcApi>,
    readRetry: RetryOptions,
    onPair: (pair: { owner: Address; agent: Address }) => Promise<void> = async () => {},
  ) => {
    let owner: Address | undefined;
    return createAllowanceControl({
      rpc,
      readRetry,
      newOwner: async (usdc) => {
        const buyer = await newBuyer(rpc, chain.keys.mintAuthority.signer, usdc);
        owner = buyer.signer.address;
        chain.network.surfnet.fundSol(buyer.signer.address, Number(GRANT_LAMPORTS));
        await waitForNewSlot(rpc);
        return buyer;
      },
      newAgent: async () => {
        const agent = await generateKeyPairSigner();
        await onPair({ owner: owner!, agent: agent.address });
        return agent;
      },
    });
  };

  /**
   * A node that is behind the chain: each of the first `lag` reads of an account that `lagging` names answers that the account
   * does not exist, as a node that has not yet applied the block does. `reads` lists every read of such an account.
   */
  const nodeBehind = (rpc: Rpc<SolanaRpcApi>, lagging: Map<Address, number>, reads: Address[]): Rpc<SolanaRpcApi> =>
    new Proxy(rpc, {
      get(target, property, receiver) {
        const method = Reflect.get(target, property, receiver) as (...args: unknown[]) => { send(...args: unknown[]): Promise<unknown> };
        if (property !== "getAccountInfo") return method;
        return (account: Address, ...rest: unknown[]) => {
          const request = method(account, ...rest);
          if (!lagging.has(account)) return request;
          return {
            send: async (...args: unknown[]) => {
              reads.push(account);
              const left = lagging.get(account)!;
              if (left <= 0) return request.send(...args);
              lagging.set(account, left - 1);
              return { context: { slot: 0n }, value: null };
            },
          };
        };
      },
    });

  const delegationOf = async (pair: { owner: Address; agent: Address }) =>
    (await allowanceAccounts({ ...pair, mint: USDC_DEVNET_MINT, nonce: 0n })).delegation;

  it("waits until a node shows the delegation before it returns the grant", async () => {
    const lagging = new Map<Address, number>();
    const reads: Address[] = [];
    const control = controlOver(nodeBehind(chain.network.rpc, lagging, reads), { attempts: 5, delayMs: 10 }, async (pair) => {
      lagging.set(await delegationOf(pair), 2);
    });

    const grant = await control.grant({ usdc: 100_000n, perPeriod: 50_000n, periodSeconds: 3_600 });

    // Two reads that find nothing, then the one that finds it.
    expect(reads).toEqual([grant.delegation, grant.delegation, grant.delegation]);
  });

  it("fails the grant, and says so, when the delegation never shows within the target's reads", async () => {
    const lagging = new Map<Address, number>();
    const reads: Address[] = [];
    const control = controlOver(nodeBehind(chain.network.rpc, lagging, reads), { attempts: 3, delayMs: 10 }, async (pair) => {
      lagging.set(await delegationOf(pair), 1_000);
    });

    await expect(control.grant({ usdc: 100_000n, perPeriod: 50_000n, periodSeconds: 3_600 })).rejects.toThrow(
      /delegation [1-9A-HJ-NP-Za-km-z]{32,44} did not show at confirmed in 3 reads/,
    );
    expect(reads).toHaveLength(3);
  });

  it("grants a recurring delegation that starts now, and revokes it with the owner's authority", async () => {
    const rpc = chain.network.rpc;
    const control = controlOver(rpc, { attempts: 1, delayMs: 0 });
    const grant = await control.grant({ usdc: 100_000n, perPeriod: 50_000n, periodSeconds: 3_600 });
    const stored = await fetchMaybeRecurringDelegation(rpc, grant.delegation, { commitment: "confirmed" });
    expect(stored.exists && stored.data).toMatchObject({ amountPerPeriod: 50_000n, periodLengthS: 3_600n, amountPulledInPeriod: 0n });
    const accounts = await allowanceAccounts({ owner: grant.owner.signer.address, agent: grant.agent.address, mint: USDC_DEVNET_MINT, nonce: 0n });
    expect(accounts.delegation).toBe(grant.delegation);
    // The grant makes the authority the delegate of the owner's USDC account, for all of it.
    const delegated = (await fetchToken(rpc, grant.owner.usdcAccount, { commitment: "confirmed" })).data;
    expect(isSome(delegated.delegate) && delegated.delegate.value).toBe(accounts.subscriptionAuthority);
    expect(delegated.delegatedAmount).toBe(2n ** 64n - 1n);

    await control.revoke(grant);
    expect((await fetchMaybeRecurringDelegation(rpc, grant.delegation, { commitment: "confirmed" })).exists).toBe(false);
    expect((await fetchMaybeSubscriptionAuthority(rpc, accounts.subscriptionAuthority, { commitment: "confirmed" })).exists).toBe(false);
    // Closing the authority also takes its approval off the owner's USDC account: the account's one delegate slot is free.
    const revoked = (await fetchToken(rpc, grant.owner.usdcAccount, { commitment: "confirmed" })).data;
    expect(isNone(revoked.delegate)).toBe(true);
    expect(revoked.delegatedAmount).toBe(0n);
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
