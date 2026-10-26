import { generateKeyPairSigner, type Address, type KeyPairSigner, type Rpc, type SolanaRpcApi, type TransactionSigner } from "@solana/kit";
import { mintUsdc } from "./usdc.js";

export interface Buyer {
  readonly signer: KeyPairSigner;
  readonly usdcAccount: Address;
}

/** A fresh buyer key holding `usdc` base units in its associated token account, and no SOL (spec §9.1). */
export async function newBuyer(rpc: Rpc<SolanaRpcApi>, mintAuthority: TransactionSigner, usdc: bigint): Promise<Buyer> {
  const signer = await generateKeyPairSigner();
  const usdcAccount = await mintUsdc(rpc, mintAuthority, signer.address, usdc);
  return { signer, usdcAccount };
}
