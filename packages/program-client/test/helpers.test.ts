import { address, type Address, type ReadonlyUint8Array } from "@solana/kit";
import { describe, expect, it } from "vitest";
import {
  CloseKind,
  EVENT_IX_TAG,
  STINT_PROGRAM_ADDRESS,
  dueAt,
  earnedAt,
  elapsedAt,
  findClaimedEvent,
  getClaimedEventEncoder,
  getClosedEventEncoder,
  type ProgramInstruction,
} from "../src/index.js";

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

describe("findClaimedEvent", () => {
  const key = address("11111111111111111111111111111111");
  const claimed = getClaimedEventEncoder().encode({ session: key, amount: 8_000n, claimed: 8_000n });
  const closed = getClosedEventEncoder().encode({
    session: key,
    kind: CloseKind.Standard,
    claimed: 0n,
    owed: 0n,
    refunded: 0n,
    redirected: 0n,
    closedBy: key,
    paidUntil: 0n,
    at: 0n,
  });

  /** An `emit_cpi!` instruction as it appears among a transaction's inner instructions. */
  function emitted(payload: ReadonlyUint8Array, programAddress: Address = STINT_PROGRAM_ADDRESS): ProgramInstruction {
    const data = new Uint8Array(EVENT_IX_TAG.length + payload.length);
    data.set(EVENT_IX_TAG, 0);
    data.set(payload, EVENT_IX_TAG.length);
    return { programAddress, data };
  }

  it("decodes the Claimed event that the program emitted, among other events", () => {
    const expected = { session: key, amount: 8_000n, claimed: 8_000n };
    expect(findClaimedEvent([emitted(claimed)])).toEqual(expected);
    expect(findClaimedEvent([emitted(closed), emitted(claimed)])).toEqual(expected);
  });

  it("is undefined when the program emitted no Claimed event", () => {
    expect(findClaimedEvent([])).toBeUndefined();
    expect(findClaimedEvent([emitted(closed)])).toBeUndefined();
  });

  it("ignores an event emitted by another program", () => {
    const tokenProgram = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
    expect(findClaimedEvent([emitted(claimed, tokenProgram)])).toBeUndefined();
  });
});
