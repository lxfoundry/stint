import { TOKEN_PROGRAM_ADDRESS, findAssociatedTokenPda, getTransferCheckedInstruction } from "@solana-program/token";
import type { Address, Instruction, TransactionSigner } from "@solana/kit";
import { allowancePullInstruction } from "@lxfoundry/stint-subscriptions-client";

/**
 * Where a session's deposit comes from (spec §5.3, §10): the authority's own associated token account, or a recurring
 * delegation that `owner` granted the authority's key on the Subscriptions & Allowances program.
 */
export type FundingSource =
  | { readonly kind: "own" }
  | { readonly kind: "allowance"; readonly owner: Address; readonly nonce: bigint };

export const OWN_FUNDS: FundingSource = { kind: "own" };

/** Who refunds go to: the owner of the account the money comes from (spec §4.6). */
export function refundOwnerOf(funding: FundingSource, authority: Address): Address {
  return funding.kind === "allowance" ? funding.owner : authority;
}

/**
 * The one funding instruction of an `open` or a `topUp` (spec §5.3): exactly `amount` of `mint` into `vault`, by a
 * `TransferChecked` from the authority's own account, or by one pull from its allowance.
 */
export async function fundingInstruction(input: {
  readonly funding: FundingSource;
  readonly authority: TransactionSigner;
  readonly mint: Address;
  readonly vault: Address;
  readonly amount: bigint;
  readonly decimals: number;
}): Promise<Instruction> {
  const { funding, authority, mint, vault, amount } = input;
  if (funding.kind === "allowance") {
    return allowancePullInstruction({ owner: funding.owner, agent: authority, mint, nonce: funding.nonce, destination: vault, amount });
  }
  const [source] = await findAssociatedTokenPda({ owner: authority.address, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  return getTransferCheckedInstruction({ source, mint, destination: vault, authority, amount, decimals: input.decimals });
}
