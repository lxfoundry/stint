import {
  TOKEN_PROGRAM_ADDRESS,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getMintEncoder,
  getMintSize,
  getMintToCheckedInstruction,
} from "@solana-program/token";
import { address, some, type Address, type Rpc, type SolanaRpcApi, type TransactionSigner } from "@solana/kit";
import { sendInstructions } from "../network/transactions.js";
import type { LocalNetwork } from "../network/surfnet.js";

/** Devnet USDC (spec section 3.4). */
export const USDC_DEVNET_MINT = address("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
export const USDC_DECIMALS = 6;

/**
 * Writes the USDC mint at its devnet address with harness keys as its mint and freeze authorities
 * (spec section 12.3). Balances are then minted by ordinary transactions.
 */
export async function writeUsdcMint(
  network: LocalNetwork,
  authorities: { mintAuthority: Address; freezeAuthority: Address },
): Promise<void> {
  const data = getMintEncoder().encode({
    mintAuthority: some(authorities.mintAuthority),
    supply: 0n,
    decimals: USDC_DECIMALS,
    isInitialized: true,
    freezeAuthority: some(authorities.freezeAuthority),
  });
  if (data.length !== getMintSize()) throw new Error(`Unexpected mint size ${data.length}`);
  const rent = await network.rpc.getMinimumBalanceForRentExemption(BigInt(getMintSize())).send();
  network.surfnet.setAccount(USDC_DEVNET_MINT, Number(rent), Uint8Array.from(data), TOKEN_PROGRAM_ADDRESS);
}

/** Creates the owner's USDC associated token account, paid for by `payer`, and returns it. */
export async function createUsdcAccount(
  rpc: Rpc<SolanaRpcApi>,
  payer: TransactionSigner,
  owner: Address,
): Promise<Address> {
  const [account] = await findAssociatedTokenPda({ owner, mint: USDC_DEVNET_MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  const create = await getCreateAssociatedTokenIdempotentInstructionAsync({ payer, owner, mint: USDC_DEVNET_MINT });
  await sendInstructions(rpc, payer, [create]);
  return account;
}

/** Mints USDC to the owner's associated token account, creating it first, and returns it. */
export async function mintUsdc(
  rpc: Rpc<SolanaRpcApi>,
  mintAuthority: TransactionSigner,
  owner: Address,
  amount: bigint,
): Promise<Address> {
  const account = await createUsdcAccount(rpc, mintAuthority, owner);
  const mintTo = getMintToCheckedInstruction({
    mint: USDC_DEVNET_MINT,
    token: account,
    mintAuthority,
    amount,
    decimals: USDC_DECIMALS,
  });
  await sendInstructions(rpc, mintAuthority, [mintTo]);
  return account;
}
