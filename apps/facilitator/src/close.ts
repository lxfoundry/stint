import {
  blockhash,
  fetchEncodedAccount,
  isInstructionWithAccounts,
  isInstructionWithData,
  type Address,
} from "@solana/kit";
import {
  CloseKind,
  STINT_PROGRAM_ADDRESS,
  StintInstruction,
  decodeSession,
  identifyStintInstruction,
  parseCloseInstruction,
  type Session,
} from "@lxfoundry/stint-program-client";
import {
  checkCloseTransaction,
  fetchClosedEvent,
  inspectTransaction,
  readUntilFound,
  refuse,
  storedSessionFields,
  type Check,
  type CloseInfo,
  type InspectedTransaction,
  type SponsoredCloseResponse,
} from "@lxfoundry/stint-x402";
import { DEFAULT_READ_RETRY, signAsFeePayer, submitSettlement } from "./settle.js";
import { simulate, type FacilitatorContext } from "./verify.js";

/** How long `GET /close` serves the same blockhash and block height (spec §6.1: cached for a few seconds). */
export const DEFAULT_CLOSE_INFO_TTL_MS = 2_000;

type Lifetime = Pick<CloseInfo, "recentBlockhash" | "lastValidBlockHeight" | "blockHeight">;

/**
 * The session at `session`, read at `confirmed`, or undefined if no account of the program is there. The address comes
 * from anyone, and another program's account decodes into whatever its bytes say.
 */
async function readSession(rpc: FacilitatorContext["rpc"], session: Address): Promise<Session | undefined> {
  const account = await fetchEncodedAccount(rpc, session, { commitment: "confirmed" });
  if (!account.exists || account.programAddress !== STINT_PROGRAM_ADDRESS) return undefined;
  return decodeSession(account).data;
}

export interface CloseInfoSource {
  /** `GET /close`'s body. With a session, its stored fields too, or undefined if no session exists at that address. */
  read(session?: Address): Promise<CloseInfo | undefined>;
}

/**
 * Answers `GET /close` (spec §6.1). The blockhash and the block height are read at `confirmed` and served for `ttlMs`, so
 * that unauthenticated requests do not each reach the node; a session's stored fields are read on each request.
 */
export function createCloseInfoSource(
  ctx: Pick<FacilitatorContext, "rpc" | "keys">,
  options: { readonly ttlMs?: number; readonly clock?: () => number } = {},
): CloseInfoSource {
  const ttlMs = options.ttlMs ?? DEFAULT_CLOSE_INFO_TTL_MS;
  const clock = options.clock ?? Date.now;
  let cached: { readonly at: number; readonly lifetime: Promise<Lifetime> } | undefined;

  const fetchLifetime = async (): Promise<Lifetime> => {
    const [{ value }, height] = await Promise.all([
      ctx.rpc.getLatestBlockhash({ commitment: "confirmed" }).send(),
      ctx.rpc.getBlockHeight({ commitment: "confirmed" }).send(),
    ]);
    return { recentBlockhash: value.blockhash, lastValidBlockHeight: value.lastValidBlockHeight.toString(), blockHeight: height.toString() };
  };

  const lifetime = (): Promise<Lifetime> => {
    const now = clock();
    // A clock earlier than the cached read counts as expired: the blockhash would otherwise be served until it catches up.
    if (!cached || now < cached.at || now - cached.at >= ttlMs) {
      const entry = { at: now, lifetime: fetchLifetime() };
      // A read that failed is not served again: the next request asks the node.
      entry.lifetime.catch(() => {
        if (cached === entry) cached = undefined;
      });
      cached = entry;
    }
    return cached.lifetime;
  };

  return {
    async read(session) {
      const [current, stored] = await Promise.all([lifetime(), session ? readSession(ctx.rpc, session) : undefined]);
      const info: CloseInfo = { feePayer: ctx.keys.feePayer, ...current, programId: STINT_PROGRAM_ADDRESS };
      if (!session) return info;
      return stored ? { ...info, session: storedSessionFields(session, stored) } : undefined;
    },
  };
}

/** A sponsored close that passed every check of spec §5.4's sponsored row. */
export interface VerifiedSponsoredClose {
  readonly tx: InspectedTransaction;
  readonly session: Address;
  /** The session's authority, which signed the close. */
  readonly payer: Address;
}

/** The session and the closer the transaction's `stint.close` names; undefined unless it holds exactly one well-formed `stint.close`. */
function namedClose(tx: InspectedTransaction): { readonly session: Address; readonly closer: Address } | undefined {
  const named = tx.instructions.flatMap((ix) => {
    if (ix.programAddress !== STINT_PROGRAM_ADDRESS || !isInstructionWithData(ix) || !isInstructionWithAccounts(ix)) return [];
    try {
      if (identifyStintInstruction(ix) !== StintInstruction.Close) return [];
      const { accounts } = parseCloseInstruction(ix);
      return [{ session: accounts.session.address, closer: accounts.closer.address }];
    } catch {
      return []; // data no instruction of the program has, or too few accounts
    }
  });
  return named.length === 1 ? named[0] : undefined;
}

