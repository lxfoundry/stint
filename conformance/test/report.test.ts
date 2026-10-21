import { describe, expect, it } from "vitest";
import { renderReport } from "../src/report.js";
import type { ScenarioOutcome } from "../src/types.js";

const outcome = (overrides: Partial<ScenarioOutcome>): ScenarioOutcome => ({
  id: 1,
  title: "Open, connect, close early",
  target: "local",
  status: "pending",
  result: "pending",
  durationMs: 0,
  passesWhilePending: false,
  ...overrides,
});

describe("renderReport", () => {
  it("writes one table row per scenario", () => {
    const report = renderReport([outcome({}), outcome({ id: 2, title: "Close before minSeconds" })]);
    expect(report).toContain("| Scenario | Target | Status | Result | Duration |");
    expect(report).toContain("| 1. Open, connect, close early | local | pending | pending | 0.0 s |");
    expect(report).toContain("| 2. Close before minSeconds | local | pending | pending | 0.0 s |");
  });

  it("flags a pending scenario that passes", () => {
    const report = renderReport([outcome({ result: "pass", passesWhilePending: true, durationMs: 1234 })]);
    expect(report).toContain("| pass (make required) | 1.2 s |");
    expect(report).toContain("Make required: 1");
  });

  it("escapes pipes in titles", () => {
    expect(renderReport([outcome({ title: "a | b" })])).toContain("1. a \\| b");
  });

  it("counts each result", () => {
    const report = renderReport([
      outcome({ status: "required", result: "pass" }),
      outcome({ id: 2, result: "not applicable" }),
      outcome({ id: 3, title: "A failure", status: "required", result: "fail", error: "boom" }),
    ]);
    expect(report).toContain("Status: required 2, pending 1 · Result: pass 1, fail 1, pending 0, not applicable 1");
    expect(report).toContain("3. A failure: boom");
  });
});
