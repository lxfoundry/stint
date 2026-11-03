import { createHmac } from "node:crypto";
import { createKeyPairSignerFromBytes, createKeyPairSignerFromPrivateKeyBytes } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { KEY_INDEX, deriveSellerKey, deriveSellerKeys, describeKeys } from "../src/keys.js";

const seed = Uint8Array.from({ length: 32 }, (_, index) => index);

describe("the seller's keys", () => {
  it("derives the same five distinct keys from the same seed", async () => {
    const first = await deriveSellerKeys(seed);
    const again = await deriveSellerKeys(seed);
    const addresses = Object.values(first).map((key) => key.signer.address);
    expect(new Set(addresses).size).toBe(5);
    expect(Object.values(again).map((key) => key.signer.address)).toEqual(addresses);
    expect(first.koraFeePayer.signer.address).toBe((await deriveSellerKey(seed, KEY_INDEX.koraFeePayer)).signer.address);
  });

  it("gives each key its 64-byte secret, private half then public half", async () => {
    const key = await deriveSellerKey(seed, KEY_INDEX.rentPayer);
    expect(key.secretKey).toHaveLength(64);
    expect((await createKeyPairSignerFromBytes(key.secretKey)).address).toBe(key.signer.address);
  });

  it("derives other keys than the devnet harness does from the same seed", async () => {
    const harness = await createKeyPairSignerFromPrivateKeyBytes(
      Uint8Array.from(createHmac("sha256", seed).update("stint-devnet-harness/1").digest()),
    );
    expect((await deriveSellerKey(seed, 1)).signer.address).not.toBe(harness.address);
  });

  it("names each key's role, funding key first", async () => {
    const keys = await deriveSellerKeys(seed);
    const lines = describeKeys(keys).split("\n");
    expect(lines).toHaveLength(5);
    expect(lines[0]).toBe(`${keys.funding.signer.address}  funding key: send it devnet SOL; it gives the next two theirs`);
    expect(lines[4]).toMatch(new RegExp(`^${keys.seller.signer.address}  the seller's wallet`));
  });
});
