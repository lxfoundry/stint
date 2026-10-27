import type { Scenario, ScenarioContext, ScenarioOutcome, Target } from "./types.js";

/**
 * Runs scenarios one after another, in the order of their numbers. Concurrency and the isolation
 * groups of spec section 12.2 arrive with the first scenarios that need them.
 */
export async function runScenarios(
  scenarios: readonly Scenario[],
  target: Target,
  makeContext: (scenario: Scenario) => ScenarioContext | Promise<ScenarioContext>,
  now: () => number = () => performance.now(),
): Promise<ScenarioOutcome[]> {
  const ids = new Set<number>();
  for (const scenario of scenarios) {
    if (ids.has(scenario.id)) throw new Error(`Duplicate scenario id ${scenario.id}`);
    ids.add(scenario.id);
  }

  const outcomes: ScenarioOutcome[] = [];
  for (const scenario of [...scenarios].sort((a, b) => a.id - b.id)) {
    const base = { id: scenario.id, title: scenario.title, target: target.name, status: scenario.status };

    if (!scenario.needs.every((capability) => target.capabilities.has(capability))) {
      outcomes.push({ ...base, result: "not applicable", durationMs: 0, passesWhilePending: false });
      continue;
    }

    if (!scenario.run) {
      const required = scenario.status === "required";
      outcomes.push({
        ...base,
        result: required ? "fail" : "pending",
        durationMs: 0,
        passesWhilePending: false,
        ...(required ? { error: "a required scenario has no implementation" } : {}),
      });
      continue;
    }

    const started = now();
    try {
      await scenario.run(await makeContext(scenario));
      outcomes.push({
        ...base,
        result: "pass",
        durationMs: now() - started,
        passesWhilePending: scenario.status === "pending",
      });
    } catch (error) {
      outcomes.push({
        ...base,
        result: scenario.status === "required" ? "fail" : "pending",
        durationMs: now() - started,
        passesWhilePending: false,
        error: describeError(error),
      });
    }
  }
  return outcomes;
}

/** One line describing anything thrown: an error's message with its causes, or the value itself. */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    const cause = error.cause === undefined ? "" : ` (cause: ${describeError(error.cause)})`;
    return `${error.message || error.name}${cause}`;
  }
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error, (_, value) => (typeof value === "bigint" ? value.toString() : value)) ?? String(error);
  } catch {
    return String(error);
  }
}

/** A run fails when any required scenario fails (spec section 12.2, "Status"). */
export function exitCodeFor(outcomes: readonly ScenarioOutcome[]): 0 | 1 {
  return outcomes.some((outcome) => outcome.result === "fail") ? 1 : 0;
}
