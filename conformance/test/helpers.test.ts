import { generateKeyPairSigner, getSolanaErrorFromJsonRpcError } from "@solana/kit";
import { StintError } from "@lxfoundry/stint-client";
import { STINT_ERROR__NOT_EXPIRED, STINT_ERROR__UNAUTHORIZED } from "@lxfoundry/stint-program-client";
import { describe, expect, it } from "vitest";
import { buyerClient, closePollMs, rejectedWithProgramError, refusalOf, sessionSeconds } from "../src/helpers.js";
import type { Target } from "../src/types.js";

describe("buyerClient", () => {
  it("is a client for the buyer's key whose period budget is 1 USDC", async () => {
    const signer = await generateKeyPairSigner();
    expect(buyerClient({ signer, usdcAccount: signer.address }).remainingBudget()).toBe(1_000_000n);
  });
});

describe("sessionSeconds", () => {
  const target = (name: Target["name"]): Target => ({ name, capabilities: new Set() });

  it("is as long as asked on a network of ours, and ten seconds longer on devnet, where each step takes seconds", () => {
    expect(sessionSeconds(target("local"), 8)).toBe(8);
    expect(sessionSeconds(target("external"), 8)).toBe(8);
    expect(sessionSeconds(target("devnet"), 8)).toBe(18);
  });

  it("is polled for a close every second on a network of ours, and every two seconds on devnet, which rate-limits", () => {
    expect(closePollMs(target("local"))).toBe(1_000);
    expect(closePollMs(target("external"))).toBe(1_000);
    expect(closePollMs(target("devnet"))).toBe(2_000);
  });
});

describe("rejectedWithProgramError", () => {
  /** What `sendTransaction` rejects with when preflight simulation fails: a kit error built from the node's JSON-RPC error. */
  const preflightFailure = (err: unknown) =>
    getSolanaErrorFromJsonRpcError({ code: -32002, message: "Transaction simulation failed", data: { err, logs: [], unitsConsumed: 0 } });
  /** What `confirmSignature` throws for a transaction that landed and failed. */
  const confirmedFailure = (err: unknown) => new Error(`Transaction 5xyz failed: ${JSON.stringify(err)}`);
  const custom = (code: number) => ({ InstructionError: [0, { Custom: code }] });

  it("finds the code in a preflight rejection, where it sits in the cause of the kit error", () => {
    expect(rejectedWithProgramError(preflightFailure(custom(STINT_ERROR__UNAUTHORIZED)), STINT_ERROR__UNAUTHORIZED)).toBe(true);
  });

  it("finds the code in the error confirmSignature throws for a transaction that failed", () => {
    expect(rejectedWithProgramError(confirmedFailure(custom(STINT_ERROR__UNAUTHORIZED)), STINT_ERROR__UNAUTHORIZED)).toBe(true);
  });

  it("finds the code further down a chain of causes", () => {
    const wrapped = new Error("the close failed", { cause: new Error("sending failed", { cause: preflightFailure(custom(STINT_ERROR__UNAUTHORIZED)) }) });
    expect(rejectedWithProgramError(wrapped, STINT_ERROR__UNAUTHORIZED)).toBe(true);
  });

  it.each([
    { what: "a preflight rejection", error: preflightFailure(custom(STINT_ERROR__NOT_EXPIRED)) },
    { what: "a failed transaction", error: confirmedFailure(custom(STINT_ERROR__NOT_EXPIRED)) },
  ])("does not take another custom error of the program for it: $what", ({ error }) => {
    expect(rejectedWithProgramError(error, STINT_ERROR__UNAUTHORIZED)).toBe(false);
  });

  it("does not take a code that only starts with the same digits for it", () => {
    expect(rejectedWithProgramError(confirmedFailure(custom(60060)), STINT_ERROR__UNAUTHORIZED)).toBe(false);
  });

  it.each([
    { what: "an instruction error that is not a custom one", error: preflightFailure({ InstructionError: [0, "InvalidAccountData"] }) },
    { what: "a transaction error", error: preflightFailure("BlockhashNotFound") },
    { what: "a network error", error: new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED 127.0.0.1:8899") }) },
    { what: "a timeout", error: new Error("Transaction 5xyz was not confirmed within 15000 ms") },
    { what: "a value that is not an error", error: "6006" },
  ])("is false for a rejection that is not the program's: $what", ({ error }) => {
    expect(rejectedWithProgramError(error, STINT_ERROR__UNAUTHORIZED)).toBe(false);
  });

  it("stops at a chain of causes that loops", () => {
    const loop = new Error("loop");
    loop.cause = loop;
    expect(rejectedWithProgramError(loop, STINT_ERROR__UNAUTHORIZED)).toBe(false);
  });
});

describe("refusalOf", () => {
  it("gives a StintError's status, the error its body names, its body and its message", async () => {
    const body = { error: "invalid_duration", minSeconds: 5, maxSeconds: 120 };
    expect(await refusalOf(Promise.reject(new StintError("refused", 400, body)))).toEqual({
      status: 400,
      reason: "invalid_duration",
      body,
      message: "refused",
    });
  });

  it("is undefined for a call that went through, and throws any other error", async () => {
    expect(await refusalOf(Promise.resolve("opened"))).toBeUndefined();
    await expect(refusalOf(Promise.reject(new Error("network down")))).rejects.toThrow("network down");
  });
});
