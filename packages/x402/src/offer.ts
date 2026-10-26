import { address, type Address } from "@solana/kit";
import { SCHEME } from "./constants.js";
import type { ElapsedExtra, ElapsedRequirements, FacilitatorExtra, Network, SellerTerms, Terms } from "./types.js";

export interface OfferInput {
  readonly network: string;
  readonly asset: Address;
  readonly payTo: Address;
  readonly receiverAuthorizer: Address;
  readonly terms: Terms;
  readonly seconds: number;
  readonly facilitator: FacilitatorExtra;
  readonly lifetime: { readonly blockhash: string; readonly lastValidBlockHeight: bigint };
  readonly maxTimeoutSeconds: number;
  readonly idleCloseSeconds: number;
  readonly closeOnOutage: boolean;
}

export type CloseRequirementsInput = Omit<OfferInput, "seconds"> & { readonly session: Address };

/** The exact deposit for a duration: `rate × seconds` (spec §5.1). */
export function amountFor(rate: bigint, seconds: number): bigint {
  return rate * BigInt(seconds);
}

function build(input: Omit<OfferInput, "seconds">, seconds: number, amount: bigint, action: ElapsedExtra["action"], session?: Address): ElapsedRequirements {
  return {
    scheme: SCHEME,
    network: input.network as Network,
    amount: amount.toString(),
    asset: input.asset,
    payTo: input.payTo,
    maxTimeoutSeconds: input.maxTimeoutSeconds,
    extra: {
      paymentFlow: "escrow",
      action,
      ...(session === undefined ? {} : { session }),
      programId: input.facilitator.programId,
      rate: input.terms.rate.toString(),
      seconds,
      minSeconds: input.terms.minSeconds,
      maxSeconds: input.terms.maxSeconds,
      receiverAuthorizer: input.receiverAuthorizer,
      feePayer: input.facilitator.feePayer,
      rentPayer: input.facilitator.rentPayer,
      closeUrl: input.facilitator.closeUrl,
      recentBlockhash: input.lifetime.blockhash,
      lastValidBlockHeight: input.lifetime.lastValidBlockHeight.toString(),
      idleCloseSeconds: input.idleCloseSeconds,
      closeOnOutage: input.closeOnOutage,
    },
  };
}

/** One `accepts` entry for an open of `seconds` (spec §5.1). */
export function buildOpenOffer(input: OfferInput): ElapsedRequirements {
  return build(input, input.seconds, amountFor(input.terms.rate, input.seconds), "open");
}

/** The requirements a gate sends with a close: nothing deposited (spec §5.5). */
export function buildCloseRequirements(input: CloseRequirementsInput): ElapsedRequirements {
  return build(input, 0, 0n, "close", input.session);
}

export type DurationCheck = { readonly ok: true } | { readonly ok: false; readonly minSeconds: number; readonly maxSeconds: number };

/** Valid open durations: whole seconds from `minSeconds` to `maxSeconds` (spec §5.2). */
export function checkOpenDuration(terms: Terms, seconds: number): DurationCheck {
  return Number.isInteger(seconds) && seconds >= terms.minSeconds && seconds <= terms.maxSeconds
    ? { ok: true }
    : { ok: false, minSeconds: terms.minSeconds, maxSeconds: terms.maxSeconds };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isU64String = (value: unknown) => typeof value === "string" && /^(0|[1-9][0-9]{0,19})$/.test(value);
const isU32 = (value: unknown) => Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 0xffff_ffff;
const isText = (value: unknown) => typeof value === "string" && value.length > 0;

/** Returns the value as an `elapsed` entry if it has every field of spec §5.1 with its encoding. */
export function readElapsedRequirements(value: unknown): ElapsedRequirements | undefined {
  if (!isRecord(value) || value.scheme !== SCHEME || !isRecord(value.extra)) return undefined;
  const extra = value.extra;
  const valid =
    isText(value.network) &&
    isU64String(value.amount) &&
    isText(value.asset) &&
    isText(value.payTo) &&
    Number.isInteger(value.maxTimeoutSeconds) &&
    extra.paymentFlow === "escrow" &&
    (extra.action === "open" || extra.action === "topUp" || extra.action === "close") &&
    (extra.session === undefined || isText(extra.session)) &&
    isText(extra.programId) &&
    isU64String(extra.rate) &&
    isU32(extra.seconds) &&
    isU32(extra.minSeconds) &&
    isU32(extra.maxSeconds) &&
    isText(extra.receiverAuthorizer) &&
    isText(extra.feePayer) &&
    isText(extra.rentPayer) &&
    isText(extra.closeUrl) &&
    isText(extra.recentBlockhash) &&
    isU64String(extra.lastValidBlockHeight) &&
    isU32(extra.idleCloseSeconds) &&
    typeof extra.closeOnOutage === "boolean";
  return valid ? (value as ElapsedRequirements) : undefined;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (isRecord(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

/** Requirements are equal when every field has the same value, whatever the key order. */
export function sameRequirements(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

export function sellerTermsOf(requirements: ElapsedRequirements): SellerTerms {
  const extra = requirements.extra;
  return {
    programId: address(extra.programId),
    asset: address(requirements.asset),
    payTo: address(requirements.payTo),
    receiverAuthorizer: address(extra.receiverAuthorizer),
    terms: { rate: BigInt(extra.rate), minSeconds: extra.minSeconds, maxSeconds: extra.maxSeconds },
  };
}
