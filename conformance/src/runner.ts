import type { Scenario, ScenarioContext, ScenarioOutcome, Target } from "./types.js";

export interface RunOptions {
  /** A scenario that runs longer than this fails: a hung run must not hang whoever started it. Its work is not cancelled. */
  readonly timeoutMs?: number;
}

function withTimeout<T>(work: Promise<T>, timeoutMs: number | undefined, id: number): Promise<T> {
  if (timeoutMs === undefined) return work;
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`scenario ${id} timed out after ${timeoutMs} ms`)), timeoutMs);
  });
  return Promise.race([work, limit]).finally(() => clearTimeout(timer));
}

/**
 * Runs scenarios one after another, in the order of their numbers. Concurrency and the isolation
 * groups of spec section 12.2 are not built: a scenario's `group` is not acted on. Scenario 26, of
 * the own-stack group, stops and restarts the common gate, which is safe only because no other
 * scenario runs meanwhile. A scenario that times out is not cancelled, so a later scenario may run
 * while its work goes on: after a timed-out scenario 26, it may find the gate stopped.
 */
export async function runScenarios(
  scenarios: readonly Scenario[],
  target: Target,
  makeContext: (scenario: Scenario) => ScenarioContext | Promise<ScenarioContext>,
  now: () => number = () => performance.now(),
  options: RunOptions = {},
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
      await withTimeout(Promise.resolve(makeContext(scenario)).then((context) => scenario.run!(context)), options.timeoutMs, scenario.id);
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
