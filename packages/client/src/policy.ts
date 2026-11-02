import type { Address } from "@solana/kit";
import { STINT_PROGRAM_ADDRESS } from "@lxfoundry/stint-program-client";
import { SOLANA_DEVNET, USDC_DEVNET, checkTopUpDuration, type ElapsedRequirements } from "@lxfoundry/stint-x402";

export interface Asset {
  readonly mint: Address;
  readonly decimals: number;
}

/** Spec §9.2. The limits a buyer's code enforces, whatever a seller offers. */
export interface Policy {
  /** Default: devnet. */
  readonly networks?: readonly string[];
  /** Default: the Stint program. */
  readonly programs?: readonly Address[];
  /** Default: devnet USDC, 6 decimals. */
  readonly assets?: readonly Asset[];
  readonly sellers?: readonly Address[];
  readonly maxRate: bigint;
  /** The most one session may lock: its opening deposit and every top-up together. */
  readonly maxPerSession: bigint;
  readonly budget: { readonly amount: bigint; readonly periodSeconds: number };
  /** Default 300. */
  readonly maxMinSeconds?: number;
  /**
   * Seconds to wait for a close that the gate reports pending (`202`) before the next step of the close fallback chain
   * (spec §9.2, §9.3). Default 180: it must exceed two blockhash lifetimes, the gate's close and its one resend.
   */
  readonly closeWaitSeconds?: number;
}

type Refusal = { readonly ok: false; readonly reason: string };

export type PolicyCheck = { readonly ok: true; readonly decimals: number; readonly amount: bigint } | Refusal;

const no = (reason: string): Refusal => ({ ok: false, reason });

/**
 * The checks every payment shares (spec §9.3). `signer` is the buyer's key, which must not be the facilitator's fee
 * payer or rent payer: its signature would then authorize what the facilitator's keys are confined from (spec §5.3).
 * Then the allowlists, the rate and the minimum charge. Returns the asset's decimals.
 */
function checkSellerAndTerms(policy: Policy, offer: ElapsedRequirements, signer: Address): { readonly ok: true; readonly decimals: number } | Refusal {
  const extra = offer.extra;
  if (extra.feePayer === signer) return no("the offer names this client's own signer as the fee payer");
  if (extra.rentPayer === signer) return no("the offer names this client's own signer as the rent payer");
  if (!(policy.networks ?? [SOLANA_DEVNET]).includes(offer.network)) return no(`network ${offer.network} is not allowed`);
  if (!(policy.programs ?? [STINT_PROGRAM_ADDRESS]).includes(extra.programId as Address)) {
    return no(`program ${extra.programId} is not allowed`);
  }
  const asset = (policy.assets ?? [USDC_DEVNET]).find((candidate) => candidate.mint === offer.asset);
  if (!asset) return no(`asset ${offer.asset} is not allowed`);
  if (policy.sellers && !policy.sellers.includes(offer.payTo as Address)) return no(`seller ${offer.payTo} is not allowed`);
  const rate = BigInt(extra.rate);
  if (rate > policy.maxRate) return no(`rate ${rate} exceeds maxRate ${policy.maxRate}`);
  if (extra.minSeconds > (policy.maxMinSeconds ?? 300)) return no(`minSeconds ${extra.minSeconds} exceeds maxMinSeconds`);
  return { ok: true, decimals: asset.decimals };
}

/** The amount: exactly `rate × seconds`, within `maxPerSession` with what the session already holds, and within the period budget. */
function checkAmount(policy: Policy, offer: ElapsedRequirements, sessionTotal: bigint, locked: bigint, decimals: number): PolicyCheck {
  const amount = BigInt(offer.amount);
  if (amount !== BigInt(offer.extra.rate) * BigInt(offer.extra.seconds)) return no("the amount is not rate × seconds");
  if (sessionTotal + amount > policy.maxPerSession) return no(`${sessionTotal + amount} exceeds maxPerSession ${policy.maxPerSession}`);
  if (locked + amount > policy.budget.amount) return no(`${amount} would exceed the period budget`);
  return { ok: true, decimals, amount };
}

/** The checks before signing an open (spec §9.3). `locked` is what this period already locked. */
export function checkOffer(policy: Policy, offer: ElapsedRequirements, requested: number, locked: bigint, signer: Address): PolicyCheck {
  const extra = offer.extra;
  if (extra.action !== "open") return no("not an open offer");
  const allowed = checkSellerAndTerms(policy, offer, signer);
  if (!allowed.ok) return allowed;
  if (extra.seconds !== requested) return no(`the offer is for ${extra.seconds} s, not the ${requested} s requested`);
  if (!Number.isInteger(extra.seconds) || extra.seconds < extra.minSeconds || extra.seconds > extra.maxSeconds) {
    return no(`${extra.seconds} s is outside ${extra.minSeconds}..${extra.maxSeconds}`);
  }
  return checkAmount(policy, offer, 0n, locked, allowed.decimals);
}

/** What a top-up is checked against: the session it extends, as this client opened it. */
export interface TopUpContext {
  /** The entry the session opened with: a top-up must offer the same terms, for the same seller. */
  readonly opened: ElapsedRequirements;
  readonly session: Address;
  /** What the session holds through this client: its opening deposit and earlier top-ups. */
  readonly sessionTotal: bigint;
  /** What this period already locked, across sessions. */
  readonly locked: bigint;
  readonly signer: Address;
}

/**
 * The checks before signing a top-up (spec §9.3): an open's, then the session and the same terms and seller as the entry
 * it opened with, a duration that fits what `maxSeconds` leaves after the seconds the session's deposit covers, and an
 * amount within `maxPerSession` together with what the session already holds.
 */
export function checkTopUp(policy: Policy, offer: ElapsedRequirements, requested: number, context: TopUpContext): PolicyCheck {
  const extra = offer.extra;
  if (extra.action !== "topUp") return no("not a top-up offer");
  if (extra.session !== context.session) return no(`the offer is for session ${extra.session}, not ${context.session}`);
  const allowed = checkSellerAndTerms(policy, offer, context.signer);
  if (!allowed.ok) return allowed;
  const was = context.opened;
  if (
    offer.network !== was.network ||
    offer.asset !== was.asset ||
    offer.payTo !== was.payTo ||
    extra.programId !== was.extra.programId ||
    extra.receiverAuthorizer !== was.extra.receiverAuthorizer ||
    extra.rate !== was.extra.rate ||
    extra.minSeconds !== was.extra.minSeconds ||
    extra.maxSeconds !== was.extra.maxSeconds
  ) {
    return no("the offer's terms differ from the session's");
  }
  if (extra.seconds !== requested) return no(`the offer is for ${extra.seconds} s, not the ${requested} s requested`);
  const rate = BigInt(extra.rate);
  const duration = checkTopUpDuration({ rate, minSeconds: extra.minSeconds, maxSeconds: extra.maxSeconds }, context.sessionTotal, extra.seconds);
  if (!duration.ok) return no(`${extra.seconds} s is outside 1..${duration.maxSeconds}, what maxSeconds leaves`);
  return checkAmount(policy, offer, context.sessionTotal, context.locked, allowed.decimals);
}
