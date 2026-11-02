import { isAddress, isBlockhash } from "@solana/kit";

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const U64_MAX = 0xffff_ffff_ffff_ffffn;

/** A `u64` as a decimal string (spec §5.1), without leading zeros and at most `u64::MAX`. */
export const isU64String = (value: unknown): value is string =>
  typeof value === "string" && /^(0|[1-9][0-9]{0,19})$/.test(value) && BigInt(value) <= U64_MAX;

/** A `u32` as a JSON number (spec §5.1). */
export const isU32 = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 0xffff_ffff;

export const isAddressText = (value: unknown): value is string => typeof value === "string" && isAddress(value);

export const isBlockhashText = (value: unknown): value is string => typeof value === "string" && isBlockhash(value);
