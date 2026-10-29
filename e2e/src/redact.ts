import type { ScenarioOutcome } from "@lxfoundry/stint-conformance";

/**
 * Reduces every URL in a text to its scheme and host. An RPC URL can carry an API key in its path or query, and a
 * service that fails quotes the URL it called (Kora's HTTP client does); the host is enough to tell which
 * endpoint failed. Credentials in the authority go too.
 */
export function redactUrls(text: string): string {
  return text.replace(/\b([a-z][a-z0-9+.-]*):\/\/([^\s"'<>\\)\]]+)/gi, (_match, scheme: string, rest: string) => {
    const authority = rest.split(/[/?#]/, 1)[0]!;
    return `${scheme}://${authority.slice(authority.lastIndexOf("@") + 1)}`;
  });
}

/** The outcomes with each error's URLs redacted: what may be printed and written to a report. */
export function redactOutcomes(outcomes: readonly ScenarioOutcome[]): ScenarioOutcome[] {
  return outcomes.map((outcome) => (outcome.error === undefined ? outcome : { ...outcome, error: redactUrls(outcome.error) }));
}
