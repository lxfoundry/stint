import { fetchMaybeToken, getTokenSize } from "@solana-program/token";
import {
  address,
  blockhash,
  type Address,
  type Base64EncodedWireTransaction,
  type KeyPairSigner,
  type Rpc,
  type SolanaRpcApi,
} from "@solana/kit";
import { STINT_PROGRAM_ADDRESS, fetchMaybeSession, getSessionSize } from "@lxfoundry/stint-program-client";
import {
  X402_VERSION,
  associatedTokenAddress,
  checkCloseTransaction,
  checkOpenTransaction,
  inspectTransaction,
  readElapsedPayload,
  readElapsedRequirements,
  refuse,
  sameRequirements,
  sellerTermsOf,
  sessionMatches,
  type Check,
  type FacilitatorKeys,
  type InspectedTransaction,
  type InvalidReason,
} from "@lxfoundry/stint-x402";
import type { KoraClient } from "./kora.js";
import { checkPayerFunding, executedInstructions, type Funding } from "./payers.js";

export interface FacilitatorContext {
  readonly rpc: Rpc<SolanaRpcApi>;
  readonly network: string;
  readonly keys: FacilitatorKeys;
  readonly rentPayer: KeyPairSigner;
  readonly kora: KoraClient;
  /** How long `/settle` waits for `confirmed` before answering `settlement_pending`. */
  readonly confirmTimeoutMs: number;
}

export type Verified =
  | {
      readonly ok: true;
      readonly type: "open" | "close";
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
  // A close funds nothing: the rent payer only receives the session's rent back.
  let funding: Funding = { destinations: [], budget: 0n };
  if (elapsed.type === "open") {
    const check = await checkOpenTransaction(tx, requirements, ctx.keys);
    if (!check.ok) return check;
    const receiverToken = await associatedTokenAddress(address(requirements.payTo), address(requirements.asset));
    if (!(await fetchMaybeToken(ctx.rpc, receiverToken)).exists) {
      return refuse("invalid_terms", "payTo has no token account for the asset");
    }
    facts = { payer: check.value.authority, session: check.value.session };
    const [sessionRent, vaultRent] = await Promise.all([
      ctx.rpc.getMinimumBalanceForRentExemption(BigInt(getSessionSize())).send(),
      ctx.rpc.getMinimumBalanceForRentExemption(BigInt(getTokenSize())).send(),
    ]);
    funding = { destinations: [check.value.session, check.value.vault], budget: sessionRent + vaultRent };
  } else {
    if (!extra.session) return refuse("invalid_payment_requirements", "a close names its session");
    const session = address(extra.session);
    const stored = await fetchMaybeSession(ctx.rpc, session, { commitment: "confirmed" });
    if (!stored.exists) return refuse("unknown_session", "no such session");
    if (!sessionMatches(stored.data, sellerTermsOf(requirements))) {
      return refuse("invalid_terms", "the session's terms differ from the requirements");
    }
    const check = await checkCloseTransaction(tx, { session, closer: stored.data.receiverAuthorizer }, ctx.keys);
    if (!check.ok) return check;
    facts = { payer: stored.data.authority, session };
  }

  const { value: valid } = await ctx.rpc.isBlockhashValid(blockhash(tx.blockhash), { commitment: "confirmed" }).send();
  if (!valid) return refuse("blockhash_expired", "the transaction's blockhash is no longer valid");

  const simulated = await simulate(ctx, tx, funding);
  if (!simulated.ok) return simulated;
  return { ok: true, type: elapsed.type, tx, ...facts };
}

/**
 * Simulates with inner instructions (spec §5.4): the transaction must succeed, and every System
 * Program instruction it would execute, its own and those its programs invoke, must respect the
 * payer rules of `checkPayerFunding`. The fee payer and the rent payer are system-owned wallets,
 * so only System Program instructions can debit them, and the fee is implicit. Reading the
 * instructions rather than balances keeps the check independent of concurrent settlements.
 */
async function simulate(ctx: FacilitatorContext, tx: InspectedTransaction, funding: Funding): Promise<Check<null>> {
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
    return refuse("simulation_failed", `${json(value.err)} ${last}`.trim());
  }
  return checkPayerFunding(executedInstructions(tx, value.innerInstructions), ctx.keys, funding);
}
