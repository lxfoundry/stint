import { describe, expect, it } from "vitest";
import { readUntil } from "../src/reads.js";

describe("readUntil", () => {
  it("reads again until the value is what the caller waits for, and returns it", async () => {
    let reads = 0;
    const value = await readUntil({ attempts: 5, delayMs: 1 }, async () => ++reads, (read) => read >= 3);
    expect(value).toBe(3);
    expect(reads).toBe(3);
  });

  it("returns the last value after the last attempt, so that the caller's assertion reports it", async () => {
    let reads = 0;
    expect(await readUntil({ attempts: 3, delayMs: 1 }, async () => ++reads, () => false)).toBe(3);
  });

  it("reads once when the target allows one attempt", async () => {
    let reads = 0;
    expect(await readUntil({ attempts: 1, delayMs: 1_000 }, async () => ++reads, () => false)).toBe(1);
  });

  it("ends with a read's own error", async () => {
    await expect(readUntil({ attempts: 3, delayMs: 1 }, async () => Promise.reject(new Error("rpc down")), () => true)).rejects.toThrow("rpc down");
  });
});
