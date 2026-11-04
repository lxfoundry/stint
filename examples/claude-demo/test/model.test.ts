import { describe, expect, it } from "vitest";
import {
  canLaunch,
  capsule,
  closeRefusal,
  formatAmount,
  formatUsdc,
  headline,
  isStale,
  ledgerLine,
  needsFunding,
  secondsLeft,
  skewOf,
  surfaceOf,
  topUpRefusal,
} from "../app/model.js";
import { FAUCET_URL, type DemoAction, type DemoSession, type DemoState, type LedgerEntry } from "../src/state.js";

/** A 100 s session from 1,000 to 1,100, at 1000 base units a second, in a seller's 300 s at most. */
const running = (fields: Partial<DemoSession> = {}): DemoSession => ({
  state: "open",
  sessionId: "S",
  startedAt: 1_000,
  paidUntil: 1_100,
  deposited: "100000",
  rate: "1000",
  maxSeconds: 300,
  topUpMarginSeconds: 10,
  frames: 0,
  links: { topUps: [] },
  ...fields,
});
const none: DemoSession = { state: "none", topUpMarginSeconds: 10, frames: 0, links: { topUps: [] } };
const stateOf = (session: DemoSession, usdc?: string, busy?: DemoAction): DemoState => ({
  wallet: { address: "A", ...(usdc === undefined ? {} : { usdc }) },
  gateUrl: "https://gate.example",
  faucetUrl: FAUCET_URL,
  session,
  exchange: { current: [] },
  ledger: [],
  now: 0,
  ...(busy ? { busy } : {}),
});

describe("amounts", () => {
  it("shows USDC with at least three decimals, and no trailing zero beyond them", () => {
    expect(formatUsdc("100000")).toBe("0.100 USDC");
    expect(formatUsdc("1000")).toBe("0.001 USDC");
    expect(formatUsdc("0")).toBe("0.000 USDC");
    expect(formatUsdc("100")).toBe("0.0001 USDC");
    expect(formatUsdc("1500000")).toBe("1.500 USDC");
    expect(formatUsdc("1234567")).toBe("1.234567 USDC");
    expect(formatUsdc("12000000")).toBe("12.000 USDC");
    expect(formatUsdc("-5")).toBe("? USDC");
  });
});

describe("the time left", () => {
  it("counts whole seconds to paidUntil, never below zero", () => {
    expect(secondsLeft(running(), 1_090_000)).toBe(10);
    expect(secondsLeft(running(), 1_090_100)).toBe(10);
    expect(secondsLeft(running(), 1_100_500)).toBe(0);
    expect(secondsLeft(none, 0)).toBe(0);
  });

  it("corrects the panel's clock by the server's", () => {
    expect(skewOf(10_500, 10_000)).toBe(500);
    expect(skewOf(9_000, 10_000)).toBe(-1_000);
  });
});

describe("the capsule", () => {
  it("draws the paid time and the time used as shares of the paid time and one top-up more", () => {
    expect(capsule(running(), 1_050_000)).toEqual({ used: 50 / 200, paid: 100 / 200 });
    expect(capsule(running({ paidUntil: 1_200, deposited: "200000" }), 1_050_000)).toEqual({ used: 50 / 300, paid: 200 / 300 });
    expect(capsule(running(), 990_000)).toEqual({ used: 0, paid: 100 / 200 });
  });

  it("never draws past the longest session, and keeps a short session readable in a long one", () => {
    expect(capsule(running({ paidUntil: 1_300, deposited: "300000" }), 1_050_000)).toEqual({ used: 50 / 300, paid: 1 });
    expect(capsule(running({ maxSeconds: 1_000 }), 1_050_000)).toEqual({ used: 50 / 200, paid: 100 / 200 });
    expect(capsule(running({ maxSeconds: 1_000, paidUntil: 1_950, deposited: "950000" }), 1_050_000)).toEqual({ used: 50 / 1_000, paid: 950 / 1_000 });
    expect(capsule(running({ maxSeconds: 1_000, paidUntil: 2_000, deposited: "1000000" }), 1_050_000)).toEqual({ used: 50 / 1_000, paid: 1 });
  });

  it("stops at the close, is full once the session expired, and is empty with no session", () => {
    expect(capsule(running({ state: "closed", endedAt: 1_030 }), 1_090_000)).toEqual({ used: 30 / 200, paid: 100 / 200 });
    expect(capsule(running({ state: "expired" }), 1_500_000)).toEqual({ used: 100 / 200, paid: 100 / 200 });
    expect(capsule(none, 0)).toEqual({ used: 0, paid: 0 });
  });
});

