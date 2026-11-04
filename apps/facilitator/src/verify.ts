import { fetchMaybeToken, getTokenSize } from "@solana-program/token";
import {
  address,
  blockhash,
  type Address,
  type Base64EncodedWireTransaction,
  type KeyPairSigner,
  type Rpc,
  type SolanaRpcApi,
  type TransactionError,
} from "@solana/kit";
import {
  STINT_ERROR__SESSION_EXPIRED,
  STINT_PROGRAM_ADDRESS,
  fetchMaybeSession,
  getSessionSize,
  paidUntil,
  type Session,
} from "@lxfoundry/stint-program-client";
import {
  SUBSCRIPTIONS_ERROR__AMOUNT_EXCEEDS_PERIOD_LIMIT,
  SUBSCRIPTIONS_ERROR__DELEGATION_EXPIRED,
  SUBSCRIPTIONS_ERROR__DELEGATION_NOT_STARTED,
  SUBSCRIPTIONS_PROGRAM_ADDRESS,
} from "@lxfoundry/stint-subscriptions-client";
import {
  TOP_UP_MARGIN_SECONDS,
  X402_VERSION,
  associatedTokenAddress,
  checkCloseTransaction,
  checkOpenTransaction,
  checkTopUpTransaction,
  inspectTransaction,
  readElapsedPayload,
  readElapsedRequirements,
  refuse,
  sameRequirements,
  sellerTermsOf,
  sessionMatches,
  type Check,
  type ElapsedRequirements,
  type FacilitatorKeys,
  type InspectedTransaction,
  type InvalidReason,
  type RetryOptions,
} from "@lxfoundry/stint-x402";
import type { KoraClient } from "./kora.js";
import { checkPayerFunding, executedInstructions, type Funding } from "./payers.js";
import { vaultReceipt } from "./receipt.js";

export interface FacilitatorContext {
  readonly rpc: Rpc<SolanaRpcApi>;
  readonly network: string;
  readonly keys: FacilitatorKeys;
  readonly rentPayer: KeyPairSigner;
  readonly kora: KoraClient;
  /** How long `/settle` waits for `confirmed` before answering `settlement_pending`. */
  readonly confirmTimeoutMs: number;
  /** How a confirmed close's transaction is re-read while the node returns nothing. Default 5 reads, 400 ms apart. */
  readonly readRetry?: RetryOptions;
  /** The facilitator's clock, in milliseconds: it decides the top-up margin of spec §5.4. Default `Date.now`. */
  readonly clock?: () => number;
}

export type Verified =
  | {
      readonly ok: true;
      readonly type: "open" | "topUp" | "close";
      readonly tx: InspectedTransaction;
      /** The session's authority (spec §5.5: `payer`). */
      readonly payer: Address;
      readonly session: Address;
    }
  | { readonly ok: false; readonly reason: InvalidReason; readonly message: string };

