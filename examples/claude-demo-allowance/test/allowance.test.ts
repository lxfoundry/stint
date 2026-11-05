import type { AllowanceReport } from "@lxfoundry/stint-client";
import type { Address } from "@solana/kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Demo } from "../../claude-demo/src/demo.js";
import type { DemoState } from "../../claude-demo/src/state.js";
import { ALLOWANCE_READ_EVERY_MS, ALLOWANCE_READ_WAIT_MS, isChainRefusal, refusalWords, withAllowance } from "../src/allowance.js";

const OWNER = "CciCZMJsih7NY5pet9kc1siPSj7169WSFZoTTQ5dGezx" as Address;
const AGENT = "Eqc9hpkQBqhtSTPyzo1V9skXio92jkKsZejFcEj58sBj" as Address;
const DELEGATION = "55HZmMwLy4icQoTtnUjoApY7HNKLGmDKpXcE6a7CdHb4" as Address;
/** 2026-11-05T17:15:51Z. */
const END = 1_793_898_951;
const REFUSED =
  'The gate refused the payment: {"x402Version":2,"error":"simulation_failed"} (with an allowance, this is how a payment it cannot fund is refused: used up for the period, expired or revoked, or the owner\'s balance too low)';
const REFUSED_TOP_UP = 'The gate refused the top-up: {"x402Version":2,"error":"simulation_failed"}';

type Period = NonNullable<AllowanceReport["period"]>;
function report(period?: Partial<Period>, rest: Partial<AllowanceReport> = {}): AllowanceReport {
  return {
    owner: OWNER,
    delegation: DELEGATION,
    ...(period === undefined
      ? {}
      : {
          period: {
            perPeriod: 200_000n,
            pulled: 0n,
            available: 200_000n,
            periodStart: BigInt(END - 3_600),
            periodEnd: BigInt(END),
            expiresAt: BigInt(END + 82_800),
            status: "active" as const,
            ...period,
          },
        }),
    ownerBalance: 19_896_000n,
    delegatedAmount: 18_446_744_073_709_551_615n,
    ...rest,
  };
}

function baseState(error?: DemoState["error"]): DemoState {
  return {
    wallet: { address: OWNER, usdc: "19896000", checkedAt: 0 },
    gateUrl: "https://gate.example",
    faucetUrl: "https://faucet.circle.com/",
    session: { state: "none", topUpMarginSeconds: 10, frames: 0, links: { topUps: [] } },
    exchange: { current: [] },
    ledger: [],
    now: 0,
    ...(error ? { error } : {}),
  };
}

/** A demo whose launch and top-up fail with `message`, keeping it in its state as `createDemo` does. */
function failingDemo(message: string): Demo {
  let error: DemoState["error"];
  const fail = (action: "launch" | "top-up") => async (): Promise<DemoState> => {
    error = { action, message, at: 1 };
    throw new Error(message);
  };
  return {
    sink: {} as Demo["sink"],
    state: async () => baseState(error),
    launch: fail("launch"),
    topUp: fail("top-up"),
    close: async () => baseState(error),
    shutdown: async () => ({ closed: [], failed: [] }),
  };
}

const amounts = { launch: 100_000n, topUp: 100_000n };

