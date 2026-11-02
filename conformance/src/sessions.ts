import type { Address } from "@solana/kit";
import { fetchMaybeSession, paidUntil, type Session } from "@lxfoundry/stint-program-client";
import { associatedTokenAddress } from "@lxfoundry/stint-x402";
import { expectTrue } from "./assert.js";
import { readUntil } from "./reads.js";
import type { DirectSession, ScenarioContext } from "./types.js";

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
