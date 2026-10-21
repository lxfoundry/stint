import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  STINT_ERROR__INVALID_TERMS,
  STINT_ERROR__MATH_OVERFLOW,
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
    expect(STINT_ERROR__INVALID_TERMS).toBe(6000);
    expect(STINT_ERROR__MATH_OVERFLOW).toBe(6009);
  });
});
