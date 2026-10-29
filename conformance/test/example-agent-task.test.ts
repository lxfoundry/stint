import type { Address } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { assertRentReturned, receivedAmount } from "../src/scenarios/22-example-agent-task.js";

const account = "WATCHED";
const parsed = (amount: string, overrides: Record<string, unknown> = {}) => ({
  type: "account",
  address: account,
  slot: "38",
  lamports: "2039280",
  owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  encoding: "jsonParsed",
  data: { parsed: { info: { tokenAmount: { amount, decimals: 6 } }, type: "account" }, program: "spl-token", space: "165" },
  ...overrides,
});

describe("receivedAmount", () => {
  it("reads the token amount of a message about the account", () => {
    expect(receivedAmount(parsed("250000"), account)).toBe(250_000n);
    expect(receivedAmount(parsed("0"), account)).toBe(0n);
  });

  it("reads nothing from another account, another type, another encoding, or no amount", () => {
    expect(receivedAmount(parsed("1", { address: "OTHER" }), account)).toBeUndefined();
    expect(receivedAmount(parsed("1", { type: "slot" }), account)).toBeUndefined();
    expect(receivedAmount(parsed("1", { encoding: "base64" }), account)).toBeUndefined();
    expect(receivedAmount(parsed("1", { data: {} }), account)).toBeUndefined();
    expect(receivedAmount("text", account)).toBeUndefined();
    expect(receivedAmount(null, account)).toBeUndefined();
  });
});

describe("assertRentReturned", () => {
  const rentPayer = "RENT" as Address;
  const session = "SESSION" as Address;
  const vault = "VAULT" as Address;
  const accounts = { rentPayer, session, vault };
  const balances = (overrides: Record<string, { pre: bigint; post: bigint }> = {}) =>
    new Map<Address, { pre: bigint; post: bigint }>(
      Object.entries({
        [rentPayer]: { pre: 9_995_329_840n, post: 10_000_000_000n },
        [session]: { pre: 2_630_880n, post: 0n },
        [vault]: { pre: 2_039_280n, post: 0n },
        ...overrides,
      }) as [Address, { pre: bigint; post: bigint }][],
    );

  it("returns what the session and the vault held when the rent payer gained exactly that", () => {
    expect(assertRentReturned(balances(), accounts)).toBe(4_670_160n);
  });

  it("refuses a rent payer that gained less, or more", () => {
    expect(() => assertRentReturned(balances({ [rentPayer]: { pre: 9_995_329_840n, post: 9_999_999_999n } }), accounts)).toThrow(/gained/);
    expect(() => assertRentReturned(balances({ [rentPayer]: { pre: 1n, post: 5_000_000n } }), accounts)).toThrow(/gained/);
  });

  it("refuses an account that still holds lamports, and one that is missing", () => {
    expect(() => assertRentReturned(balances({ [vault]: { pre: 2_039_280n, post: 1n } }), accounts)).toThrow(/still holds/);
    const missing = balances();
    missing.delete(session);
    expect(() => assertRentReturned(missing, accounts)).toThrow(/session SESSION is not in the transaction/);
  });
});
