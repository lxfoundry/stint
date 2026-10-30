import {
  fetchToken,
  getCloseAccountInstruction,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getTransferCheckedInstruction,
} from "@solana-program/token";
import { catalogue, runScenarios, type Target } from "@lxfoundry/stint-conformance";
import { createSessionTools, createStintClient } from "@lxfoundry/stint-client";
import {
  CloseKind,
  STINT_PROGRAM_ADDRESS,
  eventAccounts,
  findSessionPda,
  getCloseInstruction,
  getOpenInstruction,
} from "@lxfoundry/stint-program-client";
import { associatedTokenAddress } from "@lxfoundry/stint-x402";
import type { Address } from "@solana/kit";
import { fetchSysvarClock } from "@solana/sysvars";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEVNET_GENESIS_HASH } from "../src/devnet/config.js";
import { cleanUp, returnSol, returnSolRetrying, returnUsdc, returnUsdcRetrying } from "../src/devnet/funds.js";
import { deriveKeys } from "../src/devnet/keys.js";
import { newBuyer } from "../src/fixtures/buyers.js";
import { fundSol, newHarnessKey } from "../src/fixtures/keys.js";
import { USDC_DEVNET_MINT, mintUsdc } from "../src/fixtures/usdc.js";
import { sendInstructions } from "../src/network/transactions.js";
import { waitForNewSlot } from "../src/network/surfnet.js";
import { startLocalChain, type LocalChain } from "../src/targets/chain.js";
import { cleanDevnet, devnetFunds, startDevnetStack, type DevnetStack, type DevnetStackOptions } from "../src/targets/devnet.js";
import { createDirectChain } from "../src/targets/direct.js";
import { TEST_TERMS } from "../src/targets/services.js";

const FUNDING_USDC = 10_000_000n;

interface RpcStub {
  readonly url: string;
  close(): Promise<void>;
}

