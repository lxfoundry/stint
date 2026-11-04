import { fetchMaybeToken } from "@solana-program/token";
import { isSome, type Address, type Rpc, type SolanaRpcApi } from "@solana/kit";
import { fetchSysvarClock } from "@solana/sysvars";
import {
  allowanceAccounts,
  fetchMaybeRecurringDelegation,
  periodState,
  type AllowanceRef,
  type PeriodState,
} from "@lxfoundry/stint-subscriptions-client";

/** What the chain says about an allowance (spec §10.3). */
export interface AllowanceReport {
  readonly owner: Address;
  readonly delegation: Address;
  /** On the chain's clock. Absent when the owner has granted this key no such allowance, or has revoked it. */
  readonly period?: PeriodState;
  /** The owner's balance of the mint, in base units. */
  readonly ownerBalance: bigint;
  /**
   * What the owner's account lets the Subscription Authority move: its SPL Token delegated amount, or 0 when the account
   * has another delegate or none (S8: one delegate per token account).
   */
  readonly delegatedAmount: bigint;
}

/** Reads the delegation, the owner's balance and the chain's clock, at `confirmed`. */
export async function readAllowance(
  rpc: Rpc<SolanaRpcApi>,
  ref: AllowanceRef,
  config: { readonly abortSignal?: AbortSignal } = {},
): Promise<AllowanceReport> {
  const accounts = await allowanceAccounts(ref);
  const read = { commitment: "confirmed" as const, ...config };
  const [delegation, token, clock] = await Promise.all([
    fetchMaybeRecurringDelegation(rpc, accounts.delegation, read),
    fetchMaybeToken(rpc, accounts.ownerToken, read),
    fetchSysvarClock(rpc, read),
  ]);
  return {
    owner: ref.owner,
    delegation: accounts.delegation,
    ...(delegation.exists ? { period: periodState(delegation.data, BigInt(clock.unixTimestamp)) } : {}),
    ownerBalance: token.exists ? token.data.amount : 0n,
    delegatedAmount:
      token.exists && isSome(token.data.delegate) && token.data.delegate.value === accounts.subscriptionAuthority ? token.data.delegatedAmount : 0n,
  };
}

/** Why the allowance cannot fund a payment of `amount` now, or undefined when it can (spec §10.3). */
export function allowanceShortfall(report: AllowanceReport, amount: bigint): string | undefined {
  const period = report.period;
  if (!period) return `the owner ${report.owner} has granted this key no allowance, or has revoked it`;
  if (period.status === "expired") return "the allowance has expired";
  if (period.status === "notStarted") return "the allowance has not started yet";
  if (period.available < amount) {
    if (amount > period.perPeriod) return `the payment, ${amount}, is larger than the allowance's cap per period, ${period.perPeriod}`;
    return `the allowance for this period is used up: ${period.pulled} of ${period.perPeriod} pulled, ${period.available} left, ${amount} needed; the period ends at ${period.periodEnd}`;
  }
  if (report.ownerBalance < amount) return `the owner's account holds ${report.ownerBalance}, less than the ${amount} needed`;
  if (report.delegatedAmount < amount) {
    return "the owner's account no longer lets the allowance program move its tokens: its SPL Token delegate was changed or revoked";
  }
  return undefined;
}
