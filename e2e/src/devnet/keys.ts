import { createHmac } from "node:crypto";
import { createKeyPairSignerFromPrivateKeyBytes, getAddressEncoder, type Address, type KeyPairSigner } from "@solana/kit";
import type { HarnessKey } from "../fixtures/keys.js";
import type { ServiceKeys } from "../targets/services.js";

/**
 * Which index of the seed is which key. The funding key is a person's to fund and plays no part in a
 * scenario; the next four are the stack's; the buyers follow, one index each. An index is an address:
 * never reorder these, or the keys of earlier runs, and what they hold, are no longer found.
 */
export const KEY_INDEX = { funding: 0, koraFeePayer: 1, rentPayer: 2, receiverAuthorizer: 3, seller: 4 } as const;
const FIRST_BUYER_INDEX = 5;

/**
 * The buyer keys a run may hand out. With the four of the stack this makes 100 keys, which the clean-up
 * reads in one batch of 100 accounts for their SOL and one for their USDC.
 */
export const BUYER_POOL = 96;

/** The key at `index` of `seed`, of any length: HMAC-SHA-256 of the index, keyed by the seed, taken as an Ed25519 private key. */
export async function deriveKey(seed: Uint8Array, index: number): Promise<HarnessKey> {
  const privateKey = Uint8Array.from(createHmac("sha256", seed).update(`stint-devnet-harness/${index}`).digest());
  const signer = await createKeyPairSignerFromPrivateKeyBytes(privateKey);
  return { signer, secretKey: Uint8Array.from([...privateKey, ...getAddressEncoder().encode(signer.address)]) };
}

export interface DevnetKeys {
  readonly funding: HarnessKey;
  readonly stack: ServiceKeys;
  /** In the order that the target hands them out. */
  readonly buyers: readonly HarnessKey[];
  /** Every key but the funding key, by address: what the clean-up empties and signs closes with. */
  readonly holders: ReadonlyMap<Address, KeyPairSigner>;
}

export async function deriveKeys(seed: Uint8Array, buyerPool = BUYER_POOL): Promise<DevnetKeys> {
  const funding = await deriveKey(seed, KEY_INDEX.funding);
  const stack: ServiceKeys = {
    koraFeePayer: await deriveKey(seed, KEY_INDEX.koraFeePayer),
    rentPayer: await deriveKey(seed, KEY_INDEX.rentPayer),
    receiverAuthorizer: await deriveKey(seed, KEY_INDEX.receiverAuthorizer),
    seller: await deriveKey(seed, KEY_INDEX.seller),
  };
  const buyers = await Promise.all(Array.from({ length: buyerPool }, (_, offset) => deriveKey(seed, FIRST_BUYER_INDEX + offset)));
  const holders = new Map<Address, KeyPairSigner>();
  for (const key of [...Object.values(stack), ...buyers]) holders.set(key.signer.address, key.signer);
  return { funding, stack, buyers, holders };
}
