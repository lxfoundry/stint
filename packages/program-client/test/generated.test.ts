import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  STINT_ERROR__ACCOUNT_MISMATCH,
  STINT_ERROR__DEPOSIT_TOO_LARGE,
  STINT_ERROR__DEPOSIT_TOO_SMALL,
  STINT_ERROR__INVALID_TERMS,
  STINT_ERROR__MATH_OVERFLOW,
  STINT_ERROR__MINT_MISMATCH,
  STINT_ERROR__NOT_EXPIRED,
  STINT_ERROR__NOTHING_TO_TOP_UP,
  STINT_ERROR__SESSION_EXPIRED,
  STINT_ERROR__UNAUTHORIZED,
  STINT_PROGRAM_ADDRESS,
} from "../src/index.js";

describe("generated program client", () => {
  it("uses the program ID declared in Anchor.toml", () => {
    const anchorToml = readFileSync(new URL("../../../Anchor.toml", import.meta.url), "utf8");
    const declared = /\[programs\.localnet\]\s*\nstint = "([1-9A-HJ-NP-Za-km-z]+)"/.exec(anchorToml)?.[1];
    expect(declared).toBeDefined();
    expect(STINT_PROGRAM_ADDRESS).toBe(declared);
  });

  it("numbers the program errors from 6000, in the order of spec section 4.5", () => {
    expect([
      STINT_ERROR__INVALID_TERMS,
      STINT_ERROR__DEPOSIT_TOO_SMALL,
      STINT_ERROR__DEPOSIT_TOO_LARGE,
      STINT_ERROR__SESSION_EXPIRED,
      STINT_ERROR__NOT_EXPIRED,
      STINT_ERROR__NOTHING_TO_TOP_UP,
      STINT_ERROR__UNAUTHORIZED,
      STINT_ERROR__MINT_MISMATCH,
      STINT_ERROR__ACCOUNT_MISMATCH,
      STINT_ERROR__MATH_OVERFLOW,
    ]).toEqual([6000, 6001, 6002, 6003, 6004, 6005, 6006, 6007, 6008, 6009]);
  });
});
