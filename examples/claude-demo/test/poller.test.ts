import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPoller } from "../app/poller.js";

/** A read that settles when the test says so, and counts how many run at once. */
function controlledRead() {
  const settle: Array<(error?: Error) => void> = [];
  let running = 0;
  const stats = { started: 0, mostAtOnce: 0 };
  const read = vi.fn(
    () =>
      new Promise<void>((resolve, reject) => {
        stats.started += 1;
        running += 1;
        stats.mostAtOnce = Math.max(stats.mostAtOnce, running);
        settle.push((error) => {
          running -= 1;
          if (error) reject(error);
          else resolve();
        });
      }),
  );
  return { read, stats, finish: (error?: Error) => settle.shift()?.(error) };
}

describe("the poll", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("never runs two reads at once: a read asked for while one is under way waits for it", async () => {
    const { read, stats, finish } = controlledRead();
    const poller = createPoller({ read, nextDelay: () => 2_000, onError: () => {} });
    poller.schedule(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(stats.started).toBe(1);
    expect(poller.inFlight).toBe(true);
    // An action asks for a read in 0.5 s, several times over, while the first has not answered.
    poller.schedule(500);
    await vi.advanceTimersByTimeAsync(500);
    poller.schedule(500);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(stats.started).toBe(1);
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(poller.inFlight).toBe(false);
    // The next one is set only once the first settled, and at the delay then asked for.
    await vi.advanceTimersByTimeAsync(1_999);
    expect(stats.started).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(stats.started).toBe(2);
    finish();
    await vi.advanceTimersByTimeAsync(10_000);
    finish();
    expect(stats.mostAtOnce).toBe(1);
  });

  it("goes on after a read that fails, and says why", async () => {
    const { read, stats, finish } = controlledRead();
    const onError = vi.fn();
    const poller = createPoller({ read, nextDelay: () => 500, onError });
    poller.schedule(0);
    await vi.advanceTimersByTimeAsync(0);
    finish(new Error("host closed"));
    await vi.advanceTimersByTimeAsync(0);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toEqual(new Error("host closed"));
    await vi.advanceTimersByTimeAsync(500);
    expect(stats.started).toBe(2);
  });

  it("replaces the read that is set with the one asked for last", async () => {
    const { read, stats } = controlledRead();
    const poller = createPoller({ read, nextDelay: () => 2_000, onError: () => {} });
    poller.schedule(2_000);
    poller.schedule(500);
    await vi.advanceTimersByTimeAsync(499);
    expect(stats.started).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(stats.started).toBe(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(stats.started).toBe(1);
  });
});