/**
 * Spec §5.4, the sponsored row. Read-only: it simulates and never submits. The static checks come first, so that a
 * transaction that fails them costs no read of the node.
 */
export async function verifySponsoredClose(ctx: FacilitatorContext, transaction: unknown): Promise<Check<VerifiedSponsoredClose>> {
  if (typeof transaction !== "string" || transaction.length === 0) return refuse("invalid_payload", "the body carries no transaction");
  const tx = inspectTransaction(transaction);
  if (!tx) return refuse("invalid_payload", "the transaction cannot be decoded as version 0");
  const named = namedClose(tx);
  if (!named) return refuse("unexpected_instruction", "a close is stint.close alone");
  // Payer positions, layout, the signer set and the closer's signature, with the closer the instruction names: it is
  // compared with the session's authority once the session is read.
  const check = await checkCloseTransaction(tx, named, ctx.keys);
  if (!check.ok) return check;
  if (check.value.kind !== CloseKind.Standard && check.value.kind !== CloseKind.AtExpiry) {
    return refuse("invalid_terms", "a sponsored close is Standard or AtExpiry");
  }

  const stored = await readSession(ctx.rpc, named.session);
  if (!stored) return refuse("unknown_session", "no such session");
  if (stored.rentPayer !== ctx.keys.rentPayer) return refuse("invalid_terms", "the session's rent payer is not this facilitator's");
  if (named.closer !== stored.authority) return refuse("invalid_payload", "the closer is not the session's authority");

  const { value: valid } = await ctx.rpc.isBlockhashValid(blockhash(tx.blockhash), { commitment: "confirmed" }).send();
  if (!valid) return refuse("blockhash_expired", "the transaction's blockhash is no longer valid");
  // A close funds nothing: the rent payer only receives the session's rent back.
  const simulated = await simulate(ctx, tx, { destinations: [], budget: 0n });
  if (!simulated.ok) return simulated;
  return { ok: true, value: { tx, session: named.session, payer: stored.authority } };
}

/**
 * Kora signs as fee payer, then the close is submitted and waited for as `/settle` does (spec §5.5, without settlement
 * records). `paid` counts the claims made before the close, as the gate's answer does.
 */
async function submitSponsoredClose(ctx: FacilitatorContext, verified: VerifiedSponsoredClose): Promise<SponsoredCloseResponse> {
  const { tx, payer } = verified;

  const signed = await signAsFeePayer(ctx, tx.transaction);
  if (!signed.ok) return { success: false, errorReason: "simulation_failed", errorMessage: signed.errorMessage, transaction: "" };
  const { wire, signature } = signed;
  const settled = await submitSettlement(ctx, { type: "close", wire, signature, blockhash: tx.blockhash, payer, amount: "0" });
  if (!settled.success) {
    return { success: false, errorReason: settled.errorReason ?? "simulation_failed", errorMessage: settled.errorMessage, transaction: settled.transaction };
  }

  // `submitSettlement` reports `owed + redirected` only; the buyer's answer needs the claims and the refund as well.
  const event = await readUntilFound(
    () => fetchClosedEvent(ctx.rpc, signature).catch(() => undefined),
    ctx.readRetry ?? DEFAULT_READ_RETRY,
  );
  if (!event) return { success: true, transaction: signature };
  return {
    success: true,
    transaction: signature,
    paid: (event.claimed + event.owed + event.redirected).toString(),
    refunded: event.refunded.toString(),
  };
}

export type SponsoredCloser = (transaction: unknown) => Promise<SponsoredCloseResponse>;

/**
 * `POST /close` (spec §6.1). One sponsored close is settled at a time per session: one that passes verification while
 * another of its session is being settled gets that close's answer and is not sent, since only one can land and each one
 * sent costs the fee payer a fee. The check and the registration happen in one synchronous step, so two requests cannot
 * both pass it.
 */
export function createSponsoredCloser(ctx: FacilitatorContext): SponsoredCloser {
  const inFlight = new Map<Address, Promise<SponsoredCloseResponse>>();
  return async (transaction) => {
    const verified = await verifySponsoredClose(ctx, transaction);
    if (!verified.ok) return { success: false, errorReason: verified.reason, errorMessage: verified.message, transaction: "" };
    const { session } = verified.value;
    const running = inFlight.get(session);
    if (running) return running;
    const settling = submitSponsoredClose(ctx, verified.value).finally(() => inFlight.delete(session));
    inFlight.set(session, settling);
    return settling;
  };
}
