import {
  TOKEN_PROGRAM_ADDRESS,
  TokenInstruction,
  identifyTokenInstruction,
  parseTransferCheckedInstruction,
} from "@solana-program/token";
import { isInstructionWithAccounts, isInstructionWithData, type Address, type Instruction } from "@solana/kit";
import {
  SUBSCRIPTIONS_PROGRAM_ADDRESS,
  SubscriptionsInstruction,
  findEventAuthorityPda,
  findSubscriptionAuthorityPda,
  identifySubscriptionsInstruction,
  parseTransferRecurringInstruction,
} from "@lxfoundry/stint-subscriptions-client";
import { refuse, type Check } from "./types.js";

/** A funding instruction, read the same way whatever its kind (spec §5.3, §10.2). */
export interface FundingRead {
  readonly kind: "transfer" | "allowance";
  /** The token account debited. */
  readonly source: Address;
  readonly destination: Address;
  readonly mint: Address;
  readonly amount: bigint;
  /** The key whose signature moves the tokens: the transfer's authority, or the pull's delegatee. */
  readonly signer: Address;
  /** The pull's delegator, the owner of the allowance: an allowance only. */
  readonly owner?: Address;
}

/** The pull's accounts: delegation, subscription authority, owner's account, destination, mint, token program, delegatee, event authority, program. */
const PULL_ACCOUNTS = 9;

function kindOf<T>(identify: (ix: { data: Uint8Array }) => T, ix: Instruction): T | undefined {
  if (!isInstructionWithData(ix) || !isInstructionWithAccounts(ix)) return undefined;
  try {
    return identify(ix as never);
  } catch {
    return undefined; // data no instruction of that program has
  }
}

/**
 * The funding instruction of an open or a top-up: a `TransferChecked`, or one pull from a recurring delegation (spec §10.2).
 * Undefined when the instruction is neither, or is malformed, which the layout check refuses as `unexpected_instruction`.
 * A pull whose program-derived accounts are not the canonical ones for its owner and mint is refused here. Its delegation
 * account is checked by the program itself, at simulation: it holds the delegator and the delegatee the program compares.
 */
export async function readFunding(ix: Instruction): Promise<Check<FundingRead> | undefined> {
  if (ix.programAddress === TOKEN_PROGRAM_ADDRESS && kindOf(identifyTokenInstruction, ix) === TokenInstruction.TransferChecked) {
    try {
      const t = parseTransferCheckedInstruction(ix as never);
      return {
        ok: true,
        value: {
          kind: "transfer",
          source: t.accounts.source.address,
          destination: t.accounts.destination.address,
          mint: t.accounts.mint.address,
          amount: t.data.amount,
          signer: t.accounts.authority.address,
        },
      };
    } catch {
      return undefined; // too few accounts, or short data
    }
  }
  if (ix.programAddress !== SUBSCRIPTIONS_PROGRAM_ADDRESS) return undefined;
  if (kindOf(identifySubscriptionsInstruction, ix) !== SubscriptionsInstruction.TransferRecurring) return undefined;
  // Exactly its nine accounts: more are for a mint's transfer hook, and only classic SPL Token mints are supported (spec §3.4).
  if ((ix.accounts?.length ?? 0) !== PULL_ACCOUNTS) return undefined;
  let pull: ReturnType<typeof parseTransferRecurringInstruction>;
  try {
    pull = parseTransferRecurringInstruction(ix as never);
  } catch {
    return undefined;
  }
  const { accounts, data } = pull;
  const { mint, delegator: owner, amount } = data.transferData;
  const [authority] = await findSubscriptionAuthorityPda({ user: owner, tokenMint: mint });
  const [eventAuthority] = await findEventAuthorityPda();
  if (
    accounts.tokenMint.address !== mint ||
    accounts.tokenProgram.address !== TOKEN_PROGRAM_ADDRESS ||
    accounts.subscriptionAuthority.address !== authority ||
    accounts.eventAuthority.address !== eventAuthority ||
    accounts.selfProgram.address !== SUBSCRIPTIONS_PROGRAM_ADDRESS
  ) {
    return refuse("invalid_terms", "the allowance pull's accounts are not the canonical ones for its owner and mint");
  }
  return {
    ok: true,
    value: {
      kind: "allowance",
      source: accounts.delegatorAta.address,
      destination: accounts.receiverAta.address,
      mint,
      amount,
      signer: accounts.delegatee.address,
      owner,
    },
  };
}
