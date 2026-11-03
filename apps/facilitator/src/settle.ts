import {
  SOLANA_ERROR__JSON_RPC__INVALID_PARAMS,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_MIN_CONTEXT_SLOT_NOT_REACHED,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_NODE_UNHEALTHY,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_TRANSACTION_PRECOMPILE_VERIFICATION_FAILURE,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_TRANSACTION_SIGNATURE_LEN_MISMATCH,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_TRANSACTION_SIGNATURE_VERIFICATION_FAILURE,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_UNSUPPORTED_TRANSACTION_VERSION,
  SOLANA_ERROR__TRANSACTION_ERROR__ALREADY_PROCESSED,
  blockhash,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getSignatureFromTransaction,
  getTransactionDecoder,
  isSolanaError,
  partiallySignTransaction,
  type Address,
  type Base64EncodedWireTransaction,
  type Signature,
  type Transaction,
} from "@solana/kit";
import {
  TransactionFailedError,
  fetchClosedEvent,
  inspectTransaction,
  readConfirmation,
  readElapsedPayload,
  readUntilFound,
  refuse,
  retryRequirementsKey,
  waitForConfirmation,
  type ElapsedRequirements,
  type InspectedTransaction,
  type InvalidReason,
  type Network,
  type RetryOptions,
  type SettleResponse,
} from "@lxfoundry/stint-x402";
import type { SettlementRecord, SettlementStore } from "./records.js";
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

/** What `/verify` answers (spec §5.4): the session authority as the payer, or a refusal. */
export type VerifyAnswer =
  | { readonly ok: true; readonly payer: Address }
  | { readonly ok: false; readonly reason: InvalidReason; readonly message: string };

/** `/verify` and `/settle` for resource servers (spec §6.1), with the settlement records of spec §5.5. */
export interface Settlement {
  /** Read-only: a payload whose message is recorded is answered from its record. `apiKey` is the API key's SHA-256, hex. */
  verify(payload: unknown, requirements: unknown, apiKey: string): Promise<VerifyAnswer>;
  /** Settles a payload at most once: a retry is answered from its record. `apiKey` is the API key's SHA-256, hex. */
  settle(payload: unknown, requirements: unknown, apiKey: string): Promise<SettleResponse>;
}

/** Who a settlement came from: a retry repeats both (spec §5.5, "How a retry is answered"). */
interface Origin {
  readonly apiKey: string;
  readonly requirements: string;
}

const sameOrigin = (a: Origin, b: Origin) => a.apiKey === b.apiKey && a.requirements === b.requirements;

const OTHER_SETTLEMENT = refuse(
  "invalid_payment_requirements",
  "the transaction belongs to a settlement that came with other requirements or another API key",
);

/** The payload's transaction, if it decodes: what a retry is known by. */
function transactionOf(payload: unknown): InspectedTransaction | undefined {
  const elapsed = readElapsedPayload(payload);
  return elapsed && inspectTransaction(elapsed.transaction);
}

/** `/verify`'s answer from a completed record: valid while the settlement is pending or has succeeded (spec §5.5). */
function fromRecord(signed: SignedSettlement, outcome: SettleResponse | undefined): VerifyAnswer {
  if (!outcome || outcome.success) return { ok: true, payer: signed.payer };
  return refuse((outcome.errorReason ?? "simulation_failed") as InvalidReason, outcome.errorMessage ?? "the recorded settlement failed");
}

/**
 * `/verify` and `/settle` (spec §5.4, §5.5). A settlement claims its message's hash before anything else, re-verifies,
 * has the rent payer sign an open and Kora sign as fee payer, then records the signed transaction and submits it. Within
 * this instance, a duplicate in flight joins the settlement already running: it is registered before anything is
 * awaited, so two requests cannot both start one.
 */
