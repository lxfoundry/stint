import type { Address } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { whileGateStopped } from "../src/scenarios/26-expired-session-nobody-closes.js";
import type { StackControl } from "../src/types.js";

/** A stack that records what is done to its gate. */
const recording = (calls: string[]): StackControl => ({
  rentPayer: "RENT" as Address,
  stopGate: async () => void calls.push("stop"),
  startGate: async () => void calls.push("start"),
});

describe("whileGateStopped", () => {
  it("stops the gate, runs the work, starts the gate again, and returns what the work returned", async () => {
    const calls: string[] = [];
    expect(await whileGateStopped(recording(calls), async () => calls.push("work"))).toBe(2);
    expect(calls).toEqual(["stop", "work", "start"]);
  });

  it("starts the gate again, and rethrows, when the work throws", async () => {
    const calls: string[] = [];
    const failing = async () => {
      calls.push("work");
      throw new Error("no close");
    };
    await expect(whileGateStopped(recording(calls), failing)).rejects.toThrow("no close");
    expect(calls).toEqual(["stop", "work", "start"]);
  });
});
