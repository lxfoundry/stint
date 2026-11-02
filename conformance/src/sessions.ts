import type { Address } from "@solana/kit";
import { CloseKind, dueAt, fetchMaybeSession, paidUntil, type ClosedEvent, type Session } from "@lxfoundry/stint-program-client";
import { associatedTokenAddress, fetchClosedEvent, tokenBalanceChanges } from "@lxfoundry/stint-x402";
import { expectEqual, expectTrue } from "./assert.js";
import { readUntil } from "./reads.js";
import type { Buyer, DirectSession, ScenarioContext } from "./types.js";

/** The session as the program stored it at its open, read until the node shows it (spec §12.2). */
export async function readOpenedSession(context: ScenarioContext, session: Address): Promise<Session> {
  const readSession = () => fetchMaybeSession(context.rpc, session, { commitment: "confirmed" });
  const account = await readUntil(context.readRetry, readSession, (read) => read.exists);
  expectTrue(account.exists, "the session exists on-chain after the open");
  return account.data;
}

/**
 * A session the scenario opened through the gate, as `DirectChain.close` takes it: every account a close names, derived
 * from the session's stored fields (spec §4.1), so that its buyer can close it on the program, past the gate.
 */
export async function directSessionOf(session: Address, stored: Session): Promise<DirectSession> {
  return {
    session,
    vault: await associatedTokenAddress(session, stored.mint),
    rentPayer: stored.rentPayer,
    receiverToken: await associatedTokenAddress(stored.receiver, stored.mint),
    refundTo: await associatedTokenAddress(stored.refundOwner, stored.mint),
    deposit: stored.deposited,
    startedAt: stored.startedAt,
    paidUntil: paidUntil(stored),
  };
}

/** A buyer's close of its session, as `expectRefunded` checks it. */
export interface BuyersClose {
  readonly signature: string;
  readonly session: Address;
  /** The session as the program stored it at the open. */
  readonly stored: Session;
  readonly buyer: Buyer;
  /** The amounts the client's receipt reported, when it reported them. */
  readonly reported?: { readonly paid?: bigint; readonly refunded?: bigint };
}

/**
 * Checks a buyer's close as scenario 1 does (spec §12.7): a `Standard` close; `paid = due` and `refunded = deposit − due`,
 * where `due` follows from the chain's clock at the close (spec §4.2); the receiver gains `due` and the buyer `deposit −
 * due` in the close's own transaction (spec §12.2, "Measuring money"), the scenario having made no claim; the receipt, if
 * it carries amounts, says the same; and the session account is closed. Returns the close's `Closed` event.
 */
export async function expectRefunded(context: ScenarioContext, close: BuyersClose): Promise<ClosedEvent> {
  const { signature, session, stored, buyer, reported } = close;
  const event = await fetchClosedEvent(context.rpc, signature, context.readRetry);
  expectTrue(event, "the close emitted Closed");
  expectEqual(event.kind, CloseKind.Standard, "the buyer's close is a Standard close");
  const due = dueAt(stored, event.at);
  expectEqual(event.claimed + event.owed + event.redirected, due, "paid = due");
  expectEqual(event.refunded, stored.deposited - due, "refunded = deposit − due");
  if (reported?.paid !== undefined) expectEqual(reported.paid, due, "the receipt's paid = due");
  if (reported?.refunded !== undefined) expectEqual(reported.refunded, stored.deposited - due, "the receipt's refunded = deposit − due");
  const changes = await tokenBalanceChanges(context.rpc, signature, context.readRetry);
  expectEqual(changes.get(await associatedTokenAddress(stored.receiver, stored.mint)), due, "the receiver's gain in the close");
  expectEqual(changes.get(buyer.usdcAccount), stored.deposited - due, "the buyer's refund in the close");
  const readSession = () => fetchMaybeSession(context.rpc, session, { commitment: "confirmed" });
  expectTrue(!(await readUntil(context.readRetry, readSession, (read) => !read.exists)).exists, "the session account is closed");
  return event;
}
