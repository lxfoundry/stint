import { describe, expect, it } from "vitest";
import { isRunning, type SessionPhase } from "../src/state.js";

describe("the running phases", () => {
  it("are those where a session is opening, open or closing, and no other", () => {
    // Every phase is listed, so that a new one fails to type-check here until it is classified.
    const expected: Record<SessionPhase, boolean> = {
      none: false,
      opening: true,
      open: true,
      closing: true,
      closed: false,
      expired: false,
      ended: false,
    };
    for (const [state, running] of Object.entries(expected) as [SessionPhase, boolean][]) {
      expect({ state, running: isRunning({ state }) }).toEqual({ state, running });
    }
  });
});