const json = (value: unknown) => JSON.stringify(value, (_, inner) => (typeof inner === "bigint" ? inner.toString() : inner));
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/** Spec §5.4. Read-only: it simulates and never submits. */
export async function verifyPayment(ctx: FacilitatorContext, payload: unknown, requirementsValue: unknown): Promise<Verified> {
  if (!isRecord(payload)) return refuse("invalid_payload", "the payload is not an object");
  if (payload.x402Version !== X402_VERSION) return refuse("invalid_x402_version", "x402Version must be 2");

  const requirements = readElapsedRequirements(requirementsValue);
  if (!requirements) return refuse("invalid_payment_requirements", "not elapsed requirements");
  const extra = requirements.extra;
  if (
    requirements.network !== ctx.network ||
    extra.programId !== STINT_PROGRAM_ADDRESS ||
    extra.feePayer !== ctx.keys.feePayer ||
    extra.rentPayer !== ctx.keys.rentPayer
  ) {
    return refuse("invalid_payment_requirements", "the requirements name another network, program or facilitator");
  }
  // Compared with the requirements the resource server issued, never with the client's echo alone.
  if (!sameRequirements(payload.accepted, requirements)) {
    return refuse("invalid_payment_requirements", "accepted differs from the issued requirements");
  }

  const elapsed = readElapsedPayload(payload);
  if (!elapsed || elapsed.type !== extra.action) return refuse("invalid_payload", "the payload does not match the action");
  const tx = inspectTransaction(elapsed.transaction);
  if (!tx) return refuse("invalid_payload", "the transaction cannot be decoded as version 0");

  let facts: { payer: Address; session: Address };
  // A close and a top-up fund nothing: the rent payer only receives a closed session's rent back.
  let funding: Funding = { destinations: [], budget: 0n };
  // The answer to a top-up past `maxSeconds`, whatever comes after, unless the simulation finds this message processed.
  let pastMaxSeconds: Verified | undefined;
  // What the simulation must show the vault receiving: the payment's whole amount, from a transfer or a pull (spec §10.2).
  let receipt: { vault: Address; amount: bigint } | undefined;
  if (elapsed.type === "open") {
    const check = await checkOpenTransaction(tx, requirements, ctx.keys);
    if (!check.ok) return check;
    const receiverToken = await associatedTokenAddress(address(requirements.payTo), address(requirements.asset));
    if (!(await fetchMaybeToken(ctx.rpc, receiverToken)).exists) {
      return refuse("invalid_terms", "payTo has no token account for the asset");
    }
    facts = { payer: check.value.authority, session: check.value.session };
    receipt = { vault: check.value.vault, amount: BigInt(requirements.amount) };
    const [sessionRent, vaultRent] = await Promise.all([
      ctx.rpc.getMinimumBalanceForRentExemption(BigInt(getSessionSize())).send(),
      ctx.rpc.getMinimumBalanceForRentExemption(BigInt(getTokenSize())).send(),
    ]);
    funding = { destinations: [check.value.session, check.value.vault], budget: sessionRent + vaultRent };
  } else if (elapsed.type === "topUp") {
    const found = await loadMatchingSession(ctx, requirements, "top-up");
    if (!found.ok) return found;
    const { session, stored } = found.value;
    // The transaction must land before the end: from `paid_until` on, the program refuses it (spec §4.3). Compared in
    // milliseconds, so that 9.5 s left is less than the margin.
    const left = Number(paidUntil(stored)) * 1000 - (ctx.clock ?? Date.now)();
    if (left < TOP_UP_MARGIN_SECONDS * 1000) {
      return refuse("session_expired", `the session's paid time ends in less than ${TOP_UP_MARGIN_SECONDS} s`);
    }
    const check = await checkTopUpTransaction(tx, requirements, stored, ctx.keys);
    if (!check.ok) return check;
    if (stored.deposited + BigInt(requirements.amount) > stored.rate * BigInt(stored.maxSeconds)) {
      // Not answered yet: a top-up that landed with no record of it is in the deposit read now, and near maxSeconds fails
      // this check, though its simulation reports it already processed, which is not final (spec §5.5).
      pastMaxSeconds = refuse("invalid_amount", "the top-up would take the session past maxSeconds");
    }
    facts = { payer: stored.authority, session };
    receipt = { vault: check.value.vault, amount: BigInt(requirements.amount) };
  } else {
    const found = await loadMatchingSession(ctx, requirements, "close");
    if (!found.ok) return found;
    const { session, stored } = found.value;
    const check = await checkCloseTransaction(tx, { session, closer: stored.receiverAuthorizer }, ctx.keys);
    if (!check.ok) return check;
    facts = { payer: stored.authority, session };
  }

  const { value: valid } = await ctx.rpc.isBlockhashValid(blockhash(tx.blockhash), { commitment: "confirmed" }).send();
  if (!valid) return pastMaxSeconds ?? refuse("blockhash_expired", "the transaction's blockhash is no longer valid");

  const simulated = await simulate(ctx, tx, funding, receipt);
  if (pastMaxSeconds && (simulated.ok || simulated.reason !== "already_processed")) return pastMaxSeconds;
  if (!simulated.ok) return simulated;
  return { ok: true, type: elapsed.type, tx, ...facts };
}

/**
 * The session an entry names, as the chain stores it, once its terms are known to match the requirements: what a
 * top-up and a close sent through `/settle` read before any other check. `action` words the refusal when the entry
 * names no session.
 */