export function createSettlement(ctx: FacilitatorContext, store: SettlementStore): Settlement {
  const network = ctx.network as Network;
  const inFlight = new Map<string, Origin & { readonly settling: Promise<SettleResponse> }>();

  const refusal = (check: { readonly reason: InvalidReason; readonly message: string }, payer?: Address): SettleResponse => ({
    success: false,
    errorReason: check.reason,
    errorMessage: check.message,
    transaction: "",
    network,
    ...(payer === undefined ? {} : { payer }),
  });

  /** Steps 2 to 4 of spec §5.5: re-verify; the rent payer signs an open, which creates accounts; Kora signs as fee payer. */
  async function verifyAndSign(
    payload: unknown,
    requirements: unknown,
  ): Promise<{ readonly ok: true; readonly value: SignedSettlement } | { readonly ok: false; readonly response: SettleResponse }> {
    const verified = await verifyPayment(ctx, payload, requirements);
    if (!verified.ok) return { ok: false, response: refusal(verified) };
    let transaction = verified.tx.transaction;
    if (verified.type === "open") transaction = await partiallySignTransaction([ctx.rentPayer.keyPair], transaction);
    const signed = await signAsFeePayer(ctx, transaction);
    if (!signed.ok) return { ok: false, response: refusal(refuse("simulation_failed", signed.errorMessage), verified.payer) };
    // Verification passed, so these are elapsed requirements.
    const amount = (requirements as ElapsedRequirements).amount;
    return {
      ok: true,
      value: { type: verified.type, wire: signed.wire, signature: signed.signature, blockhash: verified.tx.blockhash, payer: verified.payer, amount },
    };
  }

  /** A payload whose message is claimed or recorded (spec §5.5, "How a retry is answered"). */
  async function answerRetry(held: SettlementRecord, origin: Origin): Promise<SettleResponse> {
    if (!sameOrigin(held, origin)) return refusal(OTHER_SETTLEMENT);
    if (held.outcome) return held.outcome;
    // Claimed and not yet submitted, by another instance: only a store shared by instances holds such a claim here.
    if (!held.signed) return { success: false, errorReason: "settlement_pending", transaction: "", network };
    const submission = await resolveRecorded(ctx, held.signed);
    if (submission.kind === "settled") await store.put({ ...held, outcome: submission.response });
    return submission.response;
  }

  /** Spec §5.5, steps 1 to 5, for one message. */
  async function settleOnce(messageHash: string, origin: Origin, payload: unknown, requirements: unknown): Promise<SettleResponse> {
    const claim: SettlementRecord = { messageHash, ...origin };
    const held = await store.claim(claim);
    if (held) return answerRetry(held, origin);
    let kept = false;
    try {
      const signed = await verifyAndSign(payload, requirements);
      if (!signed.ok) return signed.response;
      // Step 5: the record holds the transaction before it is submitted, so that a retry finds it whatever happens next.
      await store.put({ ...claim, signed: signed.value });
      kept = true;
      const submission = await sendAndConfirm(ctx, signed.value);
      // The node did not take it: the payload may come again, and is then verified as new.
      if (submission.kind === "refused") kept = false;
      else if (submission.kind === "settled") await store.put({ ...claim, signed: signed.value, outcome: submission.response });
      return submission.response;
    } finally {
      if (!kept) await store.release(messageHash);
    }
  }

  return {
    async verify(payload, requirements, apiKey) {
      const tx = transactionOf(payload);
      const record = tx && (await store.get(tx.messageHash));
      if (record) {
        if (!sameOrigin(record, { apiKey, requirements: retryRequirementsKey(requirements) })) return OTHER_SETTLEMENT;
        // A claim that holds no transaction yet has not been submitted: it is verified as any payload is.
        if (record.signed) return fromRecord(record.signed, record.outcome);
      }
      const verified = await verifyPayment(ctx, payload, requirements);
      return verified.ok ? { ok: true, payer: verified.payer } : verified;
    },

    async settle(payload, requirements, apiKey) {
      const tx = transactionOf(payload);
      if (!tx) {
        // Nothing a retry is known by: verification refuses a payload whose transaction does not decode.
        const verified = await verifyPayment(ctx, payload, requirements);
        return refusal(verified.ok ? refuse("invalid_payload", "the transaction cannot be decoded") : verified);
      }
      const origin: Origin = { apiKey, requirements: retryRequirementsKey(requirements) };
      // No `await` between the lookup and the registration: a duplicate in flight joins this settlement.
      const running = inFlight.get(tx.messageHash);
      if (running) return sameOrigin(running, origin) ? running.settling : refusal(OTHER_SETTLEMENT);
      const settling = settleOnce(tx.messageHash, origin, payload, requirements);
      inFlight.set(tx.messageHash, { ...origin, settling });
      try {
        return await settling;
      } finally {
        inFlight.delete(tx.messageHash);
      }
    },
  };
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
 * How a submission ended (spec §5.5). `settled` is final: the transaction is confirmed, landed with an error, or can no
 * longer land. `pending` leaves the outcome unknown. `refused` is a transaction that the node would not take at its first
 * submission, so the payload may come again.
 */
export type Submission =
  | { readonly kind: "settled"; readonly response: SettleResponse }
  | { readonly kind: "pending"; readonly response: SettleResponse }
  | { readonly kind: "refused"; readonly response: SettleResponse };

type SubmitContext = Pick<FacilitatorContext, "rpc" | "network" | "confirmTimeoutMs" | "readRetry">;

/**
 * The errors a node answers `sendTransaction` with before it forwards the transaction, which `@solana/kit` reports with
 * the JSON-RPC error's own code: a failed preflight, a signature that does not verify or has the wrong length, a
 * precompile that fails, an unsupported version, a context slot not reached, an unhealthy node, invalid parameters.
 */
const REFUSED_BEFORE_FORWARDING: ReadonlySet<number> = new Set([
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_TRANSACTION_SIGNATURE_VERIFICATION_FAILURE,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_TRANSACTION_SIGNATURE_LEN_MISMATCH,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_TRANSACTION_PRECOMPILE_VERIFICATION_FAILURE,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_UNSUPPORTED_TRANSACTION_VERSION,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_MIN_CONTEXT_SLOT_NOT_REACHED,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_NODE_UNHEALTHY,
  SOLANA_ERROR__JSON_RPC__INVALID_PARAMS,
]);

/**
 * A refusal by the node itself, which did not take the transaction. Any other failure of the request leaves open whether
 * it did: no answer in time, a connection that drops, an HTTP error, or another JSON-RPC error, which a proxy or a load
 * balancer can answer after it has forwarded the transaction.
 */
const refusedByNode = (error: unknown): boolean => isSolanaError(error) && REFUSED_BEFORE_FORWARDING.has(error.context.__code);

/** The node has processed this very message (S16), as the cause of a preflight failure or the error itself. */
function alreadyProcessed(error: unknown): boolean {
  // The chain is short; the bound keeps one that loops from running for ever.
  for (let depth = 0, current = error; current instanceof Error && depth < 10; depth++, current = current.cause) {
    if (isSolanaError(current, SOLANA_ERROR__TRANSACTION_ERROR__ALREADY_PROCESSED)) return true;
  }
  return false;
}

function failure(ctx: SubmitContext, signed: SignedSettlement, errorReason: string, errorMessage?: string): SettleResponse {
  return {
    success: false,
    errorReason,
    ...(errorMessage === undefined ? {} : { errorMessage }),
    transaction: signed.signature,
    network: ctx.network as Network,
    payer: signed.payer,
  };
}

/**
 * The answer for a confirmed transaction: an open's or a top-up's deposit; for a close, what this transaction paid the
 * receiver, `owed + redirected` from its `Closed` event, or no amount when the event cannot be read. Earlier claims are
 * the gate's to add (spec §5.5).
 */
async function confirmedResponse(ctx: SubmitContext, signed: SignedSettlement): Promise<SettleResponse> {
  const network = ctx.network as Network;
  const { signature, payer } = signed;
  if (signed.type !== "close") return { success: true, transaction: signature, network, payer, amount: signed.amount };
  const event = await readUntilFound(
    () => fetchClosedEvent(ctx.rpc, signature).catch(() => undefined),
    ctx.readRetry ?? DEFAULT_READ_RETRY,
  );
  if (!event) return { success: true, transaction: signature, network, payer };
  return { success: true, transaction: signature, network, payer, amount: (event.owed + event.redirected).toString() };
}

/**
 * Submits and waits for `confirmed` (spec §5.5). A node that refuses the transaction before forwarding it, at its first
 * submission, did not take it: `refused`. A refusal of a transaction sent again (`resent`) leaves the outcome unknown,
 * since its first submission may still land. A node that reports the message already processed has it, from an earlier
 * submission or from whoever sent these same bytes, and its outcome is read by its ID. After any other failure to send,
 * the node may have taken the transaction, so its outcome is waited for as for one it took. Only a status carrying an
 * error, or a blockhash that expired before the transaction landed, is a final failure; a wait that ends first leaves
 * the outcome unknown. A confirmed transaction is always a success, even when its `Closed` event cannot be read yet.
 */
export async function sendAndConfirm(
  ctx: SubmitContext,
  signed: SignedSettlement,
  options: { readonly resent?: boolean } = {},
): Promise<Submission> {
  let sendError: string | undefined;
  try {
    await ctx.rpc.sendTransaction(signed.wire as Base64EncodedWireTransaction, { encoding: "base64", preflightCommitment: "confirmed" }).send();
  } catch (error) {
    // Already processed (S16): its outcome is read by its ID, below.
    if (!alreadyProcessed(error)) {
      if (refusedByNode(error)) {
        if (options.resent) return { kind: "pending", response: failure(ctx, signed, "settlement_pending", message(error)) };
        return { kind: "refused", response: failure(ctx, signed, "simulation_failed", message(error)) };
      }
      // The node may have taken it: its outcome is waited for, below, as for one it took.
      sendError = message(error);
    }
  }

  try {
    const outcome = await waitForConfirmation(ctx.rpc, signed.signature, signed.blockhash, ctx.confirmTimeoutMs);
    if (outcome === "pending") return { kind: "pending", response: failure(ctx, signed, "settlement_pending", sendError) };
    if (outcome === "expired") return { kind: "settled", response: failure(ctx, signed, "blockhash_expired", sendError) };
  } catch (error) {
    if (error instanceof TransactionFailedError) return { kind: "settled", response: failure(ctx, signed, "simulation_failed", message(error)) };
    return { kind: "pending", response: failure(ctx, signed, "settlement_pending", message(error)) };
  }
  return { kind: "settled", response: await confirmedResponse(ctx, signed) };
}

/**
 * A recorded transaction whose outcome is not known (spec §5.5, "How a retry is answered"). It is looked up by its ID
 * first, in the node's transaction history as well as its recent statuses: a record outlives its blockhash by a margin,
 * and a node keeps recent statuses only for a while. One that has not landed is submitted again while its blockhash is
 * still valid, which S16 makes safe; once the blockhash has expired, one last look decides, since a transaction that
 * landed just before the expiry can show just after (spec §7.1). A lookup that cannot be read leaves the outcome unknown.
 */
export async function resolveRecorded(ctx: SubmitContext, signed: SignedSettlement): Promise<Submission> {
  const landed = () => readConfirmation(ctx.rpc, signed.signature, { searchTransactionHistory: true });
  try {
    if (await landed()) return { kind: "settled", response: await confirmedResponse(ctx, signed) };
    const { value: valid } = await ctx.rpc.isBlockhashValid(blockhash(signed.blockhash), { commitment: "confirmed" }).send();
    if (!valid) {
      if (await landed()) return { kind: "settled", response: await confirmedResponse(ctx, signed) };
      return { kind: "settled", response: failure(ctx, signed, "blockhash_expired") };
    }
  } catch (error) {
    if (error instanceof TransactionFailedError) return { kind: "settled", response: failure(ctx, signed, "simulation_failed", message(error)) };
    return { kind: "pending", response: failure(ctx, signed, "settlement_pending", message(error)) };
  }
  return sendAndConfirm(ctx, signed, { resent: true });
}

/** Submits and waits for `confirmed`, as `sendAndConfirm` does, and gives its answer: what the sponsored close uses. */
export async function submitSettlement(ctx: SubmitContext, signed: SignedSettlement): Promise<SettleResponse> {
  return (await sendAndConfirm(ctx, signed)).response;
}
