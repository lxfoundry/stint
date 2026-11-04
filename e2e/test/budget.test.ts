import type { ScenarioContext } from "@lxfoundry/stint-conformance";
import { describe, expect, it } from "vitest";
import { overrun, tallyRun } from "../src/budget.js";

/** A context whose buyers, direct sessions and allowances are stubs, with a record of what reached them. */
function fakeContext(withDirect: boolean, withAllowance = false) {
  const reached = { buyers: [] as bigint[], opens: 0, grants: [] as bigint[], revokes: 0 };
  const context = {
    newBuyer: async (usdc: bigint) => {
      reached.buyers.push(usdc);
      return {};
    },
    ...(withDirect && {
      direct: {
        open: async () => {
          reached.opens += 1;
          return {};
        },
      },
    }),
    ...(withAllowance && {
      allowance: {
        grant: async ({ usdc }: { usdc: bigint }) => {
          reached.grants.push(usdc);
          return {};
        },
        revoke: async () => {
          reached.revokes += 1;
        },
      },
    }),
  } as unknown as ScenarioContext;
  return { context, reached };
}

describe("tallyRun", () => {
  it("counts the USDC lent and a key for each buyer and each direct session, across contexts, and passes the calls on", async () => {
    const tally = tallyRun();
    const first = fakeContext(true);
    const second = fakeContext(false);
    const a = tally.watch(first.context);
    const b = tally.watch(second.context);

    await a.newBuyer(100_000n);
    await a.newBuyer(0n);
    await a.direct!.open({ buyer: {} as never, seconds: 5 });
    await b.newBuyer(30_000n);

    expect([tally.lent, tally.keys]).toEqual([130_000n, 4]);
    expect(first.reached).toEqual({ buyers: [100_000n, 0n], opens: 1, grants: [], revokes: 0 });
    expect(second.reached).toEqual({ buyers: [30_000n], opens: 0, grants: [], revokes: 0 });
    expect(b.direct).toBeUndefined();
    expect(b.allowance).toBeUndefined();
  });

  it("counts an allowance's grant as the USDC lent to its owner and two keys, the owner's and the agent's, and not its revoke", async () => {
    const tally = tallyRun();
    const { context, reached } = fakeContext(false, true);
    const watched = tally.watch(context);

    await watched.allowance!.grant({ usdc: 70_000n, perPeriod: 50_000n, periodSeconds: 3_600 });
    await watched.allowance!.revoke({} as never);

    expect([tally.lent, tally.keys]).toEqual([70_000n, 2]);
    expect(reached).toEqual({ buyers: [], opens: 0, grants: [70_000n], revokes: 1 });
  });
});

describe("overrun", () => {
  const limits = { usdc: 5_000_000n, keys: 96 };

  it("is empty for a run that fits, at the limits included", () => {
    expect(overrun({ lent: 4_000_000n, keys: 60 }, limits)).toEqual([]);
    expect(overrun({ lent: 5_000_000n, keys: 96 }, limits)).toEqual([]);
  });

  it("names each limit a run goes beyond", () => {
    expect(overrun({ lent: 5_000_001n, keys: 10 }, limits)).toEqual([
      "the scenarios lend 5000001 USDC base units to their buyers and a devnet run is given 5000000",
    ]);
    expect(overrun({ lent: 1n, keys: 97 }, limits)).toEqual([
      "the scenarios take 97 keys for buyers, direct sessions and allowances and a devnet run has 96",
    ]);
    expect(overrun({ lent: 6_000_000n, keys: 100 }, limits)).toHaveLength(2);
  });
});
