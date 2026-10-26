import {
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getSignatureFromTransaction,
  getTransactionDecoder,
  partiallySignTransaction,
} from "@solana/kit";
import { fetchClosedEvent, waitForConfirmation, type Network, type SettleResponse } from "@lxfoundry/stint-x402";
import { verifyPayment, type FacilitatorContext } from "./verify.js";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Spec §5.5, without settlement records (a later stage adds them): re-verify, the rent payer signs
 * an open, Kora signs as fee payer, then submit and wait for `confirmed`.
 */
export async function settlePayment(
  ctx: FacilitatorContext,
  payload: unknown,
  requirements: { readonly amount?: unknown },
): Promise<SettleResponse> {
  const network = ctx.network as Network;
  const verified = await verifyPayment(ctx, payload, requirements);
  if (!verified.ok) {
    return { success: false, errorReason: verified.reason, errorMessage: verified.message, transaction: "", network };
  }
  const payer = verified.payer;

  let transaction = verified.tx.transaction;
  if (verified.type === "open") transaction = await partiallySignTransaction([ctx.rentPayer.keyPair], transaction);

  let wire;
  try {
    wire = await ctx.kora.signTransaction(getBase64EncodedWireTransaction(transaction));
  } catch (error) {
    return { success: false, errorReason: "simulation_failed", errorMessage: `Kora: ${message(error)}`, transaction: "", network, payer };
  }
  const signature = getSignatureFromTransaction(getTransactionDecoder().decode(getBase64Encoder().encode(wire)));

  try {
    await ctx.rpc.sendTransaction(wire, { encoding: "base64", preflightCommitment: "confirmed" }).send();
    const outcome = await waitForConfirmation(ctx.rpc, signature, verified.tx.blockhash, ctx.confirmTimeoutMs);
    if (outcome !== "confirmed") {
      const errorReason = outcome === "pending" ? "settlement_pending" : "blockhash_expired";
      return { success: false, errorReason, transaction: signature, network, payer };
    }
  } catch (error) {
    return { success: false, errorReason: "simulation_failed", errorMessage: message(error), transaction: signature, network, payer };
  }

  let amount = String(requirements.amount);
  if (verified.type === "close") {
    // What this transaction paid the receiver; earlier claims are the gate's to add (spec §5.5).
    const event = await fetchClosedEvent(ctx.rpc, signature);
    if (!event) throw new Error(`Close ${signature} confirmed without a Closed event`);
    amount = (event.owed + event.redirected).toString();
  }
  return { success: true, transaction: signature, network, payer, amount };
}
