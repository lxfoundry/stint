import { describe, expect, it } from "vitest";
import { TOOL } from "../../claude-demo/src/state.js";
import { actionErrorText, budgetLine, budgetShare, grantCommand, launchHint, utcTime, type AllowanceView } from "../src/budget.js";
import { ALLOWANCE_TOOL, PANEL_URI, TO_HANDLER } from "../src/names.js";

const OWNER = "CciCZMJsih7NY5pet9kc1siPSj7169WSFZoTTQ5dGezx";
const AGENT = "Eqc9hpkQBqhtSTPyzo1V9skXio92jkKsZejFcEj58sBj";
/** 2026-11-05T17:15:51Z. */
const END = 1_793_898_951;
const view = (read?: AllowanceView["read"], extra: Partial<AllowanceView> = {}): AllowanceView => ({
  owner: OWNER,
  agent: AGENT,
  nonce: "0",
  ...(read ? { read, readAt: 0 } : {}),
  stale: false,
  ...extra,
});
const active = (pulled: string, left: string): NonNullable<AllowanceView["read"]> => ({
  status: "active",
  perPeriod: "200000",
  pulled,
  left,
  periodEnd: END,
  expiresAt: END + 82_800,
});

describe("the tool names", () => {
  it("are the allowance demo's own, each mapped onto the first demo's handler", () => {
    expect(Object.values(ALLOWANCE_TOOL)).toEqual([
      "stint_allowance_demo",
      "stint_allowance_demo_state",
      "stint_allowance_demo_launch",
      "stint_allowance_demo_top_up",
      "stint_allowance_demo_close",
    ]);
    expect(TO_HANDLER).toEqual({
      [ALLOWANCE_TOOL.demo]: TOOL.demo,
      [ALLOWANCE_TOOL.state]: TOOL.state,
      [ALLOWANCE_TOOL.launch]: TOOL.launch,
      [ALLOWANCE_TOOL.topUp]: TOOL.topUp,
      [ALLOWANCE_TOOL.close]: TOOL.close,
    });
    expect(PANEL_URI).toBe("ui://stint-allowance-demo/panel.html");
  });
});

describe("the allowance's words", () => {
  it("gives a time of day in UTC", () => {
    expect(utcTime(END)).toBe("17:15 UTC");
  });

  it("says what was pulled, what is left and when the period ends", () => {
    expect(budgetLine(view(active("100000", "100000")))).toBe("0.100 of 0.200 USDC pulled this period · 0.100 USDC left · the period ends at 17:15 UTC");
    expect(budgetShare(view(active("100000", "100000")))).toBe(0.5);
    expect(budgetShare(view(active("200000", "0")))).toBe(1);
  });

  it("says when nothing was read yet, when there is no allowance, and when it has ended or not started", () => {
    expect(budgetLine(view())).toBe("Reading the allowance…");
    expect(budgetLine(view({ status: "none" }))).toBe("No allowance from this owner for this agent yet");
    expect(budgetLine(view({ ...active("0", "0"), status: "expired" } as AllowanceView["read"]))).toBe("The allowance has expired");
    expect(budgetLine(view({ ...active("0", "0"), status: "notStarted" } as AllowanceView["read"]))).toBe("The allowance has not started yet");
    expect(budgetShare(view({ status: "none" }))).toBe(0);
  });

  it("says so when no read has ever succeeded", () => {
    expect(budgetLine(view(undefined, { stale: true }))).toBe("The allowance could not be read: the node did not answer, trying again");
  });

  it("marks a read that could not be made again", () => {
    expect(budgetLine(view(active("0", "200000"), { stale: true }))).toBe(
      "0.000 of 0.200 USDC pulled this period · 0.200 USDC left · the period ends at 17:15 UTC (the latest read failed: this is the one before)",
    );
  });

  it("gives the grant command with the agent's address, a day's expiry, and the nonce when it is not 0", () => {
    const now = Date.UTC(2026, 10, 5, 16, 0, 0, 500);
    expect(grantCommand(view({ status: "none" }), now)).toBe(
      `pnpm stint allowance grant --keypair "$HOME/.config/stint/allowance-owner.json" --agent ${AGENT} --per-period 200000 --period 3600 --expires 2026-11-06T16:00:00Z`,
    );
    expect(grantCommand(view({ status: "none" }, { nonce: "2" }), now)).toMatch(/ --nonce 2$/);
  });

  it("warns before a launch the allowance cannot fund, and says nothing otherwise", () => {
    expect(launchHint(view(active("200000", "0")), 100_000n)).toBe("0.000 USDC left this period: a launch will be refused on-chain");
    expect(launchHint(view({ status: "none" }), 100_000n)).toBe("No allowance yet: a launch will be refused on-chain");
    expect(launchHint(view({ ...active("0", "0"), status: "expired" } as AllowanceView["read"]), 100_000n)).toBe(
      "The allowance has expired: a launch will be refused on-chain",
    );
    expect(launchHint(view(active("100000", "100000")), 100_000n)).toBeUndefined();
    expect(launchHint(view(), 100_000n)).toBeUndefined();
  });
});

describe("the error the panel shows after an action", () => {
  const gate = 'Refused on-chain: the allowance for this period is used up. The gate refused the payment: {"error":"simulation_failed"}';
  it("is the state's short error for a refusal by the chain", () => {
    expect(actionErrorText(gate, "Refused on-chain: the allowance for this period is used up. The gate answered simulation_failed.")).toBeUndefined();
  });

  it("is the tool's text for any other failure", () => {
    expect(actionErrorText("A session is already running", "A session is already running")).toBe("A session is already running");
    expect(actionErrorText("The gate refused the payment: {}", "The gate refused the payment: {}")).toBe("The gate refused the payment: {}");
  });

  it("is the tool's text when the state holds no error", () => {
    expect(actionErrorText("no answer", undefined)).toBe("no answer");
  });
});
