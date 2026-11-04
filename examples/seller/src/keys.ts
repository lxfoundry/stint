import { createHmac } from "node:crypto";
import { createKeyPairSignerFromPrivateKeyBytes, getAddressEncoder, type KeyPairSigner } from "@solana/kit";

/**
 * Which index of the seed is which key: the funding key, which a person funds, then the stack's. An index is an
 * address: never reorder these, or the keys of an earlier deployment, and what they hold, are no longer found.
 */
export const KEY_INDEX = { funding: 0, koraFeePayer: 1, rentPayer: 2, receiverAuthorizer: 3, seller: 4 } as const;
export type KeyRole = keyof typeof KEY_INDEX;

/** The derivation's own label: a seed made for another use gives other keys here. */
export const KEY_LABEL = "stint-example-seller";

export interface SellerKey {
  readonly signer: KeyPairSigner;
  /** The 64 bytes Kora and the facilitator take: the private half, then the public half. */
  readonly secretKey: Uint8Array;
}

export type SellerKeys = { readonly [Role in KeyRole]: SellerKey };

/** The key at `index`: HMAC-SHA-256 of `stint-example-seller/<index>`, keyed by the seed, taken as an Ed25519 private key. */
export async function deriveSellerKey(seed: Uint8Array, index: number): Promise<SellerKey> {
  const privateKey = Uint8Array.from(createHmac("sha256", seed).update(`${KEY_LABEL}/${index}`).digest());
  const signer = await createKeyPairSignerFromPrivateKeyBytes(privateKey);
  return { signer, secretKey: Uint8Array.from([...privateKey, ...getAddressEncoder().encode(signer.address)]) };
}

export async function deriveSellerKeys(seed: Uint8Array): Promise<SellerKeys> {
  const roles = Object.keys(KEY_INDEX) as KeyRole[];
  const keys = await Promise.all(roles.map((role) => deriveSellerKey(seed, KEY_INDEX[role])));
  return Object.fromEntries(roles.map((role, position) => [role, keys[position]!])) as SellerKeys;
}

const ROLES: Readonly<Record<KeyRole, string>> = {
  funding: "funding key: send it devnet SOL; it gives the next two theirs",
  koraFeePayer: "Kora's fee payer: the fees of payments and closes",
  rentPayer: "the rent payer: each open session's accounts, returned at its close",
  receiverAuthorizer: "the receiver authorizer: signs the gate's closes, holds nothing",
  seller: "the seller's wallet: the USDC buyers pay",
};

/** One line per key, funding key first: its address, two spaces, its role. */
export function describeKeys(keys: SellerKeys): string {
  return (Object.keys(KEY_INDEX) as KeyRole[]).map((role) => `${keys[role].signer.address}  ${ROLES[role]}`).join("\n");
}