describe("the chain's refusal", () => {
  it("is a payment or a top-up the gate refused after the facilitator's simulation failed", () => {
    expect(isChainRefusal(REFUSED)).toBe(true);
    expect(isChainRefusal(REFUSED_TOP_UP)).toBe(true);
    expect(isChainRefusal('The gate refused the payment: {"error":"invalid_payload"}')).toBe(false);
    expect(isChainRefusal("A session is already running: top it up, close it, or let it end")).toBe(false);
  });

  it("is said from a read of the allowance made after it", () => {
    expect(refusalWords(report({ pulled: 200_000n, available: 0n }), 100_000n)).toBe(
      "Refused on-chain: the allowance for this period is used up (0.200 of 0.200 USDC pulled; the period ends at 17:15 UTC).",
    );
    expect(refusalWords(report({ pulled: 150_000n, available: 50_000n }), 100_000n)).toBe(
      "Refused on-chain: the allowance for this period has 0.050 USDC left, less than the 0.100 USDC needed (0.150 of 0.200 USDC pulled; the period ends at 17:15 UTC).",
    );
    expect(refusalWords(report({ perPeriod: 50_000n, available: 50_000n }), 100_000n)).toBe(
      "Refused on-chain: the payment, 0.100 USDC, is larger than the allowance's cap per period, 0.050 USDC.",
    );
    expect(refusalWords(report(), 100_000n)).toBe("Refused on-chain: this owner has granted the agent no allowance, or has revoked it.");
    expect(refusalWords(report({ status: "expired", available: 0n }), 100_000n)).toBe("Refused on-chain: the allowance has expired.");
    expect(refusalWords(report({ status: "notStarted", available: 0n }), 100_000n)).toBe("Refused on-chain: the allowance has not started yet.");
    expect(refusalWords(report({}, { ownerBalance: 50_000n }), 100_000n)).toBe(
      "Refused on-chain: the owner's account holds 0.050 USDC, less than the 0.100 USDC needed.",
    );
    expect(refusalWords(report({}, { delegatedAmount: 0n }), 100_000n)).toBe(
      "Refused on-chain: the owner's USDC account no longer lets the allowance program move its tokens.",
    );
  });

  it("names the general reasons when the read explains nothing, or failed", () => {
    const general =
      "Refused on-chain: the seller's simulation of the payment failed, which an allowance does when it is used up for the period, expired or revoked, or when the owner's balance is too low.";
    expect(refusalWords(report({}), 100_000n)).toBe(general);
    expect(refusalWords(undefined, 100_000n)).toBe(general);
  });
});

