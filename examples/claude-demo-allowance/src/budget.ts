/**
 * The allowance as the state carries it, and the words the panel and the server use for it. Pure: the panel's bundle
 * includes it.
 */
import { formatAmount, formatUsdc } from "../../claude-demo/app/model.js";
import type { DemoState } from "../../claude-demo/src/state.js";

/** What the chain said at a read: base-unit strings, Unix seconds. */
export type AllowanceRead =
  | { readonly status: "none" }
  | {
      readonly status: "active" | "expired" | "notStarted";
      readonly perPeriod: string;
      readonly pulled: string;
      readonly left: string;
      /** The next period's start, or the expiry if that comes first. */
      readonly periodEnd: number;
      /** Absent for a delegation that never expires. */
      readonly expiresAt?: number;
    };

export interface AllowanceView {
  readonly owner: string;
  readonly agent: string;
  readonly nonce: string;
  /** The latest read that succeeded; absent until one has. */
  readonly read?: AllowanceRead;
  /** When `read` was made, in milliseconds. */
  readonly readAt?: number;
  /** The latest read failed: `read` is the one before. */
  readonly stale: boolean;
}

export type AllowanceState = DemoState & { readonly allowance: AllowanceView };

/** What the panel suggests granting: two payments of 0.100 USDC an hour, for one day. */
export const SUGGESTED_PER_PERIOD = "200000";
export const SUGGESTED_PERIOD_SECONDS = 3_600;
const DAY_MS = 86_400_000;

/** `17:15 UTC`. */
export function utcTime(unixSeconds: number): string {
  return `${new Date(unixSeconds * 1000).toISOString().slice(11, 16)} UTC`;
}

export function budgetLine(view: AllowanceView): string {
  const read = view.read;
  if (!read) return "Reading the allowance…";
  const stale = view.stale ? " (the latest read failed: this is the one before)" : "";
  switch (read.status) {
    case "none":
      return `No allowance from this owner for this agent yet${stale}`;
    case "expired":
      return `The allowance has expired${stale}`;
    case "notStarted":
      return `The allowance has not started yet${stale}`;
    case "active":
      return `${formatAmount(read.pulled)} of ${formatUsdc(read.perPeriod)} pulled this period · ${formatUsdc(read.left)} left · the period ends at ${utcTime(read.periodEnd)}${stale}`;
  }
}

/** The share of the period's cap already pulled, from 0 to 1. */
export function budgetShare(view: AllowanceView): number {
  const read = view.read;
  if (!read || read.status === "none" || BigInt(read.perPeriod) === 0n) return 0;
  return Math.min(1, Number(BigInt(read.pulled) * 10_000n / BigInt(read.perPeriod)) / 10_000);
}

/** The command the owner runs, from the repository, to grant this agent the suggested allowance. */
export function grantCommand(view: AllowanceView, nowMs: number): string {
  const expires = new Date(nowMs + DAY_MS).toISOString().replace(/\.\d{3}Z$/, "Z");
  const nonce = view.nonce === "0" ? "" : ` --nonce ${view.nonce}`;
  return `pnpm stint allowance grant --keypair "$HOME/.config/stint/allowance-owner.json" --agent ${view.agent} --per-period ${SUGGESTED_PER_PERIOD} --period ${SUGGESTED_PERIOD_SECONDS} --expires ${expires}${nonce}`;
}

/** Said before a launch the allowance, as last read, cannot fund: the launch is still offered, and the chain refuses it. */
export function launchHint(view: AllowanceView, amount: bigint): string | undefined {
  const read = view.read;
  if (!read) return undefined;
  const refused = "a launch will be refused on-chain";
  if (read.status === "none") return `No allowance yet: ${refused}`;
  if (read.status === "expired") return `The allowance has expired: ${refused}`;
  if (read.status === "notStarted") return `The allowance has not started yet: ${refused}`;
  return BigInt(read.left) < amount ? `${formatUsdc(read.left)} left this period: ${refused}` : undefined;
}
