import type { Address } from "@solana/kit";
import { STINT_PROGRAM_ADDRESS } from "@lxfoundry/stint-program-client";
import { SOLANA_DEVNET, USDC_DEVNET, type ElapsedRequirements } from "@lxfoundry/stint-x402";

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
  readonly maxPerSession: bigint;
  readonly budget: { readonly amount: bigint; readonly periodSeconds: number };
  /** Default 300. */
  readonly maxMinSeconds?: number;
}

export type PolicyCheck =
  | { readonly ok: true; readonly decimals: number; readonly amount: bigint }
  | { readonly ok: false; readonly reason: string };

const no = (reason: string): PolicyCheck => ({ ok: false, reason });

/** The checks before signing any payment (spec §9.3). `locked` is what this period already locked. */
export function checkOffer(policy: Policy, offer: ElapsedRequirements, requested: number, locked: bigint): PolicyCheck {
  const extra = offer.extra;
  if (extra.action !== "open") return no("not an open offer");
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
  if (extra.seconds !== requested) return no(`the offer is for ${extra.seconds} s, not the ${requested} s requested`);
  if (!Number.isInteger(extra.seconds) || extra.seconds < extra.minSeconds || extra.seconds > extra.maxSeconds) {
    return no(`${extra.seconds} s is outside ${extra.minSeconds}..${extra.maxSeconds}`);
  }
  const amount = BigInt(offer.amount);
  if (amount !== rate * BigInt(extra.seconds)) return no("the amount is not rate × seconds");
  if (amount > policy.maxPerSession) return no(`${amount} exceeds maxPerSession ${policy.maxPerSession}`);
  if (locked + amount > policy.budget.amount) return no(`${amount} would exceed the period budget`);
  return { ok: true, decimals: asset.decimals, amount };
}
