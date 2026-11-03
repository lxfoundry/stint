import { generateKeyPairSigner, type Address, type Rpc, type SolanaRpcApi } from "@solana/kit";
import { beforeAll, describe, expect, it } from "vitest";
import { createMemoryStore, createRecordPruner, type SettlementRecord } from "../src/records.js";

const BLOCKHASH = "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N";

describe("the in-memory settlement store (spec §5.5)", () => {
  const claim = (messageHash: string): SettlementRecord => ({ messageHash, apiKey: "key", requirements: "{}" });

  it("claims a hash once: a second claim gets the record that holds it, unchanged", async () => {
    const store = createMemoryStore();
    expect(await store.claim(claim("a"))).toBeUndefined();
    expect(await store.claim({ ...claim("a"), apiKey: "other" })).toEqual(claim("a"));
    expect(await store.get("a")).toEqual(claim("a"));
  });

  it("replaces a record, releases a claim, and lists what it holds", async () => {
    const store = createMemoryStore();
    await store.claim(claim("a"));
    await store.claim(claim("b"));
    await store.put({ ...claim("a"), requirements: "completed" });
    await store.release("b");
    expect(await store.list()).toEqual([{ ...claim("a"), requirements: "completed" }]);
    expect(await store.claim(claim("b"))).toBeUndefined();
  });
});

describe("the record pruner (spec §5.5, 'How long')", () => {
  let payer: Address;
  const record = (messageHash: string, signed = true): SettlementRecord => ({
    messageHash,
    apiKey: "key",
    requirements: "{}",
    ...(signed ? { signed: { type: "open" as const, wire: "AQ==", signature: "sig", blockhash: BLOCKHASH, payer, amount: "30000" } } : {}),
  });

  beforeAll(async () => {
    payer = (await generateKeyPairSigner()).address;
  });

  /** The node's answer to `isBlockhashValid`, and how many times it was asked. */
  function node(valid: () => boolean) {
    const asked = { count: 0 };
    const rpc = {
      isBlockhashValid: () => ({
        send: async () => {
          asked.count++;
          return { value: valid() };
        },
      }),
    } as unknown as Rpc<SolanaRpcApi>;
    return { rpc, asked };
  }

  it("keeps a record while its blockhash is valid", async () => {
    const store = createMemoryStore();
    await store.claim(record("a"));
    const { rpc } = node(() => true);
    const pruner = createRecordPruner({ rpc }, store, { marginMs: 0, clock: () => 0 });
    expect(await pruner.pruneOnce()).toBe(0);
    expect(await pruner.pruneOnce()).toBe(0);
    expect(await store.get("a")).toBeDefined();
  });

  it("drops a record a margin after the node first reported its blockhash no longer valid, and not before", async () => {
    const store = createMemoryStore();
    await store.claim(record("a"));
    const clock = { now: 1_000 };
    const { rpc, asked } = node(() => false);
    const pruner = createRecordPruner({ rpc }, store, { marginMs: 60_000, clock: () => clock.now });

    expect(await pruner.pruneOnce()).toBe(0); // first seen expired at 1,000
    clock.now = 60_999;
    expect(await pruner.pruneOnce()).toBe(0);
    clock.now = 61_000;
    expect(await pruner.pruneOnce()).toBe(1);
    expect(await store.get("a")).toBeUndefined();
    // The node is asked once: from then on the record waits out its margin.
    expect(asked.count).toBe(1);
  });

  it("keeps a claim that holds no transaction yet, without asking the node", async () => {
    const store = createMemoryStore();
    await store.claim(record("a", false));
    const { rpc, asked } = node(() => false);
    const pruner = createRecordPruner({ rpc }, store, { marginMs: 0, clock: () => 0 });
    expect(await pruner.pruneOnce()).toBe(0);
    expect(await pruner.pruneOnce()).toBe(0);
    expect(asked.count).toBe(0);
    expect(await store.get("a")).toBeDefined();
  });

  it("asks again at the next pass when the node's answer cannot be read", async () => {
    const store = createMemoryStore();
    await store.claim(record("a"));
    let failing = true;
    const { rpc, asked } = node(() => {
      if (failing) throw new Error("rpc down");
      return false;
    });
    const pruner = createRecordPruner({ rpc }, store, { marginMs: 0, clock: () => 0 });
    expect(await pruner.pruneOnce()).toBe(0);
    failing = false;
    expect(await pruner.pruneOnce()).toBe(0); // seen expired now
    expect(await pruner.pruneOnce()).toBe(1);
    expect(asked.count).toBe(2);
  });

  it("joins a pass already running", async () => {
    const store = createMemoryStore();
    await store.claim(record("a"));
    const { rpc, asked } = node(() => true);
    const pruner = createRecordPruner({ rpc }, store, { marginMs: 0, clock: () => 0 });
    const [first, second] = [pruner.pruneOnce(), pruner.pruneOnce()];
    expect(second).toBe(first);
    await first;
    expect(asked.count).toBe(1);
  });
});
