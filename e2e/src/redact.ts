import type { ScenarioOutcome } from "@lxfoundry/stint-conformance";
import { redactUrls } from "@lxfoundry/stint-x402";

/** The outcomes with each error's URLs redacted: what may be printed and written to a report. */
export function redactOutcomes(outcomes: readonly ScenarioOutcome[]): ScenarioOutcome[] {
  return outcomes.map((outcome) => (outcome.error === undefined ? outcome : { ...outcome, error: redactUrls(outcome.error) }));
}
