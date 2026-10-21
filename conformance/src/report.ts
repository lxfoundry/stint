import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ScenarioOutcome } from "./types.js";

const escapeCell = (text: string) => text.replaceAll("|", "\\|");
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

/** The run report of spec section 12.2: one row per scenario, then the counts. */
export function renderReport(outcomes: readonly ScenarioOutcome[]): string {
  const rows = outcomes.map((outcome) => {
    const result = outcome.passesWhilePending ? `${outcome.result} (make required)` : outcome.result;
    return `| ${outcome.id}. ${escapeCell(outcome.title)} | ${outcome.target} | ${outcome.status} | ${result} | ${seconds(outcome.durationMs)} |`;
  });

  const count = (predicate: (outcome: ScenarioOutcome) => boolean) => outcomes.filter(predicate).length;
  const statuses = `required ${count((o) => o.status === "required")}, pending ${count((o) => o.status === "pending")}`;
  const results = [
    `pass ${count((o) => o.result === "pass")}`,
    `fail ${count((o) => o.result === "fail")}`,
    `pending ${count((o) => o.result === "pending")}`,
    `not applicable ${count((o) => o.result === "not applicable")}`,
  ].join(", ");
  const summary = `Status: ${statuses} · Result: ${results}`;

  const flagged = count((o) => o.passesWhilePending);
  const failures = outcomes
    .filter((o) => o.error !== undefined)
    .map((o) => `- ${o.id}. ${o.title}: ${o.error}`);

  return [
    "| Scenario | Target | Status | Result | Duration |",
    "|---|---|---|---|---|",
    ...rows,
    "",
    summary,
    ...(flagged > 0 ? ["", `Make required: ${flagged}`] : []),
    ...(failures.length > 0 ? ["", "Errors:", ...failures] : []),
    "",
  ].join("\n");
}

/** Writes `report.md` and `report.json` into `directory`. */
export function writeReport(directory: string, outcomes: readonly ScenarioOutcome[]): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "report.md"), renderReport(outcomes));
  writeFileSync(join(directory, "report.json"), `${JSON.stringify(outcomes, null, 2)}\n`);
}
