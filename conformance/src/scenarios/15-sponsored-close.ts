import { CloseKind, fetchMaybeSession } from "@lxfoundry/stint-program-client";
import {
  HEADERS,
  associatedTokenAddress,
  buildSponsoredClose,
  decodePaymentRequiredHeader,
  fetchClosedEvent,
  lamportBalances,
  readCloseInfo,
  readElapsedRequirements,
  tokenBalanceChanges,
  type CloseInfo,
  type PaymentRequired,
  type SponsoredCloseResponse,
} from "@lxfoundry/stint-x402";
import { expectEqual, expectTrue } from "../assert.js";
import { buyerClient, sessionSeconds } from "../helpers.js";
import { readUntil } from "../reads.js";
import type { DirectChain, ScenarioContext } from "../types.js";
import { assertRentReturned } from "./22-example-agent-task.js";

/** The `closeUrl` of the gate's offer, which the gate copies from its facilitator's `/supported` (spec §5.1). */
async function offeredCloseUrl(gateUrl: string): Promise<string> {
  const response = await fetch(`${gateUrl}/sessions`, { method: "POST" });
  expectEqual(response.status, 402, "an open without a payment is answered 402");
  const header = response.headers.get(HEADERS.paymentRequired);
  const required = (header ? decodePaymentRequiredHeader(header) : await response.json()) as PaymentRequired;
  const offer = required.accepts.map(readElapsedRequirements).find((entry) => entry?.extra.action === "open");
  expectTrue(offer, "the 402 offers an elapsed open");
  return offer.extra.closeUrl;
}

/** `GET closeUrl?session=`: the facilitator's fee payer, a blockhash and the session's stored fields. */
async function closeInfoFor(context: ScenarioContext, closeUrl: string, session: string): Promise<CloseInfo> {
  // The facilitator's node can lag the scenario's own: a 404 for a session that has just opened is asked again.
  const response = await readUntil(context.readRetry, () => fetch(`${closeUrl}?session=${session}`), (answer) => answer.status !== 404);
  expectEqual(response.status, 200, "GET closeUrl?session= finds the session");
  const info = readCloseInfo(await response.json());
  expectTrue(info !== undefined && info.session !== undefined, "GET closeUrl?session= answers a fee payer, a blockhash and the session's fields");
  return info;
}

/** `POST closeUrl`, as a buyer sends it: no API key. A refusal sends nothing, so `unknown_session` from a lagging node is asked again. */
async function postClose(context: ScenarioContext, closeUrl: string, transaction: string): Promise<SponsoredCloseResponse> {
  const send = async (): Promise<SponsoredCloseResponse> => {
    const response = await fetch(closeUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ transaction }),
    });
    expectEqual(response.status, 200, "POST closeUrl answers 200");
    return (await response.json()) as SponsoredCloseResponse;
  };
  return readUntil(context.readRetry, send, (answer) => answer.success || answer.errorReason !== "unknown_session");
}

/**
 * The second half of scenario 15: a session opened directly on-chain names a harness key as its rent payer, so the
 * facilitator refuses to sponsor its close, and the session stays open. The scenario then closes it on the program.
 */
async function refusesAnotherRentPayer(context: ScenarioContext, closeUrl: string, direct: DirectChain): Promise<void> {
  const buyer = await context.newBuyer(100_000n); // the deposit is 10,000 (20,000 on devnet): the funding key lends no more than that
  const opened = await direct.open({ buyer, seconds: sessionSeconds(context.target, 10) });
  const readSession = () => fetchMaybeSession(context.rpc, opened.session, { commitment: "confirmed" });
  try {
    const info = await closeInfoFor(context, closeUrl, opened.session);
    expectEqual(info.session?.rentPayer, opened.rentPayer, "GET closeUrl?session= reports the harness's rent payer");
    const answer = await postClose(context, closeUrl, await buildSponsoredClose(info, { session: opened.session, closer: buyer.signer }));
    expectTrue(
      !answer.success && answer.errorReason === "invalid_terms",
      `the close of a session whose rent payer is not the facilitator's is refused with invalid_terms (${JSON.stringify(answer)})`,
    );
    expectTrue((await readSession()).exists, "the refused close left the session open");
  } finally {
    // No gate or sweeper closes a session whose receiver authorizer and rent payer are harness keys.
    if ((await readSession()).exists) await direct.close(opened, buyer.signer);
  }
}

