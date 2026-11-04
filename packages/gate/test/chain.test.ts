import {
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_MIN_CONTEXT_SLOT_NOT_REACHED,
  SolanaError,
  generateKeyPairSigner,
  getBase58Decoder,
  getBase64Decoder,
  type Address,
  type Rpc,
  type RpcSubscriptions,
  type SolanaRpcApi,
  type SolanaRpcSubscriptionsApi,
} from "@solana/kit";
import {
  CloseKind,
  EVENT_IX_TAG,
  STINT_PROGRAM_ADDRESS,
  getClosedEventEncoder,
  getSessionEncoder,
  type SessionArgs,
} from "@lxfoundry/stint-program-client";
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

/** A transaction as `getTransaction` returns it with `json` encoding, its inner instructions holding `events` (base58 data). */
function recorded(events: string[]) {
  return {
    transaction: { message: { accountKeys: [STINT_PROGRAM_ADDRESS], instructions: [] } },
    meta: { err: null, innerInstructions: [{ index: 0, instructions: events.map((data) => ({ programIdIndex: 0, accounts: [], data })) }] },
  };
}

/** The base58 data of the `Closed` event of a close of `session`, `at` on the chain's clock, for a session paid until 1,800,000,030. */
function closedEventData(session: Address, at: bigint): string {
  const event = getClosedEventEncoder().encode({
    session,
    kind: CloseKind.Standard,
    claimed: 0n,
    owed: 8_000n,
    refunded: 22_000n,
    redirected: 0n,
    closedBy: session,
    paidUntil: 1_800_000_030n,
    at,
  });
  return getBase58Decoder().decode(Uint8Array.from([...EVENT_IX_TAG, ...event]));
}

/** An RPC that lists `entries` for any address, newest first, and returns `transactions` by signature; `fetched` records each read. */
function rpcListing(entries: { signature: string; err: unknown }[], transactions: Record<string, unknown>) {
  const fetched: string[] = [];
  const rpc = {
    getSignaturesForAddress: () => ({
      send: async () => entries.map((entry) => ({ ...entry, slot: 1n, blockTime: null, confirmationStatus: "confirmed", memo: null })),
    }),
    getTransaction: (signature: string) => ({
      send: async () => {
        fetched.push(signature);
        return transactions[signature] ?? null;
      },
    }),
  } as unknown as Rpc<SolanaRpcApi>;
  return { rpc, fetched };
}

const signatureFilledWith = (fill: number) => getBase58Decoder().decode(new Uint8Array(64).fill(fill));

describe("the RPC chain's lookup of a session's last close", () => {
  const where = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDyLb" as Address;
  const [LATER, FAILED, CLOSE, OPEN] = [1, 2, 3, 4].map(signatureFilledWith) as [string, string, string, string];

  it("returns the Closed event of the newest successful close of the session, past a later transfer and a failed transaction", async () => {
    const { rpc, fetched } = rpcListing(
      [
        { signature: LATER, err: null },
        { signature: FAILED, err: { InstructionError: [0, { Custom: 6004 }] } },
        { signature: CLOSE, err: null },
        { signature: OPEN, err: null },
      ],
      { [LATER]: recorded([]), [CLOSE]: recorded([closedEventData(where, 1_800_000_008n)]), [OPEN]: recorded([]) },
    );

    const event = await createRpcChain(rpc).lastClose!(where);

    expect(event).toMatchObject({ session: where, kind: CloseKind.Standard, at: 1_800_000_008n, paidUntil: 1_800_000_030n });
    expect(fetched).toEqual([LATER, CLOSE]); // the failed one is never read, nor anything past the close
  });

  it("returns undefined when no listed transaction holds a close of this session, or the node cannot return it yet", async () => {
    const other = (await generateKeyPairSigner()).address;
    const { rpc, fetched } = rpcListing(
      [
        { signature: CLOSE, err: null },
        { signature: OPEN, err: null },
      ],
      { [CLOSE]: recorded([closedEventData(other, 1_800_000_008n)]) },
    );

    expect(await createRpcChain(rpc).lastClose!(where)).toBeUndefined();
    expect(fetched).toEqual([CLOSE, OPEN]); // one read each in a look: the gate repeats the look
  });

  it("does not read again, given the same set, a transaction that an earlier look found to hold no close", async () => {
    const { rpc, fetched } = rpcListing(
      [
        { signature: LATER, err: null },
        { signature: OPEN, err: null },
      ],
      { [LATER]: recorded([]), [OPEN]: recorded([]) },
    );
    const chain = createRpcChain(rpc);
    const notCloses = new Set<string>();

    expect(await chain.lastClose!(where, notCloses)).toBeUndefined();
    expect(await chain.lastClose!(where, notCloses)).toBeUndefined();
    expect(fetched).toEqual([LATER, OPEN]);
  });
});

