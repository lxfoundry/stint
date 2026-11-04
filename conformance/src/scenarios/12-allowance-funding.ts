import type { Address } from "@solana/kit";
import { createStintClient, type Policy } from "@lxfoundry/stint-client";
import { fetchMaybeSession } from "@lxfoundry/stint-program-client";
import { fetchMaybeRecurringDelegation } from "@lxfoundry/stint-subscriptions-client";
import { associatedTokenAddress } from "@lxfoundry/stint-x402";
import { expectEqual, expectTrue } from "../assert.js";
import { awaitClose } from "../closes.js";
import { closePollMs, refusalOf, sessionSeconds } from "../helpers.js";
import { openOffers } from "../payments.js";
import { readUntil } from "../reads.js";
import { describeError } from "../runner.js";
import type { ScenarioContext } from "../types.js";

/** The limits the scenarios use (helpers.ts's `buyerClient`), so that only the allowance's cap refuses a payment. */
const POLICY: Policy = { maxRate: 10_000n, maxPerSession: 1_000_000n, budget: { amount: 1_000_000n, periodSeconds: 3_600 } };

/**
 * Scenario 12 (spec §10, §12.7): an owner grants the agent's key a recurring delegation, and the agent's sessions are paid
 * from it. Pulled from the owner: the open and the top-up take the owner's USDC, and the agent holds none. Refunded to the
 * owner: an early close returns the unused part to the owner, and the period's count of what was pulled stays where it
 * was. Refused over the cap: a payment past the period's cap is refused by the chain, takes nothing and locks nothing; a
 * client with a node refuses it before signing.
 */
export async function allowanceFunding(context: ScenarioContext): Promise<void> {
  const allowance = context.allowance;
  if (!allowance) throw new Error("Scenario 12 needs the harness to grant an allowance (context.allowance), as the local and devnet targets do");
  const { offer } = await openOffers(context.gateUrl);
  const rate = BigInt(offer.extra.rate);
  const first = sessionSeconds(context.target, 20);
  const extra = sessionSeconds(context.target, 10);
  // The cap covers the open and the top-up with 5 s to spare. The third payment is larger than what is left even after
  // the open alone (`extra + 5` s), so a node that answers from behind still shows it over the cap.
  const third = extra + 10;
  const perPeriod = rate * BigInt(first + extra + 5);
  const funded = rate * BigInt(first + extra + 40);
  const grant = await allowance.grant({ usdc: funded, perPeriod, periodSeconds: 3_600 });
  try {
    const owner = grant.owner.signer.address;
    const usdcOf = async (account: Address): Promise<bigint> => {
      const { value } = await context.rpc.getAccountInfo(account, { encoding: "base64", commitment: "confirmed" }).send();
      if (!value) return 0n;
      return BigInt((await context.rpc.getTokenAccountBalance(account, { commitment: "confirmed" }).send()).value.amount);
    };
    // A node can answer from behind right after it reported a transaction confirmed (spec §12.2): every read that follows
    // a payment is retried until it shows what the scenario expects, and the assertion reports what it last found.
    const ownerBalance = (expected: bigint) => readUntil(context.readRetry, () => usdcOf(grant.owner.usdcAccount), (amount) => amount === expected);
    const pulled = (expected: bigint) =>
      readUntil(
        context.readRetry,
        async () => {
          const read = await fetchMaybeRecurringDelegation(context.rpc, grant.delegation, { commitment: "confirmed" });
          return read.exists ? read.data.amountPulledInPeriod : undefined;
        },
        (amount) => amount === expected,
      );
    const client = createStintClient({ signer: grant.agent, policy: POLICY, allowance: { owner, nonce: grant.nonce } });
    const ownerStart = funded;
    expectEqual(await ownerBalance(ownerStart), ownerStart, "the owner holds what it was funded with");

    // Pulled from the owner. A connection holds the session from the open to the close: the gate closes a session that has
    // had none for its idle close, and the reads below take seconds on devnet.
    const session = await client.open(context.gateUrl, { seconds: first });
    const deposit = session.cost;
    const holding = await session.connect();
    holding.on("error", () => {});
    try {
      const readSession = () => fetchMaybeSession(context.rpc, session.id, { commitment: "confirmed" });
      const opened = await readUntil(context.readRetry, readSession, (read) => read.exists);
      expectTrue(opened.exists, "the session exists on-chain after the open");
      if (!opened.exists) return;
      expectEqual(opened.data.refundOwner, owner, "the session's refund owner is the allowance's owner");
      expectEqual(opened.data.authority, grant.agent.address, "the session's authority is the agent");
      expectEqual(await ownerBalance(ownerStart - deposit), ownerStart - deposit, "the open is pulled from the owner's account");
      const agentToken = await associatedTokenAddress(grant.agent.address, opened.data.mint);
      expectEqual((await context.rpc.getAccountInfo(agentToken, { commitment: "confirmed" }).send()).value, null, "the agent has no USDC account at all");
      expectEqual(await pulled(deposit), deposit, "the period counts the open");

      // The top-up is pulled too. `session.cost` counts everything the session holds: the deposit and the top-up.
      const toppedUp = await session.topUp({ seconds: extra });
      const held = session.cost;
      expectEqual(held, deposit + toppedUp.cost, "the session holds the deposit and the top-up");
      expectEqual(await ownerBalance(ownerStart - held), ownerStart - held, "the top-up is pulled from the owner's account");
      expectEqual(await pulled(held), held, "the period counts the open and the top-up");

      // Refunded to the owner, and the period's count stays.
      await session.close();
      const { event } = await awaitClose(context.rpc, session.id, context.readRetry, 15_000, "the close is on-chain", closePollMs(context.target));
      expectTrue(event.refunded > 0n, "closing early refunds something");
      const afterClose = ownerStart - held + event.refunded;
      expectEqual(await ownerBalance(afterClose), afterClose, "the refund goes to the owner's account");
      expectEqual(await usdcOf(agentToken), 0n, "nothing reaches the agent");
      expectEqual(await pulled(held), held, "a refund does not restore the allowance");

      // Refused over the cap, by the chain: nothing taken, nothing locked, nothing counted.
      const budget = client.remainingBudget();
      const refused = await refusalOf(client.open(context.gateUrl, { seconds: third }));
      expectEqual(refused?.status, 402, "a payment over the cap is refused with 402");
      expectEqual(refused?.reason, "simulation_failed", "a payment over the cap is refused as simulation_failed");
      expectTrue(/allowance/.test(refused?.message ?? ""), "the refusal says that an allowance may be the cause");
      expectEqual(await ownerBalance(afterClose), afterClose, "the refused payment takes nothing from the owner");
      expectEqual(client.remainingBudget(), budget, "the refused payment locks nothing");
      expectEqual(await pulled(held), held, "the refused pull is not counted");

      // A client with a node refuses it before signing.
      const checking = createStintClient({ signer: grant.agent, policy: POLICY, allowance: { owner, nonce: grant.nonce }, rpc: context.rpc });
      const early = await refusalOf(checking.open(context.gateUrl, { seconds: third }));
      expectEqual(early?.status, undefined, "a client with a node refuses before sending anything");
      expectTrue(/allowance for this period is used up/.test(early?.message ?? ""), "it says that the period's allowance is used up");
    } finally {
      holding.terminate();
    }
  } finally {
    // A failed revoke must not hide the scenario's own outcome. On devnet, the clean-up revokes whatever is left.
    await allowance.revoke(grant).catch((error: unknown) => console.error(`scenario 12: the revoke failed: ${describeError(error)}`));
  }
}