describe("the wallet's log", () => {
  const entry = (fields: Partial<LedgerEntry>): LedgerEntry => ({ kind: "launch", sessionId: "S", at: 0, direction: "out", ...fields });

  it("writes each movement as the balance before, the amount and the balance after", () => {
    expect(ledgerLine(entry({ amount: "100000", before: "19630000", after: "19530000" }))).toBe("[launch] 19.630 - 0.100 = 19.530 USDC");
    expect(ledgerLine(entry({ kind: "top-up", amount: "100000", before: "19530000", after: "19430000" }))).toBe(
      "[top-up] 19.530 - 0.100 = 19.430 USDC",
    );
    expect(ledgerLine(entry({ kind: "close", direction: "in", amount: "34000", before: "19430000", after: "19464000" }))).toBe(
      "[close] 19.430 + 0.034 = 19.464 USDC",
    );
  });

  it("names the ends the demo did not make", () => {
    expect(ledgerLine(entry({ kind: "expired", direction: "in", amount: "0", before: "900000", after: "900000" }))).toBe(
      "[expired] 0.900 + 0.000 = 0.900 USDC: the seller was paid in full",
    );
    expect(ledgerLine(entry({ kind: "ended", direction: "in", amount: "39000", before: "900000", after: "939000" }))).toBe(
      "[ended by the seller] 0.900 + 0.039 = 0.939 USDC",
    );
  });

  it("gives the amount alone when the balance before is not known, and says so when the amount is not", () => {
    expect(ledgerLine(entry({ amount: "100000" }))).toBe("[launch] -0.100 USDC");
    expect(ledgerLine(entry({ kind: "close", direction: "in" }))).toBe("[close] the refund was not reported: see the close transaction");
  });

  it("writes amounts with at least three decimals, and nothing for a value that is not one", () => {
    expect(formatAmount("19464000")).toBe("19.464");
    expect(formatAmount("1234567")).toBe("1.234567");
    expect(formatAmount("x")).toBe("?");
  });
});

describe("what the panel offers", () => {
  it("offers a top-up until the margin before the end, and within the longest session", () => {
    expect(topUpRefusal(running(), 1_086_000)).toBeUndefined();
    expect(topUpRefusal(running(), 1_087_000)).toBe("Too close to the end: a top-up must start more than 13 s before it");
    expect(topUpRefusal(running({ paidUntil: 1_300, deposited: "300000" }), 1_100_000)).toBe(
      "A session runs at most 300 s: this one has no room for 100 s more",
    );
    expect(topUpRefusal(running({ paidUntil: 1_200, deposited: "200000" }), 1_100_000)).toBeUndefined();
    expect(topUpRefusal(running({ state: "closed" }), 1_050_000)).toBe("The session is closed: launch a new one");
  });

  it("offers a close until the paid time is over", () => {
    expect(closeRefusal(running(), 1_099_000)).toBeUndefined();
    expect(closeRefusal(running(), 1_100_000)).toBe("The paid time is over: the gate is closing the session");
    expect(closeRefusal(none, 0)).toBe("No session is running: launch one first");
  });

  it("offers a launch from 0.1 USDC, when no session runs and nothing is under way", () => {
    expect(canLaunch(stateOf(none, "100000"))).toBe(true);
    expect(canLaunch(stateOf(none, "99999"))).toBe(false);
    expect(canLaunch(stateOf(none))).toBe(false);
    expect(canLaunch(stateOf(running(), "100000"))).toBe(false);
    expect(canLaunch(stateOf(running({ state: "expired" }), "100000"))).toBe(true);
    expect(canLaunch(stateOf(none, "100000", "launch"))).toBe(false);
  });
});

