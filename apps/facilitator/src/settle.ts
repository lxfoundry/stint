import {
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getSignatureFromTransaction,
  getTransactionDecoder,
  partiallySignTransaction,
  type Address,
  type Base64EncodedWireTransaction,
  type Signature,
  type Transaction,
} from "@solana/kit";
import {
  TransactionFailedError,
  fetchClosedEvent,
  readUntilFound,
  waitForConfirmation,
  type Network,
  type RetryOptions,
  type SettleResponse,
} from "@lxfoundry/stint-x402";
import { verifyPayment, type FacilitatorContext } from "./verify.js";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Kora signs `transaction` as fee payer, for `/settle` and for the sponsored close alike. A refusal is an answer, not a
 * throw: its message comes back for the caller to report. The signature is read from the signed wire outside that try,
 * so a wire whose signature cannot be read still throws.
 */
export async function signAsFeePayer(
  ctx: Pick<FacilitatorContext, "kora">,
  transaction: Transaction,
): Promise<{ readonly ok: true; readonly wire: string; readonly signature: Signature } | { readonly ok: false; readonly errorMessage: string }> {
  let wire;
  try {
    wire = await ctx.kora.signTransaction(getBase64EncodedWireTransaction(transaction));
  } catch (error) {
    return { ok: false, errorMessage: `Kora: ${message(error)}` };
  }
  const signature = getSignatureFromTransaction(getTransactionDecoder().decode(getBase64Encoder().encode(wire)));
  return { ok: true, wire, signature };
}

/** How `/settle` re-reads a confirmed close whose transaction the node does not return yet. */
export const DEFAULT_READ_RETRY: RetryOptions = { attempts: 5, delayMs: 400 };

/**
 * Spec §5.5, without settlement records (not yet kept): re-verify, the rent payer signs
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

  const signed = await signAsFeePayer(ctx, transaction);
  if (!signed.ok) {
    return { success: false, errorReason: "simulation_failed", errorMessage: signed.errorMessage, transaction: "", network, payer };
  }
  return submitSettlement(ctx, {
    type: verified.type,
    wire: signed.wire,
    signature: signed.signature,
    blockhash: verified.tx.blockhash,
    payer,
    amount: String(requirements.amount),
  });
}

/** A verified transaction, signed by every party, ready to submit. */
export interface SignedSettlement {
  readonly type: "open" | "topUp" | "close";
  /** The fully signed transaction, base64. */
  readonly wire: string;
  /** Its ID: the fee payer's signature. */
  readonly signature: string;
  readonly blockhash: string;
  /** The session authority. */
  readonly payer: Address;
  /** The amount an open or a top-up deposits; a close reports what its `Closed` event says it paid. */
  readonly amount: string;
}

/**
 * Submits and waits for `confirmed`. A refusal at submission (the node's preflight) is final. Once
 * the node has accepted the transaction, only a status carrying an error is a final failure: any
 * other error leaves the outcome unknown, so it is `settlement_pending` with the signature. A
 * confirmed transaction is always a success, even when its `Closed` event cannot be read yet: the
 * amount is then left out.
 */
export async function submitSettlement(
  ctx: Pick<FacilitatorContext, "rpc" | "network" | "confirmTimeoutMs" | "readRetry">,
  signed: SignedSettlement,
): Promise<SettleResponse> {
  const network = ctx.network as Network;
  const { signature, payer } = signed;
  try {
    await ctx.rpc.sendTransaction(signed.wire as Base64EncodedWireTransaction, { encoding: "base64", preflightCommitment: "confirmed" }).send();
  } catch (error) {
    return { success: false, errorReason: "simulation_failed", errorMessage: message(error), transaction: signature, network, payer };
  }

  try {
    const outcome = await waitForConfirmation(ctx.rpc, signature, signed.blockhash, ctx.confirmTimeoutMs);
    if (outcome !== "confirmed") {
      const errorReason = outcome === "pending" ? "settlement_pending" : "blockhash_expired";
      return { success: false, errorReason, transaction: signature, network, payer };
    }
  } catch (error) {
    const errorReason = error instanceof TransactionFailedError ? "simulation_failed" : "settlement_pending";
    return { success: false, errorReason, errorMessage: message(error), transaction: signature, network, payer };
  }

  if (signed.type !== "close") return { success: true, transaction: signature, network, payer, amount: signed.amount };
  // What this transaction paid the receiver; earlier claims are the gate's to add (spec §5.5).
  const event = await readUntilFound(
    () => fetchClosedEvent(ctx.rpc, signature).catch(() => undefined),
    ctx.readRetry ?? DEFAULT_READ_RETRY,
  );
  if (!event) return { success: true, transaction: signature, network, payer };
  return { success: true, transaction: signature, network, payer, amount: (event.owed + event.redirected).toString() };
}
