import { CloseKind, EVENT_IX_TAG, STINT_PROGRAM_ADDRESS, getClosedEventEncoder } from "@lxfoundry/stint-program-client";
import { generateKeyPairSigner, getBase58Decoder, type Address, type Rpc, type SolanaRpcApi } from "@solana/kit";
import { beforeAll, describe, expect, it } from "vitest";
import { awaitClose, findClose } from "../src/closes.js";

const sig = (fill: number) => getBase58Decoder().decode(new Uint8Array(64).fill(fill));
const [LATER, FAILED, CLOSE, OPEN] = [sig(1), sig(2), sig(3), sig(4)] as const;
const retry = { attempts: 1, delayMs: 0 };

/** A confirmed transaction as `getTransaction` returns it with `json` encoding, with these inner instructions (base58 data). */
const transaction = (inner: string[]) => ({
  transaction: { message: { accountKeys: [STINT_PROGRAM_ADDRESS], instructions: [] } },
  meta: { err: null, innerInstructions: [{ index: 0, instructions: inner.map((data) => ({ programIdIndex: 0, accounts: [], data })) }] },
});

/** A close: one inner `Closed` event for `session`. */
function closeTransaction(session: Address, closedBy: Address) {
  const event = getClosedEventEncoder().encode({
    session,
    kind: CloseKind.AtExpiry,
    claimed: 0n,
    owed: 10_000n,
    refunded: 0n,
    redirected: 0n,
    closedBy,
    paidUntil: 1_800_000_010n,
    at: 1_800_000_011n,
  });
  return transaction([getBase58Decoder().decode(Uint8Array.from([...EVENT_IX_TAG, ...event]))]);
}

const listed = (signature: string, err: unknown = null) => ({ signature, err, slot: 1n, blockTime: null, confirmationStatus: "confirmed", memo: null });

/**
 * A node that answers each listing with the next of `listings` (the last repeating; an error is a listing that the node rejects),
 * and knows `transactions` by signature: a transaction, or a function that answers each read of it (`null` is a node that cannot
 * return it yet). `fetched` records every read.
 */
function fakeRpc(listings: readonly (readonly ReturnType<typeof listed>[] | Error)[], transactions: Record<string, unknown>) {
  const fetched: string[] = [];
  let lists = 0;
  const rpc = {
    getSignaturesForAddress: () => ({
      send: async () => {
        const next = listings[Math.min(lists++, listings.length - 1)]!;
        if (next instanceof Error) throw next;
        return next;
      },
    }),
    getTransaction: (read: string) => ({
      send: async () => {
        fetched.push(read);
        const known = transactions[read];
        return typeof known === "function" ? (known as () => unknown)() : (known ?? null);
      },
    }),
  } as unknown as Rpc<SolanaRpcApi>;
  return { rpc, fetched };
}

describe("the close of a session that someone else closed", () => {
  let session: Address;
  let other: Address;

  beforeAll(async () => {
    session = (await generateKeyPairSigner()).address;
    other = (await generateKeyPairSigner()).address;
  });

  it("is the newest successful transaction with a Closed event for the session, skipping a failed one and a later transfer", async () => {
    const { rpc, fetched } = fakeRpc(
      [[listed(LATER), listed(FAILED, { InstructionError: [0, { Custom: 6004 }] }), listed(CLOSE), listed(OPEN)]],
      { [LATER]: transaction([]), [CLOSE]: closeTransaction(session, other), [OPEN]: transaction([]) },
    );
    const found = await findClose(rpc, session, retry);
    expect(found?.signature).toBe(CLOSE);
    expect(found?.event).toMatchObject({ session, kind: CloseKind.AtExpiry, owed: 10_000n, closedBy: other });
    expect(fetched).toEqual([LATER, CLOSE]); // the failed one is never read, and nothing past the close
  });

  it("is not a Closed event that names another session", async () => {
    const { rpc } = fakeRpc([[listed(CLOSE)]], { [CLOSE]: closeTransaction(other, other) });
    expect(await findClose(rpc, session, retry)).toBeUndefined();
  });

  it("is nothing while the address has no transactions", async () => {
    expect(await findClose(fakeRpc([[]], {}).rpc, session, retry)).toBeUndefined();
  });

  it("is waited for until it shows up", async () => {
    const { rpc } = fakeRpc([[], [], [listed(CLOSE)]], { [CLOSE]: closeTransaction(session, other) });
    expect((await awaitClose(rpc, session, retry, 5_000, "the close shows up", 1)).signature).toBe(CLOSE);
  });

  it("is waited for without reading a transaction again that held no Closed event, however often it looks", async () => {
    const { rpc, fetched } = fakeRpc(
      [[listed(LATER), listed(OPEN)], [listed(LATER), listed(OPEN)], [listed(CLOSE), listed(LATER), listed(OPEN)]],
      { [LATER]: transaction([]), [OPEN]: transaction([]), [CLOSE]: closeTransaction(session, other) },
    );
    await awaitClose(rpc, session, retry, 5_000, "the close shows up", 1);
    expect(fetched).toEqual([LATER, OPEN, CLOSE]); // each of the first two once, over three looks
  });

  it("is waited for by reading again a transaction that the node could not return yet", async () => {
    let reads = 0;
    const { rpc, fetched } = fakeRpc([[listed(CLOSE)]], { [CLOSE]: () => (reads++ === 0 ? null : closeTransaction(session, other)) });
    expect((await awaitClose(rpc, session, retry, 5_000, "the close shows up", 1)).signature).toBe(CLOSE);
    expect(fetched).toEqual([CLOSE, CLOSE]);
  });

  it("is waited for through a listing that the node rejects, such as a rate limit, and looked for again", async () => {
    const { rpc } = fakeRpc([new Error("HTTP error (429): Too Many Requests"), [listed(CLOSE)]], { [CLOSE]: closeTransaction(session, other) });
    expect((await awaitClose(rpc, session, retry, 5_000, "the close shows up", 1)).signature).toBe(CLOSE);
  });

  it("is waited for no longer than the limit when every listing is rejected, and the error names what was awaited and why the last look failed", async () => {
    const rejected = new Error("HTTP error (429): Too Many Requests");
    const error = await awaitClose(fakeRpc([rejected], {}).rpc, session, retry, 30, "the sweeper closes the session", 5).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("the sweeper closes the session: not within 30 ms");
    expect((error as Error).cause).toBe(rejected);
  });

  it("is waited for no longer than the limit, and the error names what was awaited", async () => {
    await expect(awaitClose(fakeRpc([[]], {}).rpc, session, retry, 30, "the sweeper closes the session", 5)).rejects.toThrow(
      "the sweeper closes the session: not within 30 ms",
    );
  });
});
