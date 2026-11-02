import { CloseKind, fetchMaybeSession } from "@lxfoundry/stint-program-client";
import { lamportBalances } from "@lxfoundry/stint-x402";
import { expectEqual, expectTrue, sleep } from "../assert.js";
import { awaitClose } from "../closes.js";
import { buyerClient, closePollMs, sessionSeconds } from "../helpers.js";
import { expectRefunded, readOpenedSession } from "../sessions.js";
import type { ScenarioContext, StackControl } from "../types.js";

/** What the buyer with SOL is given: the fee of its own close, 5,000 lamports, with the rent-exempt minimum of an empty account (890,880) to spare. */
const BUYER_LAMPORTS = 2_000_000n;

/**
 * Runs `work` with the gate and the facilitator both stopped, and starts them again afterwards, whatever happened: the
 * facilitator first, so that the gate settles through it as soon as it is back. Kora keeps running. The services are the
 * run's common ones, as in scenario 26: spec §12.2 gives scenario 25 a stack of its own, and stopping the common ones is
 * safe only because the runner runs one scenario at a time.
 */
export async function whileGateAndFacilitatorStopped<T>(stack: StackControl, work: () => Promise<T>): Promise<T> {
  await stack.stopGate();
  try {
    await stack.stopFacilitator();
    return await work();
  } finally {
    // The gate starts again even if the facilitator does not, so that one failure does not take every later scenario down.
    try {
      await stack.startFacilitator();
    } finally {
      await stack.startGate();
    }
  }
}

/**
 * Scenario 25 (spec §12.7): the gate and the facilitator cannot be reached when the buyer closes. With SOL on the
 * authority, and a node, the client's close fallback (spec §9.3) ends with a close of its own on the chain: refunded as
 * in scenario 1. Without SOL, nothing can close the session before its paid time runs out: the client says so, and the
 * session runs to expiry. Once the facilitator is back, its sweeper closes it with `AtExpiry`, and the receiver is paid
 * the whole deposit.
 */
export async function gateAndFacilitatorUnreachableAtClose(context: ScenarioContext): Promise<void> {
  const stack = context.stack;
  if (!stack) throw new Error("scenario 25 needs a target that provides stack control");
  const fundSol = context.fundSol;
  if (!fundSol) throw new Error("scenario 25 needs a target that can give a buyer SOL");
  const withSol = await context.newBuyer(100_000n); // the session costs 30,000 (40,000 on devnet)
  await fundSol(withSol.signer.address, BUYER_LAMPORTS);
  const withoutSol = await context.newBuyer(100_000n); // the session costs 15,000 (25,000 on devnet)

  // Each session gets a connection as soon as it opens: it keeps the gate's idle timer from closing it before the gate stops (spec §7.3).
  const paying = await buyerClient(withSol, { rpc: context.rpc }).open(context.gateUrl, { seconds: sessionSeconds(context.target, 30) });
  const payingSocket = await paying.connect();
  const stranded = await buyerClient(withoutSol, { rpc: context.rpc }).open(context.gateUrl, { seconds: sessionSeconds(context.target, 15) });
  const strandedSocket = await stranded.connect();
  for (const socket of [payingSocket, strandedSocket]) socket.on("error", () => {});
  const storedPaying = await readOpenedSession(context, paying.id);
  const storedStranded = await readOpenedSession(context, stranded.id);
  expectEqual(storedStranded.rentPayer, stack.rentPayer, "the session without SOL names the facilitator's rent payer: the sweeper's to close");

  const outcome = await whileGateAndFacilitatorStopped(stack, async () => {
    await sleep((storedPaying.minSeconds + 2) * 1_000); // past the minimum, as in scenario 1
    const receipt = await paying.close();
    const refusal = await stranded.close().then(
      () => undefined,
      (error: unknown) => error,
    );
    const strandedOpen = (await fetchMaybeSession(context.rpc, stranded.id, { commitment: "confirmed" })).exists;
    return { receipt, refusal, strandedOpen };
  });
  payingSocket.terminate();
  strandedSocket.terminate();

  // With SOL: the client's own close, its fee paid by the buyer.
  const { receipt } = outcome;
  expectEqual(receipt.via, "unilateral", "the client closed the session on the chain itself, the gate and the facilitator being unreachable");
  const event = await expectRefunded(context, { signature: receipt.transaction, session: paying.id, stored: storedPaying, buyer: withSol, reported: receipt });
  expectEqual(event.closedBy, withSol.signer.address, "the close was signed by the buyer, as the session's authority");
  const lamports = (await lamportBalances(context.rpc, receipt.transaction, context.readRetry)).get(withSol.signer.address);
  expectTrue(lamports !== undefined && lamports.post < lamports.pre, "the buyer paid the fee of its own close");

  // Without SOL: no step could close the session, and it runs to expiry.
  const { refusal } = outcome;
  expectTrue(
    refusal instanceof Error && /runs to the end of its paid time/.test(refusal.message),
    `the client says that the session without SOL runs to the end of its paid time (${String(refusal)})`,
  );
  expectTrue(outcome.strandedOpen, "the session without SOL is still open once every step has failed");
  const paidUntilMs = stranded.paidUntil * 1_000;
  const found = await awaitClose(
    context.rpc,
    stranded.id,
    context.readRetry,
    Math.max(0, paidUntilMs - Date.now()) + 30_000,
    "the sweeper closes the session without SOL within 30 s of paid_until",
    closePollMs(context.target),
  );
  expectEqual(found.event.kind, CloseKind.AtExpiry, "the session without SOL ran to expiry, and was closed with AtExpiry");
  expectEqual(found.event.claimed + found.event.owed, storedStranded.deposited, "the whole deposit is charged");
  expectEqual(found.event.refunded + found.event.redirected, 0n, "nothing is refunded");
}
