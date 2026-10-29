import type { RetryOptions } from "@lxfoundry/stint-x402";
import { sleep } from "./assert.js";

/**
 * Reads until `done` accepts the value, at most `options.attempts` times, `options.delayMs` apart, and
 * returns the last value read, accepted or not, so that the scenario's own assertion reports what was found.
 * A node can answer from behind right after it reported a transaction `confirmed`; how patient a read must
 * be is the target's to say (`ScenarioContext.readRetry`). A read that throws ends the retries with its error.
 */
export async function readUntil<T>(options: RetryOptions, read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const value = await read();
    if (done(value) || attempt >= options.attempts) return value;
    await sleep(options.delayMs);
  }
}
