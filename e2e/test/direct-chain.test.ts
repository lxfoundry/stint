import { fetchToken } from "@solana-program/token";
import { sleep, type DirectChain } from "@lxfoundry/stint-conformance";
import { CloseKind, fetchMaybeSession, fetchSession } from "@lxfoundry/stint-program-client";
import { fetchClosedEvent, lamportBalances, tokenBalanceChanges } from "@lxfoundry/stint-x402";
import type { Address, KeyPairSigner } from "@solana/kit";
import { fetchSysvarClock } from "@solana/sysvars";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newBuyer } from "../src/fixtures/buyers.js";
import { fundSol, newHarnessKey } from "../src/fixtures/keys.js";
import { waitForNewSlot } from "../src/network/surfnet.js";
import { createDirectChain } from "../src/targets/direct.js";
import { startLocalStack, type LocalStack } from "../src/targets/local.js";
import { TEST_TERMS } from "../src/targets/services.js";

const ONE_READ = { attempts: 1, delayMs: 0 };

describe("sessions opened straight on the program, on the local stack", () => {
  let stack: LocalStack;
  let rentPayer: KeyPairSigner;
  let direct: DirectChain;

  /** A direct chain on the stack's chain and seller, with `payer` as its rent payer and a fresh funded key as its fee payer. */
  async function directChainWith(payer: KeyPairSigner): Promise<DirectChain> {
    const feePayer = await newHarnessKey();
    fundSol(stack.network, feePayer.signer.address, 5);
    await waitForNewSlot(stack.network.rpc);
    return createDirectChain({
      rpc: stack.network.rpc,
      terms: TEST_TERMS,
      seller: { wallet: stack.keys.seller.signer.address, usdcAccount: stack.keys.sellerUsdcAccount },
      feePayer: feePayer.signer,
      rentPayer: async () => payer,
      readRetry: ONE_READ,
    });
  }

  beforeAll(async () => {
    stack = await startLocalStack();
    const key = await newHarnessKey();
    fundSol(stack.network, key.signer.address, 5);
    await waitForNewSlot(stack.network.rpc);
    rentPayer = key.signer;
    direct = await directChainWith(rentPayer);
  });

  afterAll(async () => {
    await stack?.stop();
  });

  const buyerWith = (usdc: bigint) => newBuyer(stack.network.rpc, stack.keys.mintAuthority.signer, usdc);
  const balanceOf = async (account: Address) => (await stack.network.rpc.getBalance(account, { commitment: "confirmed" }).send()).value;
  const sessionExists = async (session: Address) => (await fetchMaybeSession(stack.network.rpc, session, { commitment: "confirmed" })).exists;
  const chainClockReaches = (seconds: bigint) => async () =>
    (await fetchSysvarClock(stack.network.rpc, { commitment: "confirmed" })).unixTimestamp >= seconds;

  it("opens a session whose rent payer and receiver authorizer are not the stack's, funded by the buyer", async () => {
    const buyer = await buyerWith(1_000_000n);

    const opened = await direct.open({ buyer, seconds: 30 });

    const stored = (await fetchSession(stack.network.rpc, opened.session, { commitment: "confirmed" })).data;
    expect(stored).toMatchObject({
      authority: buyer.signer.address,
      receiver: stack.keys.seller.signer.address,
      refundOwner: buyer.signer.address,
      rentPayer: rentPayer.address,
      deposited: 30_000n,
      rate: 1_000n,
      minSeconds: 5,
      maxSeconds: 120,
    });
    expect(stored.rentPayer).not.toBe(stack.facilitator.rentPayer);
    expect(stored.receiverAuthorizer).not.toBe(stack.keys.receiverAuthorizer.signer.address);
    expect(stored.receiverAuthorizer).not.toBe(stack.facilitator.rentPayer);
    expect(opened).toMatchObject({
      rentPayer: rentPayer.address,
      receiverToken: stack.keys.sellerUsdcAccount,
      refundTo: buyer.usdcAccount,
      deposit: 30_000n,
      startedAt: stored.startedAt,
      paidUntil: stored.startedAt + 30n,
    });
    expect((await fetchToken(stack.network.rpc, opened.vault, { commitment: "confirmed" })).data.amount).toBe(30_000n);
    expect((await fetchToken(stack.network.rpc, buyer.usdcAccount, { commitment: "confirmed" })).data.amount).toBe(970_000n);
  });

  it.each([4, 121, 5.5, Number.NaN])("refuses %s seconds before it sends anything: the offer sells whole seconds from 5 to 120", async (seconds) => {
    const buyer = await buyerWith(1_000_000n);

    await expect(direct.open({ buyer, seconds })).rejects.toThrow(/whole number of seconds between 5 and 120/);

    expect((await fetchToken(stack.network.rpc, buyer.usdcAccount, { commitment: "confirmed" })).data.amount).toBe(1_000_000n);
  });

  it.each([1_000n, 1_001n, -1n])("refuses a remainder of %s before it sends anything: it must be below the rate", async (remainder) => {
    const buyer = await buyerWith(1_000_000n);

    await expect(direct.open({ buyer, seconds: 5, remainder })).rejects.toThrow(/remainder.*below the rate \(1000\)/);

    expect((await fetchToken(stack.network.rpc, buyer.usdcAccount, { commitment: "confirmed" })).data.amount).toBe(1_000_000n);
  });

  it("refuses a remainder on the longest session, whose deposit could not take it", async () => {
    const buyer = await buyerWith(1_000_000n);

    await expect(direct.open({ buyer, seconds: 120, remainder: 1n })).rejects.toThrow(/longest session takes no remainder/);

    expect((await fetchToken(stack.network.rpc, buyer.usdcAccount, { commitment: "confirmed" })).data.amount).toBe(1_000_000n);
  });

  it("leaves the session to whoever closes it: refused before its paid time, and accepted from then on from a key that holds nothing", async () => {
    const buyer = await buyerWith(1_000_000n);
    const remainder = 250n;
    // 8 s and not the minimum: the refusal below must land before the paid time, whatever the machine is doing.
    const opened = await direct.open({ buyer, seconds: 8, remainder });
    // The remainder is in the vault but buys no time: the session is paid for 8 s.
    expect(opened).toMatchObject({ deposit: 8_250n, paidUntil: opened.startedAt + 8n });
    expect((await fetchSession(stack.network.rpc, opened.session, { commitment: "confirmed" })).data.deposited).toBe(8_250n);
    const stranger = await direct.newKey();
    expect(await balanceOf(stranger.address)).toBe(0n);

    await expect(direct.close(opened, stranger)).rejects.toThrow();
    expect(await sessionExists(opened.session)).toBe(true);

    await expect.poll(chainClockReaches(opened.paidUntil), { timeout: 30_000, interval: 250 }).toBe(true);
    // The stack's gate has never heard of this session, and its sweeper serves only sessions that name the facilitator's own
    // rent payer: several sweeps pass at the stack's interval, and nobody closes it.
    await sleep(4_500);
    expect(await sessionExists(opened.session)).toBe(true);

    const signature = await direct.close(opened, stranger);

    expect(await sessionExists(opened.session)).toBe(false);
    expect(await fetchClosedEvent(stack.network.rpc, signature, ONE_READ)).toMatchObject({
      kind: CloseKind.Standard,
      closedBy: stranger.address,
      owed: 8_000n,
      refunded: remainder,
    });
    // The receiver is paid rate x seconds, and the buyer gets the remainder back.
    const changes = await tokenBalanceChanges(stack.network.rpc, signature);
    expect(changes.get(opened.receiverToken)).toBe(8_000n);
    expect(changes.get(opened.refundTo)).toBe(remainder);
    const balances = await lamportBalances(stack.network.rpc, signature);
    const paying = balances.get(opened.rentPayer)!;
    const account = balances.get(opened.session)!;
    const vault = balances.get(opened.vault)!;
    expect(account.pre + vault.pre).toBeGreaterThan(0n);
    expect(account.post + vault.post).toBe(0n);
    expect(paying.post - paying.pre).toBe(account.pre + vault.pre);
    expect(await balanceOf(stranger.address)).toBe(0n);
  }, 60_000);

  it("has the stack's sweeper close a session that names the facilitator's rent payer, once its paid time has passed", async () => {
    // Scenario 26 covers the same through the gate with the gate stopped. This keeps the harness's side of it in one place:
    // the sweeper runs at the stack's interval (2 s), signing as the facilitator's rent payer, which gets the rent back.
    const swept = await directChainWith(stack.keys.rentPayer.signer);
    const buyer = await buyerWith(1_000_000n);
    const rentBefore = await balanceOf(stack.facilitator.rentPayer);

    const opened = await swept.open({ buyer, seconds: 5 });

    expect(opened.rentPayer).toBe(stack.facilitator.rentPayer);
    expect(await sessionExists(opened.session)).toBe(true);
    expect(await balanceOf(stack.facilitator.rentPayer)).toBeLessThan(rentBefore);
    await expect.poll(() => sessionExists(opened.session), { timeout: 30_000, interval: 500 }).toBe(false);
    expect(await balanceOf(stack.facilitator.rentPayer)).toBe(rentBefore);
  }, 60_000);
});
