import type { Address } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { lamportBalancesFrom } from "../src/chain.js";

const a = "AAAA" as Address;
const b = "BBBB" as Address;

describe("lamportBalancesFrom", () => {
  it("pairs each account with its balance before and after", () => {
    const balances = lamportBalancesFrom({ accountKeys: [a, b], preBalances: [10, 5n], postBalances: [4, 11n] });
    expect(balances.get(a)).toEqual({ pre: 10n, post: 4n });
    expect(balances.get(b)).toEqual({ pre: 5n, post: 11n });
  });

  it("refuses a transaction that failed: it moved nothing", () => {
    expect(() => lamportBalancesFrom({ accountKeys: [a], err: { InstructionError: [0, "Custom"] }, preBalances: [1], postBalances: [1] })).toThrow(
      /failed/,
    );
  });

  it("refuses balances that do not cover every account key", () => {
    expect(() => lamportBalancesFrom({ accountKeys: [a, b], preBalances: [1], postBalances: [1, 2] })).toThrow(/cover 1 and 2 of 2/);
  });
});
