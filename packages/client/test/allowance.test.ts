import { AccountState, TOKEN_PROGRAM_ADDRESS, getTokenEncoder } from "@solana-program/token";
import {
  address,
  generateKeyPairSigner,
  none,
  some,
  type Address,
  type KeyPairSigner,
  type Rpc,
  type SolanaRpcApi,
} from "@solana/kit";
import { SYSVAR_CLOCK_ADDRESS, getSysvarClockEncoder } from "@solana/sysvars";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseOpenInstruction } from "@lxfoundry/stint-program-client";
import {
  SUBSCRIPTIONS_PROGRAM_ADDRESS,
  allowanceAccounts,
  getRecurringDelegationEncoder,
} from "@lxfoundry/stint-subscriptions-client";
import { inspectTransaction, readElapsedPayload } from "@lxfoundry/stint-x402";
import { allowanceShortfall, createSessionTools, createStintClient, readAllowance, type Policy } from "../src/index.js";
import { accountsRpc } from "./accounts-rpc.js";
import { startTestGate, type TestGate } from "./gate.js";

const MINT = address("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const SYSVAR_OWNER = address("Sysvar1111111111111111111111111111111111111");
const policy: Policy = { maxRate: 1_000n, maxPerSession: 100_000n, budget: { amount: 40_000n, periodSeconds: 3_600 } };

/** The chain as the client reads it: a delegation from `owner` to `agent` (unless `granted` is false), the owner's USDC and the clock. */
async function chain(input: {
  readonly owner: Address;
  readonly agent: Address;
  readonly pulled: bigint;
  readonly balance: bigint;
  readonly now: bigint;
  readonly expiryTs?: bigint;
  readonly granted?: boolean;
  /** The owner's account's SPL Token delegate: by default the Subscription Authority; null for none, as after a revoke. */
  readonly delegate?: Address | null;
}): Promise<Rpc<SolanaRpcApi>> {
  const accounts = await allowanceAccounts({ owner: input.owner, agent: input.agent, mint: MINT, nonce: 0n });
  const map = new Map<Address, { owner: Address; data: Uint8Array }>();
  if (input.granted !== false) {
    const delegation = getRecurringDelegationEncoder().encode({
      header: { discriminator: 3, version: 1, bump: 255, delegator: input.owner, delegatee: input.agent, payer: input.owner, initId: 36n },
      subscriptionAuthority: accounts.subscriptionAuthority,
      mint: MINT,
      currentPeriodStartTs: 1_000n,
      periodLengthS: 3_600n,
      expiryTs: input.expiryTs ?? 0n,
      amountPerPeriod: 50_000n,
      amountPulledInPeriod: input.pulled,
    });
    map.set(accounts.delegation, { owner: SUBSCRIPTIONS_PROGRAM_ADDRESS, data: Uint8Array.from(delegation) });
  }
  const token = getTokenEncoder().encode({
    mint: MINT,
    owner: input.owner,
    amount: input.balance,
    delegate: input.delegate === null ? none() : some(input.delegate ?? accounts.subscriptionAuthority),
    state: AccountState.Initialized,
    isNative: none(),
    delegatedAmount: input.delegate === null ? 0n : 2n ** 64n - 1n,
    closeAuthority: none(),
  });
  map.set(accounts.ownerToken, { owner: TOKEN_PROGRAM_ADDRESS, data: Uint8Array.from(token) });
  const clock = getSysvarClockEncoder().encode({
    slot: 1n,
    epochStartTimestamp: 0n,
    epoch: 0n,
    leaderScheduleEpoch: 0n,
    unixTimestamp: input.now,
  } as never);
  map.set(SYSVAR_CLOCK_ADDRESS, { owner: SYSVAR_OWNER, data: Uint8Array.from(clock) });
  return accountsRpc(map);
}

describe("allowance funding in the client (spec §10.2, §10.3)", () => {
  let agent: KeyPairSigner;
  let owner: Address;
  let gate: TestGate;

  beforeEach(async () => {
    agent = await generateKeyPairSigner();
    owner = (await generateKeyPairSigner()).address;
    gate = await startTestGate(agent.address);
  });
  afterEach(async () => {
    await gate.stop();
    expect(gate.escaped).toEqual([]);
  });

  it("funds an open from the allowance: one pull, the owner as refund owner, signed by the agent only", async () => {
    const client = createStintClient({ signer: agent, policy, allowance: { owner } });
    expect(client.funding).toEqual({ kind: "allowance", owner, nonce: 0n });
    await client.open(gate.url, { seconds: 30 });
    const tx = inspectTransaction(readElapsedPayload(gate.payments[0]!)!.transaction)!;
    expect([...tx.signed]).toEqual([agent.address]);
    expect(tx.instructions[1]!.programAddress).toBe(SUBSCRIPTIONS_PROGRAM_ADDRESS);
    expect(parseOpenInstruction(tx.instructions[2] as never).accounts.refundOwner.address).toBe(owner);
  });

  it("with a node, refuses before signing a payment the allowance cannot fund, and locks nothing", async () => {
    const rpc = await chain({ owner, agent: agent.address, pulled: 30_000n, balance: 1_000_000n, now: 1_050n });
    const client = createStintClient({ signer: agent, policy, allowance: { owner }, rpc });
    await expect(client.open(gate.url, { seconds: 30 })).rejects.toThrow(/allowance for this period is used up/);
    expect(gate.payments).toHaveLength(0);
    expect(client.remainingBudget()).toBe(40_000n);
  });

  it("with a node, pays when the allowance covers the payment", async () => {
    const rpc = await chain({ owner, agent: agent.address, pulled: 20_000n, balance: 1_000_000n, now: 1_050n });
    const client = createStintClient({ signer: agent, policy, allowance: { owner }, rpc });
    await client.open(gate.url, { seconds: 30 });
    expect(gate.payments).toHaveLength(1);
  });

  it("says why an allowance cannot fund a payment", async () => {
    const read = async (input: Partial<Parameters<typeof chain>[0]>) =>
      readAllowance(await chain({ owner, agent: agent.address, pulled: 0n, balance: 1_000_000n, now: 1_050n, ...input }), {
        owner,
        agent: agent.address,
        mint: MINT,
        nonce: 0n,
      });
    expect(allowanceShortfall(await read({}), 30_000n)).toBeUndefined();
    expect(allowanceShortfall(await read({ granted: false }), 30_000n)).toMatch(/no allowance/);
    expect(allowanceShortfall(await read({ balance: 10_000n }), 30_000n)).toMatch(/holds 10000/);
    expect(allowanceShortfall(await read({ expiryTs: 1_040n }), 30_000n)).toMatch(/expired/);
    expect(allowanceShortfall(await read({ pulled: 30_000n }), 30_000n)).toMatch(/30000 of 50000 pulled, 20000 left/);
    expect(allowanceShortfall(await read({}), 60_000n)).toMatch(/larger than the allowance's cap per period/);
    expect(allowanceShortfall(await read({ delegate: null }), 30_000n)).toMatch(/delegate/);
    // Another delegate, even for the whole balance: the Subscription Authority cannot move the owner's tokens.
    expect(allowanceShortfall(await read({ delegate: (await generateKeyPairSigner()).address }), 30_000n)).toMatch(/delegate/);
  });

  it("reports the allowance through stint_allowance", async () => {
    const own = createSessionTools(createStintClient({ signer: agent, policy }));
    expect(await own.tools.stint_allowance.run({})).toEqual({ funding: "own" });
    const blind = createSessionTools(createStintClient({ signer: agent, policy, allowance: { owner } }));
    expect(await blind.tools.stint_allowance.run({})).toEqual({ funding: "allowance", owner });
    const rpc = await chain({ owner, agent: agent.address, pulled: 20_000n, balance: 900_000n, now: 1_050n });
    const seeing = createSessionTools(createStintClient({ signer: agent, policy, allowance: { owner }, rpc }));
    expect(await seeing.tools.stint_allowance.run({})).toEqual({
      funding: "allowance",
      owner,
      status: "active",
      perPeriod: "50000",
      pulledThisPeriod: "20000",
      leftThisPeriod: "30000",
      periodEndsAt: 4_600,
      ownerBalance: "900000",
    });
  });
});