/**
 * Scenario 15 (spec §12.7): a sponsored close through `closeUrl`, built only from what `GET /close` returns. Closed and
 * refunded. A session whose rent payer is not one of this facilitator's keys (opened directly on-chain with a harness
 * rent payer) is refused.
 */
export async function sponsoredClose(context: ScenarioContext): Promise<void> {
  const closeUrl = await offeredCloseUrl(context.gateUrl);
  const buyer = await context.newBuyer(100_000n); // the session costs 30,000 (40,000 on devnet): the devnet run lends no more than a buyer spends
  const opened = await buyerClient(buyer).open(context.gateUrl, { seconds: sessionSeconds(context.target, 30) });
  // A connection keeps the gate's idle timer from closing the session before the buyer does (spec §7.3).
  const socket = await opened.connect();
  try {
    const readSession = () => fetchMaybeSession(context.rpc, opened.id, { commitment: "confirmed" });
    const account = await readUntil(context.readRetry, readSession, (read) => read.exists);
    expectTrue(account.exists, "the session exists on-chain after the open");
    const stored = account.data;
    expectEqual(stored.deposited, opened.cost, "the deposit credited at open");
    if (context.stack) expectEqual(stored.rentPayer, context.stack.rentPayer, "the facilitator's rent payer fronted the rent");

    const info = await closeInfoFor(context, closeUrl, opened.id);
    const answer = await postClose(context, closeUrl, await buildSponsoredClose(info, { session: opened.id, closer: buyer.signer }));
    expectTrue(answer.success, `the sponsored close succeeds (${JSON.stringify(answer)})`);

    const closed = await fetchClosedEvent(context.rpc, answer.transaction, context.readRetry);
    expectTrue(closed, "the close emitted Closed");
    expectEqual(closed.kind, CloseKind.Standard, "the sponsored close is a Standard close");
    expectEqual(closed.closedBy, buyer.signer.address, "the close was signed by the session's authority");
    // Spec §4.2, as in scenario 1: elapsed stops at paid_until, and a close charges at least minSeconds.
    const covered = stored.deposited / stored.rate;
    const elapsed = closed.at - stored.startedAt;
    const used = elapsed < 0n ? 0n : elapsed > covered ? covered : elapsed;
    const charged = used > BigInt(stored.minSeconds) ? used : BigInt(stored.minSeconds);
    const due = stored.rate * charged;
    expectTrue(answer.paid !== undefined && answer.refunded !== undefined, "the facilitator reported the close's amounts");
    expectEqual(BigInt(answer.paid), due, "paid = due");
    expectEqual(BigInt(answer.refunded), stored.deposited - due, "refunded = deposit − due");

    const changes = await tokenBalanceChanges(context.rpc, answer.transaction, context.readRetry);
    expectEqual(changes.get(await associatedTokenAddress(stored.receiver, stored.mint)), due, "the receiver's gain in the close");
    expectEqual(changes.get(buyer.usdcAccount), stored.deposited - due, "the buyer's refund in the close");
    assertRentReturned(await lamportBalances(context.rpc, answer.transaction, context.readRetry), {
      rentPayer: stored.rentPayer,
      session: opened.id,
      vault: await associatedTokenAddress(opened.id, stored.mint),
    });
    expectTrue(!(await readUntil(context.readRetry, readSession, (read) => !read.exists)).exists, "the session account is closed");
  } finally {
    socket.close();
  }

  if (context.direct) await refusesAnotherRentPayer(context, closeUrl, context.direct);
}
