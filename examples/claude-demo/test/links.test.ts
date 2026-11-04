import { describe, expect, it } from "vitest";
import { explorerAddress, explorerTx } from "../src/links.js";
import { SELLER, signatureOf } from "./fixtures.js";

describe("Explorer links", () => {
  it("link a transaction and an address on devnet", () => {
    const signature = signatureOf(7);
    expect(explorerTx(signature)).toBe(`https://explorer.solana.com/tx/${signature}?cluster=devnet`);
    expect(explorerAddress(SELLER)).toBe(`https://explorer.solana.com/address/${SELLER}?cluster=devnet`);
  });

  it("link nothing that is not base58 of the right length", () => {
    for (const bad of ["", "abc", "0OIl".repeat(16), `${signatureOf(7)}?x=1`, "javascript:alert(1)", `${SELLER}/../x`]) {
      expect(explorerTx(bad)).toBeUndefined();
      expect(explorerAddress(bad)).toBeUndefined();
    }
  });

  it("never throw on text of a signature's or an address's length that holds a character outside base58", () => {
    for (const character of ["0", "O", "I", "l"]) {
      const signatureLike = `${signatureOf(7).slice(0, -1)}${character}`;
      const addressLike = `${SELLER.slice(0, -1)}${character}`;
      expect(signatureLike).toHaveLength(signatureOf(7).length);
      expect(() => explorerTx(signatureLike)).not.toThrow();
      expect(() => explorerAddress(addressLike)).not.toThrow();
      expect(explorerTx(signatureLike)).toBeUndefined();
      expect(explorerAddress(addressLike)).toBeUndefined();
      // The same character at the front, and in a string of exactly 64 and 43 characters.
      expect(explorerTx(character.repeat(64))).toBeUndefined();
      expect(explorerAddress(character.repeat(43))).toBeUndefined();
    }
  });
});