describe("withAllowance", () => {
  it("adds the allowance, read from the chain, to every state", async () => {
    const demo = withAllowance(failingDemo(REFUSED), { owner: OWNER, agent: AGENT, nonce: 0n, read: async () => report({ pulled: 100_000n, available: 100_000n }), amounts, now: () => 5 });
    const state = await demo.state();
    expect(state.wallet.address).toBe(OWNER);
    expect(state.allowance).toEqual({
      owner: OWNER,
      agent: AGENT,
      nonce: "0",
      read: { status: "active", perPeriod: "200000", pulled: "100000", left: "100000", periodEnd: END, expiresAt: END + 82_800 },
      readAt: 5,
      stale: false,
    });
  });

  it("says none when the owner granted nothing", async () => {
    const demo = withAllowance(failingDemo(REFUSED), { owner: OWNER, agent: AGENT, nonce: 0n, read: async () => report(), amounts });
    expect((await demo.state()).allowance.read).toEqual({ status: "none" });
  });

  it("keeps the last read, marked stale, when a read fails, and logs it", async () => {
    let clock = 0;
    let fails = false;
    const lines: string[] = [];
    const demo = withAllowance(failingDemo(REFUSED), {
      owner: OWNER,
      agent: AGENT,
      nonce: 0n,
      read: async () => {
        if (fails) throw new Error("node down");
        return report({});
      },
      amounts,
      now: () => clock,
      log: (line) => lines.push(line),
    });
    await demo.state();
    fails = true;
    clock = ALLOWANCE_READ_EVERY_MS;
    const state = await demo.state();
    expect(state.allowance).toMatchObject({ read: { status: "active" }, readAt: 0, stale: true });
    expect(lines).toEqual(["reading the allowance failed: node down"]);
  });

  it("marks the allowance stale, with no read, when the first read fails", async () => {
    const demo = withAllowance(failingDemo(REFUSED), {
      owner: OWNER,
      agent: AGENT,
      nonce: 0n,
      read: async () => {
        throw new Error("node down");
      },
      amounts,
      log: () => {},
    });
    const view = (await demo.state()).allowance;
    expect(view.stale).toBe(true);
    expect(view.read).toBeUndefined();
  });

  it("is not stopped by a log that throws", async () => {
    const demo = withAllowance(failingDemo(REFUSED), {
      owner: OWNER,
      agent: AGENT,
      nonce: 0n,
      read: async () => {
        throw new Error("node down");
      },
      amounts,
      log: () => {
        throw new Error("no stderr");
      },
    });
    expect((await demo.state()).allowance.stale).toBe(true);
    await expect(demo.launch()).rejects.toThrow(/Refused on-chain/);
  });

  it("rejects a failure that is no refusal without waiting for a read", async () => {
    let reads = 0;
    const demo = withAllowance(failingDemo("A session is already running: top it up, close it, or let it end"), {
      owner: OWNER,
      agent: AGENT,
      nonce: 0n,
      read: () => {
        reads++;
        return new Promise<AllowanceReport>(() => {});
      },
      amounts,
    });
    const outcome = await Promise.race([
      demo.launch().then(
        () => "resolved",
        (error: unknown) => (error instanceof Error ? error.message : "rejected"),
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve("waited"), 100)),
    ]);
    expect(outcome).toBe("A session is already running: top it up, close it, or let it end");
    expect(reads).toBe(1);
  });

  it("reads at most every 5 s on state reads", async () => {
    let clock = 0;
    let reads = 0;
    const demo = withAllowance(failingDemo(REFUSED), {
      owner: OWNER,
      agent: AGENT,
      nonce: 0n,
      read: async () => {
        reads++;
        return report({});
      },
      amounts,
      now: () => clock,
    });
    await demo.state();
    clock = ALLOWANCE_READ_EVERY_MS - 1;
    await demo.state();
    expect(reads).toBe(1);
    clock = ALLOWANCE_READ_EVERY_MS;
    await demo.state();
    expect(reads).toBe(2);
  });

  it("rewords a launch the chain refused, in the error it throws and in the states after it", async () => {
    const demo = withAllowance(failingDemo(REFUSED), { owner: OWNER, agent: AGENT, nonce: 0n, read: async () => report({ pulled: 200_000n, available: 0n }), amounts });
    const words = "Refused on-chain: the allowance for this period is used up (0.200 of 0.200 USDC pulled; the period ends at 17:15 UTC).";
    await expect(demo.launch()).rejects.toThrow(`${words} ${REFUSED}`);
    const state = await demo.state();
    expect(state.error).toEqual({ action: "launch", message: `${words} The gate answered simulation_failed.`, at: 1 });
  });

  it("rewords a top-up the chain refused", async () => {
    const demo = withAllowance(failingDemo(REFUSED_TOP_UP), { owner: OWNER, agent: AGENT, nonce: 0n, read: async () => report({ pulled: 200_000n, available: 0n }), amounts });
    await expect(demo.topUp()).rejects.toThrow(/^Refused on-chain: the allowance for this period is used up/);
  });

  it("says a launch the allowance has some left for, but not enough, with what is left", async () => {
    const demo = withAllowance(failingDemo(REFUSED), { owner: OWNER, agent: AGENT, nonce: 0n, read: async () => report({ pulled: 150_000n, available: 50_000n }), amounts });
    await expect(demo.launch()).rejects.toThrow(/^Refused on-chain: the allowance for this period has 0\.050 USDC left, less than the 0\.100 USDC needed/);
  });

  it("passes any other failure on as it is", async () => {
    const message = "A session is already running: top it up, close it, or let it end";
    const demo = withAllowance(failingDemo(message), { owner: OWNER, agent: AGENT, nonce: 0n, read: async () => report({}), amounts });
    await expect(demo.launch()).rejects.toThrow(message);
    expect((await demo.state()).error?.message).toBe(message);
  });

  it("rewords a refusal in the state that the wrapper has not seen through an action, with the general words", async () => {
    const general = refusalWords(undefined, 0n);
    const inner: Demo = { ...failingDemo(REFUSED), state: async () => baseState({ action: "launch", message: REFUSED, at: 1 }) };
    const demo = withAllowance(inner, { owner: OWNER, agent: AGENT, nonce: 0n, read: async () => report({ pulled: 200_000n, available: 0n }), amounts });
    expect((await demo.state()).error).toEqual({ action: "launch", message: `${general} The gate answered simulation_failed.`, at: 1 });
  });

  describe("after an action that worked", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("answers without waiting longer than a state read does for a read that never settles", async () => {
      vi.useFakeTimers();
      const inner: Demo = { ...failingDemo(REFUSED), launch: async () => baseState() };
      let reads = 0;
      const demo = withAllowance(inner, {
        owner: OWNER,
        agent: AGENT,
        nonce: 0n,
        read: () => {
          reads++;
          return new Promise<AllowanceReport>(() => {});
        },
        amounts,
      });
      let outcome = "pending";
      void demo.launch().then(() => {
        outcome = "resolved";
      });
      await vi.advanceTimersByTimeAsync(ALLOWANCE_READ_WAIT_MS - 1);
      expect(outcome).toBe("pending");
      await vi.advanceTimersByTimeAsync(1);
      expect(outcome).toBe("resolved");
      expect(reads).toBe(1);
    });
  });
});
