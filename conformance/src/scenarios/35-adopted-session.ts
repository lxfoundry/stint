import { address, type Address } from "@solana/kit";
import type { Session } from "@lxfoundry/stint-program-client";
import { lamportBalances, type ElapsedRequirements } from "@lxfoundry/stint-x402";
import { expectEqual, expectTrue, sleep } from "../assert.js";
import { sessionSeconds } from "../helpers.js";
import { openOffers } from "../payments.js";
import { readUntil } from "../reads.js";
import { expectRefunded, readOpenedSession } from "../sessions.js";
import { closeCodeOf, closeWith, connectWith, tokenFor, type ConnectAnswer } from "../tokens.js";
import type { ScenarioContext } from "../types.js";
import { assertRentReturned } from "./22-example-agent-task.js";

/** How long after the close is confirmed the gate has to drop the adopted connection (scenario 7's and 8's bound). */
const DROP_WITHIN_MS = 5_000;

/** Checks that `stored` has the terms of the gate's `offer` besides its mint: receiver, receiver authorizer, rate and bounds (spec §7.2, check 4). */
export function expectOfferTerms(stored: Session, offer: ElapsedRequirements): void {
  expectEqual(stored.receiver, address(offer.payTo), "the session pays the offer's payTo");
  expectEqual(stored.receiverAuthorizer, address(offer.extra.receiverAuthorizer), "the session names the gate's receiver authorizer");
  expectEqual(stored.rate, BigInt(offer.extra.rate), "the session has the offer's rate");
  expectEqual(stored.minSeconds, offer.extra.minSeconds, "the session has the offer's minSeconds");
  expectEqual(stored.maxSeconds, offer.extra.maxSeconds, "the session has the offer's maxSeconds");
}

/**
 * A connect for `session` with a fresh token each time, tried again within `readRetry` while the gate answers `404`: the
 * gate reads the account from its own node, which can answer from behind right after the open (spec §12.2).
 */
export function connectOnceSeen(context: ScenarioContext, sign: () => Promise<string>, session: Address): Promise<ConnectAnswer> {
  return readUntil(context.readRetry, async () => connectWith(context.gateUrl, session, await sign()), (answer) => answer.status !== 404);
}

/**
 * Scenario 35 (spec §12.7): a session opened directly on-chain with the gate's terms, mint and receiver authorizer, and a
 * harness key as rent payer, then a connect. The gate adopts it (spec §7.3): it accepts the connection and keeps it
 * open, it reports the session's status, and the buyer's close through the gate settles the session, refunded as in
 * scenario 1, with the rent returned to the harness's rent payer.
 */
export async function adoptedSession(context: ScenarioContext): Promise<void> {
  const direct = context.direct;
  if (!direct) throw new Error("scenario 35 needs a target that provides direct chain access");
  const { offer } = await openOffers(context.gateUrl);
  const buyer = await context.newBuyer(100_000n); // the deposit is 20,000 (30,000 on devnet)
  const seconds = sessionSeconds(context.target, 20);
  const opened = await direct.open({ buyer, seconds, receiverAuthorizer: address(offer.extra.receiverAuthorizer) });
  const stored = await readOpenedSession(context, opened.session);
  expectEqual(stored.mint, address(offer.asset), "the session is in the offer's asset");
  expectOfferTerms(stored, offer);
  if (context.stack) expectTrue(stored.rentPayer !== context.stack.rentPayer, "the rent payer is a harness key, not the facilitator's");

  const sign = (purpose: "connect" | "close") => tokenFor(buyer.signer, context.gateUrl, opened.session, purpose);
  const connected = await connectOnceSeen(context, () => sign("connect"), opened.session);
  expectTrue(connected.socket, `the gate accepts a connect for a session it never sold, and adopts it (status ${connected.status})`);
  try {
    const dropped = closeCodeOf(connected.socket);
    // The connection stays up, and the session is the gate's: none of its timers ran out while the connect waited.
    const early = await Promise.race([dropped, sleep(2_000).then(() => undefined)]);
    expectEqual(early, undefined, "the gate keeps the adopted session's connection open");
    const status = await fetch(`${context.gateUrl}/sessions/${opened.session}`);
    await status.text();
    expectEqual(status.status, 200, "the gate reports the status of the adopted session");

    const close = await closeWith(context.gateUrl, opened.session, await sign("close"));
    expectEqual(close.status, 200, "the gate closes the adopted session on the buyer's request");
    const { paid, refunded, transaction } = close.body as { paid?: string; refunded?: string; transaction?: string };
    expectTrue(transaction, "the close's answer names its transaction");
    expectTrue(paid !== undefined && refunded !== undefined, "the gate reported the close's amounts");
    await expectRefunded(context, {
      signature: transaction,
      session: opened.session,
      stored,
      buyer,
      reported: { paid: BigInt(paid), refunded: BigInt(refunded) },
    });
    assertRentReturned(await lamportBalances(context.rpc, transaction, context.readRetry), {
      rentPayer: opened.rentPayer,
      session: opened.session,
      vault: opened.vault,
    });
    const code = await Promise.race([dropped, sleep(DROP_WITHIN_MS).then(() => undefined)]);
    expectEqual(code, 4410, "the connection is dropped with 4410 once the close is confirmed");
  } finally {
    connected.socket.terminate();
  }
}
