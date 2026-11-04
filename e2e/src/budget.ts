import type { ScenarioContext } from "@lxfoundry/stint-conformance";

/** What one run of the scenarios may take from the devnet target's funding key and key pool. */
export interface RunLimits {
  /** USDC base units lent to buyers; a start-up requires the funding key to hold this much. */
  readonly usdc: bigint;
  /** Keys of the pool: every buyer takes one, and so does the rent payer of every direct session and the agent of every allowance. */
  readonly keys: number;
}

export interface RunTally {
  /** The context to give a scenario: `context` with its buyers, direct sessions and allowances counted. */
  watch(context: ScenarioContext): ScenarioContext;
  readonly lent: bigint;
  readonly keys: number;
}

/**
 * Counts what a run of the scenarios would lend and how many pool keys it would take, on any target, so that a run on
 * the local target shows whether the whole catalogue still fits what a devnet run is given. A buyer is counted when
 * it is asked for, as the devnet target does, and a direct session's rent payer is counted as one more key. A grant of an
 * allowance is counted as a buyer for its owner, which is lent the grant's `usdc`, and a key for its agent. Amounts that
 * a scenario takes from the offer follow the target's rate, which is lower on the local target than on devnet, so the
 * count is a floor of what a devnet run lends.
 */
export function tallyRun(): RunTally {
  let lent = 0n;
  let keys = 0;
  return {
    watch: (context) => ({
      ...context,
      newBuyer: (usdc) => {
        lent += usdc;
        keys += 1;
        return context.newBuyer(usdc);
      },
      ...(context.allowance && {
        allowance: {
          ...context.allowance,
          grant: (options) => {
            lent += options.usdc;
            keys += 2;
            return context.allowance!.grant(options);
          },
        },
      }),
      ...(context.direct && {
        direct: {
          ...context.direct,
          open: (options) => {
            keys += 1;
            return context.direct!.open(options);
          },
        },
      }),
    }),
    get lent() {
      return lent;
    },
    get keys() {
      return keys;
    },
  };
}

/** What a run took beyond `limits`, one sentence for each; empty when it fits. */
export function overrun(tally: Pick<RunTally, "lent" | "keys">, limits: RunLimits): string[] {
  const problems: string[] = [];
  if (tally.lent > limits.usdc) {
    problems.push(`the scenarios lend ${tally.lent} USDC base units to their buyers and a devnet run is given ${limits.usdc}`);
  }
  if (tally.keys > limits.keys) {
    problems.push(`the scenarios take ${tally.keys} keys for buyers, direct sessions and allowances and a devnet run has ${limits.keys}`);
  }
  return problems;
}