/**
 * An RPC that reports `status` for any signature, and holds `account` for any address once its `confirmed` state has
 * reached `slot`: a read with a later `minContextSlot` is refused, as a node refuses it. `calls` records what each request
 * asked.
 */
function rpcAtSlot(status: unknown, account: { owner: Address; data: Uint8Array } | null, slot = 100n) {
  const calls = { statuses: [] as unknown[][], reads: [] as unknown[] };
  const rpc = {
    getSignatureStatuses: (signatures: unknown, config: unknown) => ({
      send: async () => {
        calls.statuses.push([signatures, config]);
        return { context: { slot }, value: [status] };
      },
    }),
    getAccountInfo: (_: Address, config: { minContextSlot?: bigint }) => ({
      send: async () => {
        calls.reads.push(config);
        if ((config.minContextSlot ?? 0n) > slot) {
          throw new SolanaError(SOLANA_ERROR__JSON_RPC__SERVER_ERROR_MIN_CONTEXT_SLOT_NOT_REACHED, { contextSlot: slot });
        }
        return (await rpcHolding(account).getAccountInfo(_).send()) as unknown;
      },
    }),
  } as unknown as Rpc<SolanaRpcApi>;
  return { rpc, calls };
}

describe("the RPC chain's read of a session after a transaction", () => {
  const where = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDyLb" as Address;
  const TOP_UP = signatureFilledWith(5);
  const landedAt = (slot: bigint, confirmationStatus = "confirmed") => ({ slot, confirmations: 0n, err: null, confirmationStatus });

  it("reads the session at confirmed from the transaction's slot on, looking the transaction up in the node's history too", async () => {
    const args = await sessionArgs();
    const data = new Uint8Array(getSessionEncoder().encode({ ...args, deposited: 40_000n }));
    const { rpc, calls } = rpcAtSlot(landedAt(42n), { owner: STINT_PROGRAM_ADDRESS, data });

    const read = await createRpcChain(rpc).readSessionAfter!(where, TOP_UP);

    expect(read?.stored).toMatchObject({ authority: args.authority, deposited: 40_000n });
    expect(calls.statuses).toEqual([[[TOP_UP], { searchTransactionHistory: true }]]);
    expect(calls.reads).toEqual([expect.objectContaining({ commitment: "confirmed", minContextSlot: 42n })]);
  });

  it("reads a finalized transaction's session the same way", async () => {
    const data = new Uint8Array(getSessionEncoder().encode(await sessionArgs()));
    const { rpc, calls } = rpcAtSlot(landedAt(42n, "finalized"), { owner: STINT_PROGRAM_ADDRESS, data });

    expect((await createRpcChain(rpc).readSessionAfter!(where, TOP_UP))?.stored).toMatchObject({ deposited: 30_000n });
    expect(calls.reads).toEqual([expect.objectContaining({ minContextSlot: 42n })]);
  });

  it.each([
    ["shows no status for the transaction", null],
    ["shows the transaction processed only", landedAt(42n, "processed")],
  ])("answers undefined, without reading the account, while the node %s", async (_, status) => {
    const { rpc, calls } = rpcAtSlot(status, null);

    expect(await createRpcChain(rpc).readSessionAfter!(where, TOP_UP)).toBeUndefined();
    expect(calls.reads).toEqual([]);
  });

  it("answers undefined while the node's confirmed state has not reached the transaction's slot", async () => {
    const data = new Uint8Array(getSessionEncoder().encode(await sessionArgs()));
    const { rpc, calls } = rpcAtSlot(landedAt(142n), { owner: STINT_PROGRAM_ADDRESS, data }, 100n);

    expect(await createRpcChain(rpc).readSessionAfter!(where, TOP_UP)).toBeUndefined();
    expect(calls.reads).toHaveLength(1);
  });

  it("gives no session once the transaction shows and the address holds none", async () => {
    const { rpc } = rpcAtSlot(landedAt(42n), null);

    expect(await createRpcChain(rpc).readSessionAfter!(where, TOP_UP)).toEqual({ stored: undefined });
  });

  it("still rejects when the node fails otherwise", async () => {
    const { rpc } = rpcAtSlot(landedAt(42n), null);
    (rpc as unknown as { getAccountInfo: () => unknown }).getAccountInfo = () => ({
      send: async () => {
        throw new Error("fetch failed");
      },
    });

    await expect(createRpcChain(rpc).readSessionAfter!(where, TOP_UP)).rejects.toThrow(/fetch failed/);
  });
});
