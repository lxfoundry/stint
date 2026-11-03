# Stage 3: payment refusals and settlement records — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or
> executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for
> tracking.

**Goal:** A payment that does not match its offer is refused with its reason before anything is signed, and a payment
sent twice is settled once. The facilitator keeps a record of every settlement through `/settle`, keyed by the hash of
the transaction's message (spec section 5.5, "Idempotency"): a retry with the same API key and the same requirements is
answered from its record, without being verified, signed or sent again; a duplicate in flight joins the settlement
already running; a retry with other requirements or another API key is refused. A transaction whose outcome is unknown
is looked up by its ID, and sent again while it can still land. The gate answers `503` where the facilitator says a
payment may have landed without its record (`already_processed`), never `402`. Scenarios 5, 6, 13, 14, 17, 18, 19 and 32
pass on `local` and become `required`, and pass on devnet.

**Architecture:** No change to the program. The scheme package refuses a transaction whose message is not in its
canonical encoding, so that one message has one hash, and states which fields of the requirements a retry must repeat.
The facilitator gains a settlement store behind an interface (an in-memory one in this repository), a pruner that drops
a record once its transaction's blockhash has expired, and a settlement object that owns `/verify` and `/settle`; the
submission of a transaction now tells a node's refusal from a failure to send that leaves open whether the node took
the transaction. The gate maps `already_processed` to `503`, and
its facilitator client and the facilitator's Kora client get time limits. The conformance library gains the facilitator's
`/verify` in a scenario's context and helpers that build a payment by hand, so that a scenario can send what no client
would.

**Tech Stack:** TypeScript 7.0.2, vitest 5.0.5, `@solana/kit` 8.5.0, `@x402/core` 2.28.0, Surfpool 1.6.1, Kora 2.0.5.

**Spec:** `docs/specs/stint-system.md`, sections 5.3 (payloads and transaction layouts), 5.4 (verification and its
refusal reasons), 5.5 (settlement, idempotency), 6.1 and 6.5 (the facilitator's interface and its store), 7.1 (the gate's
answers, `503` for `already_processed`), 9.3 (what the client checks before signing), 11 (failure handling), 12.2 (the
facilitator API capability) and 12.7 (scenarios 5, 6, 13, 14, 17, 18, 19 and 32).

## Global Constraints

- Platform: Linux x86-64; on Windows, everything runs inside WSL 2 (T1, T2). Run every command from the repository
  root, inside WSL. Do not rely on `/tmp` staying intact while a command runs: keep scratch files under the home
  directory or a git-ignored folder of the repository.
- **Devnet only.** No transaction from this repository's code or scripts reaches another network.
- Transactions are version 0, without address lookup tables (spec section 3.5). Only classic SPL Token mints; the
  payment token is devnet USDC, `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`, 6 decimals (spec section 3.4).
- `u64` values on the wire are decimal strings; `u32` values are JSON numbers (spec section 5.1). Amounts are `bigint`
  in TypeScript, never `number`.
- **No secrets, ever, in any commit.** A settlement record holds the SHA-256 of the API key it came with, never the key.
  Never print a key's contents or the devnet seed; an RPC URL may carry an API key.
- **`/verify` is read-only** (spec section 5.4): it never claims, records, signs or submits anything.
- **A message is processed at most once** (S16): no change in this plan may let one payload be signed and sent as two
  transactions. A record is released only while its transaction has never been taken by a node.
- `FacilitatorConfig`, `GateConfig`, `ScenarioContext` and the client's options gain no required member: tests build them
  from literals.
- Scenario statuses follow the ratchet of spec section 12.2: a scenario is made `required` in the commit where it first
  passes on `local`, and never goes back to `pending`.
- Test first: write the failing test, run it, implement, run it again, commit.
- Commit messages are neutral, technical and in the present tense.

## What this stage builds, and what it leaves

Built: the canonical-message check and the retry key of the requirements (scheme package); the settlement store, its
in-memory implementation and the record pruner; settlement records on `/verify` and `/settle`; a submission that tells a
node's refusal before forwarding (final, the record released) from any other failure to send (the outcome waited for,
then `settlement_pending` while still unknown, the record kept) and reads an `AlreadyProcessed` transaction by its ID;
the lookup, in the node's transaction history too, and the resubmission of a recorded transaction whose outcome is unknown;
`already_processed` from a simulation of a message the chain has processed; the gate's `503` for `already_processed`; time
limits on the gate's facilitator client and the facilitator's Kora client; the facilitator API in a scenario's context;
scenarios 5, 6, 13, 14, 17, 18, 19 and 32.

Not built, and not to be built here:
- **A store that survives restarts and is shared by the facilitator's instances** (spec section 6.5). The facilitator
  takes any `SettlementStore`; this repository provides only the in-memory one, so a restart loses its records. The spec's
  section 13 says so (Task 4).
- **Settlement records for the sponsored close** (`POST /close`, spec section 6.1). It keeps the in-flight sharing of part
  1 of stage 7: one sponsored close of a session is settled at a time, and a duplicate gets that close's answer. A retry
  after it has landed is refused at verification (`unknown_session`, the session account being gone), which the client
  already reads as a closed session; spec section 6.1 says so (Task 4). Its submission gains the same distinction between a
  node's refusal and any other failure to send as `/settle`'s (Task 3).
- **The gate's watch of a payment that may still land** (spec section 7.1: after a `202` to an open, and after
  `already_processed`), and the client's polling after paying (spec section 9.3). A `202` or a `503` leaves the client's
  budget locked, as today, and a session that lands then is not served until the gate adopts it. Both come with scenario
  33, which loses a settlement's reply on purpose.
- **Recording which API key each open came through** (spec section 5.3), which counts a recreated `receiver_token` against
  the seller's key: that comes with scenario 27.
- **Rate limits and the limits per API key** (spec section 6.5).

## Before you start: what a person must prepare

Start from a clean tree on a branch of its own, from a `main` that holds stage 7 (`conformance/src/scenarios/25-gate-and-facilitator-unreachable-at-close.ts`
exists, and `REQUIRED` in `conformance/test/catalogue.test.ts` lists 13 scenarios) and this plan. Tasks 1 to 11 need
nothing but the repository. Task 12 runs the devnet harness, with the person's `.env.devnet` (`STINT_DEVNET_RPC_URL`,
`STINT_DEVNET_SEED`, and `STINT_DEVNET_SCAN_RPC_URL` if the provider refuses `getProgramAccounts`) and the funding key
funded as `pnpm e2e:devnet funds` says. No other run of the devnet harness may use the same seed at the same time. This
stage changes no program code, so the devnet deployment stays as it is.

Where another stage may have changed the same lines first (the `REQUIRED` lists, the devnet scenario list, the README),
this plan states its edit as a rule, with the text as stage 7 leaves it as the example.

---

### Task 1: One hash per message, the requirements a retry repeats, and a status read

Three small pieces of the scheme package that the settlement records rest on.

- `@solana/kit`'s transaction decoder takes every byte after the signatures as the message, and the message decoder
  ignores bytes past the message's end. A wire with bytes appended therefore decodes to the same instructions with other
  message bytes, and another hash: the same payment would not be recognised as a retry. `inspectTransaction` now refuses
  a message whose bytes are not its canonical encoding.
- A retry must come with "the same requirements", which leaves out the advisory fields that a fresh offer changes
  (`maxTimeoutSeconds`, `extra.recentBlockhash`, `extra.lastValidBlockHeight`; spec section 5.5). `retryRequirementsKey`
  gives the requirements without them as one string, which a record stores.
- `waitForConfirmation`'s status read becomes `readConfirmation`, exported, for the lookup of a recorded transaction
  (Task 3).

**Files:**
- Modify: `packages/x402/src/inspect.ts`, `packages/x402/src/offer.ts`, `packages/x402/src/chain.ts`
- Create: `packages/x402/test/inspect.test.ts`
- Modify: `packages/x402/test/offer.test.ts`, `packages/x402/test/chain.test.ts`

**Interfaces:**
- Consumes: `buildOpenOffer`, `buildOpenTransaction` (`packages/x402/src`); `getCompiledTransactionMessageEncoder`
  (`@solana/kit`).
- Produces, from `@lxfoundry/stint-x402`:
  - `inspectTransaction(wire: string): InspectedTransaction | undefined` returns undefined as well for a wire whose
    message bytes differ from the canonical encoding of the message they decode to; `messageHash` is unchanged otherwise;
  - `retryRequirementsKey(requirements: unknown): string`: the canonical JSON of `requirements` without
    `maxTimeoutSeconds`, `extra.recentBlockhash` and `extra.lastValidBlockHeight`, keys sorted at every level; for a value
    that is not an object, its canonical JSON (`"null"` for `undefined`);
  - `readConfirmation(rpc: Rpc<SolanaRpcApi>, signature: string, options?: { readonly searchTransactionHistory?: boolean
    }): Promise<boolean>`: true when the signature's status is `confirmed` or `finalized`; throws `TransactionFailedError`
    when it carries an error, and the RPC's error when the read fails. With `searchTransactionHistory`, the node also
    looks in its transaction history, not only in its recent statuses.

- [ ] **Step 1: Write the failing test of the canonical message**

Create `packages/x402/test/inspect.test.ts`:

```ts
import { generateKeyPairSigner, getBase64Decoder, getBase64Encoder } from "@solana/kit";
import { beforeAll, describe, expect, it } from "vitest";
import { buildOpenOffer, buildOpenTransaction, inspectTransaction } from "../src/index.js";
import { offerInput } from "./fixtures.js";

describe("inspectTransaction (spec §5.5: a message has one hash)", () => {
  let wire: string;

  beforeAll(async () => {
    const authority = await generateKeyPairSigner();
    wire = (await buildOpenTransaction({ requirements: buildOpenOffer(offerInput()), authority, decimals: 6 })).transaction;
  });

  it("decodes a transaction built by the scheme, and hashes its message", () => {
    const tx = inspectTransaction(wire);
    expect(tx?.messageHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses a wire with bytes after the message, which would decode to the same instructions under another hash", () => {
    const bytes = getBase64Encoder().encode(wire);
    const padded = getBase64Decoder().decode(Uint8Array.from([...bytes, 0]));
    expect(inspectTransaction(padded)).toBeUndefined();
  });
});
```

Run: `pnpm --filter @lxfoundry/stint-x402 test inspect.test.ts`
Expected: FAIL: "refuses a wire with bytes after the message" (`inspectTransaction` returns an object); the first test
passes.

- [ ] **Step 2: Refuse a message that is not in its canonical encoding**

In `packages/x402/src/inspect.ts`, add `getCompiledTransactionMessageEncoder` to the import from `@solana/kit`, after
`getCompiledTransactionMessageDecoder`, and in `inspectTransaction`, replace:

```ts
    const compiled = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
    if (compiled.version !== 0) return undefined;
```

with:

```ts
    const compiled = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
    if (compiled.version !== 0) return undefined;
    // The decoders take every byte after the signatures as the message and ignore what follows its end: bytes appended to
    // a wire would give the same instructions another hash, and a retry would not be recognised (spec §5.5).
    const canonical = getCompiledTransactionMessageEncoder().encode(compiled);
    if (!sameBytes(canonical, transaction.messageBytes)) return undefined;
```

and add, above `inspectTransaction`:

```ts
function sameBytes(a: ReadonlyUint8Array, b: ReadonlyUint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}
```

with `type ReadonlyUint8Array` added to the import from `@solana/kit`.

Run: `pnpm --filter @lxfoundry/stint-x402 test`
Expected: PASS, every test of the package: every transaction the scheme builds, and every one the checks' tests rebuild,
is canonical.

- [ ] **Step 3: Write the failing test of the retry key**

In `packages/x402/test/offer.test.ts`, add `retryRequirementsKey` to the import from `../src/index.js`, and append:

```ts
describe("retryRequirementsKey (spec §5.5, 'How a retry is answered')", () => {
  const offer = buildOpenOffer(input);

  it("leaves out the advisory fields that a fresh offer changes", () => {
    const fresh = buildOpenOffer({
      ...input,
      lifetime: { blockhash: "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi", lastValidBlockHeight: 9_999n },
      maxTimeoutSeconds: 30,
    });
    expect(retryRequirementsKey(fresh)).toBe(retryRequirementsKey(offer));
  });

  it("keeps every other field, whatever the key order", () => {
    const reordered = Object.fromEntries(Object.entries(offer).reverse());
    expect(retryRequirementsKey(reordered)).toBe(retryRequirementsKey(offer));
    expect(retryRequirementsKey({ ...offer, amount: "30001" })).not.toBe(retryRequirementsKey(offer));
    expect(retryRequirementsKey({ ...offer, extra: { ...offer.extra, idleCloseSeconds: 11 } })).not.toBe(retryRequirementsKey(offer));
    expect(retryRequirementsKey({ ...offer, extra: { ...offer.extra, closeUrl: "http://127.0.0.1:4021/closf" } })).not.toBe(
      retryRequirementsKey(offer),
    );
  });

  it("gives a string for a value that is not requirements", () => {
    expect(retryRequirementsKey(undefined)).toBe("null");
    expect(retryRequirementsKey("open")).toBe('"open"');
  });
});
```

Run: `pnpm --filter @lxfoundry/stint-x402 test offer.test.ts`
Expected: FAIL: `retryRequirementsKey` is not exported.

- [ ] **Step 4: Write `retryRequirementsKey`**

In `packages/x402/src/offer.ts`, after `sameRequirements`, add:

```ts
/**
 * The requirements as a retry must repeat them (spec §5.5): every field but the advisory ones that a fresh offer changes,
 * `maxTimeoutSeconds`, `extra.recentBlockhash` and `extra.lastValidBlockHeight`, as canonical JSON. A settlement record
 * stores it; a value that is not an object gives its own canonical JSON, `"null"` for `undefined`.
 */
export function retryRequirementsKey(requirements: unknown): string {
  if (!isRecord(requirements)) return JSON.stringify(canonical(requirements)) ?? "null";
  const { maxTimeoutSeconds: _timeout, ...kept } = requirements;
  if (isRecord(kept.extra)) {
    const { recentBlockhash: _blockhash, lastValidBlockHeight: _height, ...extra } = kept.extra;
    kept.extra = extra;
  }
  return JSON.stringify(canonical(kept));
}
```

Run: `pnpm --filter @lxfoundry/stint-x402 test offer.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing test of `readConfirmation`**

In `packages/x402/test/chain.test.ts`, add `readConfirmation` and `TransactionFailedError` to the import from
`../src/index.js`, add `type Rpc, type SolanaRpcApi` to the import from `@solana/kit`, and append:

```ts
describe("readConfirmation", () => {
  const SIGNATURE = getBase58Decoder().decode(new Uint8Array(64).fill(7));
  const node = (status: unknown) =>
    ({ getSignatureStatuses: () => ({ send: async () => ({ value: [status] }) }) }) as unknown as Rpc<SolanaRpcApi>;

  it("is true at confirmed and finalized, false while the transaction has not landed or is only processed", async () => {
    expect(await readConfirmation(node({ confirmationStatus: "confirmed", err: null }), SIGNATURE)).toBe(true);
    expect(await readConfirmation(node({ confirmationStatus: "finalized", err: null }), SIGNATURE)).toBe(true);
    expect(await readConfirmation(node({ confirmationStatus: "processed", err: null }), SIGNATURE)).toBe(false);
    expect(await readConfirmation(node(null), SIGNATURE)).toBe(false);
  });

  it("throws TransactionFailedError for a transaction that landed with an error", async () => {
    const failed = node({ confirmationStatus: "confirmed", err: { InstructionError: [0, { Custom: 1 }] } });
    await expect(readConfirmation(failed, SIGNATURE)).rejects.toBeInstanceOf(TransactionFailedError);
  });

  it("asks the node to search its transaction history when told to, and only then", async () => {
    const configs: unknown[] = [];
    const rpc = {
      getSignatureStatuses: (_: unknown, config?: unknown) => {
        configs.push(config);
        return { send: async () => ({ value: [null] }) };
      },
    } as unknown as Rpc<SolanaRpcApi>;
    await readConfirmation(rpc, SIGNATURE);
    await readConfirmation(rpc, SIGNATURE, { searchTransactionHistory: true });
    expect(configs).toEqual([undefined, { searchTransactionHistory: true }]);
  });
});
```

Run: `pnpm --filter @lxfoundry/stint-x402 test chain.test.ts`
Expected: FAIL: `readConfirmation` is not exported.

- [ ] **Step 6: Export the status read**

In `packages/x402/src/chain.ts`, add above `waitForConfirmation`:

```ts
/**
 * Whether a transaction is confirmed, from its signature status: true at `confirmed` or `finalized`. Throws
 * `TransactionFailedError` if it landed with an error, and the RPC's error if the read fails. A node keeps recent
 * statuses only for a while after the transaction's blockhash; with `searchTransactionHistory`, it also looks in its
 * transaction history, for a transaction that may have landed longer ago.
 */
export async function readConfirmation(
  rpc: Rpc<SolanaRpcApi>,
  signature: string,
  options: { readonly searchTransactionHistory?: boolean } = {},
): Promise<boolean> {
  const config = options.searchTransactionHistory ? { searchTransactionHistory: true } : undefined;
  const { value } = await rpc.getSignatureStatuses([toSignature(signature)], config).send();
  const status = value[0];
  if (status?.err) throw new TransactionFailedError(signature, status.err);
  return status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized";
}
```

and in `waitForConfirmation`, replace:

```ts
  const read = async () => {
    const { value } = await rpc.getSignatureStatuses([toSignature(signature)]).send();
    const status = value[0];
    if (status?.err) throw new TransactionFailedError(signature, status.err);
    return status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized";
  };
```

with:

```ts
  const read = () => readConfirmation(rpc, signature);
```

Run: `pnpm --filter @lxfoundry/stint-x402 test && pnpm --filter @lxfoundry/stint-x402 typecheck`
Expected: PASS, no type error.

- [ ] **Step 7: Commit**

```bash
git add packages/x402/src/inspect.ts packages/x402/src/offer.ts packages/x402/src/chain.ts packages/x402/test/inspect.test.ts packages/x402/test/offer.test.ts packages/x402/test/chain.test.ts
git commit -m "Refuse non-canonical messages, key requirements for retries, and export the status read"
```

---

### Task 2: The settlement store and the record pruner

A record starts as the claim of a message's hash, made before anything is verified, and is completed with the signed
transaction before it is submitted, then with its outcome (spec section 5.5). It is kept until the node reports the
transaction's blockhash no longer valid, plus a margin, and never dropped after a fixed time. The store is an interface,
so that a store shared by instances can replace the in-memory one; the pruner keeps when it first saw a blockhash
expire in its own memory, so that it never writes a record that a settlement may be writing.

**Files:**
- Create: `apps/facilitator/src/records.ts`
- Create: `apps/facilitator/test/records.test.ts`

**Interfaces:**
- Consumes: `SettleResponse` (`@lxfoundry/stint-x402`); `FacilitatorContext` (`apps/facilitator/src/verify.ts`, for its
  `rpc`); `SignedSettlement` (`apps/facilitator/src/settle.ts`, a type: `{ type: "open" | "topUp" | "close"; wire: string;
  signature: string; blockhash: string; payer: Address; amount: string }`).
- Produces, in `apps/facilitator/src/records.ts`:
  - `interface SettlementRecord { readonly messageHash: string; readonly apiKey: string; readonly requirements: string;
    readonly signed?: SignedSettlement; readonly outcome?: SettleResponse }`: `apiKey` is the SHA-256 of the API key, hex;
    `requirements` is `retryRequirementsKey` of the requirements; `signed` is set before the first submission; `outcome`
    is the final answer, absent while the outcome is unknown;
  - `interface SettlementStore { claim(record: SettlementRecord): Promise<SettlementRecord | undefined>; get(messageHash:
    string): Promise<SettlementRecord | undefined>; put(record: SettlementRecord): Promise<void>; release(messageHash:
    string): Promise<void>; list(): Promise<readonly SettlementRecord[]> }`: `claim` resolves undefined when it took the
    hash (the store now holds `record`), and otherwise the record that holds it, unchanged;
  - `createMemoryStore(): SettlementStore`;
  - `const RECORD_MARGIN_MS = 60_000` and `const DEFAULT_PRUNE_INTERVAL_MS = 30_000`;
  - `interface RecordPruner { pruneOnce(): Promise<number> }` (resolves to the number of records dropped; a pass already
    running is joined) and `createRecordPruner(ctx: Pick<FacilitatorContext, "rpc">, store: SettlementStore, options?: {
    readonly marginMs?: number; readonly clock?: () => number }): RecordPruner`.

- [ ] **Step 1: Write the failing tests**

Create `apps/facilitator/test/records.test.ts`:

```ts
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
```

Run: `pnpm --filter @lxfoundry/stint-facilitator test records.test.ts`
Expected: FAIL: `../src/records.js` does not exist.

- [ ] **Step 2: Write the store and the pruner**

Create `apps/facilitator/src/records.ts`:

```ts
import { blockhash } from "@solana/kit";
import type { SettleResponse } from "@lxfoundry/stint-x402";
import type { SignedSettlement } from "./settle.js";
import type { FacilitatorContext } from "./verify.js";

/**
 * A settlement record (spec §5.5, "Idempotency"). It starts as the claim of a message's hash, made before anything is
 * verified, so that two identical payloads can never both proceed. It is completed with the transaction signed by every
 * party before that transaction is submitted, and with its outcome once that is known.
 */
