import { getTransferCheckedInstruction } from "@solana-program/token";
import type { Buyer } from "@lxfoundry/stint-conformance";
import type { Address, Rpc, SolanaRpcApi, TransactionSigner } from "@solana/kit";
import { sendInstructions, type SendOptions } from "../network/transactions.js";
import { USDC_DECIMALS, USDC_DEVNET_MINT } from "./usdc.js";

/**
 * Sends USDC from a buyer's token account to any token account and returns the signature. The buyer
 * signs as the owner; `feePayer` pays the fee, since a buyer holds no SOL (spec §9.1).
 */
export async function sendUsdc(
  rpc: Rpc<SolanaRpcApi>,
  feePayer: TransactionSigner,
  from: Buyer,
  to: Address,
  amount: bigint,
  options?: SendOptions,
): Promise<string> {
  const transfer = getTransferCheckedInstruction({
    source: from.usdcAccount,
    mint: USDC_DEVNET_MINT,
    destination: to,
    authority: from.signer,
    amount,
    decimals: USDC_DECIMALS,
  });
  return sendInstructions(rpc, feePayer, [transfer], options);
}