async function loadMatchingSession(
  ctx: FacilitatorContext,
  requirements: ElapsedRequirements,
  action: "top-up" | "close",
): Promise<Check<{ readonly session: Address; readonly stored: Session }>> {
  if (!requirements.extra.session) return refuse("invalid_payment_requirements", `a ${action} names its session`);
  const session = address(requirements.extra.session);
  const stored = await fetchMaybeSession(ctx.rpc, session, { commitment: "confirmed" });
  if (!stored.exists) return refuse("unknown_session", "no such session");
  if (!sessionMatches(stored.data, sellerTermsOf(requirements))) {
    return refuse("invalid_terms", "the session's terms differ from the requirements");
  }
  return { ok: true, value: { session, stored: stored.data } };
}

/**
 * Simulates with inner instructions (spec §5.4): the transaction must succeed, and every System
 * Program instruction it would execute, its own and those its programs invoke, must respect the
 * payer rules of `checkPayerFunding`. The fee payer and the rent payer are system-owned wallets,
 * so only System Program instructions can debit them, and the fee is implicit. Reading the
 * instructions rather than balances keeps the check independent of concurrent settlements. It also checks that the vault
 * receives exactly `amount` (spec §10.2): a pull from an allowance moves its tokens in an inner instruction.
 */
export async function simulate(
  ctx: FacilitatorContext,
  tx: InspectedTransaction,
  funding: Funding,
  receipt?: { readonly vault: Address; readonly amount: bigint },
): Promise<Check<null>> {
  const { value } = await ctx.rpc
    .simulateTransaction(tx.wire as Base64EncodedWireTransaction, {
      encoding: "base64",
      commitment: "confirmed",
      sigVerify: false,
      replaceRecentBlockhash: false,
      innerInstructions: true,
    })
    .send();
  if (value.err) {
    const last = value.logs?.at(-1) ?? "";
    const message = `${json(value.err)} ${last}`.trim();
    // Only `top_up` raises it, from `paid_until` on (spec §4.3): the chain's clock had reached the end, though the
    // facilitator's had not.
    if (customErrorOf(tx, value.err, STINT_PROGRAM_ADDRESS) === STINT_ERROR__SESSION_EXPIRED) return refuse("session_expired", message);
    // The chain has processed this very message (S16): the payment may have landed, and this facilitator holds no record
    // of it, or it would not be verifying it (spec §5.5, "Already processed, with no record").
    if (value.err === "AlreadyProcessed") return refuse("already_processed", message);
    const allowance = ALLOWANCE_REFUSALS.get(customErrorOf(tx, value.err, SUBSCRIPTIONS_PROGRAM_ADDRESS) ?? -1);
    if (allowance) return refuse("simulation_failed", `${allowance}: ${message}`);
    return refuse("simulation_failed", message);
  }
  const payers = checkPayerFunding(executedInstructions(tx, value.innerInstructions), ctx.keys, funding);
  if (!payers.ok || receipt === undefined) return payers;
  let received: bigint;
  try {
    received = vaultReceipt(tx, value.innerInstructions, receipt.vault);
  } catch (error) {
    // What the vault would receive cannot be told: refused, never assumed.
    return refuse("invalid_amount", `what the vault would receive cannot be told: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (received !== receipt.amount) return refuse("invalid_amount", `the vault would receive ${received}, not ${receipt.amount}`);
  return payers;
}

/**
 * The custom error code reported against one of `program`'s instructions in the transaction: its own error, or that of a
 * program it invoked.
 */
function customErrorOf(tx: InspectedTransaction, err: TransactionError, program: Address): number | undefined {
  if (typeof err !== "object" || !("InstructionError" in err)) return undefined;
  // Kit's RPC returns the index and the code as bigints, though `TransactionError` types them as numbers.
  const [index, error] = err.InstructionError;
  if (tx.instructions[Number(index)]?.programAddress !== program) return undefined;
  return typeof error === "object" && "Custom" in error ? Number(error.Custom) : undefined;
}

/** What a refusal says when the allowance program refuses its pull (spec §10.3). The reason stays `simulation_failed`. */
const ALLOWANCE_REFUSALS: ReadonlyMap<number, string> = new Map([
  [SUBSCRIPTIONS_ERROR__AMOUNT_EXCEEDS_PERIOD_LIMIT, "the allowance for this period is used up"],
  [SUBSCRIPTIONS_ERROR__DELEGATION_EXPIRED, "the allowance has expired"],
  [SUBSCRIPTIONS_ERROR__DELEGATION_NOT_STARTED, "the allowance has not started yet"],
]);
