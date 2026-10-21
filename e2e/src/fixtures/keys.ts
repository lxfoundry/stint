import { Surfnet } from "@solana/surfpool";
import { createKeyPairSignerFromBytes, type Address, type KeyPairSigner } from "@solana/kit";
import type { LocalNetwork } from "../network/surfnet.js";

/** A key generated for one run, with its secret bytes for services that need them (Kora). */
export interface HarnessKey {
  readonly signer: KeyPairSigner;
  readonly secretKey: Uint8Array;
}

export async function newHarnessKey(): Promise<HarnessKey> {
  const secretKey = Uint8Array.from(Surfnet.newKeypair().secretKey);
  return { signer: await createKeyPairSignerFromBytes(secretKey), secretKey };
}

const LAMPORTS_PER_SOL = 1_000_000_000;

/** Funds an address with SOL through a cheatcode. Wait for a new slot before relying on it. */
export function fundSol(network: LocalNetwork, address: Address, sol: number): void {
  network.surfnet.fundSol(address, sol * LAMPORTS_PER_SOL);
}
