import { TOKEN_PROGRAM_ADDRESS, findAssociatedTokenPda } from "@solana-program/token";
import type { Address, Instruction, TransactionSigner } from "@solana/kit";
import type { RecurringDelegation } from "./generated/accounts/recurringDelegation.js";
import { getCloseSubscriptionAuthorityInstruction } from "./generated/instructions/closeSubscriptionAuthority.js";
import { getCreateRecurringDelegationInstruction } from "./generated/instructions/createRecurringDelegation.js";
import { getInitSubscriptionAuthorityInstructionAsync } from "./generated/instructions/initSubscriptionAuthority.js";
import { getRevokeDelegationInstruction } from "./generated/instructions/revokeDelegation.js";
import { getTransferRecurringInstructionAsync } from "./generated/instructions/transferRecurring.js";
import { findRecurringDelegationPda } from "./generated/pdas/recurringDelegation.js";
import { findSubscriptionAuthorityPda } from "./generated/pdas/subscriptionAuthority.js";

/**
 * `expectedSubscriptionAuthorityInitId` for a delegation created in the same transaction as the owner's Subscription
 * Authority: the program then requires that the authority was created in the current slot.
 */
export const UNKNOWN_INIT_ID = -(2n ** 63n);

/** A recurring delegation from `owner` to `agent`, for `mint`. `nonce` tells apart two delegations between the same keys. */
export interface AllowanceRef {
  readonly owner: Address;
  readonly agent: Address;
  readonly mint: Address;
  readonly nonce: bigint;
}

export interface AllowanceAccounts {
  /** The owner's Subscription Authority for the mint: the SPL Token delegate of `ownerToken`. */
  readonly subscriptionAuthority: Address;
  readonly delegation: Address;
  /** The owner's associated token account: what a pull debits, and where refunds go. */
  readonly ownerToken: Address;
}