describe("the headline", () => {
  it("says what the session is doing", () => {
    expect(headline(stateOf(none), 0)).toBe("Checking the wallet…");
    expect(headline(stateOf(none, "0"), 0)).toBe("Fund the wallet with 0.100 USDC to start");
    expect(headline(stateOf(none, "100000"), 0)).toBe("Ready: launch a 100 s session");
    expect(headline(stateOf(running({ state: "opening" })), 0)).toBe("Opening a session…");
    expect(headline(stateOf(running()), 1_040_000)).toBe("Running: 60 s of paid time left");
    expect(headline(stateOf(running()), 1_100_000)).toBe("Paid time over: the gate is closing");
    expect(headline(stateOf(running({ state: "closing" })), 0)).toBe("Closing the session…");
    expect(headline(stateOf(running({ state: "closed", paid: "12000", refunded: "88000" })), 0)).toBe(
      "Closed: paid 0.012 USDC, refunded 0.088 USDC",
    );
    expect(headline(stateOf(running({ state: "expired", paid: "100000" })), 0)).toBe("Expired: the seller was paid 0.100 USDC");
    expect(headline(stateOf(running({ state: "ended", paid: "61000", refunded: "39000" })), 0)).toBe(
      "Ended by the seller before its paid time: paid 0.061 USDC, refunded 0.039 USDC",
    );
  });
});

describe("the funding row", () => {
  it("shows when the wallet is short and no session runs", () => {
    expect(needsFunding(stateOf(none, "0"))).toBe(true);
    expect(needsFunding(stateOf(none, "99999"))).toBe(true);
    expect(needsFunding(stateOf(running({ state: "closed" }), "40000"))).toBe(true);
    expect(needsFunding(stateOf(running({ state: "expired" }), "40000"))).toBe(true);
    expect(needsFunding(stateOf(running({ state: "ended" }), "40000"))).toBe(true);
  });

  it("stays away while a session runs: a launch spends the balance down on purpose", () => {
    for (const phase of ["opening", "open", "closing"] as const) {
      expect(needsFunding(stateOf(running({ state: phase }), "0"))).toBe(false);
      expect(needsFunding(stateOf(running({ state: phase }), "40000"))).toBe(false);
    }
  });

  it("stays away when the wallet holds enough, or has not been read", () => {
    expect(needsFunding(stateOf(none, "100000"))).toBe(false);
    expect(needsFunding(stateOf(none, "5000000"))).toBe(false);
    expect(needsFunding(stateOf(none))).toBe(false);
  });
});

describe("which state to draw", () => {
  const at = (now: number): DemoState => ({ ...stateOf(none, "100000"), now });

  it("takes the first state, and any that is not older than the one drawn", () => {
    expect(isStale(undefined, at(1_000))).toBe(false);
    expect(isStale(at(1_000), at(1_001))).toBe(false);
    expect(isStale(at(1_000), at(1_000))).toBe(false);
  });

  it("ignores a state the server stamped before the one drawn: an answer that came late", () => {
    expect(isStale(at(1_000), at(999))).toBe(true);
    expect(isStale(at(1_000), at(0))).toBe(true);
  });
});

describe("the surface the page is painted on", () => {
  it("is dark only for a colour that reads as dark, so that Signal is never text on a light one", () => {
    expect(surfaceOf("rgb(17, 19, 24)")).toBe("dark");
    expect(surfaceOf("rgb(31, 30, 29)")).toBe("dark");
    expect(surfaceOf("rgb(17 19 24)")).toBe("dark");
    expect(surfaceOf("rgba(17, 19, 24, 1)")).toBe("dark");
    expect(surfaceOf("color(srgb 0.07 0.07 0.09)")).toBe("dark");
    expect(surfaceOf("rgb(244, 245, 242)")).toBe("light");
    expect(surfaceOf("rgb(255, 255, 255)")).toBe("light");
    expect(surfaceOf("rgb(169, 174, 182)")).toBe("light");
    expect(surfaceOf("rgb(128, 128, 128)")).toBe("light");
  });

  it("is light for a colour it cannot read, and for one that is not opaque", () => {
    expect(surfaceOf("")).toBe("light");
    expect(surfaceOf("transparent")).toBe("light");
    expect(surfaceOf("rgba(0, 0, 0, 0)")).toBe("light");
    expect(surfaceOf("rgb(17 19 24 / 20%)")).toBe("light");
    expect(surfaceOf("oklch(0.2 0.01 250)")).toBe("light");
    expect(surfaceOf("light-dark(#fff, #111)")).toBe("light");
  });
});
