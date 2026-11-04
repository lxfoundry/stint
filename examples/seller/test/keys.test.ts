import { createHmac } from "node:crypto";
import { createKeyPairSignerFromBytes, createKeyPairSignerFromPrivateKeyBytes } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { KEY_INDEX, KEY_LABEL, deriveSellerKey, deriveSellerKeys, describeKeys } from "../src/keys.js";

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

  // A seed that is deployed gives keys that hold money: a change to the derivation, to the label or to an index would
  // silently move them to other addresses, and what the old ones hold would no longer be found.
  it("derives the same addresses as an earlier version from a fixed seed", async () => {
    expect(KEY_LABEL).toBe("stint-example-seller");
    expect(KEY_INDEX).toEqual({ funding: 0, koraFeePayer: 1, rentPayer: 2, receiverAuthorizer: 3, seller: 4 });
    const keys = await deriveSellerKeys(seed);
    expect(Object.fromEntries(Object.entries(keys).map(([role, key]) => [role, key.signer.address]))).toEqual({
      funding: "4iLVHhqHL56hs2M4j5C7Fr37LqJeZho9radjHxgjh29G",
      koraFeePayer: "5fThuw3CLHNBUXbncNtd5hn6UE6yi3T7FsxyF1rEWF4r",
      rentPayer: "HQnqmEVaPXpaqiQvXHHZxCdHNKtqz62EYjvV9pxD957m",
      receiverAuthorizer: "FWdpM5uqURSoTVN4c5hqC6Ju5G4G1aGsx2ybEkh2UR53",
      seller: "CECeNsZhhDiCyDcHZL5dzvqZiHe3fjqKsT7p2NDzEhod",
    });
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
