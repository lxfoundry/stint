import { createKeyPairSignerFromBytes } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { BUYER_POOL, deriveKey, deriveKeys } from "../src/devnet/keys.js";

const SEED = Uint8Array.from(Buffer.from("ab".repeat(32), "hex"));
const OTHER_SEED = Uint8Array.from(Buffer.from("cd".repeat(32), "hex"));

describe("deriveKey", () => {
  it("gives the same key for the same seed and index, on every machine", async () => {
    expect((await deriveKey(SEED, 0)).signer.address).toBe("HScoUHx6TLP6WYahxQ2RicCnKWhLYNnKqct3wnmhnpDu");
    expect((await deriveKey(SEED, 1)).signer.address).toBe("76BGuYQabUAdJnUCWu3emyYUiLNa1hngHzrte4cF7ujw");
    expect((await deriveKey(SEED, 5)).signer.address).toBe("81TfcadkiUu6BjrUr6dp7i2AQGGNPqWfh1kiHgTRxRXo");
  });

  it("accepts the 64 bytes that a recovery phrase gives", async () => {
    const phraseSeed = Uint8Array.from(
      Buffer.from("408b285c123836004f4b8842c89324c1f01382450c0d439af345ba7fc49acf705489c6fc77dbd4e3dc1dd8cc6bc9f043db8ada1e243c4a0eafb290d399480840", "hex"),
    );
    expect((await deriveKey(phraseSeed, 0)).signer.address).toBe("7NaUu2saxsDHo5qY8CNP4H9mXn3ggg5tMF9bktv8ETaM");
    expect((await deriveKey(phraseSeed, 1)).signer.address).toBe("DJFkSPHRG6gLLyuXb3fWdn9HUSSUgrZFsDmt2i8rDATP");
  });

  it("gives another key for another index and for another seed", async () => {
    const addresses = new Set([
      (await deriveKey(SEED, 0)).signer.address,
      (await deriveKey(SEED, 1)).signer.address,
      (await deriveKey(OTHER_SEED, 0)).signer.address,
    ]);
    expect(addresses.size).toBe(3);
  });

  it("returns the secret key in the form the services take: 64 bytes that sign as the same address", async () => {
    const key = await deriveKey(SEED, 3);
    expect(key.secretKey).toHaveLength(64);
    expect((await createKeyPairSignerFromBytes(key.secretKey)).address).toBe(key.signer.address);
  });
});

describe("deriveKeys", () => {
  it("puts the funding key first, then the stack's keys, then the buyers", async () => {
    const keys = await deriveKeys(SEED);
    expect(keys.funding.signer.address).toBe("HScoUHx6TLP6WYahxQ2RicCnKWhLYNnKqct3wnmhnpDu");
    expect(keys.stack.koraFeePayer.signer.address).toBe("76BGuYQabUAdJnUCWu3emyYUiLNa1hngHzrte4cF7ujw");
    expect(keys.buyers[0]?.signer.address).toBe("81TfcadkiUu6BjrUr6dp7i2AQGGNPqWfh1kiHgTRxRXo");
    expect(keys.buyers).toHaveLength(BUYER_POOL);
  });

  it("lists every key but the funding key as a holder, each once", async () => {
    const keys = await deriveKeys(SEED, 3);
    expect(keys.holders.size).toBe(4 + 3);
    expect(keys.holders.has(keys.funding.signer.address)).toBe(false);
    expect(keys.holders.get(keys.stack.seller.signer.address)).toBe(keys.stack.seller.signer);
    expect(keys.holders.get(keys.buyers[2]!.signer.address)).toBe(keys.buyers[2]!.signer);
    expect((await deriveKeys(SEED)).holders.size).toBe(4 + BUYER_POOL);
  });
});
