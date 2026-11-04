import { createStintClient } from "@lxfoundry/stint-client";
import { findClose } from "@lxfoundry/stint-conformance";
import { closeLeftSessions } from "@lxfoundry/stint-example-seller";
import { CloseKind, fetchMaybeSession } from "@lxfoundry/stint-program-client";
import { associatedTokenAddress, lamportBalances, tokenBalanceChanges } from "@lxfoundry/stint-x402";
import { fetchSysvarClock } from "@solana/sysvars";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fundSol, newHarnessKey } from "../src/fixtures/keys.js";
import { waitForNewSlot } from "../src/network/surfnet.js";
import { startLocalStack, type LocalStack } from "../src/targets/local.js";

// The example seller (`examples/seller`) closes, at its start, the sessions an earlier process of the deployment left
// open: those whose rent payer and receiver authorizer are its own and whose paid time has not run out, with a `Standard`
// close its receiver authorizer signs. Here the stack's gate and facilitator are that earlier process: they open the
// sessions, then stop, as a restart stops them.

/** The node is ours: a read right after a write is not answered from behind, but a close lands a moment after it is sent. */
const READ_RETRY = { attempts: 20, delayMs: 100 };

describe("the example seller's start-up close, on the local stack", () => {
  let stack: LocalStack;

  beforeAll(async () => {
    stack = await startLocalStack();
  });

  afterAll(async () => {
    await stack?.stop();
  });

  it("closes a session an earlier process left open and paid for, paying the seller for the time used and refunding the buyer the rest, and leaves an expired one to the sweeper", async () => {
    const context = stack.context();
    const control = context.stack!;
    const rpc = stack.network.rpc;
    const buyer = await context.newBuyer(1_000_000n);
    const client = createStintClient({
      signer: buyer.signer,
      policy: { maxRate: 10_000n, maxPerSession: 1_000_000n, budget: { amount: 1_000_000n, periodSeconds: 3_600 } },
    });
    const paidFor = await client.open(context.gateUrl, { seconds: 60 });
    const expiring = await client.open(context.gateUrl, { seconds: 5 });
    // While they run, the gate closes a session at its paid time (5 s after the second open) and one nobody connects to 10 s
    // after its open, and the sweeper (every 2 s here) closes an expired one: the earlier process stops at once. Were the
    // stops late, the stack itself would have closed a session, which is said here rather than blamed on the start-up.
    await control.stopGate();
    await control.stopFacilitator();
    for (const [session, what] of [
      [paidFor, "the 60 s session"],
      [expiring, "the 5 s session"],
    ] as const) {
      const read = await fetchMaybeSession(rpc, session.id, { commitment: "confirmed" });
      expect(read.exists, `${what} is still open once the gate and the facilitator have stopped: they stopped in time`).toBe(true);
    }
    // The start-up decides on the chain's clock, as the program does.
    const deadline = Date.now() + 30_000;
    while ((await fetchSysvarClock(rpc, { commitment: "confirmed" })).unixTimestamp < BigInt(expiring.paidUntil)) {
      expect(Date.now(), "the chain's clock reaches the 5 s session's paid_until").toBeLessThan(deadline);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const before = await fetchMaybeSession(rpc, paidFor.id, { commitment: "confirmed" });
    if (!before.exists) throw new Error("the paid session is not on the chain");
    const stored = before.data;
    expect(stored.rentPayer).toBe(stack.keys.rentPayer.signer.address);
    const funding = await newHarnessKey();
    fundSol(stack.network, funding.signer.address, 1);
    await waitForNewSlot(rpc);

    const report = await closeLeftSessions(rpc, rpc, funding.signer, {
      rentPayer: stack.keys.rentPayer.signer.address,
      receiverAuthorizer: stack.keys.receiverAuthorizer.signer,
    });

    expect(report).toEqual({ closed: [paidFor.id], failed: [] });
    const found = await findClose(rpc, paidFor.id, READ_RETRY);
    expect(found, "the close is on the chain").toBeDefined();
    const { event, signature } = found!;
    expect(event).toMatchObject({ session: paidFor.id, kind: CloseKind.Standard, closedBy: stack.keys.receiverAuthorizer.signer.address });
    // Closed before its paid time: some of the deposit is the seller's, and the rest goes back to the buyer.
    expect(event.claimed + event.owed + event.redirected + event.refunded).toBe(paidFor.cost);
    expect(event.refunded).toBeGreaterThan(0n);
    expect(event.owed + event.redirected).toBeGreaterThan(0n);
    const changes = await tokenBalanceChanges(rpc, signature, READ_RETRY);
    expect(changes.get(buyer.usdcAccount)).toBe(event.refunded);
    expect(changes.get(stack.keys.sellerUsdcAccount)).toBe(event.owed + event.redirected);
    // The session's rent, and its vault's, go back to the rent payer, whatever the funding key paid for the close.
    const lamports = await lamportBalances(rpc, signature, READ_RETRY);
    const vault = await associatedTokenAddress(paidFor.id, stored.mint);
    const [rentPayer, account, vaultAccount] = [stored.rentPayer, paidFor.id, vault].map((address) => lamports.get(address));
    expect(account!.pre + vaultAccount!.pre).toBeGreaterThan(0n);
    expect([account!.post, vaultAccount!.post]).toEqual([0n, 0n]);
    expect(rentPayer!.post - rentPayer!.pre).toBe(account!.pre + vaultAccount!.pre);
    expect((await fetchMaybeSession(rpc, paidFor.id, { commitment: "confirmed" })).exists).toBe(false);
    // The expired session is the sweeper's: the start-up leaves it as it is.
    expect((await fetchMaybeSession(rpc, expiring.id, { commitment: "confirmed" })).exists).toBe(true);
  });
});