export interface SettlementRecord {
  /** SHA-256 of the transaction's message, hex: the record's key. */
  readonly messageHash: string;
  /** SHA-256 of the API key the payload came with, hex. The key itself is never stored. */
  readonly apiKey: string;
  /** The requirements it came with, as `retryRequirementsKey` gives them: without the advisory fields. */
  readonly requirements: string;
  /** Set before the transaction is first submitted. */
  readonly signed?: SignedSettlement;
  /** The final answer: the transaction is confirmed, landed with an error, or can no longer land. Absent while not known. */
  readonly outcome?: SettleResponse;
}

/**
 * Where settlement records live (spec §6.5). Each method is atomic. A store that survives restarts and is shared by the
 * facilitator's instances implements this interface; this repository provides only `createMemoryStore`, whose claims
 * end with the process that made them. A shared store must also release a claim whose instance stopped before it
 * recorded a transaction: the pruner keeps such claims, and another instance answers their payload
 * `settlement_pending` without a transaction until then.
 */
export interface SettlementStore {
  /**
   * Claims `record.messageHash`. Resolves undefined when no claim or record held it, and the store now holds `record`;
   * otherwise resolves to the record that holds it, unchanged.
   */
  claim(record: SettlementRecord): Promise<SettlementRecord | undefined>;
  get(messageHash: string): Promise<SettlementRecord | undefined>;
  /** Replaces the record of `record.messageHash`. */
  put(record: SettlementRecord): Promise<void>;
  /** Removes the claim or the record of `messageHash`. */
  release(messageHash: string): Promise<void>;
  list(): Promise<readonly SettlementRecord[]>;
}

/** Records in this process's memory: lost when it stops, and seen by no other instance (spec §6.5). */
export function createMemoryStore(): SettlementStore {
  const records = new Map<string, SettlementRecord>();
  return {
    async claim(record) {
      const held = records.get(record.messageHash);
      if (held) return held;
      records.set(record.messageHash, record);
      return undefined;
    },
    get: async (messageHash) => records.get(messageHash),
    put: async (record) => void records.set(record.messageHash, record),
    release: async (messageHash) => void records.delete(messageHash),
    list: async () => [...records.values()],
  };
}

/** How long a record outlives the moment its transaction's blockhash was first found no longer valid (spec §5.5). */
export const RECORD_MARGIN_MS = 60_000;
/** How often the facilitator looks for records to drop. */
export const DEFAULT_PRUNE_INTERVAL_MS = 30_000;

export interface RecordPruner {
  /** One pass: resolves to the number of records dropped. A pass already running is joined. */
  pruneOnce(): Promise<number>;
}

/**
 * Drops each record a margin after the node first reported its transaction's blockhash no longer valid, at `confirmed`,
 * the commitment the facilitator verifies at (spec §5.5, "How long"). A payload that comes back after that is verified as
 * new, and refused as `blockhash_expired`, so a landed transaction cannot be presented as a payment again. A claim that
 * holds no transaction yet is being settled, and is kept. When the node's answer cannot be read, the next pass asks again.
 * When each blockhash was first seen expired is kept here, not in the store, so that a pass never writes a record.
 */
export function createRecordPruner(
  ctx: Pick<FacilitatorContext, "rpc">,
  store: SettlementStore,
  options: { readonly marginMs?: number; readonly clock?: () => number } = {},
): RecordPruner {
  const marginMs = options.marginMs ?? RECORD_MARGIN_MS;
  const clock = options.clock ?? Date.now;
  const expiredSince = new Map<string, number>();
  let running: Promise<number> | undefined;

  async function pass(): Promise<number> {
    const records = await store.list();
    const held = new Set(records.map((record) => record.messageHash));
    for (const messageHash of expiredSince.keys()) if (!held.has(messageHash)) expiredSince.delete(messageHash);
    let dropped = 0;
    for (const record of records) {
      const signed = record.signed;
      if (!signed) continue;
      const since = expiredSince.get(record.messageHash);
      if (since === undefined) {
        const lifetime = blockhash(signed.blockhash);
        try {
          const { value: valid } = await ctx.rpc.isBlockhashValid(lifetime, { commitment: "confirmed" }).send();
          if (!valid) expiredSince.set(record.messageHash, clock());
        } catch {
          // Asked again at the next pass.
        }
        continue;
      }
      if (clock() - since < marginMs) continue;
      await store.release(record.messageHash);
      expiredSince.delete(record.messageHash);
      dropped++;
    }
    return dropped;
  }

  return {
    pruneOnce: () => (running ??= pass().finally(() => (running = undefined))),
  };
}
```

Run: `pnpm --filter @lxfoundry/stint-facilitator test records.test.ts && pnpm --filter @lxfoundry/stint-facilitator typecheck`
Expected: PASS, no type error.

- [ ] **Step 3: Commit**

```bash
git add apps/facilitator/src/records.ts apps/facilitator/test/records.test.ts
git commit -m "Add the settlement store, its in-memory implementation and the record pruner"
```

---

### Task 3: How a submission ends, a recorded transaction looked up, and Kora's time limit

Today a failure of `sendTransaction` is answered `simulation_failed` whatever it was. Spec section 5.5 needs three cases
told apart:
- the node refused the transaction with one of the errors a node returns before it forwards one (a failed preflight, a
  signature that does not verify, an unhealthy node, invalid parameters, and the like): it did not take it, so the
  payload may come again;
- the node reports the message already processed (S16): it has it, and its outcome is read by its ID;
- anything else, a request with no answer or another error (a proxy or a load balancer can answer one after it has
  forwarded the transaction): the node may have taken it, so its outcome is waited for as for a transaction it took, and
  is `settlement_pending` while still unknown, with the record kept.

A recorded transaction whose outcome is unknown is looked up by its ID, in the node's transaction history as well as its
recent statuses, before anything is sent again. The sponsored close's submission goes through the same function, so it
gains the same distinction. Two smaller pieces: a simulation that reports the message already processed is answered
`already_processed` (spec section 5.4), and a request to Kora that gets no answer is given up, so that a settlement
waiting on its signature cannot hold its claim for ever.

Two test fakes of the facilitator stand for a node's refusal with a plain `Error`, which the new submission reads, rightly,
as a lost answer: Step 1 makes them throw what `@solana/kit` throws for a refusal at preflight.

**Files:**
- Modify: `apps/facilitator/src/settle.ts`, `apps/facilitator/src/verify.ts`, `apps/facilitator/src/kora.ts`
- Test: `apps/facilitator/test/settle.test.ts`, `apps/facilitator/test/verify.test.ts`, `apps/facilitator/test/kora.test.ts`,
  `apps/facilitator/test/close.test.ts`, `apps/facilitator/test/sweeper.test.ts`

**Interfaces:**
- Consumes: `readConfirmation` (Task 1), `waitForConfirmation`, `TransactionFailedError`, `fetchClosedEvent`,
  `readUntilFound` (`@lxfoundry/stint-x402`); `isSolanaError`, `SOLANA_ERROR__TRANSACTION_ERROR__ALREADY_PROCESSED` and
  the JSON-RPC error codes of `@solana/kit`.
- Produces, in `apps/facilitator/src/settle.ts`:
  - `type Submission = { readonly kind: "settled" | "pending" | "refused"; readonly response: SettleResponse }`, as a union
    of the three kinds: `settled` is final (confirmed, landed with an error, or no longer able to land), `pending` leaves
    the outcome unknown, `refused` is a transaction the node would not take at its first submission;
  - `sendAndConfirm(ctx: Pick<FacilitatorContext, "rpc" | "network" | "confirmTimeoutMs" | "readRetry">, signed:
    SignedSettlement, options?: { readonly resent?: boolean }): Promise<Submission>`: `refused` only for one of the
    errors a node returns before forwarding, at a first submission; after any other failure to send, it waits for the
    outcome as for a transaction sent;
  - `resolveRecorded(ctx: <the same Pick>, signed: SignedSettlement): Promise<Submission>`: never `refused`; its lookups
    search the node's transaction history;
  - `submitSettlement(ctx, signed): Promise<SettleResponse>`, unchanged in signature: `sendAndConfirm`'s response;
  - `SignedSettlement` unchanged.
- Produces, in `apps/facilitator/src/kora.ts`: `const DEFAULT_KORA_TIMEOUT_MS = 15_000` and
  `createKoraClient(url: string, apiKey: string, timeoutMs?: number): KoraClient`; a request with no answer within
  `timeoutMs` rejects with `Error("Kora <method>: no answer within <timeoutMs> ms")`.
- `verifyPayment` answers `{ ok: false, reason: "already_processed" }` when the simulation's `err` is `"AlreadyProcessed"`.

- [ ] **Step 1: Make the test fakes refuse as a node refuses**

In `apps/facilitator/test/close.test.ts` and in `apps/facilitator/test/sweeper.test.ts`, add
`SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM`, `SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE` and
`SolanaError` at the top of the import from `@solana/kit`, and after the last import, add:

```ts
/** A refusal by the node at preflight, as `@solana/kit` reports it: the program's error is its cause. */
const preflightRefusal = () =>
  new SolanaError(SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE, {
    cause: new SolanaError(SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM, { code: 6004, index: 0 }),
  } as never);
```

In `apps/facilitator/test/close.test.ts`, in the fake node's `sendTransaction`, replace:

```ts
        if (node.failSend) throw new Error("preflight refused");
```

with:

```ts
        if (node.failSend) throw preflightRefusal();
```

In `apps/facilitator/test/sweeper.test.ts`, in the fake node's `sendTransaction`, replace:

```ts
          throw new Error("Transaction simulation failed: custom program error 0x1774");
```

with:

```ts
          throw preflightRefusal();
```

Run: `pnpm --filter @lxfoundry/stint-facilitator test close.test.ts sweeper.test.ts`
Expected: PASS: today's submission answers any failure to send as `simulation_failed`, so these tests do not change
their outcome. After Step 3 they pass only with this form of the refusal.

- [ ] **Step 2: Write the failing tests of the submission**

In `apps/facilitator/test/settle.test.ts`:

Replace the import from `@solana/kit` with:

```ts
import {
  SOLANA_ERROR__JSON_RPC__INTERNAL_ERROR,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
  SOLANA_ERROR__TRANSACTION_ERROR__ALREADY_PROCESSED,
  SOLANA_ERROR__TRANSACTION_ERROR__BLOCKHASH_NOT_FOUND,
  SolanaError,
  generateKeyPairSigner,
  getBase58Decoder,
  type Address,
  type Rpc,
  type SolanaRpcApi,
} from "@solana/kit";
```

and the import from `../src/settle.js` with:

```ts
import { resolveRecorded, sendAndConfirm, submitSettlement, type SignedSettlement } from "../src/settle.js";
```

Replace the `Script` interface and `fakeRpc` with:

```ts
/** What the fake node answers: each read takes the next entry of its list, the last one repeating. */
interface Script {
  send?: () => unknown;
  statuses: (() => unknown)[];
  transactions: (() => unknown)[];
  /** What `isBlockhashValid` answers, in turn. Default: valid. */
  valid?: (() => boolean)[];
}

function fakeRpc(script: Script): {
  rpc: Rpc<SolanaRpcApi>;
  /** How many reads of each kind were made, and for each status read whether it searched the transaction history. */
  reads: { statuses: number; transactions: number; valid: number; sent: number; history: boolean[] };
} {
  const reads = { statuses: 0, transactions: 0, valid: 0, sent: 0, history: [] as boolean[] };
  const next = <T>(list: (() => T)[], index: number) => list[Math.min(index, list.length - 1)]!();
  const call = (answer: () => unknown) => ({ send: async () => answer() });
  const rpc = {
    sendTransaction: () =>
      call(() => {
        reads.sent++;
        return (script.send ?? (() => SIGNATURE))();
      }),
    getSignatureStatuses: (_: unknown, config?: { searchTransactionHistory?: boolean }) => {
      reads.history.push(config?.searchTransactionHistory === true);
      return call(() => ({ value: [next(script.statuses, reads.statuses++)] }));
    },
    isBlockhashValid: () => call(() => ({ value: script.valid ? next(script.valid, reads.valid++) : true })),
    getTransaction: () => call(() => next(script.transactions, reads.transactions++)),
  };
  return { rpc: rpc as unknown as Rpc<SolanaRpcApi>, reads };
}
```

Below `const confirmed = …`, add:

```ts
const failed = () => ({ confirmationStatus: "confirmed", err: { InstructionError: [2, { Custom: 6000 }] } });
const notLanded = () => null;
/** A JSON-RPC error from the node's preflight, as `@solana/kit` reports it: the transaction error is its cause. */
const preflight = (cause: SolanaError) => () => {
  throw new SolanaError(SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE, { cause } as never);
};
```

After `describe("submitSettlement (spec §5.5)", …)`, which is unchanged, append:

```ts
describe("sendAndConfirm (spec §5.5)", () => {
  let payer: Address;
  const ctx = (rpc: Rpc<SolanaRpcApi>) => ({ rpc, network: NETWORK, confirmTimeoutMs: 300, readRetry: { attempts: 1, delayMs: 0 } });
  const signed = (): SignedSettlement => ({ type: "open", wire: "AQ==", signature: SIGNATURE, blockhash: BLOCKHASH, payer, amount: "30000" });

  beforeAll(async () => {
    payer = (await generateKeyPairSigner()).address;
  });

  it("waits for the outcome when sending gets no answer, since the node may have taken the transaction", async () => {
    const lost = () => {
      throw new TypeError("fetch failed");
    };
    // It had taken it, and it lands.
    expect(await sendAndConfirm(ctx(fakeRpc({ send: lost, statuses: [confirmed], transactions: [() => null] }).rpc), signed())).toMatchObject({
      kind: "settled",
      response: { success: true, amount: "30000" },
    });
    // It had not, and the blockhash expires: it can no longer land. The answer keeps why the send failed.
    const neverTaken = fakeRpc({ send: lost, statuses: [notLanded], transactions: [() => null], valid: [() => false] });
    expect(await sendAndConfirm(ctx(neverTaken.rpc), signed())).toMatchObject({
      kind: "settled",
      response: { errorReason: "blockhash_expired", errorMessage: "fetch failed" },
    });
    // Neither shows before the wait ends: still unknown, with the send's error.
    const undecided = fakeRpc({ send: lost, statuses: [notLanded], transactions: [() => null] });
    expect(await sendAndConfirm(ctx(undecided.rpc), signed())).toMatchObject({
      kind: "pending",
      response: { success: false, errorReason: "settlement_pending", errorMessage: "fetch failed", transaction: SIGNATURE, payer },
    });
  });

  it("does not take a JSON-RPC error other than those a node returns before forwarding for a refusal", async () => {
    const internal = () => {
      throw new SolanaError(SOLANA_ERROR__JSON_RPC__INTERNAL_ERROR, { __serverMessage: "internal error" } as never);
    };
    const { rpc } = fakeRpc({ send: internal, statuses: [notLanded], transactions: [() => null] });
    expect(await sendAndConfirm(ctx(rpc), signed())).toMatchObject({ kind: "pending", response: { errorReason: "settlement_pending" } });
  });

  it("is a refusal when the node refuses the first submission, and leaves the outcome open when it refuses one sent again", async () => {
    const refusing = { send: preflight(new SolanaError(SOLANA_ERROR__TRANSACTION_ERROR__BLOCKHASH_NOT_FOUND)), statuses: [notLanded], transactions: [() => null] };
    expect(await sendAndConfirm(ctx(fakeRpc(refusing).rpc), signed())).toMatchObject({
      kind: "refused",
      response: { success: false, errorReason: "simulation_failed" },
    });
    expect(await sendAndConfirm(ctx(fakeRpc(refusing).rpc), signed(), { resent: true })).toMatchObject({
      kind: "pending",
      response: { errorReason: "settlement_pending", transaction: SIGNATURE },
    });
  });

  it("reads the outcome by the transaction's ID when the node reports it already processed", async () => {
    const { rpc } = fakeRpc({ send: preflight(new SolanaError(SOLANA_ERROR__TRANSACTION_ERROR__ALREADY_PROCESSED)), statuses: [confirmed], transactions: [() => null] });
    expect(await sendAndConfirm(ctx(rpc), signed())).toEqual({
      kind: "settled",
      response: { success: true, transaction: SIGNATURE, network: NETWORK, payer, amount: "30000" },
    });
  });

  it("is final for a transaction that landed with an error, and for one whose blockhash expired before it landed", async () => {
    expect(await sendAndConfirm(ctx(fakeRpc({ statuses: [failed], transactions: [() => null] }).rpc), signed())).toMatchObject({
      kind: "settled",
      response: { errorReason: "simulation_failed" },
    });
    const expired = fakeRpc({ statuses: [notLanded], transactions: [() => null], valid: [() => false] });
    expect(await sendAndConfirm(ctx(expired.rpc), signed())).toMatchObject({ kind: "settled", response: { errorReason: "blockhash_expired" } });
  });
});

describe("resolveRecorded (spec §5.5: a recorded transaction whose outcome is not known)", () => {
  let payer: Address;
  const ctx = (rpc: Rpc<SolanaRpcApi>) => ({ rpc, network: NETWORK, confirmTimeoutMs: 300, readRetry: { attempts: 1, delayMs: 0 } });
  const signed = (): SignedSettlement => ({ type: "open", wire: "AQ==", signature: SIGNATURE, blockhash: BLOCKHASH, payer, amount: "30000" });

  beforeAll(async () => {
    payer = (await generateKeyPairSigner()).address;
  });

  it("answers a transaction that has landed, without sending it again, from the node's transaction history", async () => {
    const { rpc, reads } = fakeRpc({ statuses: [confirmed], transactions: [() => null] });
    expect(await resolveRecorded(ctx(rpc), signed())).toMatchObject({ kind: "settled", response: { success: true, amount: "30000" } });
    expect(reads.sent).toBe(0);
    // A record outlives the node's recent statuses of its transaction: the lookup searches the history too.
    expect(reads.history).toEqual([true]);
  });

  it("sends again a transaction that has not landed while its blockhash is still valid", async () => {
    const { rpc, reads } = fakeRpc({ statuses: [notLanded, confirmed], transactions: [() => null] });
    expect(await resolveRecorded(ctx(rpc), signed())).toMatchObject({ kind: "settled", response: { success: true } });
    expect(reads.sent).toBe(1);
  });

  it("answers blockhash_expired, without sending, once the blockhash has expired and a last look finds nothing", async () => {
    const { rpc, reads } = fakeRpc({ statuses: [notLanded], transactions: [() => null], valid: [() => false] });
    expect(await resolveRecorded(ctx(rpc), signed())).toMatchObject({ kind: "settled", response: { errorReason: "blockhash_expired" } });
    expect(reads).toMatchObject({ statuses: 2, sent: 0 });
  });

  it("answers the transaction that shows at the last look, after its blockhash expired, from the history too", async () => {
    const { rpc, reads } = fakeRpc({ statuses: [notLanded, confirmed], transactions: [() => null], valid: [() => false] });
    expect(await resolveRecorded(ctx(rpc), signed())).toMatchObject({ kind: "settled", response: { success: true } });
    expect(reads.sent).toBe(0);
    expect(reads.history).toEqual([true, true]);
  });

  it("answers simulation_failed for a transaction that landed with an error", async () => {
    const { rpc } = fakeRpc({ statuses: [failed], transactions: [() => null] });
    expect(await resolveRecorded(ctx(rpc), signed())).toMatchObject({ kind: "settled", response: { errorReason: "simulation_failed" } });
  });

  it("leaves the outcome open, without sending, when the lookup cannot be read", async () => {
    const { rpc, reads } = fakeRpc({
      statuses: [
        () => {
          throw new Error("rpc down");
        },
      ],
      transactions: [() => null],
    });
    expect(await resolveRecorded(ctx(rpc), signed())).toMatchObject({ kind: "pending", response: { errorReason: "settlement_pending" } });
    expect(reads.sent).toBe(0);
  });
});
```

Run: `pnpm --filter @lxfoundry/stint-facilitator test settle.test.ts`
Expected: FAIL: `sendAndConfirm` and `resolveRecorded` are not exported. The six tests of `submitSettlement` are unchanged.

- [ ] **Step 3: Write the submission**

In `apps/facilitator/src/settle.ts`, replace the import from `@solana/kit` with:

```ts
import {
  SOLANA_ERROR__JSON_RPC__INVALID_PARAMS,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_MIN_CONTEXT_SLOT_NOT_REACHED,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_NODE_UNHEALTHY,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_TRANSACTION_PRECOMPILE_VERIFICATION_FAILURE,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_TRANSACTION_SIGNATURE_LEN_MISMATCH,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_TRANSACTION_SIGNATURE_VERIFICATION_FAILURE,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_UNSUPPORTED_TRANSACTION_VERSION,
  SOLANA_ERROR__TRANSACTION_ERROR__ALREADY_PROCESSED,
  blockhash,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getSignatureFromTransaction,
  getTransactionDecoder,
  isSolanaError,
  partiallySignTransaction,
  type Address,
  type Base64EncodedWireTransaction,
  type Signature,
  type Transaction,
} from "@solana/kit";
```

Add `readConfirmation` to the import from `@lxfoundry/stint-x402`. Then replace everything from `/** A verified
transaction, signed by every party, ready to submit. */` to the end of the file with:

```ts
/** A verified transaction, signed by every party, ready to submit. */
export interface SignedSettlement {
  readonly type: "open" | "topUp" | "close";
  /** The fully signed transaction, base64. */
  readonly wire: string;
  /** Its ID: the fee payer's signature. */
  readonly signature: string;
  readonly blockhash: string;
  /** The session authority. */
  readonly payer: Address;
  /** The amount an open or a top-up deposits; a close reports what its `Closed` event says it paid. */
  readonly amount: string;
}

/**
 * How a submission ended (spec §5.5). `settled` is final: the transaction is confirmed, landed with an error, or can no
 * longer land. `pending` leaves the outcome unknown. `refused` is a transaction that the node would not take at its first
 * submission, so the payload may come again.
 */
