import { createSolanaRpc } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { describeError, exitCodeFor, runScenarios } from "../src/runner.js";
import type { Scenario, ScenarioContext, Target } from "../src/types.js";

const local: Target = { name: "local", capabilities: new Set(["chain", "stack", "facilitatorApi"]) };
const external: Target = { name: "external", capabilities: new Set() };
const context = (target: Target) => (): ScenarioContext => ({
  target,
  gateUrl: "http://127.0.0.1:9",
  rpc: createSolanaRpc("http://127.0.0.1:9"),
  newBuyer: async () => {
    throw new Error("no buyers in unit tests");
  },
  sendUsdc: async () => {
    throw new Error("no payments in unit tests");
  },
  subscriptionSettleMs: 0,
  readRetry: { attempts: 1, delayMs: 0 },
});

function scenario(overrides: Partial<Scenario>): Scenario {
  return { id: 1, title: "A scenario", needs: [], group: "shared", status: "pending", ...overrides };
}

const passes = async () => {};
const fails = async () => {
  throw new Error("boom");
};

describe("runScenarios", () => {
  it("fails a required scenario that outlasts the timeout, naming it, and leaves a pending one pending", async () => {
    const slow = () => new Promise<void>((resolve) => setTimeout(resolve, 300));
    const outcomes = await runScenarios(
      [scenario({ id: 1, status: "required", run: slow }), scenario({ id: 2, status: "pending", run: slow })],
      local,
      context(local),
      undefined,
      { timeoutMs: 30 },
    );
    expect(outcomes.map((outcome) => outcome.result)).toEqual(["fail", "pending"]);
    expect(outcomes[0]?.error).toBe("scenario 1 timed out after 30 ms");
  });

  it("runs without a limit when no timeout is given", async () => {
    const [outcome] = await runScenarios([scenario({ run: () => new Promise((resolve) => setTimeout(resolve, 50)) })], local, context(local));
    expect(outcome?.result).toBe("pass");
  });

  it("reports a scenario whose needs the target lacks as not applicable", async () => {
    const [outcome] = await runScenarios([scenario({ needs: ["stack"], run: fails })], external, context(external));
    expect(outcome?.result).toBe("not applicable");
  });

  it("reports a pending scenario without an implementation as pending", async () => {
    const [outcome] = await runScenarios([scenario({})], local, context(local));
    expect(outcome?.result).toBe("pending");
  });

  it("fails a required scenario without an implementation", async () => {
    const [outcome] = await runScenarios([scenario({ status: "required" })], local, context(local));
    expect(outcome?.result).toBe("fail");
    expect(outcome?.error).toBe("a required scenario has no implementation");
  });

  it("reports a failing pending scenario as pending, with its error", async () => {
    const [outcome] = await runScenarios([scenario({ run: fails })], local, context(local));
    expect(outcome?.result).toBe("pending");
    expect(outcome?.error).toBe("boom");
  });

  it("flags a pending scenario that passes", async () => {
    const [outcome] = await runScenarios([scenario({ run: passes })], local, context(local));
    expect(outcome?.result).toBe("pass");
    expect(outcome?.passesWhilePending).toBe(true);
  });

  it("fails a required scenario that throws", async () => {
    const [outcome] = await runScenarios([scenario({ status: "required", run: fails })], local, context(local));
    expect(outcome?.result).toBe("fail");
  });

  it("runs scenarios in the order of their numbers", async () => {
    const outcomes = await runScenarios([scenario({ id: 2 }), scenario({ id: 1 })], local, context(local));
    expect(outcomes.map((outcome) => outcome.id)).toEqual([1, 2]);
  });
});

describe("exitCodeFor", () => {
  it("is 1 when any required scenario fails, and 0 otherwise", async () => {
    const failing = await runScenarios([scenario({ status: "required", run: fails })], local, context(local));
    const pendingOnly = await runScenarios([scenario({ run: fails })], local, context(local));
    expect(exitCodeFor(failing)).toBe(1);
    expect(exitCodeFor(pendingOnly)).toBe(0);
  });
});

describe("runScenarios, with implemented scenarios", () => {
  it("refuses duplicate scenario ids before running any", async () => {
    let ran = false;
    const run = async () => {
      ran = true;
    };
    await expect(runScenarios([scenario({ run }), scenario({ run })], local, context(local))).rejects.toThrow(
      "Duplicate scenario id 1",
    );
    expect(ran).toBe(false);
  });

  it("measures each scenario's duration with the injected clock", async () => {
    const ticks = [100, 350];
    const [outcome] = await runScenarios([scenario({ run: passes })], local, context(local), () => ticks.shift()!);
    expect(outcome?.durationMs).toBe(250);
  });

  it("passes each scenario the context made for it", async () => {
    const seen: string[] = [];
    const makeContext = (s: Scenario) => ({ ...context(local)(), target: s.id === 1 ? local : external });
    const run = async (ctx: ScenarioContext) => {
      seen.push(ctx.target.name);
    };
    await runScenarios([scenario({ id: 2, run }), scenario({ id: 1, run })], local, makeContext);
    expect(seen).toEqual(["local", "external"]);
  });
});

describe("describeError", () => {
  it("gives an error's message and its causes", () => {
    const error = new Error("settle failed", { cause: new Error("connection refused") });
    expect(describeError(error)).toBe("settle failed (cause: connection refused)");
  });

  it("describes thrown values that are not errors", () => {
    expect(describeError("plain")).toBe("plain");
    expect(describeError({ code: 7, amount: 5n })).toBe('{"code":7,"amount":"5"}');
    expect(describeError(undefined)).toBe("undefined");
  });
});