export async function allowanceAccounts(ref: AllowanceRef): Promise<AllowanceAccounts> {
  const [subscriptionAuthority] = await findSubscriptionAuthorityPda({ user: ref.owner, tokenMint: ref.mint });
  const [delegation] = await findRecurringDelegationPda({
    subscriptionAuthority,
    delegator: ref.owner,
    delegatee: ref.agent,
    nonce: ref.nonce,
  });
  const [ownerToken] = await findAssociatedTokenPda({ owner: ref.owner, mint: ref.mint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  return { subscriptionAuthority, delegation, ownerToken };
}

/** Where a recurring delegation stands, at a time on the chain's clock, as the program's next pull would see it. */
export interface PeriodState {
  readonly perPeriod: bigint;
  /** What has been pulled in the current period. A refund does not lower it. */
  readonly pulled: bigint;
  /** What a pull may still take in the current period: 0 once expired, or before the start. */
  readonly available: bigint;
  /** Unix seconds. */
  readonly periodStart: bigint;
  /** Unix seconds: the next period's start, or the expiry if that comes first. */
  readonly periodEnd: bigint;
  /** Unix seconds; 0 for a delegation that never expires. */
  readonly expiresAt: bigint;
  readonly status: "active" | "expired" | "notStarted";
}

type PeriodFields = Pick<RecurringDelegation, "currentPeriodStartTs" | "periodLengthS" | "expiryTs" | "amountPerPeriod" | "amountPulledInPeriod">;

/**
 * The program's own rule (its `validate_recurring_transfer`), applied at `now` without pulling anything. A period that has
 * elapsed is replaced by the current one, with nothing pulled; with a finite expiry, the start advances no further than
 * the last period start before the expiry. The expiry is a hard stop: after it, nothing can be pulled.
 */
export function periodState(delegation: PeriodFields, now: bigint): PeriodState {
  const length = BigInt(delegation.periodLengthS);
  const expiry = delegation.expiryTs;
  let start = delegation.currentPeriodStartTs;
  let pulled = delegation.amountPulledInPeriod;
  const status = expiry !== 0n && now > expiry ? "expired" : now < start ? "notStarted" : "active";
  if (status === "active" && length > 0n && now - start >= length) {
    const candidate = start + ((now - start) / length) * length;
    if (expiry === 0n || candidate < expiry) {
      start = candidate;
      pulled = 0n;
    } else {
      const lastBillable = expiry - 1n;
      if (lastBillable >= start) {
        const lastStart = start + ((lastBillable - start) / length) * length;
        if (lastStart > start) {
          start = lastStart;
          pulled = 0n;
        }
      }
    }
  }
  const left = delegation.amountPerPeriod > pulled ? delegation.amountPerPeriod - pulled : 0n;
  const end = start + length;
  return {
    perPeriod: delegation.amountPerPeriod,
    pulled,
    available: status === "active" ? left : 0n,
    periodStart: start,
    periodEnd: expiry !== 0n && end > expiry ? expiry : end,
    expiresAt: expiry,
    status,
  };
}

/**
 * One pull of exactly `amount` from the owner's associated token account into `destination` (spec §10.2), signed by the
 * agent as the delegation's delegatee. `destination` must exist: the program checks its mint.
 */
export async function allowancePullInstruction(input: {
  readonly owner: Address;
  readonly agent: TransactionSigner;
  readonly mint: Address;
  readonly nonce: bigint;
  readonly destination: Address;
  readonly amount: bigint;
}): Promise<Instruction> {
  const accounts = await allowanceAccounts({ owner: input.owner, agent: input.agent.address, mint: input.mint, nonce: input.nonce });
  return getTransferRecurringInstructionAsync({
    delegationPda: accounts.delegation,
    subscriptionAuthority: accounts.subscriptionAuthority,
    delegatorAta: accounts.ownerToken,
    receiverAta: input.destination,
    tokenMint: input.mint,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
    delegatee: input.agent,
    transferData: { amount: input.amount, delegator: input.owner, mint: input.mint },
  });
}

export interface GrantInput {
  readonly owner: TransactionSigner;
  readonly agent: Address;
  readonly mint: Address;
  readonly perPeriod: bigint;
  readonly periodSeconds: bigint;
  /** Unix seconds, after the grant lands. Required: a delegation that starts when it lands must have an expiry. */
  readonly expiresAt: bigint;
  readonly nonce: bigint;
  /** The `initId` of the owner's Subscription Authority if it exists; omitted, the grant creates it. */
  readonly existingInitId?: bigint;
}

/**
 * The grant of spec §10.1: the owner's Subscription Authority, unless it exists, and a recurring delegation to the agent
 * that starts when the transaction lands. The owner signs, and pays the fee and both accounts' rent.
 */
export async function grantInstructions(input: GrantInput): Promise<Instruction[]> {
  if (input.expiresAt <= 0n) throw new RangeError("A grant needs an expiry: a delegation that starts when it lands must end");
  const accounts = await allowanceAccounts({ owner: input.owner.address, agent: input.agent, mint: input.mint, nonce: input.nonce });
  const create = getCreateRecurringDelegationInstruction({
    delegator: input.owner,
    subscriptionAuthority: accounts.subscriptionAuthority,
    delegationAccount: accounts.delegation,
    delegatee: input.agent,
    recurringDelegation: {
      nonce: input.nonce,
      amountPerPeriod: input.perPeriod,
      periodLengthS: input.periodSeconds,
      startTs: 0n,
      expiryTs: input.expiresAt,
      expectedSubscriptionAuthorityInitId: input.existingInitId ?? UNKNOWN_INIT_ID,
    },
  });
  if (input.existingInitId !== undefined) return [create];
  const init = await getInitSubscriptionAuthorityInstructionAsync({
    owner: input.owner,
    tokenMint: input.mint,
    userAta: accounts.ownerToken,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });
  return [init, create];
}

/**
 * Revokes a delegation; its rent returns to the owner. `closeAuthority` also closes the owner's Subscription Authority,
 * which returns its rent too, and ends every other delegation the owner has granted for that mint.
 */
export function revokeInstructions(input: {
  readonly owner: TransactionSigner;
  readonly delegation: Address;
  readonly closeAuthority?: Address;
}): Instruction[] {
  const revoke = getRevokeDelegationInstruction({ authority: input.owner, delegationAccount: input.delegation });
  if (input.closeAuthority === undefined) return [revoke];
  return [revoke, getCloseSubscriptionAuthorityInstruction({ user: input.owner, subscriptionAuthority: input.closeAuthority })];
}