export type Submission =
  | { readonly kind: "settled"; readonly response: SettleResponse }
  | { readonly kind: "pending"; readonly response: SettleResponse }
  | { readonly kind: "refused"; readonly response: SettleResponse };

type SubmitContext = Pick<FacilitatorContext, "rpc" | "network" | "confirmTimeoutMs" | "readRetry">;

/**
 * The errors a node answers `sendTransaction` with before it forwards the transaction, which `@solana/kit` reports with
 * the JSON-RPC error's own code: a failed preflight, a signature that does not verify or has the wrong length, a
 * precompile that fails, an unsupported version, a context slot not reached, an unhealthy node, invalid parameters.
 */
const REFUSED_BEFORE_FORWARDING: ReadonlySet<number> = new Set([
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_TRANSACTION_SIGNATURE_VERIFICATION_FAILURE,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_TRANSACTION_SIGNATURE_LEN_MISMATCH,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_TRANSACTION_PRECOMPILE_VERIFICATION_FAILURE,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_UNSUPPORTED_TRANSACTION_VERSION,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_MIN_CONTEXT_SLOT_NOT_REACHED,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_NODE_UNHEALTHY,
  SOLANA_ERROR__JSON_RPC__INVALID_PARAMS,
]);

/**
 * A refusal by the node itself, which did not take the transaction. Any other failure of the request leaves open whether
 * it did: no answer in time, a connection that drops, an HTTP error, or another JSON-RPC error, which a proxy or a load
 * balancer can answer after it has forwarded the transaction.
 */
const refusedByNode = (error: unknown): boolean => isSolanaError(error) && REFUSED_BEFORE_FORWARDING.has(error.context.__code);

/** The node has processed this very message (S16), as the cause of a preflight failure or the error itself. */
function alreadyProcessed(error: unknown): boolean {
  // The chain is short; the bound keeps one that loops from running for ever.
  for (let depth = 0, current = error; current instanceof Error && depth < 10; depth++, current = current.cause) {
    if (isSolanaError(current, SOLANA_ERROR__TRANSACTION_ERROR__ALREADY_PROCESSED)) return true;
  }
  return false;
}

function failure(ctx: SubmitContext, signed: SignedSettlement, errorReason: string, errorMessage?: string): SettleResponse {
  return {
    success: false,
    errorReason,
    ...(errorMessage === undefined ? {} : { errorMessage }),
    transaction: signed.signature,
    network: ctx.network as Network,
    payer: signed.payer,
  };
}

/**
 * The answer for a confirmed transaction: an open's or a top-up's deposit; for a close, what this transaction paid the
 * receiver, `owed + redirected` from its `Closed` event, or no amount when the event cannot be read. Earlier claims are
 * the gate's to add (spec §5.5).
 */
async function confirmedResponse(ctx: SubmitContext, signed: SignedSettlement): Promise<SettleResponse> {
  const network = ctx.network as Network;
  const { signature, payer } = signed;
  if (signed.type !== "close") return { success: true, transaction: signature, network, payer, amount: signed.amount };
  const event = await readUntilFound(
    () => fetchClosedEvent(ctx.rpc, signature).catch(() => undefined),
    ctx.readRetry ?? DEFAULT_READ_RETRY,
  );
  if (!event) return { success: true, transaction: signature, network, payer };
  return { success: true, transaction: signature, network, payer, amount: (event.owed + event.redirected).toString() };
}

/**
 * Submits and waits for `confirmed` (spec §5.5). A node that refuses the transaction before forwarding it, at its first
 * submission, did not take it: `refused`. A refusal of a transaction sent again (`resent`) leaves the outcome unknown,
 * since its first submission may still land. A node that reports the message already processed has it, from an earlier
 * submission or from whoever sent these same bytes, and its outcome is read by its ID. After any other failure to send,
 * the node may have taken the transaction, so its outcome is waited for as for one it took. Only a status carrying an
 * error, or a blockhash that expired before the transaction landed, is a final failure; a wait that ends first leaves
 * the outcome unknown. A confirmed transaction is always a success, even when its `Closed` event cannot be read yet.
 */
export async function sendAndConfirm(
  ctx: SubmitContext,
  signed: SignedSettlement,
  options: { readonly resent?: boolean } = {},
): Promise<Submission> {
  let sendError: string | undefined;
  try {
    await ctx.rpc.sendTransaction(signed.wire as Base64EncodedWireTransaction, { encoding: "base64", preflightCommitment: "confirmed" }).send();
  } catch (error) {
    // Already processed (S16): its outcome is read by its ID, below.
    if (!alreadyProcessed(error)) {
      if (refusedByNode(error)) {
        if (options.resent) return { kind: "pending", response: failure(ctx, signed, "settlement_pending", message(error)) };
        return { kind: "refused", response: failure(ctx, signed, "simulation_failed", message(error)) };
      }
      // The node may have taken it: its outcome is waited for, below, as for one it took.
      sendError = message(error);
    }
  }

  try {
    const outcome = await waitForConfirmation(ctx.rpc, signed.signature, signed.blockhash, ctx.confirmTimeoutMs);
    if (outcome === "pending") return { kind: "pending", response: failure(ctx, signed, "settlement_pending", sendError) };
    if (outcome === "expired") return { kind: "settled", response: failure(ctx, signed, "blockhash_expired", sendError) };
  } catch (error) {
    if (error instanceof TransactionFailedError) return { kind: "settled", response: failure(ctx, signed, "simulation_failed", message(error)) };
    return { kind: "pending", response: failure(ctx, signed, "settlement_pending", message(error)) };
  }
  return { kind: "settled", response: await confirmedResponse(ctx, signed) };
}

/**
 * A recorded transaction whose outcome is not known (spec §5.5, "How a retry is answered"). It is looked up by its ID
 * first, in the node's transaction history as well as its recent statuses: a record outlives its blockhash by a margin,
 * and a node keeps recent statuses only for a while. One that has not landed is submitted again while its blockhash is
 * still valid, which S16 makes safe; once the blockhash has expired, one last look decides, since a transaction that
 * landed just before the expiry can show just after (spec §7.1). A lookup that cannot be read leaves the outcome unknown.
 */
export async function resolveRecorded(ctx: SubmitContext, signed: SignedSettlement): Promise<Submission> {
  const landed = () => readConfirmation(ctx.rpc, signed.signature, { searchTransactionHistory: true });
  try {
    if (await landed()) return { kind: "settled", response: await confirmedResponse(ctx, signed) };
    const { value: valid } = await ctx.rpc.isBlockhashValid(blockhash(signed.blockhash), { commitment: "confirmed" }).send();
    if (!valid) {
      if (await landed()) return { kind: "settled", response: await confirmedResponse(ctx, signed) };
      return { kind: "settled", response: failure(ctx, signed, "blockhash_expired") };
    }
  } catch (error) {
    if (error instanceof TransactionFailedError) return { kind: "settled", response: failure(ctx, signed, "simulation_failed", message(error)) };
    return { kind: "pending", response: failure(ctx, signed, "settlement_pending", message(error)) };
  }
  return sendAndConfirm(ctx, signed, { resent: true });
}

/** Submits and waits for `confirmed`, as `sendAndConfirm` does, and gives its answer: what the sponsored close uses. */
export async function submitSettlement(ctx: SubmitContext, signed: SignedSettlement): Promise<SettleResponse> {
  return (await sendAndConfirm(ctx, signed)).response;
}
```

Run: `pnpm --filter @lxfoundry/stint-facilitator test`
Expected: PASS: the six earlier tests of `settle.test.ts` included, and `close.test.ts` and `sweeper.test.ts` with the
refusals of Step 1. With their old plain `Error`, five of their tests would now fail: that error reads as a lost
answer, and their fake node then reports the transaction confirmed.

- [ ] **Step 4: Write the failing test of `already_processed` in a simulation**

In `apps/facilitator/test/verify.test.ts`, in `describe("an open", …)`, after the test "refuses a transaction whose
simulation fails, with the node's error", add:

```ts
    it("answers already_processed, which is not final, when the simulation reports this very message processed", async () => {
      await resetNode();
      node.simulation = { err: "AlreadyProcessed" };
      expect(await verifyPayment(ctx, await openPayload(), offer)).toMatchObject({ ok: false, reason: "already_processed" });
    });
```

Run: `pnpm --filter @lxfoundry/stint-facilitator test verify.test.ts`
Expected: FAIL: the reason is `simulation_failed`.

- [ ] **Step 5: Map it**

In `apps/facilitator/src/verify.ts`, in `simulate`, replace:

```ts
    if (programError(tx, value.err) === STINT_ERROR__SESSION_EXPIRED) return refuse("session_expired", message);
```

with:

```ts
    if (programError(tx, value.err) === STINT_ERROR__SESSION_EXPIRED) return refuse("session_expired", message);
    // The chain has processed this very message (S16): the payment may have landed, and this facilitator holds no record
    // of it, or it would not be verifying it (spec §5.5, "Already processed, with no record").
    if (value.err === "AlreadyProcessed") return refuse("already_processed", message);
```

Run: `pnpm --filter @lxfoundry/stint-facilitator test verify.test.ts`
Expected: PASS.

- [ ] **Step 6: Write the failing test of Kora's time limit**

In `apps/facilitator/test/kora.test.ts`, append inside `describe("createKoraClient errors", …)`:

```ts
  it("gives up a request that gets no answer within its time limit", async () => {
    vi.stubGlobal(
      "fetch",
      (_: unknown, init: RequestInit) => new Promise((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason))),
    );
    const error = await createKoraClient("http://localhost:8080", "k", 20).getPayerSigner().catch((e: Error) => e);
    expect((error as Error).message).toBe("Kora getPayerSigner: no answer within 20 ms");
  });
```

Run: `pnpm --filter @lxfoundry/stint-facilitator test kora.test.ts`
Expected: FAIL at once, with "Cannot read properties of undefined (reading 'addEventListener')": today's client passes
`fetch` no `signal`, so nothing could ever give the request up.

- [ ] **Step 7: Give Kora's requests a time limit**

In `apps/facilitator/src/kora.ts`, above the comment that starts `// Kora quotes the RPC URL it called in its errors`,
add:

```ts
/**
 * How long a request to Kora may go without an answer. A settlement waiting on Kora's signature holds its claim, and any
 * duplicate joins it (spec §5.5), so the wait must end.
 */
export const DEFAULT_KORA_TIMEOUT_MS = 15_000;

```

Then replace the line `export function createKoraClient(url: string, apiKey: string): KoraClient {` and the start of
`call`, up to and including `const text = await response.text();`, with:

```ts
export function createKoraClient(url: string, apiKey: string, timeoutMs = DEFAULT_KORA_TIMEOUT_MS): KoraClient {
  let id = 0;

  async function call<T>(method: string, params: Record<string, unknown>): Promise<T> {
    let response: Response;
    let text: string;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": apiKey },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      text = await response.text();
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") throw new Error(`Kora ${method}: no answer within ${timeoutMs} ms`, { cause: error });
      throw error;
    }
```

The rest of `call` (from `if (!response.ok && …`) is unchanged.

Run: `pnpm --filter @lxfoundry/stint-facilitator test && pnpm --filter @lxfoundry/stint-facilitator typecheck`
Expected: PASS, no type error.

- [ ] **Step 8: Commit**

```bash
git add apps/facilitator/src/settle.ts apps/facilitator/src/verify.ts apps/facilitator/src/kora.ts apps/facilitator/test/settle.test.ts apps/facilitator/test/verify.test.ts apps/facilitator/test/kora.test.ts apps/facilitator/test/close.test.ts apps/facilitator/test/sweeper.test.ts
git commit -m "Tell a node's refusal from a lost answer at submission, look recorded transactions up, and bound Kora's requests"
```

---

### Task 4: Settlement records on `/verify` and `/settle`

`/settle` follows the five steps of spec section 5.5: claim the message's hash, re-verify, the rent payer signs (an
open), Kora signs, then complete the record and submit. A payload whose message is claimed or recorded is a retry. With
the same API key and the same requirements (`retryRequirementsKey`), it is answered from its record: the recorded
outcome, or, when there is none yet, the lookup of Task 3. With other requirements or another API key it is refused
(`invalid_payment_requirements`): its transaction belongs to another settlement. Within one instance a duplicate in
flight joins the settlement already running, and is never claimed, verified or sent a second time. The claim is released
when steps 2 to 4 refuse the payload and when the node refuses the transaction at its first submission; in every other
case the record is kept.

`/verify` stays read-only. It answers a recorded payload from its record: valid while its settlement is pending or has
succeeded, and otherwise the recorded failure. A claim that holds no transaction yet has not been submitted, so its
payload is verified as any other is.

**Files:**
- Modify: `apps/facilitator/src/settle.ts`, `apps/facilitator/src/server.ts`, `apps/facilitator/src/index.ts`
- Create: `apps/facilitator/test/settlement.test.ts`
- Modify: `apps/facilitator/test/server.test.ts`, `apps/facilitator/test/sweeper-server.test.ts`
- Modify: `docs/specs/stint-system.md` (sections 5.4, 5.5, 6.1 and 13)

**Interfaces:**
- Consumes: `SettlementStore`, `SettlementRecord`, `createMemoryStore`, `createRecordPruner`,
  `DEFAULT_PRUNE_INTERVAL_MS` (Task 2); `sendAndConfirm`, `resolveRecorded`, `signAsFeePayer`, `SignedSettlement`
  (`apps/facilitator/src/settle.ts`); `verifyPayment` (`apps/facilitator/src/verify.ts`); `retryRequirementsKey`,
  `inspectTransaction`, `readElapsedPayload`, `refuse` (`@lxfoundry/stint-x402`).
- Produces, in `apps/facilitator/src/settle.ts`:
  - `type VerifyAnswer = { readonly ok: true; readonly payer: Address } | { readonly ok: false; readonly reason:
    InvalidReason; readonly message: string }`;
  - `interface Settlement { verify(payload: unknown, requirements: unknown, apiKey: string): Promise<VerifyAnswer>;
    settle(payload: unknown, requirements: unknown, apiKey: string): Promise<SettleResponse> }`, where `apiKey` is the
    SHA-256 of the API key the request came with, hex;
  - `createSettlement(ctx: FacilitatorContext, store: SettlementStore): Settlement`.
  - `settlePayment` is removed: `createSettlement` replaces it.
- Produces, on `FacilitatorConfig`: optional `settlementStore?: SettlementStore` (default `createMemoryStore()`) and
  `recordPruneIntervalMs?: number` (default `DEFAULT_PRUNE_INTERVAL_MS`).
- From `@lxfoundry/stint-facilitator`: `createSettlement`, `sendAndConfirm`, `resolveRecorded`, `submitSettlement`,
  `createMemoryStore`, `createRecordPruner`, and the types `Settlement`, `VerifyAnswer`, `SignedSettlement`, `Submission`,
  `SettlementRecord`, `SettlementStore`, `RecordPruner`.

- [ ] **Step 1: Write the failing tests**

Create `apps/facilitator/test/settlement.test.ts`:

