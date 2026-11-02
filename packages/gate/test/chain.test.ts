import {
  generateKeyPairSigner,
  getBase64Decoder,
  type Address,
  type Rpc,
  type RpcSubscriptions,
  type SolanaRpcApi,
  type SolanaRpcSubscriptionsApi,
} from "@solana/kit";
import { STINT_PROGRAM_ADDRESS, getSessionEncoder, type SessionArgs } from "@lxfoundry/stint-program-client";
import { describe, expect, it } from "vitest";
import { createRpcChain } from "../src/chain.js";

const SYSTEM_PROGRAM = "11111111111111111111111111111111" as Address;
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as Address;

/** An RPC whose `getAccountInfo` answers with one account (or none), as the node would. */
function rpcHolding(account: { owner: Address; data: Uint8Array } | null): Rpc<SolanaRpcApi> {
  return {
    getAccountInfo: () => ({
      send: async () => ({
        context: { slot: 1n },
        value: account && {
          data: [getBase64Decoder().decode(account.data), "base64"],
          executable: false,
          lamports: 1_000_000n,
          owner: account.owner,
          space: BigInt(account.data.length),
        },
      }),
    }),
  } as unknown as Rpc<SolanaRpcApi>;
}

async function sessionArgs(): Promise<SessionArgs> {
  const [authority, mint, receiver, receiverAuthorizer, refundOwner, rentPayer] = await Promise.all(
    Array.from({ length: 6 }, async () => (await generateKeyPairSigner()).address),
  );
  return {
    version: 1,
    bump: 255,
    authority: authority!,
    seed: 7n,
    mint: mint!,
    receiver: receiver!,
    receiverAuthorizer: receiverAuthorizer!,
    refundOwner: refundOwner!,
    rentPayer: rentPayer!,
    rate: 1_000n,
    minSeconds: 5,
    maxSeconds: 120,
    startedAt: 1_800_000_000n,
    deposited: 30_000n,
    claimed: 0n,
  };
}

describe("the RPC chain's session read", () => {
  const where = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDyLb" as Address;

  it("returns the session an account of the program holds", async () => {
    const args = await sessionArgs();
    const data = new Uint8Array(getSessionEncoder().encode(args));

    const read = await createRpcChain(rpcHolding({ owner: STINT_PROGRAM_ADDRESS, data })).readSession(where);

    expect(read).toMatchObject({ authority: args.authority, rate: 1_000n, deposited: 30_000n });
  });

  it("returns undefined where no account exists", async () => {
    expect(await createRpcChain(rpcHolding(null)).readSession(where)).toBeUndefined();
  });

  it("returns undefined for a wallet, which holds no data", async () => {
    const wallet = rpcHolding({ owner: SYSTEM_PROGRAM, data: new Uint8Array(0) });
    expect(await createRpcChain(wallet).readSession(where)).toBeUndefined();
  });

  it("returns undefined for an account of the program too short to be a session", async () => {
    const short = rpcHolding({ owner: STINT_PROGRAM_ADDRESS, data: new Uint8Array(40) });
    expect(await createRpcChain(short).readSession(where)).toBeUndefined();
  });

  it("returns undefined for an account of another program, even one that is long enough", async () => {
    const args = await sessionArgs();
    const data = new Uint8Array(getSessionEncoder().encode(args));
    expect(await createRpcChain(rpcHolding({ owner: TOKEN_PROGRAM, data })).readSession(where)).toBeUndefined();
  });

  it("returns undefined for an account of the program that is not a session", async () => {
    const args = await sessionArgs();
    const data = new Uint8Array(getSessionEncoder().encode(args));
    data.fill(0, 0, 8);
    expect(await createRpcChain(rpcHolding({ owner: STINT_PROGRAM_ADDRESS, data })).readSession(where)).toBeUndefined();
  });

  it("still rejects when the node cannot be reached", async () => {
    const down = {
      getAccountInfo: () => ({
        send: async () => {
          throw new Error("fetch failed");
        },
      }),
    } as unknown as Rpc<SolanaRpcApi>;
    await expect(createRpcChain(down).readSession(where)).rejects.toThrow(/fetch failed/);
  });
});

