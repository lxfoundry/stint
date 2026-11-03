import { LAUNCH_AMOUNT, LAUNCH_SECONDS, TOP_UP_SECONDS, isRunning, type DemoSession, type DemoState } from "../src/state.js";

/** The panel's logic, without the DOM: the server refuses with the same words what the panel does not offer. */

const USDC_DECIMALS = 6;

/** `"100000"` → `"0.100 USDC"`: at least three decimals, and no trailing zero beyond them. */
export function formatUsdc(baseUnits: string): string {
  if (!/^\d+$/.test(baseUnits)) return "? USDC";
  const value = BigInt(baseUnits);
  const scale = 10n ** BigInt(USDC_DECIMALS);
  const fraction = (value % scale).toString().padStart(USDC_DECIMALS, "0").replace(/0+$/, "").padEnd(3, "0");
  return `${value / scale}.${fraction} USDC`;
}

/** What to add to the panel's clock to read the server's, from a state the server stamped `serverNowMs`. */
export const skewOf = (serverNowMs: number, localNowMs: number): number => serverNowMs - localNowMs;

/** Whole seconds to `paidUntil` at `nowMs` (the server's clock), never below zero. */
export function secondsLeft(session: DemoSession, nowMs: number): number {
  if (session.paidUntil === undefined) return 0;
  return Math.max(0, Math.ceil(session.paidUntil - nowMs / 1000));
}

/**
 * The capsule (`brand/README.md`): the paid time and the time used, as shares of the longest session the seller allows,
 * so that a top-up moves the capsule's end out. The time used stops at `endedAt`, and fills the capsule once expired.
 */
export function capsule(session: DemoSession, nowMs: number): { used: number; paid: number } {
  const { startedAt, paidUntil, maxSeconds } = session;
  if (startedAt === undefined || paidUntil === undefined || !maxSeconds) return { used: 0, paid: 0 };
  const paidSeconds = Math.max(0, paidUntil - startedAt);
  const at = session.state === "expired" ? paidUntil : (session.endedAt ?? nowMs / 1000);
  const usedSeconds = Math.min(paidSeconds, Math.max(0, at - startedAt));
  return { used: Math.min(1, usedSeconds / maxSeconds), paid: Math.min(1, paidSeconds / maxSeconds) };
}

function notRunning(session: DemoSession): string {
  switch (session.state) {
    case "opening":
      return "The session is still opening";
    case "closing":
      return "The session is closing";
    case "closed":
      return "The session is closed: launch a new one";
    case "expired":
      return "The session has expired: its paid time ran out";
    case "ended":
      return "The seller ended the session";
    default:
      return "No session is running: launch one first";
  }
}

/**
 * Why a top-up is not offered now, or undefined when it is: only an open session, more than the facilitator's margin
 * plus 3 s before its end (spec §5.4), and only while `maxSeconds` leaves room for `TOP_UP_SECONDS` more (spec §5.2).
 */
export function topUpRefusal(session: DemoSession, nowMs: number): string | undefined {
  if (session.state !== "open" || session.paidUntil === undefined) return notRunning(session);
  const margin = session.topUpMarginSeconds + 3;
  if (session.paidUntil - nowMs / 1000 <= margin) return `Too close to the end: a top-up must start more than ${margin} s before it`;
  if (session.deposited !== undefined && session.rate !== undefined && session.maxSeconds !== undefined) {
    const paidSeconds = Number(BigInt(session.deposited) / BigInt(session.rate));
    if (paidSeconds + TOP_UP_SECONDS > session.maxSeconds) {
      return `A session runs at most ${session.maxSeconds} s: this one has no room for ${TOP_UP_SECONDS} s more`;
    }
  }
  return undefined;
}

/** Why "Close now" is not offered, or undefined when it is: from `paidUntil` on, the gate closes the session itself. */
export function closeRefusal(session: DemoSession, nowMs: number): string | undefined {
  if (session.state !== "open" || session.paidUntil === undefined) return notRunning(session);
  if (nowMs >= session.paidUntil * 1000) return "The paid time is over: the gate is closing the session";
  return undefined;
}

/** A launch is offered when no session runs, nothing is under way, and the wallet holds `LAUNCH_AMOUNT`. */
export function canLaunch(state: DemoState): boolean {
  const usdc = state.wallet.usdc;
  return !isRunning(state.session) && !state.busy && usdc !== undefined && BigInt(usdc) >= BigInt(LAUNCH_AMOUNT);
}

/** One line on what the session is doing. */
export function headline(state: DemoState, nowMs: number): string {
  const session = state.session;
  const amounts =
    session.paid !== undefined && session.refunded !== undefined ? `paid ${formatUsdc(session.paid)}, refunded ${formatUsdc(session.refunded)}` : undefined;
  switch (session.state) {
    case "none": {
      const usdc = state.wallet.usdc;
      if (usdc === undefined) return "Checking the wallet…";
      return BigInt(usdc) < BigInt(LAUNCH_AMOUNT) ? `Fund the wallet with ${formatUsdc(LAUNCH_AMOUNT)} to start` : `Ready: launch a ${LAUNCH_SECONDS} s session`;
    }
    case "opening":
      return "Opening a session…";
    case "open":
      return session.paidUntil !== undefined && nowMs < session.paidUntil * 1000
        ? `Running: ${secondsLeft(session, nowMs)} s of paid time left`
        : "Paid time over: the gate is closing";
    case "closing":
      return "Closing the session…";
    case "closed":
      return amounts ? `Closed: ${amounts}` : "Closed";
    case "expired":
      return `Expired: the seller was paid ${formatUsdc(session.paid ?? session.deposited ?? "0")}`;
    case "ended":
      return amounts ? `Ended by the seller before its paid time: ${amounts}` : "Ended by the seller before its paid time";
  }
}