```ts
import { AccountState, TOKEN_PROGRAM_ADDRESS, getTokenEncoder } from "@solana-program/token";
import {
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
  SOLANA_ERROR__TRANSACTION_ERROR__BLOCKHASH_NOT_FOUND,
  SolanaError,
  generateKeyPairSigner,
  getBase64Decoder,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getTransactionDecoder,
  none,
  partiallySignTransaction,
  type Address,
  type KeyPairSigner,
  type Rpc,
  type SolanaRpcApi,
} from "@solana/kit";
import { STINT_PROGRAM_ADDRESS, getSessionSize } from "@lxfoundry/stint-program-client";
import { associatedTokenAddress, buildOpenOffer, buildOpenTransaction, inspectTransaction, type ElapsedRequirements } from "@lxfoundry/stint-x402";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { KoraClient } from "../src/kora.js";
import { createMemoryStore, type SettlementStore } from "../src/records.js";
import { createSettlement, type Settlement } from "../src/settle.js";
import type { FacilitatorContext } from "../src/verify.js";

const NETWORK = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const BLOCKHASH = "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N";
const MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU" as Address;
/** Digests of two API keys, as the server passes them. */
const API_KEY = "a".repeat(64);
const OTHER_KEY = "b".repeat(64);
const CONFIRMED = { confirmationStatus: "confirmed", err: null };

/**
 * What the fake node does. Until a test says otherwise: the seller's token account exists, the blockhash is valid, the
 * simulation succeeds, and a transaction sent lands at once.
 */
interface Node {
  accounts: Map<string, { owner: Address; data: Uint8Array }>;
  blockhashValid: boolean;
  simulationErr: unknown;
  /** Runs on each `sendTransaction`; throws to fail it. */
  onSend: () => void;
  /** The status the node reports for any signature. */
  status: unknown;
  calls: { simulate: number; send: number };
}

function fakeRpc(node: Node): Rpc<SolanaRpcApi> {
  const call = (answer: () => unknown) => ({ send: async () => answer() });
  const rpc = {
    getAccountInfo: (target: string) =>
      call(() => {
        const account = node.accounts.get(target);
        if (!account) return { value: null };
        return {
          value: {
            data: [getBase64Decoder().decode(account.data), "base64"],
            executable: false,
            lamports: 1_000_000n,
            owner: account.owner,
            space: BigInt(account.data.length),
          },
        };
      }),
    getMinimumBalanceForRentExemption: (space: bigint) => call(() => (space === BigInt(getSessionSize()) ? 2_000_000n : 2_039_280n)),
    isBlockhashValid: () => call(() => ({ value: node.blockhashValid })),
    simulateTransaction: () =>
      call(() => {
        node.calls.simulate++;
        return { value: { err: node.simulationErr, logs: [], innerInstructions: [] } };
      }),
    sendTransaction: () =>
      call(() => {
        node.calls.send++;
        node.onSend();
        return "sent";
      }),
    getSignatureStatuses: () => call(() => ({ value: [node.status] })),
    getTransaction: () => call(() => null),
  };
  return rpc as unknown as Rpc<SolanaRpcApi>;
}

/** Signs as the fee payer, as Kora does, counting its signatures; while `hold` is set, it waits for it first. */
function fakeKora(feePayer: KeyPairSigner, state: { signed: number; hold?: Promise<void> }): KoraClient {
  return {
    getPayerSigner: async () => ({ signer_address: feePayer.address, payment_address: feePayer.address }),
    signTransaction: async (wire) => {
      state.signed++;
      await state.hold;
      const transaction = getTransactionDecoder().decode(getBase64Encoder().encode(wire));
      return getBase64EncodedWireTransaction(await partiallySignTransaction([feePayer.keyPair], transaction));
    },
  };
}

function tokenAccount(owner: Address): { owner: Address; data: Uint8Array } {
  const data = getTokenEncoder().encode({
    mint: MINT,
    owner,
    amount: 0n,
    delegate: none(),
    state: AccountState.Initialized,
    isNative: none(),
    delegatedAmount: 0n,
    closeAuthority: none(),
  });
  return { owner: TOKEN_PROGRAM_ADDRESS, data: Uint8Array.from(data) };
}

describe("settlement records on /verify and /settle (spec §5.5)", () => {
  let buyer: KeyPairSigner;
  let feePayer: KeyPairSigner;
  let rentPayer: KeyPairSigner;
  let offer: ElapsedRequirements;
  let node: Node;
  let kora: { signed: number; hold?: Promise<void> };
  let store: SettlementStore;
  let settlement: Settlement;

  beforeAll(async () => {
    buyer = await generateKeyPairSigner();
    feePayer = await generateKeyPairSigner();
    rentPayer = await generateKeyPairSigner();
    offer = buildOpenOffer({
      network: NETWORK,
      asset: MINT,
      payTo: (await generateKeyPairSigner()).address,
      receiverAuthorizer: (await generateKeyPairSigner()).address,
      terms: { rate: 1_000n, minSeconds: 5, maxSeconds: 120 },
      seconds: 30,
      facilitator: { feePayer: feePayer.address, rentPayer: rentPayer.address, programId: STINT_PROGRAM_ADDRESS, closeUrl: "http://127.0.0.1:4021/close" },
      lifetime: { blockhash: BLOCKHASH, lastValidBlockHeight: 1_234n },
      maxTimeoutSeconds: 60,
      idleCloseSeconds: 10,
      closeOnOutage: true,
    });
  });

  beforeEach(async () => {
    node = {
      accounts: new Map(),
      blockhashValid: true,
      simulationErr: null,
      onSend: () => void (node.status = CONFIRMED),
      status: null,
      calls: { simulate: 0, send: 0 },
    };
    node.accounts.set(await associatedTokenAddress(offer.payTo as Address, MINT), tokenAccount(offer.payTo as Address));
    kora = { signed: 0 };
    const ctx: FacilitatorContext = {
      rpc: fakeRpc(node),
      network: NETWORK,
      keys: { feePayer: feePayer.address, rentPayer: rentPayer.address },
      rentPayer,
      kora: fakeKora(feePayer, kora),
      confirmTimeoutMs: 300,
      readRetry: { attempts: 1, delayMs: 0 },
    };
    store = createMemoryStore();
    settlement = createSettlement(ctx, store);
  });

  async function openPayload() {
    const built = await buildOpenTransaction({ requirements: offer, authority: buyer, decimals: 6 });
    return { x402Version: 2, accepted: offer, payload: { type: "open", transaction: built.transaction, session: built.session } };
  }
  const hashOf = (payload: Awaited<ReturnType<typeof openPayload>>) => inspectTransaction(payload.payload.transaction)!.messageHash;
  const dropsAtOnce = () => void (node.status = CONFIRMED);
  /** A transaction the node takes, and that does not land. */
  const neverLands = () => {};

  it("settles an open once, records the outcome, and answers a retry from it: nothing verified, signed or sent again", async () => {
    const payload = await openPayload();
    const first = await settlement.settle(payload, offer, API_KEY);
    expect(first).toMatchObject({ success: true, payer: buyer.address, amount: "30000" });
    expect((await store.get(hashOf(payload)))?.outcome).toEqual(first);
    // What a replay meets on the chain: a fresh verification would refuse it.
    node.simulationErr = { InstructionError: [2, { Custom: 0 }] };

    expect(await settlement.settle(payload, offer, API_KEY)).toEqual(first);
    expect(await settlement.verify(payload, offer, API_KEY)).toEqual({ ok: true, payer: buyer.address });
    expect(node.calls).toEqual({ simulate: 1, send: 1 });
    expect(kora.signed).toBe(1);
  });

  it("answers a retry whose requirements differ from the record's in the advisory fields only", async () => {
    const payload = await openPayload();
    const first = await settlement.settle(payload, offer, API_KEY);
    const fresh = {
      ...offer,
      maxTimeoutSeconds: 30,
      extra: { ...offer.extra, recentBlockhash: "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi", lastValidBlockHeight: "9999" },
    };
    expect(await settlement.settle(payload, fresh, API_KEY)).toEqual(first);
    expect(await settlement.verify(payload, fresh, API_KEY)).toEqual({ ok: true, payer: buyer.address });
    expect(node.calls.simulate).toBe(1);
  });

  it("refuses a payload of a recorded settlement that comes with other requirements or another API key", async () => {
    const payload = await openPayload();
    await settlement.settle(payload, offer, API_KEY);
    const other = { ...offer, extra: { ...offer.extra, idleCloseSeconds: 11 } };
    for (const [requirements, apiKey] of [
      [other, API_KEY],
      [offer, OTHER_KEY],
    ] as const) {
      expect(await settlement.settle(payload, requirements, apiKey)).toMatchObject({
        success: false,
        errorReason: "invalid_payment_requirements",
        transaction: "",
      });
      expect(await settlement.verify(payload, requirements, apiKey)).toMatchObject({ ok: false, reason: "invalid_payment_requirements" });
    }
    expect(node.calls).toEqual({ simulate: 1, send: 1 });
  });

  it("lets two identical settlements sent at once share one: one verification, one signature, one submission", async () => {
    const payload = await openPayload();
    const [a, b] = await Promise.all([settlement.settle(payload, offer, API_KEY), settlement.settle(payload, offer, API_KEY)]);
    expect(a).toMatchObject({ success: true });
    expect(b).toEqual(a);
    expect(node.calls).toEqual({ simulate: 1, send: 1 });
    expect(kora.signed).toBe(1);
  });

  it("refuses a duplicate in flight that comes with another API key, and lets the first settle", async () => {
    const payload = await openPayload();
    const [a, b] = await Promise.all([settlement.settle(payload, offer, API_KEY), settlement.settle(payload, offer, OTHER_KEY)]);
    expect(a).toMatchObject({ success: true });
    expect(b).toMatchObject({ success: false, errorReason: "invalid_payment_requirements" });
    expect(node.calls.send).toBe(1);
  });

  it("releases the claim when verification refuses the payment, so that the payload is verified again when it comes back", async () => {
    const payload = await openPayload();
    node.simulationErr = { InstructionError: [1, { Custom: 1 }] }; // the buyer cannot pay yet
    expect(await settlement.settle(payload, offer, API_KEY)).toMatchObject({ success: false, errorReason: "simulation_failed" });
    expect(await store.get(hashOf(payload))).toBeUndefined();
    node.simulationErr = null;
    expect(await settlement.settle(payload, offer, API_KEY)).toMatchObject({ success: true });
    expect(node.calls).toEqual({ simulate: 2, send: 1 });
  });

  it("releases the claim when the node refuses the first submission: it did not take the transaction", async () => {
    const payload = await openPayload();
    node.onSend = () => {
      const cause = new SolanaError(SOLANA_ERROR__TRANSACTION_ERROR__BLOCKHASH_NOT_FOUND);
      throw new SolanaError(SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE, { cause } as never);
    };
    expect(await settlement.settle(payload, offer, API_KEY)).toMatchObject({ success: false, errorReason: "simulation_failed" });
    expect(await store.get(hashOf(payload))).toBeUndefined();
    node.onSend = dropsAtOnce;
    expect(await settlement.settle(payload, offer, API_KEY)).toMatchObject({ success: true });
    expect(node.calls).toEqual({ simulate: 2, send: 2 });
  });

  it("keeps the record when sending gets no answer, and a retry finds the transaction landed, without sending it again", async () => {
    const payload = await openPayload();
    node.onSend = () => {
      throw new TypeError("fetch failed");
    };
    const pending = await settlement.settle(payload, offer, API_KEY);
    expect(pending).toMatchObject({ success: false, errorReason: "settlement_pending" });
    expect(pending.transaction).not.toBe("");
    expect((await store.get(hashOf(payload)))?.signed?.signature).toBe(pending.transaction);
    expect((await store.get(hashOf(payload)))?.outcome).toBeUndefined();

    node.status = CONFIRMED; // it landed after all
    const settled = await settlement.settle(payload, offer, API_KEY);
    expect(settled).toMatchObject({ success: true, transaction: pending.transaction });
    expect((await store.get(hashOf(payload)))?.outcome).toEqual(settled);
    expect(node.calls).toEqual({ simulate: 1, send: 1 });
  });

  it("sends a recorded transaction again when it has not landed and its blockhash is still valid", async () => {
    const payload = await openPayload();
    node.onSend = neverLands;
    expect(await settlement.settle(payload, offer, API_KEY)).toMatchObject({ errorReason: "settlement_pending" });
    node.onSend = dropsAtOnce;
    expect(await settlement.settle(payload, offer, API_KEY)).toMatchObject({ success: true });
    expect(node.calls).toEqual({ simulate: 1, send: 2 });
    expect(kora.signed).toBe(1);
  });

  it("records blockhash_expired for a transaction that never landed, once its blockhash has expired, and /verify reports it", async () => {
    const payload = await openPayload();
    node.onSend = neverLands;
    await settlement.settle(payload, offer, API_KEY);
    node.blockhashValid = false;
    const expired = await settlement.settle(payload, offer, API_KEY);
    expect(expired).toMatchObject({ success: false, errorReason: "blockhash_expired" });
    expect((await store.get(hashOf(payload)))?.outcome).toEqual(expired);
    expect(await settlement.verify(payload, offer, API_KEY)).toMatchObject({ ok: false, reason: "blockhash_expired" });
    expect(node.calls).toEqual({ simulate: 1, send: 1 });
  });

  it("records simulation_failed for a transaction that landed with an error, and /verify reports it", async () => {
    const payload = await openPayload();
    node.onSend = neverLands;
    await settlement.settle(payload, offer, API_KEY);
    node.status = { confirmationStatus: "confirmed", err: { InstructionError: [2, { Custom: 6000 }] } };
    expect(await settlement.settle(payload, offer, API_KEY)).toMatchObject({ success: false, errorReason: "simulation_failed" });
    expect(await settlement.verify(payload, offer, API_KEY)).toMatchObject({ ok: false, reason: "simulation_failed" });
  });

  it("answers /verify valid while a recorded settlement is pending, without verifying it again", async () => {
    const payload = await openPayload();
    node.onSend = neverLands;
    await settlement.settle(payload, offer, API_KEY);
    expect(await settlement.verify(payload, offer, API_KEY)).toEqual({ ok: true, payer: buyer.address });
    expect(node.calls.simulate).toBe(1);
  });

  it("verifies on /verify a payload whose claim holds no transaction yet: it has not been submitted", async () => {
    const payload = await openPayload();
    let release!: () => void;
    kora.hold = new Promise<void>((resolve) => (release = resolve));
    const settling = settlement.settle(payload, offer, API_KEY);
    // Claimed and verified, and waiting on the fee payer's signature.
    await expect.poll(() => kora.signed).toBe(1);
    expect(await settlement.verify(payload, offer, API_KEY)).toEqual({ ok: true, payer: buyer.address });
    expect(node.calls.simulate).toBe(2);
    release();
    expect(await settling).toMatchObject({ success: true });
  });

  it("answers already_processed, and keeps no record, for a message the chain has processed and it holds no record of", async () => {
    const payload = await openPayload();
    node.simulationErr = "AlreadyProcessed";
    expect(await settlement.verify(payload, offer, API_KEY)).toMatchObject({ ok: false, reason: "already_processed" });
    expect(await settlement.settle(payload, offer, API_KEY)).toMatchObject({ success: false, errorReason: "already_processed" });
    expect(await store.list()).toEqual([]);
    expect(node.calls.send).toBe(0);
  });

  it("refuses a payload whose transaction does not decode, as verification does, and keeps no record", async () => {
    const payload = { x402Version: 2, accepted: offer, payload: { type: "open", transaction: "AQ==", session: "x" } };
    expect(await settlement.settle(payload, offer, API_KEY)).toMatchObject({ success: false, errorReason: "invalid_payload" });
    expect(await store.list()).toEqual([]);
  });

  it("claims and records nothing on /verify", async () => {
    const payload = await openPayload();
    expect(await settlement.verify(payload, offer, API_KEY)).toEqual({ ok: true, payer: buyer.address });
    expect(await store.list()).toEqual([]);
    expect(node.calls.send).toBe(0);
  });
});
```

Run: `pnpm --filter @lxfoundry/stint-facilitator test settlement.test.ts`
Expected: FAIL: `createSettlement` is not exported.

- [ ] **Step 2: Write the settlement**

In `apps/facilitator/src/settle.ts`, replace the import from `@lxfoundry/stint-x402` with (Task 3's `readConfirmation`
kept):

```ts
import {
  TransactionFailedError,
  fetchClosedEvent,
  inspectTransaction,
  readConfirmation,
  readElapsedPayload,
  readUntilFound,
  refuse,
  retryRequirementsKey,
  waitForConfirmation,
  type ElapsedRequirements,
  type InspectedTransaction,
  type InvalidReason,
  type Network,
  type RetryOptions,
  type SettleResponse,
} from "@lxfoundry/stint-x402";
import type { SettlementRecord, SettlementStore } from "./records.js";
import { verifyPayment, type FacilitatorContext } from "./verify.js";
```