/** An account notification as the node sends it, in base64. */
const notification = (account: { owner: Address; data: Uint8Array }) => ({
  context: { slot: 1n },
  value: {
    data: [getBase64Decoder().decode(account.data), "base64"],
    executable: false,
    lamports: 1_000_000n,
    owner: account.owner,
    space: BigInt(account.data.length),
  },
});

/**
 * Account subscriptions that yield `notifications`, then `hold` until aborted, `fail` with an error, or `end`. Each
 * subscribe records its address, its configuration and its abort signal.
 */
function subscriptionsYielding(notifications: unknown[], then: "hold" | "fail" | "end" = "hold") {
  const calls: { address: Address; config: unknown; signal: AbortSignal }[] = [];
  const subscriptions = {
    accountNotifications: (address: Address, config: unknown) => ({
      subscribe: async ({ abortSignal }: { abortSignal: AbortSignal }) => {
        calls.push({ address, config, signal: abortSignal });
        return (async function* () {
          yield* notifications;
          if (then === "fail") throw new Error("socket closed");
          // Like Kit's, the notifications end once the subscription is aborted, at once if it already is.
          if (then === "hold" && !abortSignal.aborted) await new Promise((resolve) => abortSignal.addEventListener("abort", resolve));
        })();
      },
    }),
  };
  return { subscriptions: subscriptions as unknown as RpcSubscriptions<SolanaRpcSubscriptionsApi>, calls };
}

describe("the RPC chain's subscription to a session", () => {
  const where = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDyLb" as Address;

  it("reports the session after each change, and undefined once the account holds none", async () => {
    const args = await sessionArgs();
    const { subscriptions, calls } = subscriptionsYielding([
      notification({ owner: STINT_PROGRAM_ADDRESS, data: new Uint8Array(getSessionEncoder().encode(args)) }),
      notification({ owner: STINT_PROGRAM_ADDRESS, data: new Uint8Array(getSessionEncoder().encode({ ...args, deposited: 40_000n })) }),
      notification({ owner: SYSTEM_PROGRAM, data: new Uint8Array() }), // closed
    ]);
    const seen: (bigint | undefined)[] = [];
    const errors: unknown[] = [];

    const stop = createRpcChain(rpcHolding(null), subscriptions).watchSession!(where, (stored) => seen.push(stored?.deposited), (error) => errors.push(error));

    await expect.poll(() => seen).toEqual([30_000n, 40_000n, undefined]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ address: where, config: { commitment: "confirmed", encoding: "base64" } });
    stop();
    expect(calls[0]!.signal.aborted).toBe(true);
    // The notifications end once stopped; that is not reported as a failure.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(errors).toEqual([]);
  });

  it.each([
    ["fails", "fail" as const, /socket closed/],
    ["ends", "end" as const, /notifications ended/],
  ])("reports a subscription that %s, once", async (_, then, message) => {
    const { subscriptions } = subscriptionsYielding([], then);
    const errors: unknown[] = [];

    createRpcChain(rpcHolding(null), subscriptions).watchSession!(where, () => {}, (error) => errors.push(error));

    await expect.poll(() => errors).toHaveLength(1);
    expect(String(errors[0])).toMatch(message);
  });

  it("reports nothing once it has been stopped", async () => {
    const { subscriptions } = subscriptionsYielding([]);
    const errors: unknown[] = [];

    const stop = createRpcChain(rpcHolding(null), subscriptions).watchSession!(where, () => {}, (error) => errors.push(error));
    stop();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(errors).toEqual([]);
  });

  it("offers no subscription without an RPC subscriptions client", () => {
    expect(createRpcChain(rpcHolding(null)).watchSession).toBeUndefined();
  });
});
