import type { Address } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { whileGateAndFacilitatorStopped } from "../src/scenarios/25-gate-and-facilitator-unreachable-at-close.js";
import type { StackControl } from "../src/types.js";

/** A stack that records what is done to it. */
const recording = (calls: string[]): StackControl => ({
  rentPayer: "RENT" as Address,
  stopGate: async () => void calls.push("stop gate"),
  startGate: async () => void calls.push("start gate"),
  stopFacilitator: async () => void calls.push("stop facilitator"),
  startFacilitator: async () => void calls.push("start facilitator"),
});

describe("whileGateAndFacilitatorStopped", () => {
  it("stops the gate and the facilitator, runs the work, starts the facilitator then the gate, and returns what the work returned", async () => {
    const calls: string[] = [];
    expect(await whileGateAndFacilitatorStopped(recording(calls), async () => calls.push("work"))).toBe(3);
    expect(calls).toEqual(["stop gate", "stop facilitator", "work", "start facilitator", "start gate"]);
  });

  it("starts both again, and rethrows, when the work throws", async () => {
    const calls: string[] = [];
    const failing = async () => {
      calls.push("work");
      throw new Error("no close");
    };
    await expect(whileGateAndFacilitatorStopped(recording(calls), failing)).rejects.toThrow("no close");
    expect(calls).toEqual(["stop gate", "stop facilitator", "work", "start facilitator", "start gate"]);
  });

  it("starts the gate again even when the facilitator does not start", async () => {
    const calls: string[] = [];
    const stack: StackControl = {
      ...recording(calls),
      startFacilitator: async () => {
        throw new Error("EADDRINUSE");
      },
    };
    await expect(whileGateAndFacilitatorStopped(stack, async () => calls.push("work"))).rejects.toThrow("EADDRINUSE");
    expect(calls).toEqual(["stop gate", "stop facilitator", "work", "start gate"]);
  });
});