/** A JSON-RPC endpoint at a local address that answers each request as `answer` says: a provider, as far as a test cares. */
async function serveRpc(answer: (method: string, body: string) => Promise<{ status: number; reply: object }>): Promise<RpcStub> {
  const server = createServer((request, response) => {
    void (async () => {
      let body = "";
      for await (const chunk of request) body += chunk;
      const { id, method } = JSON.parse(body) as { id: unknown; method: string };
      const { status, reply } = await answer(method, body);
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id, ...reply }));
    })().catch(() => {
      response.writeHead(500).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

interface FundedSeed {
  readonly seed: Uint8Array;
  readonly funding: Address;
  readonly fundingUsdc: Address;
}

describe("the devnet target, run against the local network", () => {
  let chain: LocalChain;
  let stack: DevnetStack;
  let main: FundedSeed;
  let lamportsBefore: bigint;

  /** A seed whose funding key holds SOL and USDC, as a person leaves it after the faucets. */
  async function fundedSeed(): Promise<FundedSeed> {
    const seed = crypto.getRandomValues(new Uint8Array(32));
    const { funding } = await deriveKeys(seed, 0);
    fundSol(chain.network, funding.signer.address, 5);
    await waitForNewSlot(chain.network.rpc);
    const fundingUsdc = await mintUsdc(chain.network.rpc, chain.keys.mintAuthority.signer, funding.signer.address, FUNDING_USDC);
    return { seed, funding: funding.signer.address, fundingUsdc };
  }

  const start = (seed: Uint8Array, extra: Partial<DevnetStackOptions> = {}) =>
    startDevnetStack({ rpcUrl: chain.network.rpcUrl, wsUrl: chain.network.wsUrl, seed, preflight: false, pollMs: 100, ...extra });
  const sessionsOnChain = async () =>
    (await chain.network.rpc.getProgramAccounts(STINT_PROGRAM_ADDRESS, { commitment: "confirmed", encoding: "base64" }).send()).length;
  const usdcOf = async (account: Address) => (await fetchToken(chain.network.rpc, account)).data.amount;
  const openSession = async (running: DevnetStack, reason: string) => {
    const context = running.context();
    const buyer = await context.newBuyer(1_000_000n);
    const { tools } = createSessionTools(
      createStintClient({
        signer: buyer.signer,
        policy: { maxRate: 10_000n, maxPerSession: 1_000_000n, budget: { amount: 1_000_000n, periodSeconds: 3_600 } },
      }),
    );
    await tools.stint_open_session.run({ url: context.gateUrl, seconds: 30, reason });
    return buyer;
  };

  beforeAll(async () => {
    chain = await startLocalChain();
    main = await fundedSeed();
    lamportsBefore = (await chain.network.rpc.getBalance(main.funding, { commitment: "confirmed" }).send()).value;
    stack = await start(main.seed);
  });

  afterAll(async () => {
    await stack?.stop();
    chain?.stop();
  });

  it("offers stack control and the facilitator's API, and no chain control", () => {
    expect(stack.target.name).toBe("devnet");
    expect([...stack.target.capabilities].sort()).toEqual(["facilitatorApi", "stack"]);
  });

  it("passes scenarios 1 and 22 with buyers funded from the funding key", async () => {
    // The local network reports a subscription's slot, not the change's (T6): scenario 22 asserts
    // on the slot only when the target is named devnet, so it runs here under the local name.
    const asLocal: Target = { name: "local", capabilities: stack.target.capabilities };
    const outcomes = await runScenarios(
      catalogue.filter((scenario) => scenario.id === 1 || scenario.id === 22),
      asLocal,
      () => ({ ...stack.context(), target: asLocal }),
    );
    expect(outcomes.map((outcome) => [outcome.id, outcome.result, outcome.error])).toEqual([
      [1, "pass", undefined],
      [22, "pass", undefined],
    ]);
  }, 120_000);

  it("gives its context stack control and direct sessions, paid for by a key of the buyer pool and by the funding key", async () => {
    const { seed, funding, fundingUsdc } = await fundedSeed();
    const lamportsOfFunding = async () => (await chain.network.rpc.getBalance(funding, { commitment: "confirmed" }).send()).value;
    const fundingBefore = await lamportsOfFunding();
    const running = await start(seed);
    const context = running.context();
    expect(context.stack?.rentPayer).toBe(running.services.facilitator.rentPayer);

    const buyer = await context.newBuyer(1_000_000n);
    const opened = await context.direct!.open({ buyer, seconds: 5 });

    // The rent payer is a key that the clean-up covers, and it is not the stack's.
    expect((await deriveKeys(seed)).buyers.map((key) => key.signer.address)).toContain(opened.rentPayer);
    expect(opened.rentPayer).not.toBe(running.services.facilitator.rentPayer);
    await expect
      .poll(async () => (await fetchSysvarClock(chain.network.rpc)).unixTimestamp >= opened.paidUntil, { timeout: 30_000, interval: 500 })
      .toBe(true);
    await context.direct!.close(opened, await context.direct!.newKey());
    expect(await sessionsOnChain()).toBe(0);

    await running.stop();

    // What the rent payer held went back with the rest: the funding key ends with what it lent, less fees.
    expect(await usdcOf(fundingUsdc)).toBe(FUNDING_USDC);
    expect(fundingBefore - (await lamportsOfFunding())).toBeLessThan(5_000_000n);
  }, 120_000);

  it("closes a session left open at the end, returns the funds, and stops", async () => {
    await openSession(stack, "left open on purpose");
    expect(await sessionsOnChain()).toBe(1);

    await stack.stop();

    expect(await sessionsOnChain()).toBe(0);
    // Every base unit that the funding key lent, the seller's earnings included, is back.
    expect(await usdcOf(main.fundingUsdc)).toBe(FUNDING_USDC);
    const lamportsAfter = (await chain.network.rpc.getBalance(main.funding, { commitment: "confirmed" }).send()).value;
    // The funding key paid fees only: the rent it lent for token accounts, and the SOL it gave the stack, came back.
    expect(lamportsBefore - lamportsAfter).toBeLessThan(5_000_000n);
    await stack.stop(); // stopping twice is harmless
  }, 120_000);

  // The minimums are 500,000,000 lamports and 5,000,000 USDC base units: a key must hold both.
  it.each([
    { holds: "exactly the minimum of both", sol: 0.5, lamports: 500_000_000, usdc: 5_000_000n, funded: true },
    { holds: "more than the minimum of both", sol: 5, lamports: 5_000_000_000, usdc: 10_000_000n, funded: true },
    { holds: "less SOL than the minimum, and enough USDC", sol: 0.4, lamports: 400_000_000, usdc: 10_000_000n, funded: false },
    { holds: "enough SOL, and one base unit less USDC than the minimum", sol: 5, lamports: 5_000_000_000, usdc: 4_999_999n, funded: false },
    { holds: "no account at all", sol: 0, lamports: 0, usdc: 0n, funded: false },
  ])("tells whether the funding key is funded, as $funded, when it holds $holds", async ({ sol, lamports, usdc, funded }) => {
    const seed = crypto.getRandomValues(new Uint8Array(32));
    const { funding } = await deriveKeys(seed, 0);
    const address = funding.signer.address;
    if (sol > 0) {
      fundSol(chain.network, address, sol);
      await waitForNewSlot(chain.network.rpc);
    }
    if (usdc > 0n) await mintUsdc(chain.network.rpc, chain.keys.mintAuthority.signer, address, usdc);

    const message = await devnetFunds({ rpcUrl: chain.network.rpcUrl, seed, preflight: false });

    const [holdings, verdict] = message.split("\n");
    expect(holdings).toBe(`funding key ${address} holds ${lamports} lamports and ${usdc} USDC base units`);
    expect(verdict).toBe(funded ? "✓ Funded" : `A run needs at least 500000000 lamports and 5000000 USDC base units there: fund ${address} from the SOL and USDC faucets.`);
  }, 60_000);

  it("does nothing, and says nothing is wrong, when there is nothing to clean up", async () => {
    const fresh = await fundedSeed();
    expect(await cleanDevnet({ rpcUrl: chain.network.rpcUrl, seed: fresh.seed, preflight: false, pollMs: 100 })).toEqual([]);
    expect(await usdcOf(fresh.fundingUsdc)).toBe(FUNDING_USDC);
  }, 60_000);

  it("repairs a run that died with a session open and USDC on its keys, before the next one starts", async () => {
    const { seed, fundingUsdc } = await fundedSeed();
    const dying = await start(seed);
    await openSession(dying, "left open by a run that died");
    expect(await sessionsOnChain()).toBe(1);
    // The process "dies": its services are gone, and nothing cleans up.
    await dying.services.stop();

    const next = await start(seed);

    // The next run's start-up closed the session and took everything back before funding its own keys.
    expect(await sessionsOnChain()).toBe(0);
    await next.stop();
    expect(await usdcOf(fundingUsdc)).toBe(FUNDING_USDC);
  }, 120_000);

  it("closes a session whose seller's USDC account is gone, by recreating the account in the same transaction", async () => {
    const { seed, fundingUsdc } = await fundedSeed();
    const dying = await start(seed);
    await openSession(dying, "left open, with its payout account closed");
    await dying.services.stop();
    // Someone closes the seller's token account, which is empty: the close that pays it would now fail (spec §4.3).
    const keys = await deriveKeys(seed, 0);
    const sellerToken = await associatedTokenAddress(keys.stack.seller.signer.address, USDC_DEVNET_MINT);
    await sendInstructions(
      chain.network.rpc,
      keys.funding.signer,
      [getCloseAccountInstruction({ account: sellerToken, destination: keys.funding.signer.address, owner: keys.stack.seller.signer })],
      { pollMs: 100 },
    );
    expect((await chain.network.rpc.getAccountInfo(sellerToken, { commitment: "confirmed", encoding: "base64" }).send()).value).toBeNull();

    const next = await start(seed);

    expect(await sessionsOnChain()).toBe(0);
    await next.stop();
    expect(await usdcOf(fundingUsdc)).toBe(FUNDING_USDC);
  }, 120_000);

  it("closes a session whose authority's key the harness does not hold, as the stack's receiver authorizer", async () => {
    const { seed, fundingUsdc } = await fundedSeed();
    const running = await start(seed);
    // A buyer of its own, as the example agent is: its key is in no pool of the seed, so the clean-up cannot sign as it.
    const outsider = await newBuyer(chain.network.rpc, chain.keys.mintAuthority.signer, 1_000_000n);
    const { tools } = createSessionTools(
      createStintClient({
        signer: outsider.signer,
        policy: { maxRate: 10_000n, maxPerSession: 1_000_000n, budget: { amount: 1_000_000n, periodSeconds: 3_600 } },
      }),
    );
    await tools.stint_open_session.run({ url: running.context().gateUrl, seconds: 30, reason: "opened by a key the harness does not hold" });
    expect(await sessionsOnChain()).toBe(1);
    await running.services.stop();

    const next = await start(seed);

    // The start-up closed it with the receiver authorizer's key, which the seed gives back. The refund went to the
    // outsider's own account, which was never closed: the deposit less what was due, which is between 5 s and 30 s of the rate.
    expect(await sessionsOnChain()).toBe(0);
    const refunded = await usdcOf(outsider.usdcAccount);
    expect(refunded).toBeGreaterThanOrEqual(970_000n);
    expect(refunded).toBeLessThan(1_000_000n);
    await next.stop();
    // The outsider was not funded from the funding key, but its session paid the seller, and the clean-up returns the
    // seller's USDC to the funding key: the funding key ends with what it lent, plus what that session cost.
    expect(await usdcOf(fundingUsdc)).toBe(FUNDING_USDC + (1_000_000n - refunded));
  }, 120_000);

  it("closes a session whose buyer's USDC account is gone, by recreating the account in the same transaction", async () => {
    const { seed, fundingUsdc } = await fundedSeed();
    const dying = await start(seed);
    const buyer = await openSession(dying, "left open, with its refund account closed");
    await dying.services.stop();
    // The buyer's account is emptied and closed: the refund would now have nowhere to go (spec §4.3).
    const keys = await deriveKeys(seed, 0);
    const funding = { signer: keys.funding.signer, usdcAccount: fundingUsdc };
    await returnUsdc(chain.network.rpc, funding, buyer.signer, buyer.usdcAccount, await usdcOf(buyer.usdcAccount), { pollMs: 100 });
    expect((await chain.network.rpc.getAccountInfo(buyer.usdcAccount, { commitment: "confirmed", encoding: "base64" }).send()).value).toBeNull();

    const next = await start(seed);

    expect(await sessionsOnChain()).toBe(0);
    await next.stop();
    expect(await usdcOf(fundingUsdc)).toBe(FUNDING_USDC);
  }, 120_000);

  it("returns a USDC account's whole balance when the amount read before was stale, by reading it again", async () => {
    const { seed, fundingUsdc } = await fundedSeed();
    const keys = await deriveKeys(seed, 0);
    const funding = { signer: keys.funding.signer, usdcAccount: fundingUsdc };
    const buyer = await newBuyer(chain.network.rpc, chain.keys.mintAuthority.signer, 1_000_000n);
    // A lagging node reported less than the account holds: the close of the account would fail with that amount.
    await expect(returnUsdc(chain.network.rpc, funding, buyer.signer, buyer.usdcAccount, 400_000n, { pollMs: 100 })).rejects.toThrow();

    await returnUsdcRetrying(chain.network.rpc, funding, buyer.signer, buyer.usdcAccount, 400_000n, { pollMs: 100 });

    expect(await usdcOf(fundingUsdc)).toBe(FUNDING_USDC + 1_000_000n);
    expect((await chain.network.rpc.getAccountInfo(buyer.usdcAccount, { commitment: "confirmed", encoding: "base64" }).send()).value).toBeNull();
  }, 60_000);

  it("returns a key's whole SOL when the balance read before was stale, by reading it again", async () => {
    const { seed, fundingUsdc } = await fundedSeed();
    const keys = await deriveKeys(seed, 0);
    const funding = { signer: keys.funding.signer, usdcAccount: fundingUsdc };
    const { signer: key } = await newHarnessKey();
    fundSol(chain.network, key.address, 1);
    await waitForNewSlot(chain.network.rpc);
    // A lagging node reported 500,000 lamports less than the key holds: sending that, less the fee, would leave
    // the key with less than the rent-exempt minimum (890,880 lamports), which the runtime refuses.
    await expect(returnSol(chain.network.rpc, funding, key, 999_500_000n, { pollMs: 100 })).rejects.toThrow();

    await returnSolRetrying(chain.network.rpc, funding, key, 999_500_000n, { pollMs: 100 });

    expect((await chain.network.rpc.getBalance(key.address, { commitment: "confirmed" }).send()).value).toBe(0n);
  }, 60_000);

  it("starts, and leaves alone, a session that an outside key opened naming the seller as its receiver", async () => {
    const { seed } = await fundedSeed();
    const keys = await deriveKeys(seed, 0);
    const seller = keys.stack.seller.signer.address;
    // Only the authority and the rent payer sign an open, so anyone may name the seller as receiver. This outsider is its
    // own rent payer and receiver authorizer, at 1 base unit per second: its session is paid for about eleven days.
    const outsider = await newBuyer(chain.network.rpc, chain.keys.mintAuthority.signer, 1_000_000n);
    fundSol(chain.network, outsider.signer.address, 1);
    await waitForNewSlot(chain.network.rpc);
    const [session] = await findSessionPda(outsider.signer.address, 1n);
    const vault = await associatedTokenAddress(session, USDC_DEVNET_MINT);
    const sellerToken = await associatedTokenAddress(seller, USDC_DEVNET_MINT);
    await sendInstructions(
      chain.network.rpc,
      outsider.signer,
      [
        await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: outsider.signer, owner: session, mint: USDC_DEVNET_MINT }),
        getTransferCheckedInstruction({
          source: outsider.usdcAccount,
          mint: USDC_DEVNET_MINT,
          destination: vault,
          authority: outsider.signer,
          amount: 1_000_000n,
          decimals: 6,
        }),
        getOpenInstruction({
          authority: outsider.signer,
          rentPayer: outsider.signer,
          session,
          mint: USDC_DEVNET_MINT,
          vault,
          receiver: seller,
          receiverAuthorizer: outsider.signer.address,
          refundOwner: outsider.signer.address,
          ...(await eventAccounts()),
          seed: 1n,
          rate: 1n,
          minSeconds: 1,
          maxSeconds: 1_000_000,
        }),
      ],
      { pollMs: 100 },
    );

    const running = await start(seed);

    // Not the harness's to close: the start-up neither closed it nor refused to start because it could not.
    expect(await sessionsOnChain()).toBe(1);
    // The outsider closes it, while the running stack holds the seller's account that the close pays.
    await sendInstructions(
      chain.network.rpc,
      outsider.signer,
      [
        getCloseInstruction({
          closer: outsider.signer,
          session,
          vault,
          receiverToken: sellerToken,
          refundTo: outsider.usdcAccount,
          rentPayer: outsider.signer.address,
          ...(await eventAccounts()),
          kind: CloseKind.Standard,
        }),
      ],
      { pollMs: 100 },
    );
    expect(await sessionsOnChain()).toBe(0);
    await running.stop();
  }, 120_000);

  it("closes a session from its paid time on without recreating its buyer's refund account, which the close no longer pays", async () => {
    const { seed, fundingUsdc } = await fundedSeed();
    const keys = await deriveKeys(seed, 0);
    const funding = { signer: keys.funding.signer, usdcAccount: fundingUsdc };
    const dying = await start(seed);
    // A buyer of its own, as the example agent is: the clean-up returns nothing to its keys, so an account created for it
    // would stay, paid for by the funding key.
    const outsider = await newBuyer(chain.network.rpc, chain.keys.mintAuthority.signer, 1_000_000n);
    const { tools } = createSessionTools(
      createStintClient({
        signer: outsider.signer,
        policy: { maxRate: 10_000n, maxPerSession: 1_000_000n, budget: { amount: 1_000_000n, periodSeconds: 3_600 } },
      }),
    );
    const { paidUntil } = await tools.stint_open_session.run({ url: dying.context().gateUrl, seconds: 5, reason: "runs to its end" });
    await dying.services.stop();
    // The buyer empties its USDC account into the funding key's and closes it.
    await returnUsdc(chain.network.rpc, funding, outsider.signer, outsider.usdcAccount, await usdcOf(outsider.usdcAccount), { pollMs: 100 });
    await expect
      .poll(async () => (await fetchSysvarClock(chain.network.rpc)).unixTimestamp >= BigInt(paidUntil), { timeout: 30_000, interval: 500 })
      .toBe(true);

    const next = await start(seed);

    expect(await sessionsOnChain()).toBe(0);
    expect((await chain.network.rpc.getAccountInfo(outsider.usdcAccount, { commitment: "confirmed", encoding: "base64" }).send()).value).toBeNull();
    await next.stop();
    // All of the buyer's USDC is at the funding key: what it did not deposit when it closed its account, and the deposit
    // through the seller, which earned all of it.
    expect(await usdcOf(fundingUsdc)).toBe(FUNDING_USDC + 1_000_000n);
  }, 120_000);

  it("reports a session that no held key may close yet, then closes it once its paid time has passed", async () => {
    const { seed } = await fundedSeed();
    const running = await start(seed);
    const outsider = await newBuyer(chain.network.rpc, chain.keys.mintAuthority.signer, 1_000_000n);
    const { tools } = createSessionTools(
      createStintClient({
        signer: outsider.signer,
        policy: { maxRate: 10_000n, maxPerSession: 1_000_000n, budget: { amount: 1_000_000n, periodSeconds: 3_600 } },
      }),
    );
    // 45 s and not the usual 30: the first attempt below must land before paid_until, whatever the machine is doing.
    await tools.stint_open_session.run({ url: running.context().gateUrl, seconds: 45, reason: "no held key may close it yet" });
    await running.services.stop();
    // Only the rent payer is held, which is how the session is found: neither its authority nor its receiver authorizer is.
    const keys = await deriveKeys(seed, 0);
    const held = new Map([[keys.stack.rentPayer.signer.address, keys.stack.rentPayer.signer]]);
    const funding = {
      signer: keys.funding.signer,
      usdcAccount: await associatedTokenAddress(keys.funding.signer.address, USDC_DEVNET_MINT),
    };

    // Before paid_until the program refuses: the clean-up reports it, and throws nothing.
    const early = await cleanUp(chain.network.rpc, funding, held, { pollMs: 100 });
    expect(early).toHaveLength(1);
    expect(early[0]).toMatch(/closing session[\s\S]*paid time/);
    expect(await sessionsOnChain()).toBe(1);

    // From paid_until anyone may close it (spec §4.3): the same call succeeds once the cause is gone.
    await expect.poll(() => cleanUp(chain.network.rpc, funding, held, { pollMs: 100 }), { timeout: 60_000, interval: 3_000 }).toEqual([]);
    expect(await sessionsOnChain()).toBe(0);
  }, 120_000);

  /** Like the free tier of a provider: the local network answers every method but the listing of a program's accounts. */
  const nodeThatCannotListProgramAccounts = () =>
    serveRpc(async (method, body) =>
      method === "getProgramAccounts"
        ? { status: 400, reply: { error: { code: -32600, message: "getProgramAccounts is not available on the Free tier" } } }
        : {
            status: 200,
            reply: (await (await fetch(chain.network.rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body })).json()) as object,
          },
    );

  it("finds the sessions to close through the scan endpoint when the main one cannot list the program's accounts", async () => {
    const { seed, fundingUsdc } = await fundedSeed();
    const dying = await start(seed);
    await openSession(dying, "left open, behind a node that cannot list the program's accounts");
    await dying.services.stop();
    const provider = await nodeThatCannotListProgramAccounts();
    try {
      // Without a scan endpoint the session cannot be found: the one problem is the scan.
      const refused = await cleanDevnet({ rpcUrl: provider.url, seed, preflight: false, pollMs: 100 });
      expect(refused).toHaveLength(1);
      expect(refused[0]).toMatch(/^closing sessions: /);
      expect(await sessionsOnChain()).toBe(1);

      const problems = await cleanDevnet({ rpcUrl: provider.url, scanRpcUrl: chain.network.rpcUrl, seed, preflight: false, pollMs: 100 });

      expect(problems).toEqual([]);
      expect(await sessionsOnChain()).toBe(0);
      expect(await usdcOf(fundingUsdc)).toBe(FUNDING_USDC);
    } finally {
      await provider.close();
    }
  }, 120_000);

  it("starts, and closes what is left open at the end, through a main endpoint that cannot list the program's accounts", async () => {
    const { seed, fundingUsdc } = await fundedSeed();
    const provider = await nodeThatCannotListProgramAccounts();
    try {
      const running = await start(seed, { rpcUrl: provider.url, scanRpcUrl: chain.network.rpcUrl });
      await openSession(running, "left open at the end, behind a node that cannot list the program's accounts");
      expect(await sessionsOnChain()).toBe(1);

      await running.stop();

      expect(await sessionsOnChain()).toBe(0);
      expect(await usdcOf(fundingUsdc)).toBe(FUNDING_USDC);
    } finally {
      await provider.close();
    }
  }, 120_000);

  it("runs the sweeper against the scan endpoint, which lists the program's accounts where the main endpoint cannot", async () => {
    const { seed } = await fundedSeed();
    const keys = await deriveKeys(seed, 0);
    const provider = await nodeThatCannotListProgramAccounts();
    let running: DevnetStack | undefined;
    try {
      const started = await start(seed, { rpcUrl: provider.url, scanRpcUrl: chain.network.rpcUrl });
      running = started;
      const seller = keys.stack.seller.signer.address;
      // A session that names the facilitator's rent payer is the sweeper's to close. It is opened straight on the program,
      // so that no gate holds it.
      const swept = createDirectChain({
        rpc: chain.network.rpc,
        terms: TEST_TERMS,
        seller: { wallet: seller, usdcAccount: await associatedTokenAddress(seller, USDC_DEVNET_MINT) },
        feePayer: keys.funding.signer,
        rentPayer: async () => started.keys.rentPayer.signer,
        readRetry: { attempts: 1, delayMs: 0 },
        send: { pollMs: 100 },
      });
      const buyer = await started.context().newBuyer(100_000n);
      await swept.open({ buyer, seconds: 5 });
      expect(await sessionsOnChain()).toBe(1);

      // The listing through the main endpoint would fail at every sweep, and the session would stay open.
      await expect.poll(sessionsOnChain, { timeout: 40_000, interval: 1_000 }).toBe(0);
    } finally {
      await running?.stop();
      await provider.close();
    }
  }, 120_000);

  it("refuses a scan endpoint that is not devnet's before it cleans up anything", async () => {
    const seed = crypto.getRandomValues(new Uint8Array(32));
    const devnet = await serveRpc(async () => ({ status: 200, reply: { result: DEVNET_GENESIS_HASH } }));
    try {
      await expect(cleanDevnet({ rpcUrl: devnet.url, scanRpcUrl: chain.network.rpcUrl, seed, pollMs: 100 })).rejects.toThrow(/not devnet's/);
    } finally {
      await devnet.close();
    }
  }, 60_000);

  it("does not start when the start-up clean-up cannot read the chain", async () => {
    const seed = crypto.getRandomValues(new Uint8Array(32));
    await expect(
      startDevnetStack({ rpcUrl: "http://127.0.0.1:9", wsUrl: "ws://127.0.0.1:9", seed, preflight: false, pollMs: 100 }),
    ).rejects.toThrow(/does not start/);
  }, 60_000);

  it("refuses a buyer whose allotment would take the run's loans above the funds a start-up requires", async () => {
    const { seed } = await fundedSeed();
    const running = await start(seed);
    const context = running.context();

    await context.newBuyer(3_000_000n);
    await context.newBuyer(2_000_000n); // 5,000,000 in all: the minimum itself is still within what the run may lend

    await expect(context.newBuyer(1n)).rejects.toThrow(/5000000/);
    await running.stop();
  }, 120_000);

  it("stops handing out buyers when the pool is used", async () => {
    const { seed } = await fundedSeed();
    const small = await start(seed, { buyerPool: 1 });
    await small.context().newBuyer(0n);
    await expect(small.context().newBuyer(0n)).rejects.toThrow(/buyer keys/);
    await small.stop();
  }, 60_000);
});
