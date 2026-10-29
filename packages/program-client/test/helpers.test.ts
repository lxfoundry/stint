import { describe, expect, it } from "vitest";
import { dueAt, earnedAt, elapsedAt } from "../src/index.js";

// 30 s bought at 1,000 per second from t = 1,000, with a minimum charge of 5 s.
const session = { startedAt: 1_000n, deposited: 30_000n, rate: 1_000n, minSeconds: 5 };

describe("the amounts of spec §4.2, at a given moment", () => {
  it.each([
    // now, elapsed, earned, due
    [900n, 0n, 0n, 5_000n], // the clock is behind the start
    [1_000n, 0n, 0n, 5_000n],
    [1_002n, 2n, 2_000n, 5_000n], // inside the minimum
    [1_008n, 8n, 8_000n, 8_000n],
    [1_030n, 30n, 30_000n, 30_000n],
    [5_000n, 30n, 30_000n, 30_000n], // elapsed stops at paid_until
  ])("at %s: elapsed %s, earned %s, due %s", (now, elapsed, earned, due) => {
    expect(elapsedAt(session, now)).toBe(elapsed);
    expect(earnedAt(session, now)).toBe(earned);
    expect(dueAt(session, now)).toBe(due);
  });

  it("caps both at what the deposit buys when it is not a multiple of the rate", () => {
    const odd = { ...session, deposited: 30_500n };
    expect(earnedAt(odd, 9_000n)).toBe(30_000n);
    expect(dueAt(odd, 9_000n)).toBe(30_000n);
  });
});
