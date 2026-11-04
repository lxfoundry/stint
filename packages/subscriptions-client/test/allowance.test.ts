import { TOKEN_PROGRAM_ADDRESS, findAssociatedTokenPda } from "@solana-program/token";
import { address, generateKeyPairSigner, getAddressEncoder, getProgramDerivedAddress, getU64Encoder } from "@solana/kit";
import { describe, expect, it } from "vitest";
import {
  SUBSCRIPTIONS_PROGRAM_ADDRESS,
  SubscriptionsInstruction,
  UNKNOWN_INIT_ID,
  allowanceAccounts,
  allowancePullInstruction,
  grantInstructions,
  identifySubscriptionsInstruction,
  parseCreateRecurringDelegationInstruction,
  parseTransferRecurringInstruction,
  periodState,
  revokeInstructions,
} from "../src/index.js";

const MINT = address("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");

const delegation = (change: Partial<Parameters<typeof periodState>[0]> = {}) => ({
  currentPeriodStartTs: 1_000n,
  periodLengthS: 100n,
  expiryTs: 0n,
  amountPerPeriod: 500n,
  amountPulledInPeriod: 200n,
  ...change,
});

describe("periodState: the program's rule for the next pull", () => {
  it("leaves a period alone while it runs", () => {
    expect(periodState(delegation(), 1_050n)).toEqual({
      perPeriod: 500n,
      pulled: 200n,
      available: 300n,
      periodStart: 1_000n,
      periodEnd: 1_100n,
      expiresAt: 0n,
      status: "active",
    });
  });

  it("starts a new period with nothing pulled once one has elapsed, skipping whole periods", () => {
    expect(periodState(delegation(), 1_100n)).toMatchObject({ periodStart: 1_100n, pulled: 0n, available: 500n, periodEnd: 1_200n });
    expect(periodState(delegation(), 1_350n)).toMatchObject({ periodStart: 1_300n, pulled: 0n });
  });

  it("advances no further than the last period start before a finite expiry, and ends that period at the expiry", () => {
    // Expiry 1,300: at 1,300 the next boundary is the expiry itself, so the period that started at 1,200 is the last.
    expect(periodState(delegation({ expiryTs: 1_300n }), 1_300n)).toMatchObject({
      periodStart: 1_200n,
      periodEnd: 1_300n,
      pulled: 0n,
      status: "active",
    });
    expect(periodState(delegation({ expiryTs: 1_250n }), 1_240n)).toMatchObject({ periodStart: 1_200n, periodEnd: 1_250n });
  });

  it("offers nothing after the expiry, a hard stop, or before the period's start", () => {
    expect(periodState(delegation({ expiryTs: 1_250n }), 1_250n).status).toBe("active");
    expect(periodState(delegation({ expiryTs: 1_250n }), 1_251n)).toMatchObject({ status: "expired", available: 0n });
    expect(periodState(delegation(), 999n)).toMatchObject({ status: "notStarted", available: 0n });
  });

  it("never reports less than nothing left", () => {
    expect(periodState(delegation({ amountPulledInPeriod: 600n }), 1_050n).available).toBe(0n);
  });
});