(the earlier `import { verifyPayment, type FacilitatorContext } from "./verify.js";` line is replaced by the one above).
Then replace `settlePayment`, with its doc comment (from `/**` and ` * Spec §5.5, without settlement records (not yet
kept): re-verify, the rent payer signs` down to the function's closing brace), with:

```ts
/** What `/verify` answers (spec §5.4): the session authority as the payer, or a refusal. */
export type VerifyAnswer =
  | { readonly ok: true; readonly payer: Address }
  | { readonly ok: false; readonly reason: InvalidReason; readonly message: string };

/** `/verify` and `/settle` for resource servers (spec §6.1), with the settlement records of spec §5.5. */
export interface Settlement {
  /** Read-only: a payload whose message is recorded is answered from its record. `apiKey` is the API key's SHA-256, hex. */
  verify(payload: unknown, requirements: unknown, apiKey: string): Promise<VerifyAnswer>;
  /** Settles a payload at most once: a retry is answered from its record. `apiKey` is the API key's SHA-256, hex. */
  settle(payload: unknown, requirements: unknown, apiKey: string): Promise<SettleResponse>;
}

/** Who a settlement came from: a retry repeats both (spec §5.5, "How a retry is answered"). */
interface Origin {
  readonly apiKey: string;
  readonly requirements: string;
}

const sameOrigin = (a: Origin, b: Origin) => a.apiKey === b.apiKey && a.requirements === b.requirements;

const OTHER_SETTLEMENT = refuse(
  "invalid_payment_requirements",
  "the transaction belongs to a settlement that came with other requirements or another API key",
);

/** The payload's transaction, if it decodes: what a retry is known by. */
function transactionOf(payload: unknown): InspectedTransaction | undefined {
  const elapsed = readElapsedPayload(payload);
  return elapsed && inspectTransaction(elapsed.transaction);
}

/** `/verify`'s answer from a completed record: valid while the settlement is pending or has succeeded (spec §5.5). */
function fromRecord(signed: SignedSettlement, outcome: SettleResponse | undefined): VerifyAnswer {
  if (!outcome || outcome.success) return { ok: true, payer: signed.payer };
  return refuse((outcome.errorReason ?? "simulation_failed") as InvalidReason, outcome.errorMessage ?? "the recorded settlement failed");
}

/**
 * `/verify` and `/settle` (spec §5.4, §5.5). A settlement claims its message's hash before anything else, re-verifies,
 * has the rent payer sign an open and Kora sign as fee payer, then records the signed transaction and submits it. Within
 * this instance, a duplicate in flight joins the settlement already running: it is registered before anything is
 * awaited, so two requests cannot both start one.
 */
export function createSettlement(ctx: FacilitatorContext, store: SettlementStore): Settlement {
  const network = ctx.network as Network;
  const inFlight = new Map<string, Origin & { readonly settling: Promise<SettleResponse> }>();

  const refusal = (check: { readonly reason: InvalidReason; readonly message: string }, payer?: Address): SettleResponse => ({
    success: false,
    errorReason: check.reason,
    errorMessage: check.message,
    transaction: "",
    network,
    ...(payer === undefined ? {} : { payer }),
  });

  /** Steps 2 to 4 of spec §5.5: re-verify; the rent payer signs an open, which creates accounts; Kora signs as fee payer. */
  async function verifyAndSign(
    payload: unknown,
    requirements: unknown,
  ): Promise<{ readonly ok: true; readonly value: SignedSettlement } | { readonly ok: false; readonly response: SettleResponse }> {
    const verified = await verifyPayment(ctx, payload, requirements);
    if (!verified.ok) return { ok: false, response: refusal(verified) };
    let transaction = verified.tx.transaction;
    if (verified.type === "open") transaction = await partiallySignTransaction([ctx.rentPayer.keyPair], transaction);
    const signed = await signAsFeePayer(ctx, transaction);
    if (!signed.ok) return { ok: false, response: refusal(refuse("simulation_failed", signed.errorMessage), verified.payer) };
    // Verification passed, so these are elapsed requirements.
    const amount = (requirements as ElapsedRequirements).amount;
    return {
      ok: true,
      value: { type: verified.type, wire: signed.wire, signature: signed.signature, blockhash: verified.tx.blockhash, payer: verified.payer, amount },
    };
  }

  /** A payload whose message is claimed or recorded (spec §5.5, "How a retry is answered"). */
  async function answerRetry(held: SettlementRecord, origin: Origin): Promise<SettleResponse> {
    if (!sameOrigin(held, origin)) return refusal(OTHER_SETTLEMENT);
    if (held.outcome) return held.outcome;
    // Claimed and not yet submitted, by another instance: only a store shared by instances holds such a claim here.
    if (!held.signed) return { success: false, errorReason: "settlement_pending", transaction: "", network };
    const submission = await resolveRecorded(ctx, held.signed);
    if (submission.kind === "settled") await store.put({ ...held, outcome: submission.response });
    return submission.response;
  }

  /** Spec §5.5, steps 1 to 5, for one message. */
  async function settleOnce(messageHash: string, origin: Origin, payload: unknown, requirements: unknown): Promise<SettleResponse> {
    const claim: SettlementRecord = { messageHash, ...origin };
    const held = await store.claim(claim);
    if (held) return answerRetry(held, origin);
    let kept = false;
    try {
      const signed = await verifyAndSign(payload, requirements);
      if (!signed.ok) return signed.response;
      // Step 5: the record holds the transaction before it is submitted, so that a retry finds it whatever happens next.
      await store.put({ ...claim, signed: signed.value });
      kept = true;
      const submission = await sendAndConfirm(ctx, signed.value);
      // The node did not take it: the payload may come again, and is then verified as new.
      if (submission.kind === "refused") kept = false;
      else if (submission.kind === "settled") await store.put({ ...claim, signed: signed.value, outcome: submission.response });
      return submission.response;
    } finally {
      if (!kept) await store.release(messageHash);
    }
  }

  return {
    async verify(payload, requirements, apiKey) {
      const tx = transactionOf(payload);
      const record = tx && (await store.get(tx.messageHash));
      if (record) {
        if (!sameOrigin(record, { apiKey, requirements: retryRequirementsKey(requirements) })) return OTHER_SETTLEMENT;
        // A claim that holds no transaction yet has not been submitted: it is verified as any payload is.
        if (record.signed) return fromRecord(record.signed, record.outcome);
      }
      const verified = await verifyPayment(ctx, payload, requirements);
      return verified.ok ? { ok: true, payer: verified.payer } : verified;
    },

    async settle(payload, requirements, apiKey) {
      const tx = transactionOf(payload);
      if (!tx) {
        // Nothing a retry is known by: verification refuses a payload whose transaction does not decode.
        const verified = await verifyPayment(ctx, payload, requirements);
        return refusal(verified.ok ? refuse("invalid_payload", "the transaction cannot be decoded") : verified);
      }
      const origin: Origin = { apiKey, requirements: retryRequirementsKey(requirements) };
      // No `await` between the lookup and the registration: a duplicate in flight joins this settlement.
      const running = inFlight.get(tx.messageHash);
      if (running) return sameOrigin(running, origin) ? running.settling : refusal(OTHER_SETTLEMENT);
      const settling = settleOnce(tx.messageHash, origin, payload, requirements);
      inFlight.set(tx.messageHash, { ...origin, settling });
      try {
        return await settling;
      } finally {
        inFlight.delete(tx.messageHash);
      }
    },
  };
}
```

Run: `pnpm --filter @lxfoundry/stint-facilitator test settlement.test.ts`
Expected: PASS. `server.ts` and `index.ts` still import `settlePayment`, so the package does not type-check until Step 4.

- [ ] **Step 3: Write the failing tests of the server's wiring**

Two things that only the server does: it hands the store the API key's SHA-256, never the key, and it runs the record
pruner on an interval that its `stop` clears. The sweeper's tests count the timers set at the sweeper's default of 30 s,
which is also the pruner's default, so their facilitators get a pruner interval of their own.

In `apps/facilitator/test/server.test.ts`, replace `import { generateKeyPairSync } from "node:crypto";` with
`import { createHash, generateKeyPairSync } from "node:crypto";`, `import { generateKeyPairSigner } from "@solana/kit";`
with `import { address, generateKeyPairSigner } from "@solana/kit";`, and
`import type { SupportedResponse } from "@lxfoundry/stint-x402";` with:

```ts
import { buildOpenOffer, buildOpenTransaction, type SupportedResponse } from "@lxfoundry/stint-x402";
import { createMemoryStore, type SettlementRecord, type SettlementStore } from "../src/records.js";
```

and append inside `describe("facilitator HTTP interface (spec §6.1)", …)`:

```ts
  it("hands the settlement store the API key's SHA-256, never the key", async () => {
    const claims: SettlementRecord[] = [];
    const memory = createMemoryStore();
    const store: SettlementStore = { ...memory, claim: async (record) => (claims.push(record), memory.claim(record)) };
    const keyed = await startFacilitator({
      rpcUrl: "http://127.0.0.1:9",
      network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
      kora: { url: kora.url, apiKey: "kora-key" },
      rentPayerSecretKey: newSecretKey(),
      apiKeys: ["seller-key"],
      settlementStore: store,
    });
    try {
      const offer = buildOpenOffer({
        network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
        asset: address("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"),
        payTo: (await generateKeyPairSigner()).address,
        receiverAuthorizer: (await generateKeyPairSigner()).address,
        terms: { rate: 1_000n, minSeconds: 5, maxSeconds: 120 },
        seconds: 30,
        facilitator: { feePayer, rentPayer: keyed.rentPayer, programId: STINT_PROGRAM_ADDRESS, closeUrl: keyed.closeUrl },
        lifetime: { blockhash: "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N", lastValidBlockHeight: 1_234n },
        maxTimeoutSeconds: 60,
        idleCloseSeconds: 10,
        closeOnOutage: true,
      });
      const built = await buildOpenTransaction({ requirements: offer, authority: await generateKeyPairSigner(), decimals: 6 });
      const paymentPayload = { x402Version: 2, accepted: offer, payload: { type: "open", transaction: built.transaction, session: built.session } };
      // The node cannot be reached, so the settlement fails once it has claimed the message.
      const response = await fetch(`${keyed.url}/settle`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer seller-key" },
        body: JSON.stringify({ x402Version: 2, paymentPayload, paymentRequirements: offer }),
      });
      expect(response.status).toBe(500);
      expect(claims.map((claim) => claim.apiKey)).toEqual([createHash("sha256").update("seller-key", "utf8").digest("hex")]);
      // Released when the settlement failed, before anything was submitted.
      expect(await store.list()).toEqual([]);
    } finally {
      await keyed.stop();
    }
  });
```

In `apps/facilitator/test/sweeper-server.test.ts`, after `const MINT = …`, add:

```ts
/** The record pruner's interval in these tests: kept off the sweeper's default of 30 s, which a test counts timers at. */
const PRUNE_INTERVAL_MS = 3_600_000;
```

in `launch`, after `sweeper,` in the object given to `startFacilitator`, add `recordPruneIntervalMs: PRUNE_INTERVAL_MS,`,
and append inside the file's `describe`:

```ts
  it("starts the record pruner at its interval, and clears it when it stops", async () => {
    const started = vi.spyOn(globalThis, "setInterval");
    const cleared = vi.spyOn(globalThis, "clearInterval");
    const facilitator = await launch((await node([])).url);
    const index = started.mock.calls.findIndex((call) => call[1] === PRUNE_INTERVAL_MS);
    expect(index).toBeGreaterThanOrEqual(0);
    await facilitator.stop();
    expect(cleared).toHaveBeenCalledWith(started.mock.results[index]!.value);
  });
```

Run: `pnpm --filter @lxfoundry/stint-facilitator test server.test.ts sweeper-server.test.ts`
Expected: FAIL: the two new tests (no claim reaches the store, which today's server does not take; no timer at
`PRUNE_INTERVAL_MS`). The other tests pass.

- [ ] **Step 4: Wire the settlement into the server**

In `apps/facilitator/src/server.ts`, replace:

```ts
import { settlePayment } from "./settle.js";
import { DEFAULT_SWEEP_INTERVAL_MS, createSweeper, type SweepReport, type SweeperConfig } from "./sweeper.js";
import { verifyPayment, type FacilitatorContext } from "./verify.js";
```

with:

```ts
import { DEFAULT_PRUNE_INTERVAL_MS, createMemoryStore, createRecordPruner, type SettlementStore } from "./records.js";
import { createSettlement } from "./settle.js";
import { DEFAULT_SWEEP_INTERVAL_MS, createSweeper, type SweepReport, type SweeperConfig } from "./sweeper.js";
import type { FacilitatorContext } from "./verify.js";
```

In `FacilitatorConfig`, after the `sweeper` member, add:

```ts
  /** Where settlement records live (spec §5.5, §6.5). Default: this process's memory, which a restart empties. */
  readonly settlementStore?: SettlementStore;
  /** Milliseconds between passes that drop the records whose transaction can no longer land (default 30,000). */
  readonly recordPruneIntervalMs?: number;
```

In `startFacilitator`, after `const sponsoredClose = createSponsoredCloser(ctx);`, add:

```ts
  const store = config.settlementStore ?? createMemoryStore();
  const settlement = createSettlement(ctx, store);
  const pruner = createRecordPruner(ctx, store);
  let pruning: ReturnType<typeof setInterval> | undefined;
```

In `handle`, replace the block from `const key = request.headers.authorization?.replace(/^Bearer /, "");` to the first
`return sendJson(response, 200, settled);` after it (the second one, further down, answers `POST /close`) with:

```ts
      const key = request.headers.authorization?.replace(/^Bearer /, "");
      if (!key || !isKnownKey(key, apiKeys)) return sendJson(response, 401, { error: "unauthorized" });
      // A record holds the key's digest, never the key (spec §5.5).
      const apiKey = digest(key).toString("hex");
      const body = await readJson(request);
      const { paymentPayload, paymentRequirements } = (body ?? {}) as Record<string, unknown>;
      if (path === "/verify") {
        const verified = await settlement.verify(paymentPayload, paymentRequirements, apiKey);
        log({ event: "verify", ok: verified.ok, ...(verified.ok ? {} : { reason: verified.reason }) });
        return sendJson(
          response,
          200,
          verified.ok
            ? { isValid: true, payer: verified.payer }
            : { isValid: false, invalidReason: verified.reason, invalidMessage: verified.message },
        );
      }
      const settled = await settlement.settle(paymentPayload, paymentRequirements, apiKey);
      log({ event: "settle", success: settled.success, reason: settled.errorReason, transaction: settled.transaction });
      return sendJson(response, 200, settled);
```

Replace:

```ts
  if (config.sweeper) sweeper.start(config.sweeper.intervalMs ?? DEFAULT_SWEEP_INTERVAL_MS);
```

with:

```ts
  if (config.sweeper) sweeper.start(config.sweeper.intervalMs ?? DEFAULT_SWEEP_INTERVAL_MS);
  pruning = setInterval(
    () => void pruner.pruneOnce().catch((error: unknown) => log({ event: "error", error: error instanceof Error ? error.message : String(error) })),
    config.recordPruneIntervalMs ?? DEFAULT_PRUNE_INTERVAL_MS,
  );
  pruning.unref();
```

and in `stop`, before `await sweeper.stop();`, add `clearInterval(pruning);`.

In `apps/facilitator/src/index.ts`, replace:

```ts
export { settlePayment, submitSettlement, type SignedSettlement } from "./settle.js";
```

with:

```ts
export {
  createSettlement,
  resolveRecorded,
  sendAndConfirm,
  submitSettlement,
  type Settlement,
  type SignedSettlement,
  type Submission,
  type VerifyAnswer,
} from "./settle.js";
export { createMemoryStore, createRecordPruner, type RecordPruner, type SettlementRecord, type SettlementStore } from "./records.js";
```

Run: `pnpm --filter @lxfoundry/stint-facilitator test && pnpm typecheck`
Expected: PASS, the two tests of Step 3 included, and no type error anywhere: nothing outside the facilitator imported
`settlePayment`.

- [ ] **Step 5: State the retry rules, the release rule, the sponsored close and the store in the spec**

In `docs/specs/stint-system.md`, section 5.5, in the list that describes the response, replace:

```markdown
- `settlement_pending` is a non-final `errorReason`, accompanied by a non-empty `transaction`.
```

with:

```markdown
- `settlement_pending` is a non-final `errorReason`, accompanied by a non-empty `transaction`. The one exception needs
  a store shared by instances: an instance that finds the message claimed by another, which has not recorded its
  transaction yet, has no transaction to give, and answers with an empty one.
```

In section 5.4, replace:

```markdown
**A payload whose message this facilitator has claimed or recorded** (a retry: see Idempotency in
section 5.5) is not verified again. `/verify` answers from its record.
```

with:

```markdown
**A payload whose message this facilitator has recorded** (a retry: see Idempotency in section 5.5) is not verified
again: `/verify` answers from its record. A message that is only claimed, its transaction not recorded yet, has not
been submitted, so its payload is verified as any other.
```

In section 5.5, "How a retry is answered", replace:

```markdown
- **How a retry is answered.** A payload whose message is claimed or recorded, and that comes with
  the same API key and the same requirements, is answered from that record. "The same
  requirements" leaves out the advisory fields that a fresh offer changes: `maxTimeoutSeconds`,
  `extra.recentBlockhash` and `extra.lastValidBlockHeight`. Every field the transaction is
  checked against must match. Nothing is verified, signed or
  submitted again: the message is the one being, or already, settled.
```

with:

```markdown
- **How a retry is answered.** A payload whose message is claimed or recorded, and that comes with
  the same API key and the same requirements, is a retry. "The same requirements" leaves out the
  advisory fields that a fresh offer changes: `maxTimeoutSeconds`, `extra.recentBlockhash` and
  `extra.lastValidBlockHeight`. Every field the transaction is checked against must match. Once its
  transaction is recorded, a retry is answered from that record: nothing is verified, signed or
  submitted again, since the message is the one being, or already, settled. A message that is only
  claimed, its transaction not recorded yet, has not been submitted: `/verify` verifies its payload
  as any other, and a `/settle` of it is a duplicate in flight (below).
```

and replace:

```markdown
  - `/settle` reports the recorded outcome, or `settlement_pending` while there is none yet. If
    the transaction was submitted but its outcome is not known, it first looks the transaction
    up by its ID. If the transaction has not landed and its blockhash is still valid, it submits
    the recorded transaction again, which S16 makes safe.
```

with:

```markdown
  - `/settle` reports the recorded outcome, or `settlement_pending` while there is none yet. A
    duplicate that reaches the instance settling its message, while that settlement runs, waits for
    it and gets its answer. If the transaction was submitted but its outcome is not known, it first
    looks the transaction up by its ID, in the node's transaction history as well as its recent
    statuses, since a record outlives them. If the transaction has not landed and its blockhash is
    still valid, it submits the recorded transaction again, which S16 makes safe.
```

In section 5.5, replace:

```markdown
If step 2, 3 or 4 refuses the payload, the claim is released.
```

with:

```markdown
If step 2, 3 or 4 refuses the payload, the claim is released. So is it when the node refuses the transaction at its
first submission with an error that a node returns before it forwards a transaction (a failed preflight, a signature
that does not verify, an unhealthy node, invalid parameters): it did not take the transaction.
A node that reports it already processed has it (S16): its outcome is read by its ID. After any other failure to
submit, such as a request with no answer or another error, which a proxy can return after forwarding, the node may have
taken the transaction: the facilitator waits for its outcome as for one it submitted, keeps the record, and answers
`settlement_pending` while the outcome is unknown.
```

In section 6.1, in the row of `POST /close`, replace:

```markdown
Verified as in section 5.4 (sponsored row) and settled as in section 5.5.
```

with:

```markdown
Verified as in section 5.4 (sponsored row) and submitted as in section 5.5, steps 4 and 5, without a settlement record: once a close of the session has landed, its account is gone, so the same close sent again is refused at verification (`unknown_session`), which the client reads as a closed session (section 9.3).
```

In section 13, after the line `- A shared hosted facilitator. The image makes it a deployment.`, add:

```markdown
- A store for settlement records that survives restarts and is shared by the facilitator's instances (section 6.5). The
  facilitator takes one through its interface; this repository has only the in-memory one, which a restart empties.
```

- [ ] **Step 6: Commit**

```bash
git add apps/facilitator/src/settle.ts apps/facilitator/src/server.ts apps/facilitator/src/index.ts apps/facilitator/test/settlement.test.ts apps/facilitator/test/server.test.ts apps/facilitator/test/sweeper-server.test.ts docs/specs/stint-system.md
git commit -m "Keep settlement records: answer retries from them, join duplicates in flight, and refuse other origins"
```

---

### Task 5: Settlement records on the local network

Task 4's unit tests use a fake node. This task runs the records against Surfpool and Kora (spec section 12.1: the
facilitator's layer), where a payment settled once cannot be verified as new: its open's accounts exist, so a second
verification would fail its simulation. A valid answer there can only come from the record.

**Files:**
- Modify: `e2e/test/facilitator.test.ts`

**Interfaces:**
- Consumes: the facilitator's `/verify` and `/settle` (Task 4), and the file's own helpers `call`, `openPayment`,
  `newBuyer`; `tokenBalanceChanges`, `fetchSession`.
- Produces: nothing new.

- [ ] **Step 1: Add the tests**

In `e2e/test/facilitator.test.ts`, inside `describe("facilitator on the local network, through Kora", …)`, after the test
"settles an open, with the rent payer funding the session inside the program (spec §14 Q2), then a close", add:

```ts
  /** The buyer's USDC at `confirmed`, in base units. */
  async function usdcOf(buyer: Buyer): Promise<string> {
    return (await stack.network.rpc.getTokenAccountBalance(buyer.usdcAccount, { commitment: "confirmed" }).send()).value.amount;
  }

  it("answers a payment it has settled from its record: the same answer, one transaction, the buyer charged once", async () => {
    const buyer = await newBuyer(stack.network.rpc, stack.keys.mintAuthority.signer, 100_000n);
    const { offer, payload, session } = await openPayment(buyer);
    const first = (await call("/settle", payload, offer)) as SettleResponse;
    expect(first).toMatchObject({ success: true, payer: buyer.signer.address, amount: "30000" });

    // The session exists now, so a verification of the payload as new would fail its simulation: the record answers.
    expect(await call("/verify", payload, offer)).toEqual({ isValid: true, payer: buyer.signer.address });
    expect(await call("/settle", payload, offer)).toEqual(first);

    const changes = await tokenBalanceChanges(stack.network.rpc, first.transaction);
    expect(changes.get(buyer.usdcAccount)).toBe(-30_000n);
    expect(await usdcOf(buyer)).toBe("70000");
    expect((await fetchSession(stack.network.rpc, session)).data.deposited).toBe(30_000n);
  });

  it("settles two identical payments sent at once with one transaction", async () => {
    const buyer = await newBuyer(stack.network.rpc, stack.keys.mintAuthority.signer, 100_000n);
    const { offer, payload } = await openPayment(buyer);
    const [a, b] = (await Promise.all([call("/settle", payload, offer), call("/settle", payload, offer)])) as SettleResponse[];
    expect(a).toMatchObject({ success: true });
    expect(b).toEqual(a);
    expect(await usdcOf(buyer)).toBe("70000");
  });

  it("refuses a payment it has settled when it comes back with other requirements", async () => {
    const buyer = await newBuyer(stack.network.rpc, stack.keys.mintAuthority.signer, 100_000n);
    const { offer, payload } = await openPayment(buyer);
    expect(await call("/settle", payload, offer)).toMatchObject({ success: true });
    // The same transaction, echoing the other requirements it now comes with: only the record can tell it apart.
    const other = { ...offer, extra: { ...offer.extra, idleCloseSeconds: 11 } };
    const again = { ...payload, accepted: other };
    expect(await call("/settle", again, other)).toMatchObject({ success: false, errorReason: "invalid_payment_requirements" });
    expect(await call("/verify", again, other)).toMatchObject({ isValid: false, invalidReason: "invalid_payment_requirements" });
    expect(await usdcOf(buyer)).toBe("70000");
  });
```

These sessions are left open; the stack's sweeper closes them once their paid time has run out, or the stack stops first.
The other cases that spec section 12.1 lists for this layer are covered by unit tests only: a retry with another API key
(the local stack has one API key; Task 4's `settlement.test.ts`, while its `server.test.ts` checks that the store
receives the key's digest) and a record's expiry (it takes a blockhash's lifetime plus a minute; Task 2's
`records.test.ts`).

Run: `pnpm --filter @lxfoundry/stint-e2e test facilitator.test.ts`
Expected: PASS, every test of the file. These run Task 4's records on the local network. On a tree without Task 4, the
first test fails at its `/verify` (`simulation_failed`), and the third gets `simulation_failed` instead of
`invalid_payment_requirements`, since the payload is verified as new. The second passes there too: the chain itself takes
two identical sends as one transaction (S16). That two settlements in flight share one verification, one signature and
one submission is shown by Task 4's `settlement.test.ts`.

- [ ] **Step 2: Commit**

```bash
git add e2e/test/facilitator.test.ts
git commit -m "Test settlement records on the local network: a retry, a duplicate in flight, other requirements"
```

---

### Task 6: The gate answers `already_processed` with `503`, and its facilitator client has a time limit

Spec section 7.1: when the facilitator answers `already_processed`, the payment may have landed without a record of it,
so the gate answers `503`, never `402`: a `402` tells the client that nothing was charged, and the client then frees the
amount in its budget. The answer to an open carries the session, which the client derived itself. The gate's watch of the
session address that the spec asks for next is not built here (see "What this stage builds, and what it leaves"). The
gate's requests to the facilitator get a time limit: a settlement whose answer never comes holds the buyer's request open
for ever.

**Files:**
- Modify: `packages/gate/src/gate.ts`, `packages/gate/src/facilitator.ts`
- Test: `packages/gate/test/gate.test.ts`, `packages/gate/test/top-up.test.ts`
- Create: `packages/gate/test/facilitator.test.ts`

**Interfaces:**
- Consumes: `verifyAnswer` and `settleAnswer` of the test harness (`packages/gate/test/harness.ts`).
- Produces:
  - the gate's open route answers `503 {error: "already_processed", session}` when the facilitator's verification or its
    settlement answers `already_processed`, the latter with the `PAYMENT-RESPONSE` header; the top-up route answers `503
    {error: "already_processed"}` the same way. Nothing is provisioned, and no timer is touched;
  - `createFacilitatorClient(url: string, apiKey: string, options?: { readonly timeoutMs?: number }): FacilitatorClient`,
    with `DEFAULT_FACILITATOR_TIMEOUT_MS = 60_000`; a request with no answer within the limit rejects with
    `Error("Facilitator <path>: no answer within <timeoutMs> ms")`, which the gate answers `502` as any failure of the
    facilitator.

- [ ] **Step 1: Write the failing tests of the `503`**

In `packages/gate/test/gate.test.ts`, add `decodePaymentResponseHeader` and `encodePaymentSignatureHeader` to the import
from `@lxfoundry/stint-x402`, and after the test "answers 402 with the facilitator's reason when verification fails, and
settles nothing", add:

```ts
  it("answers 503, not 402, when the facilitator's verification says the payment may have landed (already_processed)", async () => {
    h.verifyAnswer = { isValid: false, invalidReason: "already_processed" };
    const { session, status, body } = await open();
    expect(status).toBe(503);
    expect(body).toEqual({ error: "already_processed", session });
    expect(h.calls.settle).toHaveLength(0);
    expect(h.calls.provision).toHaveLength(0);
  });

  it("answers 503 with the payment response when the settlement answers already_processed, and provisions nothing", async () => {
    h.settleAnswer = () => ({ success: false, errorReason: "already_processed", transaction: "", network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" });
    const { session, payload } = await prepareOpen();
    const response = await fetch(`${h.url}/sessions?seconds=30`, {
      method: "POST",
      headers: { "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(payload) },
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "already_processed", session });
    expect(decodePaymentResponseHeader(response.headers.get("payment-response")!)).toMatchObject({ success: false, errorReason: "already_processed" });
    expect(h.calls.provision).toHaveLength(0);
  });
```

In `packages/gate/test/top-up.test.ts`, after the test "answers 404 for a session it does not track, for one whose account
is gone, and for an id that is not an address", add:

```ts
  it("answers 503, not 402, when the top-up's verification or settlement answers already_processed, and moves no timer", async () => {
    const { session } = await open();

    h.verifyAnswer = { isValid: false, invalidReason: "already_processed" };
    expect(await sendTopUp(session, await prepareTopUp(session))).toMatchObject({ status: 503, body: { error: "already_processed" } });
    expect(ofType("topUp")).toEqual([]);

    h.verifyAnswer = { isValid: true };
    h.settleAnswer = () => ({ success: false, errorReason: "already_processed", transaction: "", network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" });
    const unsettled = await sendTopUp(session, await prepareTopUp(session));
    expect(unsettled.status).toBe(503);
    expect(unsettled.body).toEqual({ error: "already_processed" });
    expect(unsettled.paymentResponse).not.toBeNull();
    // The end timer is still the one the open armed.
    expect(pendingDue(END_DUE)).toBeDefined();
  });
```

Run: `pnpm --filter @lxfoundry/stint-gate test gate.test.ts top-up.test.ts`
Expected: FAIL: the three new tests get `402`.

- [ ] **Step 2: Answer `503`**

In `packages/gate/src/gate.ts`, after `paymentRequired`, add:

```ts
  /**
   * The facilitator answered `already_processed` (spec §5.4): the chain has processed the payment's message and the
   * facilitator holds no record of it, so the payment may have landed. That is not a refusal: `503`, never `402`, which
   * would tell the client that nothing was charged (spec §7.1).
   */
  function mayHaveLanded(response: ServerResponse, body: Record<string, unknown> = {}, headers?: Record<string, string>): void {
    sendJson(response, 503, { error: "already_processed", ...body }, headers);
  }
```

In `open`, replace:

```ts
    if (!verified.isValid) return paymentRequired(response, durations, verified.invalidReason ?? "invalid_payload");
```

with:

```ts
    if (!verified.isValid) {
      if (verified.invalidReason === "already_processed") return mayHaveLanded(response, { session });
      return paymentRequired(response, durations, verified.invalidReason ?? "invalid_payload");
    }
```

and replace:

```ts
      return paymentRequired(response, durations, settled.errorReason ?? "simulation_failed");
```

with:

```ts
      if (settled.errorReason === "already_processed") return mayHaveLanded(response, { session }, paymentResponse);
      return paymentRequired(response, durations, settled.errorReason ?? "simulation_failed");
```

In `topUp`, replace:

```ts
    if (!verified.isValid) return refusal(verified.invalidReason ?? "invalid_payload");
```

with:

```ts
    if (!verified.isValid) {
      if (verified.invalidReason === "already_processed") return mayHaveLanded(response);
      return refusal(verified.invalidReason ?? "invalid_payload");
    }
```

and replace:

```ts
      return refusal(settled.errorReason ?? "simulation_failed");
```

with:

```ts
      if (settled.errorReason === "already_processed") return mayHaveLanded(response, {}, paymentResponse);
      return refusal(settled.errorReason ?? "simulation_failed");
```

Run: `pnpm --filter @lxfoundry/stint-gate test gate.test.ts top-up.test.ts`
Expected: PASS.

- [ ] **Step 3: Write the failing test of the facilitator client's time limit**

Create `packages/gate/test/facilitator.test.ts`:

```ts
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createFacilitatorClient } from "../src/index.js";

describe("the facilitator client", () => {
  const servers: Server[] = [];

  afterEach(async () => {
    for (const server of servers.splice(0)) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  /** A server that takes every request and answers none. */
  async function silent(): Promise<string> {
    const server = createServer(() => {});
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it("gives up a request that gets no answer within its time limit", async () => {
    const client = createFacilitatorClient(await silent(), "key", { timeoutMs: 50 });
    await expect(client.supported()).rejects.toThrow("Facilitator /supported: no answer within 50 ms");
  });
});
```

Run: `pnpm --filter @lxfoundry/stint-gate test facilitator.test.ts`
Expected: FAIL: the test times out (vitest's 5 s), or the options argument is a type error under `pnpm --filter
@lxfoundry/stint-gate typecheck`.

- [ ] **Step 4: Give the client a time limit**

Replace `packages/gate/src/facilitator.ts` with:

```ts
import type { PaymentPayload, PaymentRequirements, SettleResponse, SupportedResponse, VerifyResponse } from "@lxfoundry/stint-x402";

/** The facilitator's interface for resource servers (spec §6.1). */
export interface FacilitatorClient {
  supported(): Promise<SupportedResponse>;
  verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse>;
  settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse>;
}

/**
 * How long a request to the facilitator may go without an answer: longer than the facilitator waits for a settlement to
 * confirm before it answers `settlement_pending` (30 s by default).
 */
export const DEFAULT_FACILITATOR_TIMEOUT_MS = 60_000;

export function createFacilitatorClient(url: string, apiKey: string, options: { readonly timeoutMs?: number } = {}): FacilitatorClient {
  const timeoutMs = options.timeoutMs ?? DEFAULT_FACILITATOR_TIMEOUT_MS;
  async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    try {
      const response = await fetch(`${url}${path}`, {
        method,
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new Error(`Facilitator ${path}: HTTP ${response.status} ${await response.text()}`);
      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") throw new Error(`Facilitator ${path}: no answer within ${timeoutMs} ms`, { cause: error });
      throw error;
    }
  }
  return {
    supported: () => call("GET", "/supported"),
    verify: (paymentPayload, paymentRequirements) =>
      call("POST", "/verify", { x402Version: 2, paymentPayload, paymentRequirements }),
    settle: (paymentPayload, paymentRequirements) =>
      call("POST", "/settle", { x402Version: 2, paymentPayload, paymentRequirements }),
  };
}
```

Run: `pnpm --filter @lxfoundry/stint-gate test && pnpm --filter @lxfoundry/stint-gate typecheck`
Expected: PASS, no type error.

- [ ] **Step 5: Commit**

```bash
git add packages/gate/src/gate.ts packages/gate/src/facilitator.ts packages/gate/test/gate.test.ts packages/gate/test/top-up.test.ts packages/gate/test/facilitator.test.ts
git commit -m "Answer already_processed with 503 at the gate, and bound its requests to the facilitator"
```

---

### Task 7: The facilitator's `/verify` in a scenario's context, and payments a scenario builds itself

Scenarios 18 and 19 call the facilitator's `/verify` with an API key (spec section 12.2, "Facilitator API"); the `local`
and `devnet` targets already declare the capability, and now provide it. Scenarios 5, 13, 14, 17 and 18 send payments
that no client would build: a transaction built from other terms, an instruction appended after `stint.open`, an
`accepted` entry one byte off, `x402Version` 1, or the same payment twice. A new module builds them as the client
builds a payment, with the scenario's change, and sends them to the gate. Two helpers that scenario 4 has kept to itself
move to the shared helpers, since the new scenarios need them.

**Files:**
- Modify: `conformance/src/types.ts`, `conformance/src/helpers.ts`, `conformance/src/scenarios/04-top-up.ts`
- Create: `conformance/src/payments.ts`, `conformance/test/payments.test.ts`
- Modify: `conformance/test/helpers.test.ts`
- Modify: `e2e/src/targets/local.ts`, `e2e/src/targets/devnet.ts`, `e2e/test/local-target.test.ts`,
  `e2e/test/devnet-target.test.ts`

**Interfaces:**
- Consumes: `createFacilitatorClient` (`@lxfoundry/stint-gate`, Task 6); `buildOpenTransaction`, `inspectTransaction`,
  `readElapsedRequirements`, the header codecs and `HEADERS` (`@lxfoundry/stint-x402`); `StintError`
  (`@lxfoundry/stint-client`).
- Produces:
  - in `conformance/src/types.ts`: `interface FacilitatorApi { verify(payload: PaymentPayload, requirements:
    PaymentRequirements): Promise<VerifyResponse> }`, and optional `ScenarioContext.facilitator?: FacilitatorApi`, present
    with the `facilitatorApi` capability;
  - in `conformance/src/helpers.ts`: `refusalOf(attempt: Promise<unknown>): Promise<{ readonly status?: number; readonly
    reason?: unknown; readonly body?: unknown } | undefined>` (a `StintError`'s status, its body's `error` and its body;
    undefined if the call went through; any other error is thrown) and `usdcBalance(rpc: Rpc<SolanaRpcApi>, account:
    Address): Promise<bigint>`;
  - in `conformance/src/payments.ts`:
    - `openOffers(gateUrl: string, seconds?: number): Promise<{ readonly required: PaymentRequired; readonly offer:
      ElapsedRequirements }>`: the gate's 402, read from `PAYMENT-REQUIRED`, and its first open entry;
    - `openUrl(gateUrl: string, offer: ElapsedRequirements): string`: the open route for the entry's duration;
    - `interface OpenPaymentOptions { buildFrom?: ElapsedRequirements; append?: readonly Instruction[]; accepted?:
      PaymentRequirements; x402Version?: number }` (all `readonly`);
    - `interface OpenPayment { readonly payload: PaymentPayload; readonly header: string; readonly session: Address;
      readonly vault: Address }`;
    - `openPayment(buyer: Buyer, required: PaymentRequired, offer: ElapsedRequirements, options?: OpenPaymentOptions):
      Promise<OpenPayment>`;
    - `appendInstructions(wire: string, signer: KeyPairSigner, extra: readonly Instruction[]): Promise<string>`;
    - `interface GateAnswer { readonly status: number; readonly body: Record<string, unknown>; readonly paymentResponse?:
      SettleResponse }` and `sendPayment(url: string, header: string): Promise<GateAnswer>`;
    - `expectRefused(answer: GateAnswer, reason: string, what: string): void` (402 with `body.error === reason`);
    - `expectNoSession(context: ScenarioContext, payment: Pick<OpenPayment, "session" | "vault">, what: string):
      Promise<void>`.

- [ ] **Step 1: Write the failing tests of the helpers**

In `conformance/test/helpers.test.ts`, add `refusalOf` to the import from `../src/helpers.js`, add
`import { StintError } from "@lxfoundry/stint-client";`, and append:

```ts
describe("refusalOf", () => {
  it("gives a StintError's status, the error its body names, and its body", async () => {
    const body = { error: "invalid_duration", minSeconds: 5, maxSeconds: 120 };
    expect(await refusalOf(Promise.reject(new StintError("refused", 400, body)))).toEqual({ status: 400, reason: "invalid_duration", body });
  });

  it("is undefined for a call that went through, and throws any other error", async () => {
    expect(await refusalOf(Promise.resolve("opened"))).toBeUndefined();
    await expect(refusalOf(Promise.reject(new Error("network down")))).rejects.toThrow("network down");
  });
});
```

Create `conformance/test/payments.test.ts`:

```ts
import {
  address,
  generateKeyPairSigner,
  getPublicKeyFromAddress,
  verifySignature,
  type KeyPairSigner,
} from "@solana/kit";
import { STINT_PROGRAM_ADDRESS, parseOpenInstruction } from "@lxfoundry/stint-program-client";
import { buildOpenOffer, decodePaymentSignatureHeader, inspectTransaction, type PaymentRequired } from "@lxfoundry/stint-x402";
import { beforeAll, describe, expect, it } from "vitest";
import { appendInstructions, openPayment } from "../src/payments.js";
import type { Buyer } from "../src/types.js";

const MEMO = address("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

describe("payments a scenario builds itself", () => {
  let signer: KeyPairSigner;
  let buyer: Buyer;
  let rentPayer: string;
  let feePayer: string;
  const offer = () =>
    buildOpenOffer({
      network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
      asset: address("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"),
      payTo: address("9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin"),
      receiverAuthorizer: address("Hq8i9ZoCdUuY6bEcUd5V2nhZqGPAiyxS5fTuQUe3tGLL"),
      terms: { rate: 1_000n, minSeconds: 5, maxSeconds: 120 },
      seconds: 30,
      facilitator: { feePayer, rentPayer, programId: STINT_PROGRAM_ADDRESS, closeUrl: "http://127.0.0.1:4021/close" },
      lifetime: { blockhash: "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N", lastValidBlockHeight: 1_234n },
      maxTimeoutSeconds: 60,
      idleCloseSeconds: 10,
      closeOnOutage: true,
    });
  const required = (entry: ReturnType<typeof offer>): PaymentRequired => ({ x402Version: 2, resource: { url: "http://gate.test/sessions" }, accepts: [entry] });

  beforeAll(async () => {
    signer = await generateKeyPairSigner();
    buyer = { signer, usdcAccount: address("9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin") };
    rentPayer = (await generateKeyPairSigner()).address;
    feePayer = (await generateKeyPairSigner()).address;
  });

  it("builds the payment a client builds, for the entry exactly as received, in its header", async () => {
    const entry = offer();
    const payment = await openPayment(buyer, required(entry), entry);
    expect(payment.payload).toMatchObject({ x402Version: 2, resource: { url: "http://gate.test/sessions" }, payload: { type: "open", session: payment.session } });
    expect(payment.payload.accepted).toBe(entry);
    expect(decodePaymentSignatureHeader(payment.header)).toEqual(payment.payload);
  });

  it("applies a scenario's changes: another version, another accepted entry, a transaction built from other terms", async () => {
    const entry = offer();
    const changed = { ...entry, extra: { ...entry.extra, closeUrl: "http://127.0.0.1:4021/closx" } };
    expect((await openPayment(buyer, required(entry), entry, { x402Version: 1 })).payload.x402Version).toBe(1);
    expect((await openPayment(buyer, required(entry), entry, { accepted: changed })).payload.accepted).toBe(changed);

    const otherRate = { ...entry, extra: { ...entry.extra, rate: "1001" } };
    const payment = await openPayment(buyer, required(entry), entry, { buildFrom: otherRate });
    expect(payment.payload.accepted).toBe(entry);
    const tx = inspectTransaction(payment.payload.payload.transaction as string)!;
    expect(parseOpenInstruction(tx.instructions[2] as never).data.rate).toBe(1_001n);
  });

  it("appends instructions after stint.open and signs again as the buyer, leaving the other signers' slots empty", async () => {
    const entry = offer();
    const payment = await openPayment(buyer, required(entry), entry);
    const wire = await appendInstructions(payment.payload.payload.transaction as string, signer, [
      { programAddress: MEMO, data: new TextEncoder().encode("stint") },
    ]);
    const tx = inspectTransaction(wire)!;
    expect(tx.instructions.map((ix) => ix.programAddress).at(-1)).toBe(MEMO);
    expect(tx.instructions).toHaveLength(4);
    const signature = tx.transaction.signatures[signer.address]!;
    expect(await verifySignature(await getPublicKeyFromAddress(signer.address), signature, tx.transaction.messageBytes)).toBe(true);
    expect(tx.transaction.signatures[address(rentPayer)]).toBeNull();
    expect(tx.transaction.signatures[address(feePayer)]).toBeNull();
  });
});
```

Run: `pnpm --filter @lxfoundry/stint-conformance test helpers.test.ts payments.test.ts`
Expected: FAIL: `refusalOf` is not exported, and `../src/payments.js` does not exist.

- [ ] **Step 2: Move the helpers**

In `conformance/src/helpers.ts`, replace the first two lines:

```ts
import { SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM, isSolanaError, type Rpc, type SolanaRpcApi } from "@solana/kit";
import { createStintClient, type StintClient } from "@lxfoundry/stint-client";
```

with:

```ts
import { SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM, isSolanaError, type Address, type Rpc, type SolanaRpcApi } from "@solana/kit";
import { StintError, createStintClient, type StintClient } from "@lxfoundry/stint-client";
```

and append:

```ts
/**
 * How a call of the session client was refused: the `StintError`'s HTTP status, the `error` its body names, and its body;
 * undefined if the call went through. Any other error is thrown.
 */
export async function refusalOf(
  attempt: Promise<unknown>,
): Promise<{ readonly status?: number; readonly reason?: unknown; readonly body?: unknown } | undefined> {
  try {
    await attempt;
    return undefined;
  } catch (error) {
    if (!(error instanceof StintError)) throw error;
    return { status: error.status, reason: (error.body as { error?: unknown } | undefined)?.error, body: error.body };
  }
}

/** A token account's balance at `confirmed`, in base units. */
export async function usdcBalance(rpc: Rpc<SolanaRpcApi>, account: Address): Promise<bigint> {
  return BigInt((await rpc.getTokenAccountBalance(account, { commitment: "confirmed" }).send()).value.amount);
}
```

In `conformance/src/scenarios/04-top-up.ts`: delete the function `refusalOf` with its doc comment ("How a top-up was
refused: …"); remove `StintError` from the import from `@lxfoundry/stint-client`, keeping `type StintSession`; replace
`import { buyerClient, closePollMs, sessionSeconds } from "../helpers.js";` with
`import { buyerClient, closePollMs, refusalOf, sessionSeconds, usdcBalance } from "../helpers.js";`; and replace:

```ts
  const usdcOf = async (account: Address) =>
    BigInt((await context.rpc.getTokenAccountBalance(account, { commitment: "confirmed" }).send()).value.amount);
```

with:

```ts
  const usdcOf = (account: Address) => usdcBalance(context.rpc, account);
```

Run: `pnpm --filter @lxfoundry/stint-conformance test helpers.test.ts`
Expected: PASS.

- [ ] **Step 3: Write the payments module**

Create `conformance/src/payments.ts`:

```ts
import {
  address,
  appendTransactionMessageInstructions,
  blockhash,
  createNoopSigner,
  createTransactionMessage,
  fetchEncodedAccount,
  getBase64EncodedWireTransaction,
  partiallySignTransactionMessageWithSigners,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Instruction,
  type KeyPairSigner,
} from "@solana/kit";
import {
  HEADERS,
  USDC_DEVNET,
  X402_VERSION,
  associatedTokenAddress,
  buildOpenTransaction,
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  encodePaymentSignatureHeader,
  inspectTransaction,
  readElapsedRequirements,
  type ElapsedRequirements,
  type PaymentPayload,
  type PaymentRequired,
  type PaymentRequirements,
  type SettleResponse,
} from "@lxfoundry/stint-x402";
import { expectEqual, expectTrue } from "./assert.js";
import type { Buyer, ScenarioContext } from "./types.js";

/** The gate's offers for an open, read from its 402 as a client reads them (spec §5.1), and the first open entry. */
export async function openOffers(
  gateUrl: string,
  seconds?: number,
): Promise<{ readonly required: PaymentRequired; readonly offer: ElapsedRequirements }> {
  const response = await fetch(`${gateUrl}/sessions${seconds === undefined ? "" : `?seconds=${seconds}`}`, { method: "POST" });
  await response.body?.cancel();
  expectEqual(response.status, 402, "the gate answers an open without a payment with 402");
  const header = response.headers.get(HEADERS.paymentRequired);
  expectTrue(header, "the 402 carries its offers in PAYMENT-REQUIRED");
  const required = decodePaymentRequiredHeader(header) as PaymentRequired;
  const offer = required.accepts.map(readElapsedRequirements).find((entry) => entry?.extra.action === "open");
  expectTrue(offer, "the 402 offers an elapsed open");
  return { required, offer };
}

/** The open route for the entry's duration, which the gate then offers alone (spec §5.2). */
export const openUrl = (gateUrl: string, offer: ElapsedRequirements) => `${gateUrl}/sessions?seconds=${offer.extra.seconds}`;

/** What a scenario changes in a payment that the client would build otherwise. */
export interface OpenPaymentOptions {
  /** What the transaction is built from, when it is not the offer: a payment that does not match the entry it accepts. */
  readonly buildFrom?: ElapsedRequirements;
  /** Instructions added after `stint.open`, outside the layout of spec §5.3. */
  readonly append?: readonly Instruction[];
  /** The `accepted` echo, when it is not the offer exactly as received. */
  readonly accepted?: PaymentRequirements;
  /** The payload's `x402Version`, when it is not 2. */
  readonly x402Version?: number;
}

export interface OpenPayment {
  readonly payload: PaymentPayload;
  /** The `PAYMENT-SIGNATURE` header that carries it. */
  readonly header: string;
  /** The session the transaction's `stint.open` creates, and its vault. */
  readonly session: Address;
  readonly vault: Address;
}

/**
 * `wire` with `extra` added after its instructions, signed again by `signer`: what a buyer that adds an instruction of its
 * own sends. The other signers' slots stay empty, as the facilitator's are in any payment.
 */
export async function appendInstructions(wire: string, signer: KeyPairSigner, extra: readonly Instruction[]): Promise<string> {
  const tx = inspectTransaction(wire);
  if (!tx) throw new Error("Not a version 0 transaction");
  // One signer object per address, as the scheme's builder has: the rent payer appears in two instructions.
  const noop = new Map<Address, ReturnType<typeof createNoopSigner>>();
  const signerFor = (account: Address) => {
    if (account === signer.address) return signer;
    let found = noop.get(account);
    if (!found) noop.set(account, (found = createNoopSigner(account)));
    return found;
  };
  const instructions = tx.instructions.map((instruction) => ({
    ...instruction,
    accounts: instruction.accounts?.map((meta) => (tx.signers.includes(meta.address) ? { ...meta, signer: signerFor(meta.address) } : meta)),
  }));
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(tx.feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: blockhash(tx.blockhash), lastValidBlockHeight: 0n }, m),
    (m) => appendTransactionMessageInstructions([...(instructions as Instruction[]), ...extra], m),
  );
  return getBase64EncodedWireTransaction(await partiallySignTransactionMessageWithSigners(message));
}

/**
 * A payment for an open, built and signed by `buyer` as the session client builds one (spec §5.3, §9.3), with the
 * scenario's changes. Without options it is exactly what the client sends for `offer`.
 */
export async function openPayment(
  buyer: Buyer,
  required: PaymentRequired,
  offer: ElapsedRequirements,
  options: OpenPaymentOptions = {},
): Promise<OpenPayment> {
  const from = options.buildFrom ?? offer;
  const built = await buildOpenTransaction({ requirements: from, authority: buyer.signer, decimals: USDC_DEVNET.decimals });
  const transaction = options.append ? await appendInstructions(built.transaction, buyer.signer, options.append) : built.transaction;
  const payload: PaymentPayload = {
    x402Version: options.x402Version ?? X402_VERSION,
    resource: required.resource,
    accepted: options.accepted ?? offer,
    payload: { type: "open", transaction, session: built.session },
  };
  return {
    payload,
    header: encodePaymentSignatureHeader(payload),
    session: built.session,
    vault: await associatedTokenAddress(built.session, address(from.asset)),
  };
}

/** The gate's answer to a payment. */
export interface GateAnswer {
  readonly status: number;
  readonly body: Record<string, unknown>;
  /** The decoded `PAYMENT-RESPONSE` header, when the answer carries one. */
  readonly paymentResponse?: SettleResponse;
}

/** Sends a payment, in its `PAYMENT-SIGNATURE` header, to one of the gate's payment routes. */
export async function sendPayment(url: string, header: string): Promise<GateAnswer> {
  const response = await fetch(url, { method: "POST", headers: { [HEADERS.paymentSignature]: header } });
  const settled = response.headers.get(HEADERS.paymentResponse);
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
    ...(settled === null ? {} : { paymentResponse: decodePaymentResponseHeader(settled) }),
  };
}

/** Checks that the gate refused a payment with 402 and `reason` (spec §7.1, §11). */
export function expectRefused(answer: GateAnswer, reason: string, what: string): void {
  expectEqual(answer.status, 402, `${what}: refused with 402`);
  expectEqual(answer.body.error, reason, `${what}: refused as ${reason}`);
}

/** Checks that neither the session nor its vault exists: nothing of a refused, or merely verified, payment reached the chain. */
export async function expectNoSession(
  context: ScenarioContext,
  payment: Pick<OpenPayment, "session" | "vault">,
  what: string,
): Promise<void> {
  const [session, vault] = await Promise.all([
    fetchEncodedAccount(context.rpc, payment.session, { commitment: "confirmed" }),
    fetchEncodedAccount(context.rpc, payment.vault, { commitment: "confirmed" }),
  ]);
  expectTrue(!session.exists, `${what}: no session account on-chain`);
  expectTrue(!vault.exists, `${what}: no vault on-chain`);
}
```

Run: `pnpm --filter @lxfoundry/stint-conformance test && pnpm --filter @lxfoundry/stint-conformance typecheck`
Expected: PASS, no type error.

- [ ] **Step 4: Give a scenario's context the facilitator's `/verify`**

In `conformance/src/types.ts`, replace:

```ts
import type { RetryOptions } from "@lxfoundry/stint-x402";
```

with:

```ts
import type { PaymentPayload, PaymentRequirements, RetryOptions, VerifyResponse } from "@lxfoundry/stint-x402";
```

Above `export interface ScenarioContext`, add:

```ts
/** The facilitator's `/verify` for resource servers (spec §6.1), called with the target's API key. */
export interface FacilitatorApi {
  verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse>;
}
```

and inside `ScenarioContext`, after `direct?`:

```ts
  /**
   * The facilitator's `/verify`, with an API key (spec §12.2, "Facilitator API"): present on a target with the
   * `facilitatorApi` capability (scenarios 17, 18 and 19), absent otherwise.
   */
  readonly facilitator?: FacilitatorApi;
```

In `e2e/src/targets/local.ts`, add `import { createFacilitatorClient } from "@lxfoundry/stint-gate";` after the import of
`@lxfoundry/stint-facilitator`'s types. In `startLocalStack`, after `const direct = await directChainOf(chain);`, add:

```ts
    // The facilitator keeps its address when it restarts, so one client serves every context.
    const facilitatorApi = createFacilitatorClient(services.facilitator.url, services.facilitatorApiKey);
```

and in the object `context()` returns, after `direct,`, add `facilitator: facilitatorApi,`.

In `e2e/src/targets/devnet.ts`, add `import { createFacilitatorClient } from "@lxfoundry/stint-gate";` after
`import { associatedTokenAddress } from "@lxfoundry/stint-x402";`, and after the `catch` block that follows `services =
await startServices({ … })`, add:

```ts
  // The facilitator keeps its address when it restarts, so one client serves every context.
  const facilitatorApi = createFacilitatorClient(services.facilitator.url, services.facilitatorApiKey);
```

and in the object `context()` returns, after `direct,`, add `facilitator: facilitatorApi,`.

In `e2e/test/local-target.test.ts`, in the test "gives scenarios control of the gate and sessions opened straight on the
program", after `expect(stack.context().direct).toBe(context.direct);`, add:

```ts
    expect(stack.context().facilitator).toBe(context.facilitator);
    // The stack's API key is accepted: the payload is judged, not refused as unauthorised.
    expect(await context.facilitator!.verify({ x402Version: 1, accepted: {} as never, payload: {} }, {} as never)).toMatchObject({
      isValid: false,
      invalidReason: "invalid_x402_version",
    });
```

In `e2e/test/devnet-target.test.ts`, in the test "offers stack control and the facilitator's API, and no chain control",
add `expect(stack.context().facilitator).toBeDefined();`.

Run: `pnpm typecheck && pnpm --filter @lxfoundry/stint-e2e test local-target.test.ts`
Expected: no type error; PASS (the required scenarios still pass, scenario 4 with its moved helpers).

- [ ] **Step 5: Commit**

```bash
git add conformance/src/types.ts conformance/src/helpers.ts conformance/src/payments.ts conformance/src/scenarios/04-top-up.ts conformance/test/helpers.test.ts conformance/test/payments.test.ts e2e/src/targets/local.ts e2e/src/targets/devnet.ts e2e/test/local-target.test.ts e2e/test/devnet-target.test.ts
git commit -m "Give scenarios the facilitator's /verify and payments they build themselves"
```

---

### Task 8: Scenarios 5, 6 and 13: payments the gate refuses with their reason

Spec section 12.7:
- 5: "A payment with wrong terms; with a wrong amount; with a Memo instruction appended after `stint.open`, outside the
  layout of section 5.3 → `402` with the reason (`invalid_terms`; `invalid_amount`; `unexpected_instruction`); no
  session on-chain";
- 6: "Failed payment → `402`, and no session created";
- 13: "Payment whose `accepted` differs from the offer by one byte; `x402Version` 1 → refused
  (`invalid_payment_requirements`; `invalid_x402_version`); no session".

Each payment is the buyer's own, signed, and sent to the gate's open route; each buyer holds what the offer costs (one
base unit less in scenario 6, whose payment must fail at the chain). The refusals of 5 and 13 come from the facilitator's
static checks, the one of 6 from its simulation. These checks exist since stage 1, so the scenarios should pass at once.

**Files:**
- Create: `conformance/src/scenarios/05-payment-refusals.ts`, `conformance/src/scenarios/06-failed-payment.ts`,
  `conformance/src/scenarios/13-mismatched-payload.ts`
- Modify: `conformance/src/catalogue.ts`, `conformance/test/catalogue.test.ts`, `e2e/test/local-target.test.ts`

**Interfaces:**
- Consumes: `openOffers`, `openPayment`, `openUrl`, `sendPayment`, `expectRefused`, `expectNoSession`,
  `OpenPaymentOptions` (Task 7); `usdcBalance` (Task 7); `expectEqual` (`conformance/src/assert.ts`).
- Produces: `paymentRefusals`, `failedPayment` and `mismatchedPayload`, each `(context: ScenarioContext) =>
  Promise<void>`, from their scenario modules.

- [ ] **Step 1: Write the three scenarios**

Create `conformance/src/scenarios/05-payment-refusals.ts`:

```ts
import { address } from "@solana/kit";
import { expectNoSession, expectRefused, openOffers, openPayment, openUrl, sendPayment, type OpenPaymentOptions } from "../payments.js";
import type { ScenarioContext } from "../types.js";

/** The SPL Memo program: its instruction is outside the layout of an open (spec §5.3). */
const MEMO_PROGRAM_ADDRESS = address("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

/**
 * Scenario 5 (spec §12.7): three payments that do not match the offer they accept, each refused with 402 and its reason,
 * and none leaving a session on-chain. The first is built from another rate than the offer's, the second deposits one
 * base unit less than the offer's amount, and the third adds a Memo instruction after `stint.open`. The buyer holds what
 * the offer costs, so no refusal is for want of funds.
 */
export async function paymentRefusals(context: ScenarioContext): Promise<void> {
  const { required, offer } = await openOffers(context.gateUrl);
  const buyer = await context.newBuyer(BigInt(offer.amount));
  const cases: readonly { readonly reason: string; readonly what: string; readonly options: OpenPaymentOptions }[] = [
    {
      reason: "invalid_terms",
      what: "a payment built from another rate than the offer's",
      options: { buildFrom: { ...offer, extra: { ...offer.extra, rate: (BigInt(offer.extra.rate) + 1n).toString() } } },
    },
    {
      reason: "invalid_amount",
      what: "a payment that deposits one base unit less than the offer's amount",
      options: { buildFrom: { ...offer, amount: (BigInt(offer.amount) - 1n).toString() } },
    },
    {
      reason: "unexpected_instruction",
      what: "a payment with a Memo instruction after stint.open",
      options: { append: [{ programAddress: MEMO_PROGRAM_ADDRESS, data: new TextEncoder().encode("stint scenario 5") }] },
    },
  ];
  for (const { reason, what, options } of cases) {
    const payment = await openPayment(buyer, required, offer, options);
    expectRefused(await sendPayment(openUrl(context.gateUrl, offer), payment.header), reason, what);
    await expectNoSession(context, payment, what);
  }
}
```

Create `conformance/src/scenarios/06-failed-payment.ts`:

```ts
import { expectEqual } from "../assert.js";
import { usdcBalance } from "../helpers.js";
import { expectNoSession, expectRefused, openOffers, openPayment, openUrl, sendPayment } from "../payments.js";
import type { ScenarioContext } from "../types.js";

/**
 * Scenario 6 (spec §12.7): a payment that fails. The buyer pays an offer that its USDC cannot cover: every check before
 * the chain passes, and the funding transfer fails in the facilitator's simulation. The gate answers 402
 * (`simulation_failed`), no session exists, and the buyer's USDC is unchanged.
 */
export async function failedPayment(context: ScenarioContext): Promise<void> {
  const { required, offer } = await openOffers(context.gateUrl);
  const buyer = await context.newBuyer(BigInt(offer.amount) - 1n); // one base unit short of the offer
  const before = await usdcBalance(context.rpc, buyer.usdcAccount);
  const payment = await openPayment(buyer, required, offer);
  expectRefused(await sendPayment(openUrl(context.gateUrl, offer), payment.header), "simulation_failed", "a payment the buyer cannot cover");
  await expectNoSession(context, payment, "a payment the buyer cannot cover");
  expectEqual(await usdcBalance(context.rpc, buyer.usdcAccount), before, "the failed payment takes nothing from the buyer");
}
```

Create `conformance/src/scenarios/13-mismatched-payload.ts`:

```ts
import { expectNoSession, expectRefused, openOffers, openPayment, openUrl, sendPayment, type OpenPaymentOptions } from "../payments.js";
import type { ScenarioContext } from "../types.js";

/**
 * Scenario 13 (spec §12.7): a payment whose `accepted` entry differs from the offer by one byte, and one of `x402Version`
 * 1, each refused with 402 and its reason, and neither leaving a session on-chain. The byte is the last character of
 * `extra.closeUrl`, an ASCII field that a fresh offer does not change (spec §5.5); the transaction is the one the offer
 * itself calls for, so only the echo is wrong.
 */
export async function mismatchedPayload(context: ScenarioContext): Promise<void> {
  const { required, offer } = await openOffers(context.gateUrl);
  const buyer = await context.newBuyer(BigInt(offer.amount));
  const closeUrl = offer.extra.closeUrl;
  const oneByteOff = { ...offer, extra: { ...offer.extra, closeUrl: `${closeUrl.slice(0, -1)}${closeUrl.endsWith("x") ? "y" : "x"}` } };
  const cases: readonly { readonly reason: string; readonly what: string; readonly options: OpenPaymentOptions }[] = [
    { reason: "invalid_payment_requirements", what: "a payment whose accepted entry is one byte off the offer", options: { accepted: oneByteOff } },
    { reason: "invalid_x402_version", what: "a payment of x402Version 1", options: { x402Version: 1 } },
  ];
  for (const { reason, what, options } of cases) {
    const payment = await openPayment(buyer, required, offer, options);
    expectRefused(await sendPayment(openUrl(context.gateUrl, offer), payment.header), reason, what);
    await expectNoSession(context, payment, what);
  }
}
```

In `conformance/src/catalogue.ts`, add the imports in numeric order (after the import of scenario 4's module, and after
scenario 9's for scenario 13):

```ts
import { paymentRefusals } from "./scenarios/05-payment-refusals.js";
import { failedPayment } from "./scenarios/06-failed-payment.js";
import { mismatchedPayload } from "./scenarios/13-mismatched-payload.js";
```

and replace:

```ts
  pending(5, "Payment with wrong terms, a wrong amount, or a Memo instruction"),
  pending(6, "Failed payment"),
```

with:

```ts
  pending(5, "Payment with wrong terms, a wrong amount, or a Memo instruction", [], "shared", paymentRefusals),
  pending(6, "Failed payment", [], "shared", failedPayment),
```

and:

```ts
  pending(13, "Payment whose accepted differs by one byte; x402Version 1"),
```

with:

```ts
  pending(13, "Payment whose accepted differs by one byte; x402Version 1", [], "shared", mismatchedPayload),
```

Run: `pnpm --filter @lxfoundry/stint-conformance typecheck && pnpm e2e:local`
Expected: no type error. The report lists scenarios 5, 6 and 13 as `pending` with result `pass`, each flagged as passing
while pending; the run exits 0. If one fails, its error names the case and what was checked: a status other than `402`
for scenario 5 or 13 means the gate or the facilitator let the payment through, so read the facilitator's checks in
`packages/x402/src/checks.ts` and `apps/facilitator/src/verify.ts` for that case; a `simulation_failed` where scenario 5
expects another reason means a static check is missing, since the simulation runs last.

- [ ] **Step 2: Make them `required`**

In `conformance/src/catalogue.ts`, replace the three lines of Step 1 with:

```ts
  required(5, "Payment with wrong terms, a wrong amount, or a Memo instruction", paymentRefusals),
  required(6, "Failed payment", failedPayment),
```

and:

```ts
  required(13, "Payment whose accepted differs by one byte; x402Version 1", mismatchedPayload),
```

In `conformance/test/catalogue.test.ts` and in `e2e/test/local-target.test.ts`, add `5`, `6` and `13` to `REQUIRED`, in
numeric order. With stage 7 merged and nothing else, both read `const REQUIRED = [1, 2, 3, 4, 7, 9, 15, 16, 22, 24, 25,
26, 34];` and become `const REQUIRED = [1, 2, 3, 4, 5, 6, 7, 9, 13, 15, 16, 22, 24, 25, 26, 34];`. In the comment above
`REQUIRED` in `e2e/test/local-target.test.ts`, which gives each scenario's duration, add "5, 6 and 13 about 1 s each".

Run: `pnpm --filter @lxfoundry/stint-conformance test && pnpm e2e:local`
Expected: PASS; the report counts three more `required` scenarios than before this task, every one with result `pass`.

- [ ] **Step 3: Commit**

```bash
git add conformance/src/scenarios/05-payment-refusals.ts conformance/src/scenarios/06-failed-payment.ts conformance/src/scenarios/13-mismatched-payload.ts conformance/src/catalogue.ts conformance/test/catalogue.test.ts e2e/test/local-target.test.ts
git commit -m "Add scenarios 5, 6 and 13, payments refused with their reason, and make them required"
```

---

### Task 9: Scenario 14, the same payment sent twice

Spec section 12.7: "The same payment sent twice → the same session reported twice; one session on-chain; the second
answer changes nothing at the gate (its idle timer keeps running from the first)". The second payment is a retry: the
facilitator answers it from its record (Task 4), and the gate, which tracks the session already, answers `201` with the
session's state and touches no timer (spec section 7.3). Nobody connects, so the gate's idle timer closes the session
`idleCloseSeconds` after the first answer. A timer started again by the second answer could not fire before
`idleCloseSeconds` after the second payment was sent, so the scenario looks for the close only until then, on the wall
clock alone: a gate that restarts the timer fails it every time, however the chain's clock runs. The second payment is
sent 2 s before the first timer fires, which leaves the first timer's close `idleCloseSeconds - 2 s` (8 s with the
harness's 10 s) to be settled and found; the scenario looks every second, on any target, so that a network whose closes
take seconds to settle still fits.

**Files:**
- Create: `conformance/src/scenarios/14-same-payment-twice.ts`
- Modify: `conformance/src/catalogue.ts`, `conformance/test/catalogue.test.ts`, `e2e/test/local-target.test.ts`

**Interfaces:**
- Consumes: `openOffers`, `openPayment`, `openUrl`, `sendPayment` (Task 7); `usdcBalance` (helpers);
  `readOpenedSession`, `expectRefunded` (`conformance/src/sessions.ts`); `awaitClose` (`conformance/src/closes.ts`);
  `expectEqual`, `expectTrue`, `sleep`.
- Produces: `samePaymentTwice(context: ScenarioContext): Promise<void>`.

- [ ] **Step 1: Write the scenario, as `pending`**

Create `conformance/src/scenarios/14-same-payment-twice.ts`:

```ts
import { expectEqual, expectTrue, sleep } from "../assert.js";
import { awaitClose } from "../closes.js";
import { usdcBalance } from "../helpers.js";
import { openOffers, openPayment, openUrl, sendPayment } from "../payments.js";
import { expectRefunded, readOpenedSession } from "../sessions.js";
import type { ScenarioContext } from "../types.js";

/**
 * How long before the first idle timer fires the second payment is sent: long enough for the gate to answer it before
 * that timer's close lands, short enough to leave that close most of `idleCloseSeconds` to be found. It does not change
 * what the check catches: a timer started by the second answer cannot fire before `idleCloseSeconds` after it, whatever
 * this is.
 */
const SECOND_BEFORE_IDLE_MS = 2_000;
/** How often the scenario looks for the idle close: every second on any target, so that the close is found in its window. */
const CLOSE_POLL_MS = 1_000;

/**
 * Scenario 14 (spec §12.7): the same payment sent twice. Both answers report the one session, from the one transaction,
 * and the buyer is charged once. The second answer changes nothing at the gate (spec §7.3): nobody connects, so the idle
 * timer that the first open started closes the session `idleCloseSeconds` after the first answer, 2 s after the second
 * payment. A timer started again by the second answer could not fire before `idleCloseSeconds` after that payment was
 * sent: the close must be found before then.
 */
export async function samePaymentTwice(context: ScenarioContext): Promise<void> {
  const { required, offer } = await openOffers(context.gateUrl);
  const idleMs = offer.extra.idleCloseSeconds * 1_000;
  if (idleMs < 8_000) throw new Error("scenario 14 needs an offer whose idleCloseSeconds is at least 8 s, to tell one idle timer from two");
  const buyer = await context.newBuyer(BigInt(offer.amount));
  const before = await usdcBalance(context.rpc, buyer.usdcAccount);
  const payment = await openPayment(buyer, required, offer);
  const url = openUrl(context.gateUrl, offer);

  const first = await sendPayment(url, payment.header);
  const answeredAt = Date.now();
  expectEqual(first.status, 201, "the first payment opens the session");
  expectEqual(first.body.session, payment.session, "the first answer reports the payment's session");
  const stored = await readOpenedSession(context, payment.session);

  await sleep(Math.max(0, answeredAt + idleMs - SECOND_BEFORE_IDLE_MS - Date.now()));
  const secondSentAt = Date.now();
  const second = await sendPayment(url, payment.header);
  expectEqual(second.status, 201, "the same payment sent again is answered as the first");
  expectEqual(second.body.session, payment.session, "the second answer reports the same session");
  expectEqual(second.body.paidUntil, first.body.paidUntil, "the second answer reports the same paid_until");
  expectTrue(first.paymentResponse?.transaction, "the first answer names its transaction");
  expectEqual(second.paymentResponse?.transaction, first.paymentResponse.transaction, "both answers name the one transaction");
  expectEqual(await usdcBalance(context.rpc, buyer.usdcAccount), before - BigInt(offer.amount), "the buyer is charged once");

  // The earliest a timer started by the second answer could fire. A look that began before it and found the close after
  // it is not enough: the close must be found by then.
  const secondTimerMs = secondSentAt + idleMs;
  const found = await awaitClose(
    context.rpc,
    payment.session,
    context.readRetry,
    Math.max(0, secondTimerMs - Date.now()),
    "the session is closed by the idle timer of the first answer, before one started by the second could fire",
    CLOSE_POLL_MS,
  );
  expectTrue(Date.now() < secondTimerMs, "the close is found before a timer started by the second answer could fire");
  await expectRefunded(context, { signature: found.signature, session: payment.session, stored, buyer });
}
```

In `conformance/src/catalogue.ts`, add the import in numeric order (after scenario 13's):

```ts
import { samePaymentTwice } from "./scenarios/14-same-payment-twice.js";
```

and replace:

```ts
  pending(14, "The same payment sent twice"),
```

with:

```ts
  pending(14, "The same payment sent twice", [], "shared", samePaymentTwice),
```

Run: `pnpm --filter @lxfoundry/stint-conformance typecheck && pnpm e2e:local`
Expected: no type error. Scenario 14 is `pending` with result `pass`, flagged; the run exits 0. If it fails with "the
same payment sent again is answered as the first: expected 201, got 402", the facilitator verified the retry as new
(its simulation fails, the session's accounts existing): check that `/verify` and `/settle` go through
`createSettlement` (Task 4) with the same API key digest for both calls.

- [ ] **Step 2: Make it `required`**

In `conformance/src/catalogue.ts`, replace the line of Step 1 with:

```ts
  required(14, "The same payment sent twice", samePaymentTwice),
```

In `conformance/test/catalogue.test.ts` and in `e2e/test/local-target.test.ts`, add `14` to `REQUIRED`, in numeric order
(after Task 8: `const REQUIRED = [1, 2, 3, 4, 5, 6, 7, 9, 13, 14, 15, 16, 22, 24, 25, 26, 34];`), and in the comment
above `REQUIRED` in `e2e/test/local-target.test.ts`, add "14 about 12 s".

Run: `pnpm --filter @lxfoundry/stint-conformance test && pnpm e2e:local`
Expected: PASS; one more `required` scenario, every one `pass`.

- [ ] **Step 3: Commit**

```bash
git add conformance/src/scenarios/14-same-payment-twice.ts conformance/src/catalogue.ts conformance/test/catalogue.test.ts e2e/test/local-target.test.ts
git commit -m "Add scenario 14, the same payment sent twice and settled once, and make it required"
```

---

### Task 10: Scenarios 17 and 32: requests refused before anything is signed

Spec section 12.7:
- 17: "Top-up for an unknown session → `unknown_session`";
- 32: "A duration below `minSeconds`; above `maxSeconds`; a top-up that would take the session past `maxSeconds` → `400
  invalid_duration` each time; nothing signed, nothing on-chain".

Scenario 17 asks the gate to top up an address that holds no session, first without a payment and then with one: the
gate answers `404 unknown_session` before it looks at a payment (spec section 7.1). Where the target offers the
facilitator's API, the facilitator refuses that payment with `unknown_session` too (spec section 5.4). Scenario 32 goes
through the session client: a `400` comes before any offer, so the client never signs anything. Both pass with what
stages 1 to 5 built.

**Files:**
- Create: `conformance/src/scenarios/17-top-up-unknown-session.ts`, `conformance/src/scenarios/32-durations-out-of-bounds.ts`
- Modify: `conformance/src/catalogue.ts`, `conformance/test/catalogue.test.ts`, `e2e/test/local-target.test.ts`

**Interfaces:**
- Consumes: `openOffers`, `sendPayment` (Task 7); `buyerClient`, `refusalOf`, `sessionSeconds`, `usdcBalance` (helpers);
  `readOpenedSession`, `expectRefunded`; `buildTopUpTransaction`, `encodePaymentSignatureHeader`, `USDC_DEVNET`
  (`@lxfoundry/stint-x402`); `fetchMaybeSession` (`@lxfoundry/stint-program-client`).
- Produces: `topUpUnknownSession` and `durationsOutOfBounds`, each `(context: ScenarioContext) => Promise<void>`.

- [ ] **Step 1: Write the two scenarios**

Create `conformance/src/scenarios/17-top-up-unknown-session.ts`:

```ts
import { generateKeyPairSigner } from "@solana/kit";
import {
  USDC_DEVNET,
  buildTopUpTransaction,
  encodePaymentSignatureHeader,
  type ElapsedRequirements,
  type PaymentPayload,
} from "@lxfoundry/stint-x402";
import { expectEqual } from "../assert.js";
import { openOffers, sendPayment } from "../payments.js";
import type { ScenarioContext } from "../types.js";

/**
 * Scenario 17 (spec §12.7): a top-up for a session that does not exist. The gate answers `404 unknown_session`, without a
 * payment and with one: it looks at no payment for a session it does not track (spec §7.1). The payment is a top-up of
 * 5 s built from the gate's own offer, for an address that holds nothing. With the facilitator's API, the facilitator
 * refuses that payment as `unknown_session` too (spec §5.4). Nothing is funded: the payment is never settled.
 */
export async function topUpUnknownSession(context: ScenarioContext): Promise<void> {
  const noSession = (await generateKeyPairSigner()).address; // an address that holds no session
  const url = `${context.gateUrl}/sessions/${noSession}/top-up?seconds=5`;

  const asked = await fetch(url, { method: "POST" });
  expectEqual(asked.status, 404, "a top-up for an unknown session is answered 404");
  expectEqual(((await asked.json()) as { error?: unknown }).error, "unknown_session", "as unknown_session");

  const { offer } = await openOffers(context.gateUrl);
  const entry = {
    ...offer,
    amount: (BigInt(offer.extra.rate) * 5n).toString(),
    extra: { ...offer.extra, action: "topUp", session: noSession, seconds: 5 },
  } as ElapsedRequirements;
  const authority = await generateKeyPairSigner();
  const transaction = await buildTopUpTransaction({ requirements: entry, authority, decimals: USDC_DEVNET.decimals });
  const payload: PaymentPayload = { x402Version: 2, resource: { url }, accepted: entry, payload: { type: "topUp", transaction } };
  const paid = await sendPayment(url, encodePaymentSignatureHeader(payload));
  expectEqual(paid.status, 404, "a paid top-up for an unknown session is answered 404");
  expectEqual(paid.body.error, "unknown_session", "as unknown_session");

  if (context.facilitator) {
    const verified = await context.facilitator.verify(payload, entry);
    expectEqual(verified.isValid, false, "the facilitator refuses a top-up for an unknown session");
    expectEqual(verified.invalidReason, "unknown_session", "as unknown_session");
  }
}
```

Create `conformance/src/scenarios/32-durations-out-of-bounds.ts`:

```ts
import { fetchMaybeSession } from "@lxfoundry/stint-program-client";
import { expectEqual, expectTrue } from "../assert.js";
import { buyerClient, refusalOf, sessionSeconds, usdcBalance } from "../helpers.js";
import { openOffers } from "../payments.js";
import { expectRefunded, readOpenedSession } from "../sessions.js";
import type { ScenarioContext } from "../types.js";

/** Checks a refusal as spec §5.2 states it: `400 invalid_duration`, with the bounds in the body. */
function expectInvalidDuration(
  refusal: Awaited<ReturnType<typeof refusalOf>>,
  bounds: { readonly minSeconds: number; readonly maxSeconds: number },
  what: string,
): void {
  expectEqual(refusal?.status, 400, `${what}: refused with 400`);
  expectEqual(refusal?.reason, "invalid_duration", `${what}: refused as invalid_duration`);
  const body = refusal?.body as { minSeconds?: unknown; maxSeconds?: unknown } | undefined;
  expectEqual(body?.minSeconds, bounds.minSeconds, `${what}: the refusal states the shortest duration`);
  expectEqual(body?.maxSeconds, bounds.maxSeconds, `${what}: the refusal states the longest duration`);
}

/**
 * Scenario 32 (spec §12.7): an open below `minSeconds`, an open above `maxSeconds`, and a top-up that would take a session
 * past `maxSeconds` are each refused with `400 invalid_duration`, before any offer: the client signs nothing, and nothing
 * reaches the chain. The session the scenario opens for the top-up is then closed and refunded as in scenario 1.
 */
export async function durationsOutOfBounds(context: ScenarioContext): Promise<void> {
  const { offer } = await openOffers(context.gateUrl);
  const { minSeconds, maxSeconds } = offer.extra;
  const seconds = sessionSeconds(context.target, 20);
  const buyer = await context.newBuyer(BigInt(offer.extra.rate) * BigInt(seconds)); // the one session it opens
  const client = buyerClient(buyer);
  const before = await usdcBalance(context.rpc, buyer.usdcAccount);

  for (const [asked, what] of [
    [minSeconds - 1, "an open below minSeconds"],
    [maxSeconds + 1, "an open above maxSeconds"],
  ] as const) {
    expectInvalidDuration(await refusalOf(client.open(context.gateUrl, { seconds: asked })), { minSeconds, maxSeconds }, what);
  }
  expectEqual(await usdcBalance(context.rpc, buyer.usdcAccount), before, "the refused opens take nothing: the client signed nothing");
  expectEqual(client.remainingBudget(), 1_000_000n, "the refused opens lock nothing in the budget");

  const session = await client.open(context.gateUrl, { seconds });
  const stored = await readOpenedSession(context, session.id);
  // What maxSeconds leaves once the session's own seconds are counted (spec §5.2); one second more is out of bounds.
  const room = maxSeconds - seconds;
  expectInvalidDuration(await refusalOf(session.topUp({ seconds: room + 1 })), { minSeconds: 1, maxSeconds: room }, "a top-up past maxSeconds");
  const after = await fetchMaybeSession(context.rpc, session.id, { commitment: "confirmed" });
  expectTrue(after.exists, "the session is still open after the refused top-up");
  expectEqual(after.data.deposited, stored.deposited, "the refused top-up adds nothing to the deposit");
  expectEqual(client.remainingBudget(), 1_000_000n - stored.deposited, "the refused top-up locks nothing in the budget");

  const receipt = await session.close();
  await expectRefunded(context, { signature: receipt.transaction, session: session.id, stored, buyer, reported: receipt });
}
```

In `conformance/src/catalogue.ts`, add the imports in numeric order (after scenario 16's for 17, after scenario 26's for
32):

```ts
import { topUpUnknownSession } from "./scenarios/17-top-up-unknown-session.js";
import { durationsOutOfBounds } from "./scenarios/32-durations-out-of-bounds.js";
```

and replace:

```ts
  pending(17, "Top-up for an unknown session"),
```

with:

```ts
  pending(17, "Top-up for an unknown session", [], "shared", topUpUnknownSession),
```

and:

```ts
  pending(32, "Durations out of bounds"),
```

with:

```ts
  pending(32, "Durations out of bounds", [], "shared", durationsOutOfBounds),
```

Run: `pnpm --filter @lxfoundry/stint-conformance typecheck && pnpm e2e:local`
Expected: no type error. Scenarios 17 and 32 are `pending` with result `pass`, flagged; the run exits 0.

- [ ] **Step 2: Make them `required`**

In `conformance/src/catalogue.ts`, replace the two lines of Step 1 with:

```ts
  required(17, "Top-up for an unknown session", topUpUnknownSession),
```

and:

```ts
  required(32, "Durations out of bounds", durationsOutOfBounds),
```

In `conformance/test/catalogue.test.ts` and in `e2e/test/local-target.test.ts`, add `17` and `32` to `REQUIRED`, in
numeric order (after Task 9: `const REQUIRED = [1, 2, 3, 4, 5, 6, 7, 9, 13, 14, 15, 16, 17, 22, 24, 25, 26, 32, 34];`),
and in the comment above `REQUIRED` in `e2e/test/local-target.test.ts`, add "17 about 1 s, 32 about 3 s".

Run: `pnpm --filter @lxfoundry/stint-conformance test && pnpm e2e:local`
Expected: PASS; two more `required` scenarios, every one `pass`.

- [ ] **Step 3: Commit**

```bash
git add conformance/src/scenarios/17-top-up-unknown-session.ts conformance/src/scenarios/32-durations-out-of-bounds.ts conformance/src/catalogue.ts conformance/test/catalogue.test.ts e2e/test/local-target.test.ts
git commit -m "Add scenarios 17 and 32, requests refused before anything is signed, and make them required"
```

---

### Task 11: Scenarios 18 and 19: the facilitator's `/verify`

Spec section 12.7, both needing the facilitator's API (on `external`, only with `--facilitator` and
`--facilitator-key`):
- 18: "Fee payer or rent payer in a forbidden position → refused (`payer_misuse`)";
- 19: "`/verify` of a valid open → no change on-chain".

Scenario 18 builds two opens that put a facilitator key where spec section 5.3 forbids it: the fee payer as the funder of
the vault and the rent payer of `stint.open` (built from an offer that names the fee payer as rent payer), and the rent
payer as the session's receiver (built from an offer whose `payTo` is the rent payer). Each is sent to `/verify` against
the offer as the gate issued it, the requirements a resource server sends. Scenario 19 verifies a valid open and checks,
a few slots later, that neither the session nor its vault exists and that the buyer's USDC has not moved.

**Files:**
- Create: `conformance/src/scenarios/18-payer-misuse.ts`, `conformance/src/scenarios/19-verify-valid-open.ts`
- Modify: `conformance/src/catalogue.ts`, `conformance/test/catalogue.test.ts`, `e2e/test/local-target.test.ts`

**Interfaces:**
- Consumes: `ScenarioContext.facilitator` (Task 7); `openOffers`, `openPayment`, `expectNoSession` (Task 7);
  `usdcBalance`; `expectEqual`, `sleep`.
- Produces: `payerMisuse` and `verifyValidOpen`, each `(context: ScenarioContext) => Promise<void>`.

- [ ] **Step 1: Write the two scenarios**

Create `conformance/src/scenarios/18-payer-misuse.ts`:

```ts
import type { ElapsedRequirements } from "@lxfoundry/stint-x402";
import { expectEqual } from "../assert.js";
import { expectNoSession, openOffers, openPayment } from "../payments.js";
import type { ScenarioContext } from "../types.js";

/**
 * Scenario 18 (spec §12.7): the facilitator's keys where spec §5.3 forbids them, each refused by `/verify` as
 * `payer_misuse`, and neither leaving a session on-chain. The fee payer may be the fee payer only: here it also funds the
 * vault and is `stint.open`'s rent payer. The rent payer may fund the session's accounts, never be paid by one: here it is
 * the session's receiver. Each open is verified against the offer as the gate issued it.
 */
export async function payerMisuse(context: ScenarioContext): Promise<void> {
  const facilitator = context.facilitator;
  if (!facilitator) throw new Error("scenario 18 needs a target that provides the facilitator's API");
  const { required, offer } = await openOffers(context.gateUrl);
  const buyer = await context.newBuyer(BigInt(offer.amount));
  const cases: readonly { readonly what: string; readonly buildFrom: ElapsedRequirements }[] = [
    { what: "the fee payer as the vault's funder and the open's rent payer", buildFrom: { ...offer, extra: { ...offer.extra, rentPayer: offer.extra.feePayer } } },
    { what: "the rent payer as the session's receiver", buildFrom: { ...offer, payTo: offer.extra.rentPayer } },
  ];
  for (const { what, buildFrom } of cases) {
    const payment = await openPayment(buyer, required, offer, { buildFrom });
    const verified = await facilitator.verify(payment.payload, offer);
    expectEqual(verified.isValid, false, `${what}: refused`);
    expectEqual(verified.invalidReason, "payer_misuse", `${what}: refused as payer_misuse`);
    await expectNoSession(context, payment, what);
  }
}
```

Create `conformance/src/scenarios/19-verify-valid-open.ts`:

```ts
import { expectEqual, sleep } from "../assert.js";
import { usdcBalance } from "../helpers.js";
import { expectNoSession, openOffers, openPayment } from "../payments.js";
import type { ScenarioContext } from "../types.js";

/** How long the scenario waits after `/verify` before it reads the chain: several slots on any target. */
const AFTER_VERIFY_MS = 3_000;

/**
 * Scenario 19 (spec §12.7): `/verify` of a valid open changes nothing on-chain. The facilitator finds the open valid and
 * names the buyer as its payer; it simulates and never submits (spec §5.4), so a few slots later neither the session nor
 * its vault exists, and the buyer's USDC has not moved.
 */
export async function verifyValidOpen(context: ScenarioContext): Promise<void> {
  const facilitator = context.facilitator;
  if (!facilitator) throw new Error("scenario 19 needs a target that provides the facilitator's API");
  const { required, offer } = await openOffers(context.gateUrl);
  const buyer = await context.newBuyer(BigInt(offer.amount));
  const before = await usdcBalance(context.rpc, buyer.usdcAccount);
  const payment = await openPayment(buyer, required, offer);

  const verified = await facilitator.verify(payment.payload, offer);
  expectEqual(verified.isValid, true, "the facilitator finds the open valid");
  expectEqual(verified.payer, buyer.signer.address, "and names the buyer, the session's authority, as its payer");

  await sleep(AFTER_VERIFY_MS);
  await expectNoSession(context, payment, "after /verify");
  expectEqual(await usdcBalance(context.rpc, buyer.usdcAccount), before, "the buyer's USDC has not moved");
}
```

In `conformance/src/catalogue.ts`, add the imports in numeric order (after scenario 17's):

```ts
import { payerMisuse } from "./scenarios/18-payer-misuse.js";
import { verifyValidOpen } from "./scenarios/19-verify-valid-open.js";
```

and replace:

```ts
  pending(18, "Fee payer or rent payer in a forbidden position", ["facilitatorApi"]),
  pending(19, "/verify of a valid open", ["facilitatorApi"]),
```

with:

```ts
  pending(18, "Fee payer or rent payer in a forbidden position", ["facilitatorApi"], "shared", payerMisuse),
  pending(19, "/verify of a valid open", ["facilitatorApi"], "shared", verifyValidOpen),
```

Run: `pnpm --filter @lxfoundry/stint-conformance typecheck && pnpm e2e:local`
Expected: no type error. Scenarios 18 and 19 are `pending` with result `pass`, flagged; the run exits 0.

- [ ] **Step 2: Make them `required`**

In `conformance/src/catalogue.ts`, replace the two lines of Step 1 with:

```ts
  required(18, "Fee payer or rent payer in a forbidden position", payerMisuse, ["facilitatorApi"]),
  required(19, "/verify of a valid open", verifyValidOpen, ["facilitatorApi"]),
```

In `conformance/test/catalogue.test.ts` and in `e2e/test/local-target.test.ts`, add `18` and `19` to `REQUIRED`, in
numeric order (after Task 10: `const REQUIRED = [1, 2, 3, 4, 5, 6, 7, 9, 13, 14, 15, 16, 17, 18, 19, 22, 24, 25, 26, 32,
34];`), and in the comment above `REQUIRED` in `e2e/test/local-target.test.ts`, add "18 about 1 s, 19 about 4 s". The
test "states the needs of spec section 12.7" in `conformance/test/catalogue.test.ts` is unchanged: 18 and 19 keep
`["facilitatorApi"]`.

Run: `pnpm --filter @lxfoundry/stint-conformance test && pnpm e2e:local`
Expected: PASS; two more `required` scenarios, 21 in all, every one `pass`, and 13 pending (12 not applicable).

- [ ] **Step 3: Commit**

```bash
git add conformance/src/scenarios/18-payer-misuse.ts conformance/src/scenarios/19-verify-valid-open.ts conformance/src/catalogue.ts conformance/test/catalogue.test.ts e2e/test/local-target.test.ts
git commit -m "Add scenarios 18 and 19, the facilitator's /verify, and make them required"
```

---

### Task 12: The new scenarios on devnet

No program code changes in this stage, so the devnet program stays as it is; this task runs the new scenarios there. The
person runs the devnet commands, with their `.env.devnet`.

**Files:**
- Modify: `e2e/test/devnet-target.test.ts`
- Modify: `README.md`

- [ ] **Step 1: Run the new scenarios on the devnet target, against the local network**

In `e2e/test/devnet-target.test.ts`, in the test "passes the required scenarios with buyers funded from the funding key",
add `5`, `6`, `13`, `14`, `17`, `18`, `19` and `32` to the list `required`, in numeric order (with stage 7 merged:
`const required = [1, 2, 3, 4, 5, 6, 7, 9, 13, 14, 15, 16, 17, 18, 19, 22, 24, 25, 26, 32, 34];`), and raise the test's
limit by 60 s (from `540_000` to `600_000`, if stage 7 left it at `540_000`). The new buyers draw about 210,000 USDC base
units from the run's loan, within its cap; scenario 17 funds nothing.

Run: `pnpm --filter @lxfoundry/stint-e2e test devnet-target.test.ts`
Expected: PASS.

```bash
git add e2e/test/devnet-target.test.ts
git commit -m "Run the scenarios of payment refusals and settlement records on the devnet target, checked against a local network"
```

- [ ] **Step 2: Check that the program is unchanged**

Run: `git diff --stat main -- programs/`
Expected: no output: the program in this branch is the one deployed.

- [ ] **Step 3: The devnet runs (the person, in WSL)**

Run: `pnpm e2e:devnet funds`
Expected: `✓ Funded`. Otherwise fund the address it prints, as it says.

Run: `pnpm e2e:devnet`, then once more after it ends.
Expected, both times: exit 0, every `required` scenario `pass`, scenarios 5, 6, 13, 14, 17, 18, 19 and 32 among them.
Record each run's report (scenario, result, duration) and the funding key's lines before and after for the pull request.

If a run fails:

| Symptom | Likely cause | What to do |
|---|---|---|
| Scenario 14: "the same payment sent again is answered as the first: expected 201, got 503" | The facilitator answered `already_processed`: it lost its record of the first settlement, which happens only if it restarted between the two payments | Check the facilitator's log for a restart; rerun once |
| Scenario 14: "the session is closed by the idle timer of the first answer, before one started by the second could fire: not within …", or "the close is found before a timer started by the second answer could fire: not so" | The gate's idle close took more than about 8 s, from its timer to the scenario's finding it: its settlement through the facilitator was slow, or the provider's list of the session's signatures lagged | Rerun once. If it repeats, lower `SECOND_BEFORE_IDLE_MS` in `conformance/src/scenarios/14-same-payment-twice.ts` to `1_000`, which widens the window by 1 s without weakening the check, as long as the gate answers the second payment within that second; record the change and both runs in the pull request |
| Scenario 14: "the same payment sent again is answered as the first: expected 201, got 404" | The first timer's close had landed before the gate answered the second payment | Raise `SECOND_BEFORE_IDLE_MS` back to `3_000` and rerun; record it in the pull request |
| Scenario 19: "no session account on-chain" fails | A transaction was submitted for a `/verify`, which must never happen | Stop: this is a defect of the facilitator, not of devnet |
| Scenario 5, 6 or 13: `expected 402, got 502` | The gate's request to the facilitator failed (rate limits on the provider's endpoint) | Rerun once; if it repeats, record the error in the pull request and stop |

- [ ] **Step 4: Record the devnet scenarios in the README**

In `README.md`, section "Running the scenarios on devnet", add `5`, `6`, `13`, `14`, `17`, `18`, `19` and `32` to the
sentence that lists the scenarios passing on devnet (with stage 7 merged: `Scenarios 1, 2, 3, 4, 5, 6, 7, 9, 13, 14, 15,
16, 17, 18, 19, 22, 24, 25, 26, 32 and 34 pass on devnet.`).

In the section "Status", replace:

```markdown
which moves its end; a session whose paid time has run out cannot be extended. Thirteen of the 35 end-to-end
scenarios of the [specification](docs/specs/stint-system.md) (section 12.7) pass on a local network and on devnet,
and the run report lists the other 22 as pending. Not built yet: refusals of bad payments and
settlement records, the facilitator's rate limits, and resilience across restarts.
```

with:

```markdown
which moves its end; a session whose paid time has run out cannot be extended. The facilitator refuses a payment that
does not match its offer with its reason before anything is signed, and keeps a record of each settlement, so that a
payment sent twice is settled once and answered twice. Twenty-one of the 35 end-to-end scenarios of the
[specification](docs/specs/stint-system.md) (section 12.7) pass on a local network and on devnet, and the run report
lists the other 14 as pending. Not built yet: a store for settlement records that survives a restart of the
facilitator (it keeps them in memory), the gate's watch of a payment whose settlement is pending, the facilitator's
rate limits, and resilience across restarts.
```

(If the README's line breaks differ, replace the same sentences wherever they break, and rewrap the paragraph at the
width of the lines around it.)

```bash
git add README.md
git commit -m "Record the scenarios of payment refusals and settlement records that pass on devnet"
```

---

## Done when

- `pnpm typecheck`, `pnpm test` and `pnpm e2e:local` pass, locally in WSL and in continuous integration.
- Scenarios 5, 6, 13, 14, 17, 18, 19 and 32 are `required` and pass on `local` and on devnet, with every earlier
  required scenario.
- A payment that does not match its offer is refused with `402` and its reason, and leaves nothing on-chain; a
  duration out of bounds is refused with `400 invalid_duration` before anything is signed.
- A payment sent twice is settled once: the second answer comes from the facilitator's record, a duplicate in flight
  joins the first, and a retry with other requirements or another API key is refused. A transaction whose outcome is
  unknown is looked up by its ID before it is sent again, and its record is kept until its blockhash has expired, plus a
  margin.
- The gate answers `already_processed` with `503`, never `402`.
- The pull request's description records the devnet runs and any deviation from this plan.

## Spec edits made by this stage

Each states a fact the code relies on:
- §5.5, the response's `settlement_pending` (Task 4): its transaction is empty in one case, which needs a store shared
  by instances: a message claimed by another instance that has not recorded its transaction yet;
- §5.4, the retry sentence (Task 4): a recorded payload is answered from its record; one whose message is only claimed,
  with no transaction recorded yet, is verified as any other, since nothing has been submitted;
- §5.5, "How a retry is answered" (Task 4): a retry is answered from its record once the transaction is recorded; a
  message only claimed has not been submitted, so `/verify` verifies it and a `/settle` of it is a duplicate in flight,
  which waits for that settlement and gets its answer; the lookup of a recorded transaction searches the node's
  transaction history as well as its recent statuses;
- §5.5, after "If step 2, 3 or 4 refuses the payload, the claim is released." (Task 4): the claim is released as well
  when the node refuses the transaction at its first submission with an error it returns before forwarding; a node that
  reports it already processed has it, and its outcome is read by its ID; after any other failure to submit, the outcome
  is waited for, the record is kept, and the answer is `settlement_pending` while the outcome is unknown;
- §6.1, `POST /close` (Task 4): the sponsored close is submitted without a settlement record, since a close sent again
  after one has landed is refused at verification (`unknown_session`);
- §13 (Task 4): a store for settlement records that survives restarts and is shared by instances is not built; the
  facilitator takes one through its interface.

Not edited, on purpose: §7.1's watch of the session address after a `202` and after `already_processed`, and §9.3's
polling after paying, which the spec keeps for the system as it is meant to be; this stage builds neither (see "What
this stage builds, and what it leaves").
