import type { Buyer } from "@lxfoundry/stint-conformance";
import { generateKeyPairSigner, type Rpc, type SolanaRpcApi, type TransactionSigner } from "@solana/kit";
import { mintUsdc } from "./usdc.js";

/** A fresh buyer key holding `usdc` base units in its associated token account, and no SOL (spec §9.1). */
export async function newBuyer(rpc: Rpc<SolanaRpcApi>, mintAuthority: TransactionSigner, usdc: bigint): Promise<Buyer> {
  const signer = await generateKeyPairSigner();
  const usdcAccount = await mintUsdc(rpc, mintAuthority, signer.address, usdc);
  return { signer, usdcAccount };
}