describe("the accounts and instructions of an allowance", () => {
  it("derives the program's PDAs and the owner's associated token account", async () => {
    const owner = (await generateKeyPairSigner()).address;
    const agent = (await generateKeyPairSigner()).address;
    const accounts = await allowanceAccounts({ owner, agent, mint: MINT, nonce: 7n });
    const key = getAddressEncoder();
    const [authority] = await getProgramDerivedAddress({
      programAddress: SUBSCRIPTIONS_PROGRAM_ADDRESS,
      seeds: ["SubscriptionAuthority", key.encode(owner), key.encode(MINT)],
    });
    const [delegationPda] = await getProgramDerivedAddress({
      programAddress: SUBSCRIPTIONS_PROGRAM_ADDRESS,
      seeds: ["delegation", key.encode(authority), key.encode(owner), key.encode(agent), getU64Encoder().encode(7n)],
    });
    const [ownerToken] = await findAssociatedTokenPda({ owner, mint: MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    expect(accounts).toEqual({ subscriptionAuthority: authority, delegation: delegationPda, ownerToken });
  });

  it("pulls exactly the amount from the owner's account into the destination, signed by the agent as delegatee", async () => {
    const agent = await generateKeyPairSigner();
    const owner = (await generateKeyPairSigner()).address;
    const vault = (await generateKeyPairSigner()).address;
    const ix = await allowancePullInstruction({ owner, agent, mint: MINT, nonce: 0n, destination: vault, amount: 30_000n });
    expect(ix.programAddress).toBe(SUBSCRIPTIONS_PROGRAM_ADDRESS);
    expect(identifySubscriptionsInstruction(ix as never)).toBe(SubscriptionsInstruction.TransferRecurring);
    const parsed = parseTransferRecurringInstruction(ix as never);
    const accounts = await allowanceAccounts({ owner, agent: agent.address, mint: MINT, nonce: 0n });
    expect(parsed.accounts.delegationPda.address).toBe(accounts.delegation);
    expect(parsed.accounts.subscriptionAuthority.address).toBe(accounts.subscriptionAuthority);
    expect(parsed.accounts.delegatorAta.address).toBe(accounts.ownerToken);
    expect(parsed.accounts.receiverAta.address).toBe(vault);
    expect(parsed.accounts.tokenProgram.address).toBe(TOKEN_PROGRAM_ADDRESS);
    expect(parsed.accounts.delegatee.address).toBe(agent.address);
    expect(parsed.data.transferData).toEqual({ amount: 30_000n, delegator: owner, mint: MINT });
  });

  it("grants in one transaction that creates the owner's authority, starting when it lands", async () => {
    const owner = await generateKeyPairSigner();
    const agent = (await generateKeyPairSigner()).address;
    const ixs = await grantInstructions({ owner, agent, mint: MINT, perPeriod: 300_000n, periodSeconds: 3_600n, expiresAt: 2_000_000_000n, nonce: 0n });
    expect(ixs.map((ix) => identifySubscriptionsInstruction(ix as never))).toEqual([
      SubscriptionsInstruction.InitSubscriptionAuthority,
      SubscriptionsInstruction.CreateRecurringDelegation,
    ]);
    expect(parseCreateRecurringDelegationInstruction(ixs[1] as never).data.recurringDelegation).toEqual({
      nonce: 0n,
      amountPerPeriod: 300_000n,
      periodLengthS: 3_600n,
      startTs: 0n,
      expiryTs: 2_000_000_000n,
      expectedSubscriptionAuthorityInitId: UNKNOWN_INIT_ID,
    });
  });

  it("grants with the delegation alone when the authority exists, naming its initId", async () => {
    const owner = await generateKeyPairSigner();
    const agent = (await generateKeyPairSigner()).address;
    const ixs = await grantInstructions({ owner, agent, mint: MINT, perPeriod: 1n, periodSeconds: 60n, expiresAt: 2_000_000_000n, nonce: 1n, existingInitId: 36n });
    expect(ixs).toHaveLength(1);
    expect(parseCreateRecurringDelegationInstruction(ixs[0] as never).data.recurringDelegation.expectedSubscriptionAuthorityInitId).toBe(36n);
  });

  it("refuses a grant without an expiry: a delegation that starts on landing must end", async () => {
    const owner = await generateKeyPairSigner();
    const agent = (await generateKeyPairSigner()).address;
    await expect(grantInstructions({ owner, agent, mint: MINT, perPeriod: 1n, periodSeconds: 60n, expiresAt: 0n, nonce: 0n })).rejects.toThrow(/expiry/);
  });

  it("revokes the delegation, and closes the authority only when asked", async () => {
    const owner = await generateKeyPairSigner();
    const delegationAddress = (await generateKeyPairSigner()).address;
    const authority = (await generateKeyPairSigner()).address;
    const kinds = (ixs: readonly unknown[]) => ixs.map((ix) => identifySubscriptionsInstruction(ix as never));
    expect(kinds(revokeInstructions({ owner, delegation: delegationAddress }))).toEqual([SubscriptionsInstruction.RevokeDelegation]);
    expect(kinds(revokeInstructions({ owner, delegation: delegationAddress, closeAuthority: authority }))).toEqual([
      SubscriptionsInstruction.RevokeDelegation,
      SubscriptionsInstruction.CloseSubscriptionAuthority,
    ]);
  });
});
