# Stage 7, part 2: the client's fallback closes and the gate's account-closed drop — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or
> executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for
> tracking.

**Goal:** A session can be closed whatever part of the stack is down, and the gate learns of any close it did not send.
The gate drops the connections of a session that another party closed as soon as its subscription sees the account go:
`4410` if the close came before `paid_until`, `4402` from then on, read from the close's `Closed` event. The client
closes through the fallback chain of spec section 9.3: the gate's close (waiting for one the gate reports pending), then
the facilitator's sponsored close through the offer's `closeUrl`, then a close of its own on the chain when it has a
node and SOL; failing all three, it says that the session runs to the end of its paid time. Scenarios 7, 24 and 25 pass
on `local` and become `required`, and pass on devnet.

**Architecture:** Part 1's stack, with no change to the program or the facilitator. The scheme package takes over the
lookup of a session's close from the conformance library, so that the gate can use it; the gate's chain gains an
optional `lastClose`. The gate's subscription, which today acts only on a later `paid_until`, ends the session when the
account is gone or holds another session, after a close of the gate's own in flight has had its say. The client's
`session.close()` becomes the fallback chain, and its receipt says which step closed the session. The harness can stop
and start the facilitator, and give a buyer SOL.

**Tech Stack:** TypeScript 7.0.2, vitest 5.0.5, `@solana/kit` 8.5.0, `ws` 8.22.0, Surfpool 1.6.1, Kora 2.0.5.

**Spec:** `docs/specs/stint-system.md`, sections 4.3 (`close` and who may sign it), 4.4 (`Closed`), 6.1 (`GET /close`
and `POST /close`), 7.3 (the row "Account closed by another party"), 7.4 (close codes), 9.1 to 9.4 (the client's
options, `closeWaitSeconds`, the close fallback chain), 12.2 (stack control) and 12.7 (scenarios 7, 24 and 25).

## Global Constraints

- Platform: Linux x86-64; on Windows, everything runs inside WSL 2 (T1, T2). Run every command from the repository
  root, inside WSL. Do not rely on `/tmp` staying intact while a command runs: keep scratch files under the home
  directory or a git-ignored folder of the repository.
- **Devnet only.** No transaction from this repository's code or scripts reaches another network. Every script and the
  harness check devnet's genesis hash before they send anything.
- Transactions are version 0, without address lookup tables (spec section 3.5). Only classic SPL Token mints; the
  payment token is devnet USDC, `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`, 6 decimals (spec section 3.4).
- `u64` values on the wire are decimal strings; `u32` values are JSON numbers (spec section 5.1). Amounts are `bigint`
  in TypeScript, never `number`.
- **No secrets, ever, in any commit.** Keypair files are named by path in `.env`, and the devnet harness's seed is in
  `.env.devnet` (both git-ignored). Never print a key's contents or the seed; an RPC URL may carry an API key.
- **A client never signs a transaction supplied by a seller or a facilitator** (spec section 9.3). Every close the client
  sends, it builds itself from data, and it signs only as the session's authority; it is the fee payer only of a close
  it sends to the chain itself.
- The chain's clock decides every amount. Which close code the gate sends for a close it did not make comes from the
  `Closed` event's `at` and `paid_until`, and only when that event cannot be found from the gate's session clock (spec
  section 7.3).
- `GateChain`, `GateConfig`, `ClientOptions` and `Policy` gain no required member: tests build them from literals.
  `StackControl` gains two required members, and Task 7 updates every literal of it.
- Scenario statuses follow the ratchet of spec section 12.2: a scenario is made `required` in the commit where it first
  passes on `local`, and never goes back to `pending`.
- Test first: write the failing test, run it, implement, run it again, commit.
- Commit messages are neutral, technical and in the present tense.

## What this part builds, and what it leaves

Built: the lookup of a session's close in the scheme package, and `GateChain.lastClose`; the gate's handling of a
session that another party closed (spec section 7.3); the client's close fallback chain (spec section 9.3), with
`closeWaitSeconds` in the policy, an optional `rpc` and `requestTimeoutMs` in the client's options, and `via` on its
receipts; stack control of the facilitator and SOL for a buyer in the harness; scenarios 7, 24 and 25 on `local` and on
devnet.

Not built, and not to be built here:
- **The other uses of the client's `rpc`** (spec section 9.1): checking refunds on-chain after a close, and finding
  orphaned sessions at start-up. `store` and the sponsored recovery of sessions left open by a crash come with them
  (scenario 29). With an `rpc`, this part reads the session account, sends the client's own close, and looks up which of
  its own pending closes landed, nothing else.
- **A receipt for a session found already closed with no close of the client's own pending.** The client reports it
  (`StintError`, status `404`) and treats the session as closed; it does not look up who closed it.
- **The MCP server and the example agent take no `rpc`:** their clients stop at the sponsored close. A configuration
  variable for a node URL comes with the stage that needs it.
- **Closing on inactivity, on process exit or on a signal** (spec section 9.3, "It closes …"): the tools' `closeAll`
  stays the only automatic close.
- **The gate's resend of its own pending close** (spec section 7.3, the buyer's close row: "if the close's blockhash
  expires first, build and send the close again, once"). A pending close of the gate's own that lands is now seen
  through the subscription, which drops the connections; one that never lands is left as today.
- **Replacing a subscription that fails** (left by stage 5). Without a subscription, a session closed by another party
  is found by the end timer's re-read at `paid_until`, and its connections get `4402`, as today.
- **The isolation groups of spec section 12.2.** Scenarios 24 and 25 belong to the own-stack group but run on the run's
  common stack, as 26 and 34 do: they stop the common gate (and, for 25, the facilitator) and start them again at the
  end. That is safe only because the runner runs scenarios one after another.

## Before you start: what a person must prepare

Start from a clean tree on a branch of its own, from a `main` that holds part 1 of this stage (the sponsored close:
`packages/x402/src/close-url.ts`, the facilitator's `/close` routes, scenario 15 `required`) and this plan. Tasks 1 to 8
need nothing but the repository. Task 9 runs the devnet harness, with the person's `.env.devnet`
(`STINT_DEVNET_RPC_URL`, `STINT_DEVNET_SEED`, and `STINT_DEVNET_SCAN_RPC_URL` if the provider refuses
`getProgramAccounts`) and the funding key funded as `pnpm e2e:devnet funds` says. No other run of the devnet harness may
use the same seed at the same time: its start-up closes the open sessions of the seed's keys. This part changes no
program code, so the devnet deployment stays as it is.

Where another stage may have changed the same lines first (the `REQUIRED` lists, the devnet scenario lists, the
README), this plan states its edit as a rule, with the text as part 1 leaves it as the example.

---

### Task 1: The lookup of a session's close, in the scheme package and the gate's chain

The gate must find the close of a session it did not close (spec section 7.3). The conformance library already has that
lookup (`findClose`); the gate cannot depend on the conformance library, so the function moves to the scheme package,
which both use, and the gate's chain gains a method built on it.

**Files:**
- Modify: `packages/x402/src/chain.ts`
- Modify: `conformance/src/closes.ts`
- Modify: `packages/gate/src/chain.ts`
- Test: `packages/gate/test/chain.test.ts` (`conformance/test/closes.test.ts` keeps testing `findClose` through the
  re-export, unchanged)

**Interfaces:**
- Consumes: `fetchProgramInstructions` and `RetryOptions` (`packages/x402/src/chain.ts`), `findClosedEvent` and
  `ClosedEvent` (`@lxfoundry/stint-program-client`).
- Produces:
  - from `@lxfoundry/stint-x402`: `interface FoundClose { readonly signature: string; readonly event: ClosedEvent }` and
    `findClose(rpc: Rpc<SolanaRpcApi>, session: Address, retry?: RetryOptions, notCloses?: Set<string>):
    Promise<FoundClose | undefined>`, the same function and type the conformance library exported, which it now
    re-exports;
  - on `GateChain` (`@lxfoundry/stint-gate`): optional `lastClose?(session: Address): Promise<ClosedEvent | undefined>`,
    one look, each listed transaction read once; `createRpcChain` provides it.

- [ ] **Step 1: Write the failing tests**

In `packages/gate/test/chain.test.ts`, replace the first two import statements:

```ts
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
```

with:

```ts
import {
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
```

Then append to the end of the file:

```ts
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
    expect(fetched).toEqual([CLOSE, OPEN]); // one read each: the gate repeats the whole look
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @lxfoundry/stint-gate test chain.test.ts`
Expected: FAIL in the two new tests: `createRpcChain(...).lastClose is not a function`. Every other test passes.

- [ ] **Step 3: Move `findClose` into the scheme package**

In `packages/x402/src/chain.ts`, insert after the function `fetchClosedEvent`:

```ts
/** A session's close found on the chain: its signature, and the `Closed` event it emitted. */
export interface FoundClose {
  readonly signature: string;
  readonly event: ClosedEvent;
}

/** How many of an address's newest transactions `findClose` looks through. */
const CLOSE_LOOKBACK = 20;

/**
 * The close of a session (spec §7.3, "Account closed by another party"): the newest successful transaction that loaded the
 * session's address and emitted a `Closed` event for it. A failed close, and a later transfer of lamports to the closed
 * address (S12), can come after the close, so the newest entry alone is not enough. Undefined while there is none. A node
 * still lists an address's transactions once its account is gone.
 *
 * Each entry is a request for its transaction, so a caller that looks again passes the same `notCloses` set: a signature that
 * was read and holds no close of this session is added to it, and is not read again. One that could not be read (the node
 * does not return it yet) is not added, and is tried at the next look. Without `retry`, each transaction is read once.
 */
export async function findClose(
  rpc: Rpc<SolanaRpcApi>,
  session: Address,
  retry?: RetryOptions,
  notCloses: Set<string> = new Set(),
): Promise<FoundClose | undefined> {
  const entries = await rpc.getSignaturesForAddress(session, { commitment: "confirmed", limit: CLOSE_LOOKBACK }).send();
  for (const entry of entries) {
    if (entry.err !== null || notCloses.has(entry.signature)) continue;
    const instructions = await fetchProgramInstructions(rpc, entry.signature, retry);
    if (!instructions) continue;
    const event = findClosedEvent(instructions);
    if (event?.session === session) return { signature: entry.signature, event };
    notCloses.add(entry.signature);
  }
  return undefined;
}
```

Replace the whole of `conformance/src/closes.ts` with:

```ts
import type { Address, Rpc, SolanaRpcApi } from "@solana/kit";
import { findClose, type FoundClose, type RetryOptions } from "@lxfoundry/stint-x402";
import { sleep } from "./assert.js";

// The lookup itself lives in the scheme package, which the gate uses too (spec §7.3).
export { findClose, type FoundClose };

/**
 * Looks for the close every `pollMs` until it shows up, or throws, naming `what`, after `timeoutMs`. A transaction that held no
 * close is read once over all the looks, not once per look. A look that the node rejects (a public node's rate limit, say) counts
 * as no close yet and is repeated; if the last look before the deadline was rejected, the error it throws has that one as its cause.
 */
export async function awaitClose(
  rpc: Rpc<SolanaRpcApi>,
  session: Address,
  retry: RetryOptions,
  timeoutMs: number,
  what: string,
  pollMs = 1_000,
): Promise<FoundClose> {
  const deadline = Date.now() + timeoutMs;
  const notCloses = new Set<string>();
  let rejected: unknown;
  for (;;) {
    try {
      const found = await findClose(rpc, session, retry, notCloses);
      if (found) return found;
      rejected = undefined;
    } catch (error) {
      rejected = error;
    }
    if (Date.now() >= deadline) {
      throw new Error(`${what}: not within ${timeoutMs} ms`, rejected === undefined ? undefined : { cause: rejected });
    }
    await sleep(pollMs);
  }
}
```

- [ ] **Step 4: Give the gate's chain `lastClose`**

In `packages/gate/src/chain.ts`, replace:

```ts
import { fetchClosedEvent } from "@lxfoundry/stint-x402";
```

with:

```ts
import { fetchClosedEvent, findClose } from "@lxfoundry/stint-x402";
```

In the interface `GateChain`, insert after `closedEvent(signature: string): Promise<ClosedEvent | undefined>;`:

```ts
  /**
   * The `Closed` event of the newest successful close of the session at `session` (spec §7.3, "Account closed by another
   * party"), from the address's transactions at `confirmed`, which a node still lists once the account is gone. Undefined
   * while none shows. One look, each listed transaction read once: the gate repeats the look for about 2 s.
   * Optional: a gate whose chain cannot look a close up compares its session clock with the last `paid_until` it saw.
   */
  lastClose?(session: Address): Promise<ClosedEvent | undefined>;
```

In `createRpcChain`, replace:

```ts
    closedEvent: (signature) => fetchClosedEvent(rpc, signature),
  };
```

with:

```ts
    closedEvent: (signature) => fetchClosedEvent(rpc, signature),
    lastClose: async (session) => (await findClose(rpc, session))?.event,
  };
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @lxfoundry/stint-gate test chain.test.ts && pnpm --filter @lxfoundry/stint-conformance test closes.test.ts && pnpm typecheck`
Expected: PASS, every test of both files; no type error in the workspace (the e2e package's `close-lookup.test.ts`
imports `findClose` from the conformance library, which still exports it).

- [ ] **Step 6: Commit**

```bash
git add packages/x402/src/chain.ts conformance/src/closes.ts packages/gate/src/chain.ts packages/gate/test/chain.test.ts
git commit -m "Move the lookup of a session's close into the scheme package, and give the gate's chain a lastClose"
```

---

### Task 2: The gate drops the connections of a session that another party closed

Today the gate's subscription acts only on a later `paid_until`; an account that is gone, or that holds another
session, is left to the end timer, so the connections of a session the buyer closed on-chain, or through the
facilitator's sponsored close, are served until `paid_until` and then get `4402`. This task makes the subscription end
the session at once (spec section 7.3, "Account closed by another party").

The rules, in the order the gate applies them:
1. A close of the gate's own in flight decides first. It may be what closed the account: once confirmed, it ends the
   session with its own reason and code, as today. If it does not confirm (it fails, or its settlement is still
   pending), the rules below run.
2. Otherwise forwarding stops at once, both ways, as at the end of the paid time: the session is over on chain. From
   then on the gate answers a new connection, a close and a top-up of the session with `404`, and its end timer is
   disarmed: nothing is left to settle.
3. The gate looks the close up (`lastClose`), repeating the look for about 2 s while none shows: the node's list of an
   address's transactions can lag the account notification. The bound is its own, not `readRetry`'s, since the
   connections are already muted and the session clock can decide the code without the event.
4. It drops the connections, with no close, and ends the session (`teardown("closedElsewhere")`, unsubscribe): `4402`
   if the `Closed` event's `at` is at or after its `paid_until`, `4410` before. Without an event (the chain has no
   `lastClose`, the look fails, or none shows within the bound), `4402` if the session clock has reached the last
   `paid_until` the gate saw, `4410` before.
5. A second notification during the look joins it: one look, one end.

**Files:**
- Modify: `packages/gate/src/gate.ts`
- Modify: `packages/gate/test/harness.ts`
- Modify: `packages/gate/test/follow.test.ts`
- Modify: `docs/specs/stint-system.md` (section 7.3)

**Interfaces:**
- Consumes: `GateChain.lastClose` (Task 1); in the gate, `mute`, `disarm`, `end`, `startClose`, `readUntilFound`,
  `upstream`, `sameSession`, `readRetry` and `CLOSE_CODES`, all already there.
- Produces: no new export. The gate logs `{ event: "closed_elsewhere", session, found }` when it ends a session this way.
  `EndReason` already holds `"closedElsewhere"`.

- [ ] **Step 1: Give the test harness a close to find**

In `packages/gate/test/harness.ts`, in the interface `Harness`, replace:

```ts
  sessions: Map<Address, Session>;
```

with:

```ts
  sessions: Map<Address, Session>;
  /** The close `lastClose` finds for each session; a session absent here has no close showing. */
  closes: Map<Address, ClosedEvent>;
```

Replace:

```ts
  fail: { supported: boolean; settleClose: boolean; closedEvent: boolean; provision: boolean; teardown: boolean; watch: boolean };
  hold: { provision?: Promise<void>; settleClose?: Promise<void>; settleTopUp?: Promise<void>; readSession?: Promise<void> };
```

with:

```ts
  fail: { supported: boolean; settleClose: boolean; closedEvent: boolean; provision: boolean; teardown: boolean; watch: boolean; lastClose: boolean };
  hold: { provision?: Promise<void>; settleClose?: Promise<void>; settleTopUp?: Promise<void>; readSession?: Promise<void>; lastClose?: Promise<void> };
```

Replace:

```ts
  reads: { session: number; closedEvent: number };
```

with:

```ts
  reads: { session: number; closedEvent: number; lastClose: number };
```

In `startHarness`, replace:

```ts
    sessions: new Map<Address, Session>(),
    fail: { supported: false, settleClose: false, closedEvent: false, provision: false, teardown: false, watch: false },
    hold: {},
    missing: { session: 0, closedEvent: 0 },
    reads: { session: 0, closedEvent: 0 },
```

with:

```ts
    sessions: new Map<Address, Session>(),
    closes: new Map<Address, ClosedEvent>(),
    fail: { supported: false, settleClose: false, closedEvent: false, provision: false, teardown: false, watch: false, lastClose: false },
    hold: {},
    missing: { session: 0, closedEvent: 0 },
    reads: { session: 0, closedEvent: 0, lastClose: 0 },
```

In the fake chain, insert after the `closedEvent` member (before `watchSession`):

```ts
    // A held look is counted when it starts.
    lastClose: async (session) => {
      harness.reads.lastClose++;
      await harness.hold.lastClose;
      if (harness.fail.lastClose) throw new Error("rpc down");
      return harness.closes.get(session);
    },
```

- [ ] **Step 2: Write the failing tests**

In `packages/gate/test/follow.test.ts`, replace the first two imports:

```ts
import type { Address } from "@solana/kit";
import type { Session } from "@lxfoundry/stint-program-client";
```

with:

```ts
import type { Address } from "@solana/kit";
import { CloseKind, type ClosedEvent, type Session } from "@lxfoundry/stint-program-client";
```

Replace:

```ts
  const { open, prepareOpen, send, closeWith, settleDown, token, connect } = helpers(() => h);
```

with:

```ts
  const { open, prepareOpen, send, closeWith, settleDown, token, connect, topUpOffers } = helpers(() => h);
```

Replace the helper `openConnected`:

```ts
  /** An open session with one connection: `frames` collects what the buyer's socket receives. */
  async function openConnected() {
    const { session } = await open();
    const { socket } = await connect(session, await token(session, "connect"));
    const frames: string[] = [];
    socket!.on("message", (data) => frames.push(String(data)));
    return { session, server: h.attached.at(-1)!, frames };
  }
```

with:

```ts
  /** An open session with one connection: `frames` collects what the buyer's socket receives, `dropped` its close code. */
  async function openConnected() {
    const { session } = await open();
    const { socket } = await connect(session, await token(session, "connect"));
    const frames: string[] = [];
    socket!.on("message", (data) => frames.push(String(data)));
    const dropped = new Promise<number>((resolve) => socket!.once("close", (code) => resolve(code)));
    return { session, server: h.attached.at(-1)!, frames, dropped };
  }
```

Replace the test that leaves the session as it is on four kinds of notification:

```ts
  it.each<[string, Partial<Session> | "gone"]>([
    ["the same end", { claimed: 8_000n }],
    ["an account that is gone", "gone"],
    ["another session opened at the address", { startedAt: BigInt(NOW_MS / 1000) + 5n, deposited: 90_000n }],
    ["a session with other terms", { rate: 2_000n, deposited: 120_000n }],
  ])("leaves the session as it is on a notification of %s", async (_, change) => {
    const { session } = await open();

    notify(session, change);

    expect(pendingDue(END_DUE)).toBeDefined();
    expect(h.calls.teardown).toEqual([]);
  });
```

with:

```ts
  it("leaves the session as it is on a notification of the same end", async () => {
    const { session } = await open();

    notify(session, { claimed: 8_000n });

    expect(pendingDue(END_DUE)).toBeDefined();
    expect(h.calls.teardown).toEqual([]);
  });
```

Then insert, before the last line of the file (the `});` that closes the outer `describe`):

```ts
  describe("when another party closes the session (spec §7.3)", () => {
    /** On the chain's clock: 8 s after the open, and the end of the paid time. */
    const EARLY = BigInt(NOW_MS / 1000) + 8n;
    const AT_END = BigInt(END_DUE / 1000);

    /** The `Closed` event of a close that the gate did not send, `at` on the chain's clock. */
    const closedAt = (session: Address, at: bigint): ClosedEvent => ({
      session,
      kind: CloseKind.Standard,
      claimed: 0n,
      owed: 8_000n,
      refunded: 22_000n,
      redirected: 0n,
      closedBy: h.buyer.address,
      paidUntil: AT_END,
      at,
    });
    const closesSent = () => h.calls.settle.filter((payload) => readElapsedPayload(payload)?.type === "close");
    /** A promise that a test resolves when it chooses, to hold a call of the fakes in flight. */
    function latch(): { promise: Promise<void>; release: () => void } {
      let release!: () => void;
      const promise = new Promise<void>((resolve) => (release = resolve));
      return { promise, release };
    }

    it("drops the connections with 4410, sends no close, and ends the session, when the close came before paid_until", async () => {
      const { session, dropped } = await openConnected();
      h.closes.set(session, closedAt(session, EARLY));

      notify(session, "gone");

      expect(await dropped).toBe(4410);
      expect(h.calls.teardown).toEqual(["closedElsewhere"]);
      expect(closesSent()).toEqual([]);
      expect(h.unwatched).toEqual([session]);
      expect(h.timers.pending).toEqual([]);
      expect(h.logs).toContainEqual({ event: "closed_elsewhere", session, found: true });
    });

    it("drops them with 4402 when the close came at or after paid_until: the paid time ran out, whoever closed it", async () => {
      const { session, dropped } = await openConnected();
      h.closes.set(session, closedAt(session, AT_END));

      notify(session, "gone");

      expect(await dropped).toBe(4402);
      expect(h.calls.teardown).toEqual(["closedElsewhere"]);
    });

    it("looks the close up again while none shows, then goes by its session clock: 4410 before paid_until", async () => {
      const { session, dropped } = await openConnected();

      notify(session, "gone");

      expect(await dropped).toBe(4410);
      expect(h.reads.lastClose).toBe(3); // the harness's readRetry
      expect(h.logs).toContainEqual({ event: "closed_elsewhere", session, found: false });
    });

    it("goes by its session clock without a close to read: 4402 once the clock has reached paid_until", async () => {
      const { session, dropped } = await openConnected();
      h.clock.now = END_DUE;

      notify(session, "gone");

      expect(await dropped).toBe(4402);
    });

    it("goes by its session clock when the lookup fails, and logs the failure", async () => {
      const { session, dropped } = await openConnected();
      h.fail.lastClose = true;

      notify(session, "gone");

      expect(await dropped).toBe(4410);
      expect(h.reads.lastClose).toBe(1); // a look that throws is not repeated
      expect(h.logs).toContainEqual({ event: "error", error: "rpc down" });
    });

    it("stops forwarding while it looks the close up", async () => {
      const { session, server, frames, dropped } = await openConnected();
      const held = latch();
      h.hold.lastClose = held.promise;
      h.closes.set(session, closedAt(session, EARLY));

      notify(session, "gone");
      server.send("tick:after-close");
      await settleDown();

      expect(frames).not.toContain("tick:after-close");
      held.release();
      expect(await dropped).toBe(4410);
    });

    it("refuses a new connection, a close and a top-up, and disarms its end timer, while it looks the close up", async () => {
      const { session, dropped } = await openConnected();
      const held = latch();
      h.hold.lastClose = held.promise;
      h.closes.set(session, closedAt(session, EARLY));

      notify(session, "gone");
      await expect.poll(() => h.reads.lastClose).toBe(1);

      expect((await connect(session, await token(session, "connect"))).status).toBe(404);
      expect((await closeWith(session)).status).toBe(404);
      expect((await topUpOffers(session)).status).toBe(404);
      expect(h.timers.pending.filter((timer) => timer.dueMs === END_DUE)).toEqual([]);
      expect(closesSent()).toEqual([]);
      held.release();
      expect(await dropped).toBe(4410);
    });

    it("lets a close of its own in flight decide: once confirmed, that close ends the session with its own reason and code", async () => {
      const { session, dropped } = await openConnected();
      const held = latch();
      h.hold.settleClose = held.promise;
      const closing = closeWith(session);
      await expect.poll(() => closesSent()).toHaveLength(1);

      notify(session, "gone"); // the buyer's close through the gate landed; its confirmation is still on its way
      held.release();

      expect((await closing).status).toBe(200);
      expect(await dropped).toBe(4410);
      expect(h.calls.teardown).toEqual(["closed"]);
      expect(h.reads.lastClose).toBe(0);
    });

    it("looks the close up once a close of its own in flight fails: another party closed the account", async () => {
      const { session, dropped } = await openConnected();
      const held = latch();
      h.hold.settleClose = held.promise;
      h.fail.settleClose = true;
      h.closes.set(session, closedAt(session, EARLY));
      const closing = closeWith(session);
      await expect.poll(() => closesSent()).toHaveLength(1);

      notify(session, "gone");
      held.release();

      expect((await closing).status).toBe(502);
      expect(await dropped).toBe(4410);
      expect(h.calls.teardown).toEqual(["closedElsewhere"]);
      expect(h.reads.lastClose).toBe(1);
    });

    it("ends the session once, after one look, when a second notification comes during the look", async () => {
      const { session, dropped } = await openConnected();
      const held = latch();
      h.hold.lastClose = held.promise;
      h.closes.set(session, closedAt(session, EARLY));

      notify(session, "gone");
      notify(session, "gone"); // a later transfer of lamports to the closed address (S12)
      held.release();

      expect(await dropped).toBe(4410);
      await settleDown();
      expect(h.reads.lastClose).toBe(1);
      expect(h.calls.teardown).toEqual(["closedElsewhere"]);
    });

    it.each<[string, Partial<Session>]>([
      ["another session opened at the address", { startedAt: BigInt(NOW_MS / 1000) + 5n, deposited: 90_000n }],
      ["a session with other terms", { rate: 2_000n, deposited: 120_000n }],
    ])("ends the session when the account holds %s: the tracked one was closed", async (_, change) => {
      const { session, dropped } = await openConnected();
      h.closes.set(session, closedAt(session, EARLY));

      notify(session, change);

      expect(await dropped).toBe(4410);
      expect(h.calls.teardown).toEqual(["closedElsewhere"]);
    });

    it("ends with 4402, and retries no more, a session whose end close keeps failing when another party closes it", async () => {
      const { session, dropped } = await openConnected();
      h.fail.settleClose = true; // the end close fails, as an AtExpiry close does before the chain's clock reaches the end
      h.timers.fire(pendingDue(END_DUE));
      await expect.poll(() => h.timers.pending.map((timer) => timer.delayMs)).toEqual([3_000]);
      h.closes.set(session, closedAt(session, AT_END + 1n)); // the sweeper's AtExpiry close, say

      notify(session, "gone");

      expect(await dropped).toBe(4402);
      expect(h.calls.teardown).toEqual(["closedElsewhere"]);
      expect(h.timers.pending).toEqual([]);
    });
  });
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm --filter @lxfoundry/stint-gate test follow.test.ts`
Expected: FAIL in the new tests of "when another party closes the session": the `dropped` promises never resolve
(vitest's timeout), `teardown` stays `[]`, or `reads.lastClose` stays `0`. The tests outside that `describe` pass, and
the test "lets a close of its own in flight decide" may pass already: today the gate ignores the notification and its own
close ends the session.

- [ ] **Step 4: Implement**

In `packages/gate/src/gate.ts`, in the interface `Tracked<U>`, insert after the member `endRetry`:

```ts
  /** The lookup of a close by another party, once one has started (spec §7.3): a second notification joins it. */
  endingElsewhere?: Promise<void>;
```

Insert after the constant `END_RETRY_MAX_MS` and its comment:

```ts
/**
 * How long the lookup of a close by another party waits for the node's list to show it (spec §7.3), whatever `readRetry`
 * allows: the connections are muted by then, and the session clock decides their close code without the event.
 */
const CLOSE_LOOKUP_MS = 2_000;
```

Replace:

```ts
  const readRetry = config.readRetry ?? { attempts: 5, delayMs: 200 };
```

with:

```ts
  const readRetry = config.readRetry ?? { attempts: 5, delayMs: 200 };
  const closeLookupRetry = {
    attempts: Math.max(1, Math.min(readRetry.attempts, Math.floor(CLOSE_LOOKUP_MS / Math.max(1, readRetry.delayMs)) + 1)),
    delayMs: readRetry.delayMs,
  };
```

In the function `topUp`, replace:

```ts
    if (!tracked || tracked.ended) return sendJson(response, 404, { error: "unknown_session" });
```

with:

```ts
    // A session that another party closed is over on chain while the gate looks its close up (spec §7.3).
    if (!tracked || tracked.ended || tracked.endingElsewhere) return sendJson(response, 404, { error: "unknown_session" });
```

In the function `closeSession`, replace:

```ts
    // The session may have ended while the token was checked.
    if (tracked.ended) return sendJson(response, 404, { error: "unknown_session" });
```

with:

```ts
    // The session may have ended while the token was checked, or another party may have closed it (spec §7.3).
    if (tracked.ended || tracked.endingElsewhere) return sendJson(response, 404, { error: "unknown_session" });
```

In the function `connect`, replace:

```ts
    // The session may have ended while the token was checked.
    if (tracked.ended) return refuseUpgrade(socket, 404);
```

with:

```ts
    // The session may have ended while the token was checked, or another party may have closed it (spec §7.3).
    if (tracked.ended || tracked.endingElsewhere) return refuseUpgrade(socket, 404);
```

Replace the function `follow` and its comment:

```ts
  /**
   * Follows the session's account (spec §7.3), when the chain can: a later `paid_until` on the same session, a top-up this
   * gate did not settle, moves the end timer at once and resumes forwarding if the end timer has fired. An account that is
   * gone, or that holds another session, is left to the end timer. A subscription that fails, or cannot start, is logged
   * and not replaced: the end timer's re-read still finds a later `paid_until`. A gate that has stopped starts none, since
   * nothing would end it.
   */
  function follow(tracked: Tracked<U>): void {
    if (stopped || !config.chain.watchSession) return;
    const session = tracked.info.session;
    const failed = (error: unknown) => log({ event: "subscription_error", session, error: error instanceof Error ? error.message : String(error) });
    try {
      tracked.unwatch = config.chain.watchSession(
        session,
        (stored) => {
          if (!sameSession(tracked, stored)) return;
          paidLonger(tracked, paidUntil(stored));
        },
        failed,
      );
    } catch (error) {
      failed(error);
    }
  }
```

with:

```ts
  /**
   * Follows the session's account (spec §7.3), when the chain can: a later `paid_until` on the same session, a top-up this
   * gate did not settle, moves the end timer at once and resumes forwarding if the end timer has fired. An account that is
   * gone, or that holds another session, means the session was closed: `closedElsewhere` decides how it ends. A
   * subscription that fails, or cannot start, is logged and not replaced: the end timer's re-read still finds a later
   * `paid_until`, or the account gone. A gate that has stopped starts none, since nothing would end it.
   */
  function follow(tracked: Tracked<U>): void {
    if (stopped || !config.chain.watchSession) return;
    const session = tracked.info.session;
    const failed = (error: unknown) => log({ event: "subscription_error", session, error: error instanceof Error ? error.message : String(error) });
    try {
      tracked.unwatch = config.chain.watchSession(
        session,
        (stored) => {
          if (sameSession(tracked, stored)) paidLonger(tracked, paidUntil(stored));
          else closedElsewhere(tracked);
        },
        failed,
      );
    } catch (error) {
      failed(error);
    }
  }

  /**
   * The session's account is gone, or holds another session (spec §7.3, "Account closed by another party"). A close of the
   * gate's own in flight decides first: it may be what closed the account, and once confirmed it ends the session with its
   * own reason and code; if it fails, someone else closed the account, and this runs again. Otherwise the session ends
   * here, with no close (`endClosedElsewhere`). A second notification while that runs joins it.
   */
  function closedElsewhere(tracked: Tracked<U>): void {
    if (tracked.ended) return;
    const closing = tracked.closing;
    if (closing) {
      // Runs after `startClose`'s own handler, which has cleared `closing` by then if the close failed.
      const again = () => closedElsewhere(tracked);
      void closing.then((outcome) => outcome.ended || again(), again);
      return;
    }
    tracked.endingElsewhere ??= endClosedElsewhere(tracked).catch(logError);
  }

  /**
   * Ends a session that another party closed. Forwarding stops at once: the session is over on chain, whatever the lookup
   * finds. From then on a new connection, a close or a top-up is answered `404` (`endingElsewhere` is set), and the end
   * timer is disarmed, since there is nothing left to settle. The close is looked up (`lastClose`), again for about 2 s
   * while none shows, since the node's list of the address's transactions can lag the notification. The connections get
   * `4402` if the close came at or after its `paid_until`, since the paid time ran out whoever closed it, and `4410` before;
   * without the close, the session clock is compared with the last `paid_until` the gate saw.
   */
  async function endClosedElsewhere(tracked: Tracked<U>): Promise<void> {
    mute(tracked);
    disarm(tracked, "end");
    const session = tracked.info.session;
    let event: ClosedEvent | undefined;
    if (config.chain.lastClose) {
      try {
        event = await readUntilFound(() => upstream(() => config.chain.lastClose!(session)), closeLookupRetry);
      } catch (error) {
        logError(error);
      }
    }
    if (tracked.ended) return;
    const ranOut = event ? event.at >= event.paidUntil : BigInt(Math.floor(sessionClock() / 1000)) >= tracked.paidUntil;
    log({ event: "closed_elsewhere", session, found: event !== undefined });
    await end(tracked, "closedElsewhere", ranOut ? CLOSE_CODES.PAID_TIME_ENDED : CLOSE_CODES.SESSION_CLOSED);
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @lxfoundry/stint-gate test && pnpm --filter @lxfoundry/stint-gate typecheck`
Expected: PASS, every test of the gate's suite (the lifecycle, top-up and gate tests included); no type error.

- [ ] **Step 6: Mutation check**

One at a time, make each change below, run `pnpm --filter @lxfoundry/stint-gate test follow.test.ts`, check that it
fails where stated, and undo it:
1. In `endClosedElsewhere`, `event.at >= event.paidUntil` → `event.at > event.paidUntil`: "drops them with 4402 when
   the close came at or after paid_until" fails (`4410`).
2. Delete `mute(tracked);`: "stops forwarding while it looks the close up" fails.
3. In `closedElsewhere`, delete the `if (closing) { … }` block: "lets a close of its own in flight decide" fails
   (`teardown` is `["closedElsewhere"]`, or `reads.lastClose` is 1).
4. Replace `tracked.endingElsewhere ??= endClosedElsewhere(tracked).catch(logError);` with
   `void endClosedElsewhere(tracked).catch(logError);`: "ends the session once, after one look" fails (`reads.lastClose`
   is 2), and so does "refuses a new connection, a close and a top-up …" (`endingElsewhere` is never set).
5. In `connect`, `tracked.ended || tracked.endingElsewhere` → `tracked.ended`: "refuses a new connection, a close and a
   top-up …" fails (the upgrade succeeds, so `status` is undefined).
6. In `closeSession`, the same change: that test fails (the close settles: `200`).
7. In `topUp`, delete `|| tracked.endingElsewhere`: that test fails (`402`, `session_expired`, from the muted session).
8. In `endClosedElsewhere`, delete `disarm(tracked, "end");`: that test fails (the end timer is still pending).

- [ ] **Step 7: Update the spec**

In `docs/specs/stint-system.md`, section 7.3, replace the whole row that begins `| Account closed by another party |`:

```markdown
| Account closed by another party | Drop connections: `4402` if the `Closed` event's `at` is at or after its `paid_until`, since the paid time ran out whoever closed it; otherwise `4410`. The gate lists the session address's transactions at `confirmed`, which still works once the account is gone. It takes the most recent successful one whose inner instructions hold a `Closed` event for this session (section 4.4). Failed transactions and later lamport transfers to the address (S12) can come after the close, so the latest entry alone is not enough. If that lookup fails, the gate compares its session clock with the last `paid_until` it saw | — |
```

with:

```markdown
| Account closed by another party: the subscription finds the account gone, or holding another session (section 4.1) | A close of the gate's own in flight decides first: once confirmed, it ends the session with its own reason and code. Otherwise, or if that close does not confirm, stop forwarding at once, answer a new connection, a close or a top-up of the session with `404`, and drop connections, with no close: `4402` if the `Closed` event's `at` is at or after its `paid_until`, since the paid time ran out whoever closed it; otherwise `4410`. The gate lists the session address's transactions at `confirmed`, which still works once the account is gone. It takes the most recent successful one whose inner instructions hold a `Closed` event for this session (section 4.4). Failed transactions and later lamport transfers to the address (S12) can come after the close, so the latest entry alone is not enough. The node's list can lag the notification, so a lookup that finds nothing is repeated for a few seconds at most. If it still finds nothing, or fails, the gate compares its session clock with the last `paid_until` it saw | — |
```

Run: `grep -c "Account closed by another party: the subscription" docs/specs/stint-system.md`
Expected: `1`.

- [ ] **Step 8: Commit**

```bash
git add packages/gate/src/gate.ts packages/gate/test/harness.ts packages/gate/test/follow.test.ts docs/specs/stint-system.md
git commit -m "Drop the connections of a session that another party closed, with 4402 or 4410 from its Closed event"
```

---

### Task 3: Scenario 7, a unilateral on-chain close

Spec section 12.7: "Unilateral on-chain close: connection dropped (`4410`) within 5 s". The buyer opens through the
gate, connects, then closes its session on the program, past the gate and the facilitator. Its key holds no SOL, so the
harness's direct chain pays the fee; what the gate sees is the same whoever pays it. Two helpers that later scenarios
share go in a new module.

**Files:**
- Create: `conformance/src/sessions.ts`, `conformance/test/sessions.test.ts`
- Create: `conformance/src/scenarios/07-unilateral-close.ts`
- Modify: `conformance/src/catalogue.ts`, `conformance/test/catalogue.test.ts`, `e2e/test/local-target.test.ts`

**Interfaces:**
- Consumes: `DirectChain.close`, `DirectSession`, `ScenarioContext` (`conformance/src/types.ts`); `buyerClient`,
  `sessionSeconds` (`conformance/src/helpers.ts`); `readUntil`; `paidUntil`, `fetchMaybeSession`, `Session`;
  `associatedTokenAddress`, `fetchClosedEvent`.
- Produces, in `conformance/src/sessions.ts`:
  - `readOpenedSession(context: ScenarioContext, session: Address): Promise<Session>`: the stored session, read until
    the node shows it; throws (through `expectTrue`) if it never does;
  - `directSessionOf(session: Address, stored: Session): Promise<DirectSession>`: every account a close names, derived
    from the stored fields, so that `DirectChain.close` can close a session the gate opened.

- [ ] **Step 1: Write the failing test of `directSessionOf`**

Create `conformance/test/sessions.test.ts`:

```ts
import { generateKeyPairSigner } from "@solana/kit";
import type { Session } from "@lxfoundry/stint-program-client";
import { associatedTokenAddress } from "@lxfoundry/stint-x402";
import { describe, expect, it } from "vitest";
import { directSessionOf } from "../src/sessions.js";

describe("directSessionOf", () => {
  it("derives every account a close names from a session's stored fields (spec §4.1, §4.3)", async () => {
    const [session, authority, mint, receiver, refundOwner, rentPayer] = await Promise.all(
      Array.from({ length: 6 }, async () => (await generateKeyPairSigner()).address),
    );
    const stored = {
      authority: authority!,
      mint: mint!,
      receiver: receiver!,
      refundOwner: refundOwner!,
      rentPayer: rentPayer!,
      rate: 1_000n,
      minSeconds: 5,
      maxSeconds: 120,
      startedAt: 1_800_000_000n,
      deposited: 30_000n,
      claimed: 0n,
    } as Session;

    expect(await directSessionOf(session!, stored)).toEqual({
      session,
      vault: await associatedTokenAddress(session!, mint!),
      rentPayer,
      receiverToken: await associatedTokenAddress(receiver!, mint!),
      refundTo: await associatedTokenAddress(refundOwner!, mint!),
      deposit: 30_000n,
      startedAt: 1_800_000_000n,
      paidUntil: 1_800_000_030n,
    });
  });
});
```

Run: `pnpm --filter @lxfoundry/stint-conformance test sessions.test.ts`
Expected: FAIL: `../src/sessions.js` cannot be resolved.

- [ ] **Step 2: Write the helpers**

Create `conformance/src/sessions.ts`:

```ts
import type { Address } from "@solana/kit";
import { fetchMaybeSession, paidUntil, type Session } from "@lxfoundry/stint-program-client";
import { associatedTokenAddress } from "@lxfoundry/stint-x402";
import { expectTrue } from "./assert.js";
import { readUntil } from "./reads.js";
import type { DirectSession, ScenarioContext } from "./types.js";

/** The session as the program stored it at its open, read until the node shows it (spec §12.2). */
export async function readOpenedSession(context: ScenarioContext, session: Address): Promise<Session> {
  const readSession = () => fetchMaybeSession(context.rpc, session, { commitment: "confirmed" });
  const account = await readUntil(context.readRetry, readSession, (read) => read.exists);
  expectTrue(account.exists, "the session exists on-chain after the open");
  return account.data;
}

/**
 * A session the scenario opened through the gate, as `DirectChain.close` takes it: every account a close names, derived
 * from the session's stored fields (spec §4.1), so that its buyer can close it on the program, past the gate.
 */
export async function directSessionOf(session: Address, stored: Session): Promise<DirectSession> {
  return {
    session,
    vault: await associatedTokenAddress(session, stored.mint),
    rentPayer: stored.rentPayer,
    receiverToken: await associatedTokenAddress(stored.receiver, stored.mint),
    refundTo: await associatedTokenAddress(stored.refundOwner, stored.mint),
    deposit: stored.deposited,
    startedAt: stored.startedAt,
    paidUntil: paidUntil(stored),
  };
}
```

Run: `pnpm --filter @lxfoundry/stint-conformance test sessions.test.ts`
Expected: PASS.

- [ ] **Step 3: Write the scenario, as `pending`**

Create `conformance/src/scenarios/07-unilateral-close.ts`:

```ts
import { fetchClosedEvent } from "@lxfoundry/stint-x402";
import { expectEqual, expectTrue, sleep, waitFor } from "../assert.js";
import { buyerClient, sessionSeconds } from "../helpers.js";
import { directSessionOf, readOpenedSession } from "../sessions.js";
import type { ScenarioContext } from "../types.js";

/** How soon after the close is confirmed the gate must have dropped the connection (spec §12.7). */
const DROP_WITHIN_MS = 5_000;

/**
 * Scenario 7 (spec §12.7): a unilateral on-chain close. While a connection is open, the buyer closes its session on the
 * program, past the gate and the facilitator. The gate sees the account go through its subscription to it, and drops the
 * connection with 4410 within 5 s: the close came before the paid time ran out (spec §7.3). The buyer holds no SOL, so a
 * harness key pays the fee; the gate sees the same whoever pays it.
 */
export async function unilateralClose(context: ScenarioContext): Promise<void> {
  const direct = context.direct;
  if (!direct) throw new Error("scenario 7 needs a target that provides direct chain access");
  const buyer = await context.newBuyer(100_000n); // the session costs 30,000 (40,000 on devnet)
  const session = await buyerClient(buyer).open(context.gateUrl, { seconds: sessionSeconds(context.target, 30) });
  const socket = await session.connect();
  let code: number | undefined;
  socket.on("close", (closeCode) => {
    code = closeCode;
  });
  socket.on("error", () => {});
  try {
    const stored = await readOpenedSession(context, session.id);
    // The gate subscribes to the account when the open settles; the node takes a moment to have the subscription.
    await sleep(context.subscriptionSettleMs);
    expectTrue(code === undefined, "the connection is open before the close");

    const signature = await direct.close(await directSessionOf(session.id, stored), buyer.signer);

    await waitFor(() => code !== undefined, DROP_WITHIN_MS, "the gate drops the connection within 5 s of the close's confirmation");
    expectEqual(code, 4410, "the connection is dropped with 4410: the session was closed before its paid time ran out");
    const closed = await fetchClosedEvent(context.rpc, signature, context.readRetry);
    expectTrue(closed, "the close emitted Closed");
    expectEqual(closed.closedBy, buyer.signer.address, "the buyer closed the session itself");
    expectTrue(closed.at < closed.paidUntil, "the close came before paid_until");
  } finally {
    socket.terminate();
  }
}
```

In `conformance/src/catalogue.ts`, insert the import in numeric order (after the import of scenario 4's module):

```ts
import { unilateralClose } from "./scenarios/07-unilateral-close.js";
```

and replace:

```ts
  pending(7, "Unilateral on-chain close"),
```

with:

```ts
  pending(7, "Unilateral on-chain close", [], "shared", unilateralClose),
```

Run: `pnpm --filter @lxfoundry/stint-conformance typecheck && pnpm e2e:local`
Expected: no type error. The report lists scenario 7 as `pending` with result `pass`, flagged as passing while pending;
the run exits 0. If scenario 7 fails, read its error before going on: "not within 5000 ms" means the gate did not end
the session after the close. Task 2's unit tests cover what the gate does with the notification, so check what feeds it:
`e2e/src/targets/services.ts` must give the gate `createRpcChain` with a subscriptions client, as it does since stage 5.
The harness keeps no log of the gate's.

- [ ] **Step 4: Make scenario 7 `required`**

In `conformance/src/catalogue.ts`, replace:

```ts
  pending(7, "Unilateral on-chain close", [], "shared", unilateralClose),
```

with:

```ts
  required(7, "Unilateral on-chain close", unilateralClose),
```

In `conformance/test/catalogue.test.ts` and in `e2e/test/local-target.test.ts`, add `7` to the `REQUIRED` list, in
numeric order. With part 1 merged and nothing else, both read `const REQUIRED = [1, 2, 3, 4, 9, 15, 16, 22, 26, 34];` and
become `const REQUIRED = [1, 2, 3, 4, 7, 9, 15, 16, 22, 26, 34];`. In the comment above `REQUIRED` in
`e2e/test/local-target.test.ts`, which gives each scenario's duration, add "7 about 3 s".

Run: `pnpm --filter @lxfoundry/stint-conformance test && pnpm e2e:local`
Expected: PASS; the report counts one more `required` scenario than before this task, every one with result `pass`.

- [ ] **Step 5: Commit**

```bash
git add conformance/src/sessions.ts conformance/test/sessions.test.ts conformance/src/scenarios/07-unilateral-close.ts conformance/src/catalogue.ts conformance/test/catalogue.test.ts e2e/test/local-target.test.ts
git commit -m "Add scenario 7, a unilateral on-chain close that the gate drops with 4410, and make it required"
```

---

### Task 4: The client's fallback: the gate's close, a pending close, and the sponsored close

`session.close()` today asks the gate and fails with it. This task makes it the first two steps of the fallback chain
(spec section 9.3); Task 5 adds the third.

1. **The gate's close.** `200`: the receipt. `202`: the close is pending; the client reads the gate's status every
   `closePollMs` until it answers `404`, for at most `closeWaitSeconds`: a `404` means the session is closed, and the
   pending close is the receipt, without amounts; past the wait, the chain moves on, passing the pending close on. Any
   other answer, and a gate that cannot be reached, moves the chain on: a `404` (it does not track the session, as after
   a restart), a `5xx`, a `401` (a token it refuses, say from a skewed clock) and a refusal of the close itself, such as
   `409`, which the later steps judge for themselves.
2. **The facilitator's sponsored close**, through the offer's `closeUrl`. `GET closeUrl?session=` is the check that the
   session is still open: `404` with `unknown_session` means it is closed, which ends the chain. Otherwise its body gives
   the fee payer, a blockhash and the stored fields; `buildSponsoredClose` (part 1) builds the close and refuses a body
   that describes another session or program, or names the client as fee payer. `POST closeUrl` closes it: success is
   the receipt; anything else moves the chain on, and a `settlement_pending` passes its signature on as a close that may
   still land.

Every request has a time limit, so that a host that takes the connection and never answers does not hold the chain up
while the session is charged: a read (the gate's status, `GET closeUrl`) is given up after `requestTimeoutMs`, a request
that sends a close (the gate's close, `POST closeUrl`) after `closeWaitSeconds`, since the facilitator waits for a close
to confirm before it answers.

A check that finds the session closed returns the latest pending close passed on by an earlier step, if any; otherwise it
throws `StintError("The session is already closed", 404)` and the session counts as closed. When no step closes the
session, `close()` throws a `StintError` that lists why each step was passed over, names any close sent that may still
land, and says that the session runs to the end of its paid time; the session does not count as closed, so a later
`close()` tries again. Overlapping calls of `close()` share one chain.

Receipts gain `via`: `"gate"`, `"sponsored"` or `"unilateral"`.

**Files:**
- Modify: `packages/client/src/client.ts`, `packages/client/src/policy.ts`, `packages/client/src/index.ts`
- Modify: `packages/client/test/gate.ts` (the test gate gains the facilitator's buyer endpoints and switches)
- Modify: `packages/client/test/client.test.ts`, `packages/client/test/tools.test.ts` (receipts gain `via`)
- Create: `packages/client/test/fallback.test.ts`
- Modify: `docs/specs/stint-system.md` (section 9.3)

**Interfaces:**
- Consumes: `readCloseInfo`, `buildSponsoredClose`, `SponsoredCloseResponse`, `CloseInfo`, `storedSessionFields`
  (`@lxfoundry/stint-x402`, part 1); `offer.extra.closeUrl` (`ElapsedRequirements`).
- Produces:
  - `type CloseVia = "gate" | "sponsored" | "unilateral"`, exported from `@lxfoundry/stint-client`;
  - `CloseReceipt` gains `readonly via: CloseVia`;
  - `Policy` gains `readonly closeWaitSeconds?: number` (default 180);
  - `ClientOptions` gains `readonly closePollMs?: number` (default 1,000) and `readonly requestTimeoutMs?: number`
    (default 10,000);
  - in the test gate (`packages/client/test/gate.ts`): `NETWORK`, and on `TestGate`: `feePayer`, `stored`,
    `closeSettlement`, `sessionOpen`, `facilitatorSessionOpen`, `gateDown`, `facilitatorDown`, `gateSilent`,
    `facilitatorSilent`, `sponsored`, `sponsoredAnswer`.

- [ ] **Step 1: Give the test gate the facilitator's buyer endpoints**

Replace the whole of `packages/client/test/gate.ts` with:

```ts
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { address, generateKeyPairSigner, type Address } from "@solana/kit";
import { CloseKind, STINT_PROGRAM_ADDRESS, type ClosedEvent, type Session, type SessionArgs } from "@lxfoundry/stint-program-client";
import { createGate, type Gate } from "@lxfoundry/stint-gate";
import {
  USDC_DEVNET,
  readElapsedPayload,
  readJson,
  sendJson,
  storedSessionFields,
  type CloseInfo,
  type PaymentPayload,
  type SettleResponse,
  type SponsoredCloseResponse,
  type VerifyResponse,
} from "@lxfoundry/stint-x402";
import type { WebSocket } from "ws";

export const NETWORK = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const BLOCKHASH = "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N";

export interface TestGate {
  readonly url: string;
  /** The facilitator's fee payer: offers name it, and so does `GET /close`. */
  readonly feePayer: Address;
  /** The session the fake chain holds for the buyer, as the program stores it. */
  readonly stored: SessionArgs;
  readonly payments: PaymentPayload[];
  /** Rejections that escaped `handleRequest`: the gate must contain its own errors. */
  readonly escaped: unknown[];
  /** While set, the chain cannot return the `Closed` event of a confirmed close. */
  hideClosedEvent: boolean;
  /** What the facilitator answers `/verify` with. Default `{ isValid: true }`. */
  verifyAnswer: VerifyResponse;
  /** What the facilitator answers the settlement of the gate's close with. Default: confirmed, `sig`. */
  closeSettlement: SettleResponse;
  /** While false, the chain holds no session: the gate's status answers `404`, and so does `GET /close?session=`. */
  sessionOpen: boolean;
  /** When set, what `GET /close?session=` goes by in place of `sessionOpen`: the facilitator's node can disagree with the gate's. */
  facilitatorSessionOpen?: boolean;
  /** While set, the gate's routes drop each request unanswered, as a host that cannot be reached does. */
  gateDown: boolean;
  /** While set, the facilitator's `/close` routes drop each request unanswered. */
  facilitatorDown: boolean;
  /** While set, the gate's routes take each request and never answer it. */
  gateSilent: boolean;
  /** While set, the facilitator's `/close` routes take each request and never answer it. */
  facilitatorSilent: boolean;
  /** The transactions posted to `closeUrl`, in order. */
  readonly sponsored: string[];
  /** What `POST /close` answers. Default: closed, `sponsored-sig`, 8,000 paid and 22,000 refunded. */
  sponsoredAnswer: SponsoredCloseResponse;
  stop(): Promise<void>;
}

/**
 * A gate selling 1,000 per second, 5 to 120 s, whose chain holds one session per buyer, and on the same server the
 * facilitator's buyer endpoints, `GET /close` and `POST /close` (spec §6.1), which its offers name as `closeUrl`.
 */
export async function startTestGate(buyer: Address, onAttach: (socket: WebSocket) => void = () => {}): Promise<TestGate> {
  const authorizer = await generateKeyPairSigner();
  const seller = (await generateKeyPairSigner()).address;
  const feePayer = (await generateKeyPairSigner()).address;
  const rentPayer = (await generateKeyPairSigner()).address;
  const payments: PaymentPayload[] = [];
  const escaped: unknown[] = [];
  const now = Date.now();
  const stored: SessionArgs = {
    version: 1,
    bump: 255,
    authority: buyer,
    seed: 7n,
    mint: USDC_DEVNET.mint,
    receiver: seller,
    receiverAuthorizer: authorizer.address,
    refundOwner: buyer,
    rentPayer,
    rate: 1_000n,
    minSeconds: 5,
    maxSeconds: 120,
    startedAt: BigInt(Math.floor(now / 1000)),
    deposited: 30_000n,
    claimed: 0n,
  };
  const server: Server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const gate: Gate = createGate({
    origin: url,
    network: NETWORK,
    asset: USDC_DEVNET,
    payTo: seller,
    receiverAuthorizer: authorizer,
    terms: { rate: 1_000n, minSeconds: 5, maxSeconds: 120 },
    durations: [30, 60],
    readRetry: { attempts: 2, delayMs: 1 },
    facilitator: {
      supported: async () => ({
        kinds: [{ x402Version: 2, scheme: "elapsed", network: NETWORK, extra: { feePayer, rentPayer, programId: STINT_PROGRAM_ADDRESS, closeUrl: `${url}/close` } }],
        extensions: [],
        signers: {},
      }),
      verify: async () => testGate.verifyAnswer,
      settle: async (payload) => {
        payments.push(payload);
        if (readElapsedPayload(payload)?.type === "close") return testGate.closeSettlement;
        return { success: true, transaction: "sig", network: NETWORK };
      },
    },
    chain: {
      latestBlockhash: async () => ({ blockhash: BLOCKHASH, lastValidBlockHeight: 100n }),
      readSession: async () => (testGate.sessionOpen ? (stored as unknown as Session) : undefined),
      closedEvent: async () =>
        testGate.hideClosedEvent
          ? undefined
          : ({ claimed: 0n, owed: 8_000n, refunded: 22_000n, redirected: 0n, kind: CloseKind.Standard } as ClosedEvent),
    },
    adapter: {
      provision: async () => null,
      attach: (_, socket) => onAttach(socket),
      teardown: async () => {},
    },
  });

  /** The facilitator's buyer endpoints (spec §6.1): `GET /close`, with or without `?session=`, and `POST /close`. */
  async function serveClose(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    if (req.method === "GET") {
      const session = new URL(req.url ?? "/", url).searchParams.get("session");
      if (session !== null && !(testGate.facilitatorSessionOpen ?? testGate.sessionOpen)) {
        sendJson(res, 404, { error: "unknown_session" });
        return true;
      }
      const info: CloseInfo = {
        feePayer,
        recentBlockhash: BLOCKHASH,
        lastValidBlockHeight: "100",
        blockHeight: "90",
        programId: STINT_PROGRAM_ADDRESS,
        ...(session === null ? {} : { session: storedSessionFields(address(session), stored as unknown as Session) }),
      };
      sendJson(res, 200, info);
      return true;
    }
    const body = (await readJson(req)) as { transaction?: unknown } | undefined;
    testGate.sponsored.push(String(body?.transaction));
    sendJson(res, 200, testGate.sponsoredAnswer);
    return true;
  }

  server.on("request", (req, res) => {
    const toFacilitator = new URL(req.url ?? "/", url).pathname === "/close";
    if (toFacilitator ? testGate.facilitatorDown : testGate.gateDown) return void req.socket.destroy();
    if (toFacilitator ? testGate.facilitatorSilent : testGate.gateSilent) return; // `stop` closes the connection
    (toFacilitator ? serveClose(req, res) : gate.handleRequest(req, res)).then(
      (handled) => {
        if (!handled) res.writeHead(404).end();
      },
      (error: unknown) => {
        escaped.push(error);
        res.writeHead(500).end();
      },
    );
  });
  server.on("upgrade", (req, socket, head) => {
    if (testGate.gateDown || !gate.handleUpgrade(req, socket, head)) socket.destroy();
  });
  const testGate: TestGate = {
    url,
    feePayer,
    stored,
    payments,
    escaped,
    hideClosedEvent: false,
    verifyAnswer: { isValid: true },
    closeSettlement: { success: true, transaction: "sig", network: NETWORK },
    sessionOpen: true,
    gateDown: false,
    facilitatorDown: false,
    gateSilent: false,
    facilitatorSilent: false,
    sponsored: [],
    sponsoredAnswer: { success: true, transaction: "sponsored-sig", paid: "8000", refunded: "22000" },
    stop: async () => {
      await gate.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
  return testGate;
}
```

Run: `pnpm --filter @lxfoundry/stint-client test`
Expected: PASS: every existing test of the client's suite still passes with the new test gate (nothing calls the new
endpoints yet).

- [ ] **Step 2: Write the failing tests**

Create `packages/client/test/fallback.test.ts`:

```ts
import { generateKeyPairSigner, type KeyPairSigner } from "@solana/kit";
import { inspectTransaction } from "@lxfoundry/stint-x402";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StintError, createStintClient, type Policy, type StintSession } from "../src/index.js";
import { NETWORK, startTestGate, type TestGate } from "./gate.js";

const policy: Policy = {
  maxRate: 1_000n,
  maxPerSession: 100_000n,
  budget: { amount: 100_000n, periodSeconds: 3_600 },
  closeWaitSeconds: 5,
};
/** What the test gate's facilitator answers a sponsored close with, by default, as the client reports it. */
const SPONSORED = { paid: 8_000n, refunded: 22_000n, transaction: "sponsored-sig", via: "sponsored" };

describe("the close fallback chain (spec §9.3)", () => {
  let buyer: KeyPairSigner;
  let gate: TestGate;

  beforeEach(async () => {
    buyer = await generateKeyPairSigner();
    gate = await startTestGate(buyer.address);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await gate.stop();
    expect(gate.escaped).toEqual([]);
  });

  /** A 30 s session on the test gate, for a client that reads a pending close's status every 20 ms and gives a read up after 200 ms. */
  async function openSession(overrides: Partial<Policy> = {}): Promise<StintSession> {
    const client = createStintClient({ signer: buyer, policy: { ...policy, ...overrides }, closePollMs: 20, requestTimeoutMs: 200 });
    return client.open(gate.url, { seconds: 30 });
  }
  /** The gate's close settles as pending: its signature is known, its confirmation is not. */
  const PENDING = { success: false, errorReason: "settlement_pending", transaction: "pending-sig", network: NETWORK } as const;

  /** Answers the gate's close with `status` and `body`; every other request goes through. */
  function gateCloseAnswers(session: StintSession, status: number, body: unknown): void {
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) =>
      String(input) === `${gate.url}/sessions/${session.id}/close`
        ? Promise.resolve(Response.json(body, { status }))
        : realFetch(input, init),
    );
  }

  it("closes through the gate when the gate answers, and asks the facilitator nothing", async () => {
    const session = await openSession();

    expect(await session.close()).toEqual({ paid: 8_000n, refunded: 22_000n, transaction: "sig", via: "gate" });
    expect(gate.sponsored).toEqual([]);
  });

  it("closes through closeUrl when the gate cannot be reached: a close it built itself, signed only as the authority, the facilitator's fee payer left to sign", async () => {
    const session = await openSession();
    gate.gateDown = true;

    expect(await session.close()).toEqual(SPONSORED);

    expect(gate.sponsored).toHaveLength(1);
    const close = inspectTransaction(gate.sponsored[0]!)!;
    expect(close.feePayer).toBe(gate.feePayer);
    expect([...close.signed]).toEqual([buyer.address]);
    expect(close.accounts).toContain(session.id);
  });

  it("closes through closeUrl when the gate answers 404: it does not track the session, as after a restart", async () => {
    const session = await openSession();
    gateCloseAnswers(session, 404, { error: "unknown_session" });

    expect(await session.close()).toEqual(SPONSORED);
  });

  it("closes through closeUrl when the gate's close fails with a 5xx", async () => {
    const session = await openSession();
    gate.closeSettlement = { success: false, errorReason: "simulation_failed", transaction: "", network: NETWORK };

    expect(await session.close()).toEqual(SPONSORED);
  });

  it("waits for a close the gate reports pending, and returns it once the gate reports the session gone", async () => {
    const session = await openSession({ closeWaitSeconds: 60 });
    gate.closeSettlement = PENDING;
    setTimeout(() => (gate.sessionOpen = false), 100);
    const started = Date.now();

    expect(await session.close()).toEqual({ transaction: "pending-sig", via: "gate" });
    expect(Date.now() - started).toBeLessThan(2_000); // at the gate's 404, not at the end of the wait
    expect(gate.sponsored).toEqual([]);
  });

  it("moves on to closeUrl once the gate's pending close outlasts closeWaitSeconds", async () => {
    const session = await openSession({ closeWaitSeconds: 0.2 });
    gate.closeSettlement = PENDING;

    expect(await session.close()).toEqual(SPONSORED);
  });

  it("returns a close the gate reported pending when closeUrl then finds the session closed: that close may be the one that landed", async () => {
    const session = await openSession({ closeWaitSeconds: 0.2 });
    gate.closeSettlement = PENDING;
    gate.facilitatorSessionOpen = false; // the gate's node still shows the session; the facilitator's no longer does

    expect(await session.close()).toEqual({ transaction: "pending-sig", via: "gate" });
    expect(gate.sponsored).toEqual([]);
  });

  it("names a close that may still land when no step closes the session", async () => {
    const session = await openSession({ closeWaitSeconds: 0.2 });
    gate.closeSettlement = PENDING;
    gate.facilitatorDown = true;

    await expect(session.close()).rejects.toThrow(/may still land: pending-sig \(gate\)[\s\S]*runs to the end of its paid time/);
  });

  it("reports a session that closeUrl finds closed, sends no close, and counts it as closed", async () => {
    const session = await openSession();
    gate.gateDown = true;
    gate.sessionOpen = false;

    await expect(session.close()).rejects.toMatchObject({ status: 404, message: "The session is already closed" });

    expect(gate.sponsored).toEqual([]);
    await session[Symbol.asyncDispose](); // counted as closed: disposing it does not close it again
  });

  it("says the session runs to the end of its paid time when neither the gate nor the facilitator can close it, and closes it once one can", async () => {
    const session = await openSession();
    gate.gateDown = true;
    gate.facilitatorDown = true;

    const error = await session.close().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(StintError);
    expect((error as Error).message).toMatch(/the gate cannot be reached/);
    expect((error as Error).message).toMatch(/sponsored close failed/);
    expect((error as Error).message).toMatch(/runs to the end of its paid time/);
    gate.gateDown = false;
    expect(await session.close()).toMatchObject({ via: "gate" });
  });

  it("moves past a sponsored close that the facilitator refuses, and names the refusal", async () => {
    const session = await openSession();
    gate.gateDown = true;
    gate.sponsoredAnswer = { success: false, errorReason: "simulation_failed", errorMessage: "custom program error: 0x1774", transaction: "" };

    await expect(session.close()).rejects.toThrow(/simulation_failed[\s\S]*runs to the end of its paid time/);
    expect(gate.sponsored).toHaveLength(1);
  });

  it.each<[number, unknown]>([
    [401, { error: "unauthorized" }],
    [409, { error: "refund_account_closed" }],
  ])("moves on to closeUrl when the gate refuses its close with %i: the later steps judge the close for themselves", async (status, body) => {
    const session = await openSession();
    gateCloseAnswers(session, status, body);

    expect(await session.close()).toEqual(SPONSORED);
  });

  it("names the gate's refusal when no later step closes the session either", async () => {
    const session = await openSession();
    gateCloseAnswers(session, 409, { error: "refund_account_closed" });
    gate.sponsoredAnswer = { success: false, errorReason: "simulation_failed", errorMessage: "custom program error: 0x1772", transaction: "" };

    await expect(session.close()).rejects.toThrow(/the gate answered 409[\s\S]*refund_account_closed[\s\S]*simulation_failed/);
  });

  it("passes over a gate that takes the close and never answers, once closeWaitSeconds have gone by", async () => {
    const session = await openSession({ closeWaitSeconds: 0.3 });
    gate.gateSilent = true;

    expect(await session.close()).toEqual(SPONSORED);
  });

  it("passes over a closeUrl that never answers, after requestTimeoutMs, and says why", async () => {
    const session = await openSession();
    gate.gateDown = true;
    gate.facilitatorSilent = true;

    await expect(session.close()).rejects.toThrow(/sponsored close failed \(.*timeout[\s\S]*runs to the end of its paid time/);
  });

  it("shares one chain between overlapping calls: one close is sent, and both get its receipt", async () => {
    const session = await openSession();
    gate.gateDown = true;

    const [first, second] = await Promise.all([session.close(), session.close()]);

    expect(first).toEqual(SPONSORED);
    expect(second).toEqual(SPONSORED);
    expect(gate.sponsored).toHaveLength(1);
  });
});
```

Run: `pnpm --filter @lxfoundry/stint-client test fallback.test.ts`
Expected: FAIL, every test. The type check of vitest's transform does not run, so the file loads; the first test fails on
the missing `via`, the test of a gate that never answers on vitest's 5 s limit (today's close has no time limit), and
every other test with `Close failed (HTTP …)` or a `fetch failed` rejection, or a message that does not match.

- [ ] **Step 3: Add `closeWaitSeconds` to the policy**

In `packages/client/src/policy.ts`, in the interface `Policy`, replace:

```ts
  /** Default 300. */
  readonly maxMinSeconds?: number;
}
```

with:

```ts
  /** Default 300. */
  readonly maxMinSeconds?: number;
  /**
   * Seconds to wait for a close that the gate reports pending (`202`) before the next step of the close fallback chain
   * (spec §9.2, §9.3). Default 180: it must exceed two blockhash lifetimes, the gate's close and its one resend. A request
   * that sends a close, and has no answer within it, is given up too.
   */
  readonly closeWaitSeconds?: number;
}
```

- [ ] **Step 4: Implement the first two steps of the chain**

In `packages/client/src/client.ts`, replace the import from `@lxfoundry/stint-x402`:

```ts
import {
  HEADERS,
  X402_VERSION,
  buildOpenTransaction,
  buildTopUpTransaction,
  createSessionToken,
  decodePaymentRequiredHeader,
  encodePaymentSignatureHeader,
  readElapsedRequirements,
  type ElapsedRequirements,
  type PaymentPayload,
  type PaymentRequired,
  type SessionStatus,
  type TokenPurpose,
} from "@lxfoundry/stint-x402";
```

with:

```ts
import {
  HEADERS,
  X402_VERSION,
  buildOpenTransaction,
  buildSponsoredClose,
  buildTopUpTransaction,
  createSessionToken,
  decodePaymentRequiredHeader,
  encodePaymentSignatureHeader,
  readCloseInfo,
  readElapsedRequirements,
  type ElapsedRequirements,
  type PaymentPayload,
  type PaymentRequired,
  type SessionStatus,
  type SponsoredCloseResponse,
  type TokenPurpose,
} from "@lxfoundry/stint-x402";
```

Replace:

```ts
/** `paid` and `refunded` are absent when the gate could not read the `Closed` event of a confirmed close. */
export interface CloseReceipt {
  readonly paid?: bigint;
  readonly refunded?: bigint;
  readonly transaction: string;
}
```

with:

```ts
/**
 * Which step of the close fallback chain closed the session (spec §9.3): the gate's close, the facilitator's sponsored
 * close through the offer's `closeUrl`, or a close the client sent to the chain itself.
 */
export type CloseVia = "gate" | "sponsored" | "unilateral";

/** `paid` and `refunded` are absent when the amounts of a confirmed close could not be read, or a pending close was not. */
export interface CloseReceipt {
  readonly paid?: bigint;
  readonly refunded?: bigint;
  readonly transaction: string;
  readonly via: CloseVia;
}
```

In the interface `StintSession`, replace:

```ts
  close(): Promise<CloseReceipt>;
```

with:

```ts
  /**
   * Closes the session through the close fallback chain (spec §9.3), and says which step closed it. Throws when the
   * session is already closed (`404`), and when no step can close it: the session then runs to the end of its paid time,
   * and a later call tries again. Overlapping calls share one chain.
   */
  close(): Promise<CloseReceipt>;
```

In the interface `ClientOptions`, replace:

```ts
  /** Milliseconds; runs the period budget. Default `Date.now`. */
  readonly now?: () => number;
}
```

with:

```ts
  /** Milliseconds; runs the period budget. Default `Date.now`. */
  readonly now?: () => number;
  /** Milliseconds between reads of the gate's status while its close is pending (spec §9.3). Default 1,000. */
  readonly closePollMs?: number;
  /**
   * Milliseconds after which a read of the close fallback chain (the gate's status, `GET closeUrl`) that has no answer
   * is given up (spec §9.3). Default 10,000. A request that sends a close waits `closeWaitSeconds` at most.
   */
  readonly requestTimeoutMs?: number;
}
```

Replace:

```ts
const describeBody = (body: unknown) => (typeof body === "string" ? body : JSON.stringify(body));
```

with:

```ts
const describeBody = (body: unknown) => (typeof body === "string" ? body : JSON.stringify(body));

/** An error's message, with its cause's: `fetch` reports a host that cannot be reached as "fetch failed", and why in its cause. */
const describeError = (error: unknown): string =>
  error instanceof Error ? `${error.message}${error.cause instanceof Error ? `: ${error.cause.message}` : ""}` : String(error);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const DEFAULT_CLOSE_WAIT_SECONDS = 180;
const DEFAULT_CLOSE_POLL_MS = 1_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

/** The receipt of a close whose answer reports it: the gate's `200`, or the facilitator's successful sponsored close. */
function receiptFrom(body: unknown, via: CloseVia): CloseReceipt {
  const answer = body as { paid?: string; refunded?: string; transaction: string };
  return {
    ...(answer.paid === undefined ? {} : { paid: BigInt(answer.paid) }),
    ...(answer.refunded === undefined ? {} : { refunded: BigInt(answer.refunded) }),
    transaction: answer.transaction,
    via,
  };
}

/**
 * What one step of the close fallback chain came to (spec §9.3). `pending`, on a step that did not close the session, is
 * a close it sent that may still land.
 */
type CloseStep =
  | { readonly kind: "closed"; readonly receipt: CloseReceipt }
  /** A check found the session closed. */
  | { readonly kind: "gone"; readonly reason: string; readonly pending?: CloseReceipt }
  /** The step did not close the session. */
  | { readonly kind: "next"; readonly reason: string; readonly pending?: CloseReceipt };
```

In `createStintClient`, replace:

```ts
  const now = options.now ?? Date.now;
```

with:

```ts
  const now = options.now ?? Date.now;
  const closePollMs = options.closePollMs ?? DEFAULT_CLOSE_POLL_MS;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
```

In `sessionFrom`, replace:

```ts
    let closed = false;
    let paidUntil = opened.paidUntil;
    let cost = deposit;
    const session: StintSession = {
```

with:

```ts
    let closed = false;
    let paidUntil = opened.paidUntil;
    let cost = deposit;
    /** The close fallback chain in flight: overlapping calls of `close()` share it. */
    let closing: Promise<CloseReceipt> | undefined;
    const closeWaitSeconds = options.policy.closeWaitSeconds ?? DEFAULT_CLOSE_WAIT_SECONDS;
    /** How long a request that sends a close may go unanswered: `AbortSignal.timeout` takes whole milliseconds. */
    const closeWaitMs = Math.ceil(closeWaitSeconds * 1000);

    /**
     * The close fallback chain (spec §9.3): the gate's close, then the facilitator's sponsored close through the offer's
     * `closeUrl`. A step that finds the session closed ends the chain, since a close from an earlier step can land late: a
     * close that an earlier step passed on is then the receipt. When no step closes the session, it runs to the end of its
     * paid time.
     */
    async function closeWithFallbacks(): Promise<CloseReceipt> {
      const passed: string[] = [];
      const pending: CloseReceipt[] = [];
      for (const step of [closeThroughGate, closeThroughFacilitator]) {
        const outcome = await step();
        if (outcome.kind === "closed") return outcome.receipt;
        if (outcome.pending) pending.push(outcome.pending);
        if (outcome.kind === "gone") return alreadyClosed(pending);
        passed.push(outcome.reason);
      }
      throw notClosed(passed, pending);
    }

    /**
     * The session is closed: the latest close passed on by an earlier step is the receipt, without amounts. With none,
     * another party closed the session: that is reported, and the session counts as closed.
     */
    function alreadyClosed(pending: readonly CloseReceipt[]): CloseReceipt {
      const latest = pending.at(-1);
      if (latest) return latest;
      closed = true;
      throw new StintError("The session is already closed", 404);
    }

    /** No step closed the session: why each was passed over, the closes sent that may still land, and what that costs. */
    function notClosed(passed: readonly string[], pending: readonly CloseReceipt[]): StintError {
      const sent = pending.map((close) => `${close.transaction} (${close.via})`).join(", ");
      return new StintError(
        `The session could not be closed: ${passed.join("; ")}.${sent ? ` A close sent may still land: ${sent}.` : ""} ` +
          `It runs to the end of its paid time, which is charged in full, unless ${sent ? "that close lands or " : ""}a later close succeeds`,
      );
    }

    /**
     * Step 1: the gate's close. `200` is the receipt, and a `202` is waited for. Any other answer moves the chain on, as
     * does a gate that cannot be reached or does not answer within `closeWaitSeconds`: a `404` (it does not track the
     * session, as after a restart), a `5xx`, a `401` (a token it refuses, say from a skewed clock), and a refusal of the
     * close itself, such as `409`, which the later steps judge for themselves.
     */
    async function closeThroughGate(): Promise<CloseStep> {
      const authorization = `Bearer ${await token("close")}`;
      let status: number;
      let body: unknown;
      try {
        const response = await fetch(`${gateUrl}/sessions/${opened.session}/close`, {
          method: "POST",
          headers: { authorization },
          signal: AbortSignal.timeout(closeWaitMs),
        });
        status = response.status;
        body = await readBody(response);
      } catch (error) {
        return { kind: "next", reason: `the gate cannot be reached (${describeError(error)})` };
      }
      if (status === 200) return { kind: "closed", receipt: receiptFrom(body, "gate") };
      if (status === 202) return awaitGateClose(body);
      return { kind: "next", reason: `the gate answered ${status}: ${describeBody(body)}` };
    }

    /**
     * The gate's close is pending (`202`): its status is read every `closePollMs` until it answers `404`, for at most
     * `closeWaitSeconds`. A `404` means the session is closed, and the pending close is the receipt, without amounts. Past
     * the wait the chain moves on, passing the pending close on, and the next step first checks that the session is still
     * open.
     */
    async function awaitGateClose(body: unknown): Promise<CloseStep> {
      const transaction = (body as { transaction?: unknown } | null)?.transaction;
      const still = typeof transaction === "string" ? { pending: { transaction, via: "gate" as const } } : {};
      const deadline = Date.now() + closeWaitMs;
      for (;;) {
        try {
          const response = await fetch(`${gateUrl}/sessions/${opened.session}`, { signal: AbortSignal.timeout(requestTimeoutMs) });
          await readBody(response);
          if (response.status === 404) return { kind: "gone", reason: "the gate's status finds no session", ...still };
        } catch {
          // A gate that cannot be reached now may answer at the next read.
        }
        if (Date.now() >= deadline) {
          return { kind: "next", reason: `the gate's close stayed pending for ${closeWaitSeconds} s`, ...still };
        }
        await sleep(closePollMs);
      }
    }

    /**
     * Step 2: the facilitator's sponsored close (spec §6.1, §9.3). `GET closeUrl?session=` says whether the session is
     * still open (`404 unknown_session`: it is closed) and gives the fee payer, a blockhash and the session's fields. The
     * client builds the close from them, signs it as the session's authority, and posts it. Any failure moves the chain on:
     * the facilitator cannot be reached or does not answer in time, answers something else, or does not close it.
     */
    async function closeThroughFacilitator(): Promise<CloseStep> {
      const closeUrl = offer.extra.closeUrl;
      try {
        const lookup = await fetch(`${closeUrl}?session=${opened.session}`, { signal: AbortSignal.timeout(requestTimeoutMs) });
        const found = await readBody(lookup);
        if (lookup.status === 404 && (found as { error?: unknown } | null)?.error === "unknown_session") {
          return { kind: "gone", reason: "GET closeUrl finds no session" };
        }
        const info = lookup.status === 200 ? readCloseInfo(found) : undefined;
        if (!info) return { kind: "next", reason: `GET closeUrl answered ${lookup.status}: ${describeBody(found)}` };
        // Refuses a body that describes another session or program, or names this signer as the fee payer (spec S14).
        const transaction = await buildSponsoredClose(info, { session: address(opened.session), closer: options.signer });
        const posted = await fetch(closeUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ transaction }),
          signal: AbortSignal.timeout(closeWaitMs),
        });
        const answer = (await readBody(posted)) as SponsoredCloseResponse;
        if (posted.status === 200 && answer.success) return { kind: "closed", receipt: receiptFrom(answer, "sponsored") };
        const reason = `the facilitator did not close it (HTTP ${posted.status}: ${describeBody(answer)})`;
        // A close the facilitator sent and could not confirm may still land: if a later check finds the session closed, it is the receipt.
        const unconfirmed = posted.status === 200 && !answer.success && answer.errorReason === "settlement_pending";
        return { kind: "next", reason, ...(unconfirmed ? { pending: { transaction: answer.transaction, via: "sponsored" as const } } : {}) };
      } catch (error) {
        return { kind: "next", reason: `the facilitator's sponsored close failed (${describeError(error)})` };
      }
    }

    const session: StintSession = {
```

Replace the method `close` of the session:

```ts
      async close() {
        const response = await fetch(`${gateUrl}/sessions/${opened.session}/close`, {
          method: "POST",
          headers: { authorization: `Bearer ${await token("close")}` },
        });
        const body = await readBody(response);
        if (response.status !== 200) throw new StintError(`Close failed (HTTP ${response.status}): ${describeBody(body)}`, response.status, body);
        closed = true;
        const receipt = body as { paid?: string; refunded?: string; transaction: string };
        return {
          ...(receipt.paid === undefined ? {} : { paid: BigInt(receipt.paid) }),
          ...(receipt.refunded === undefined ? {} : { refunded: BigInt(receipt.refunded) }),
          transaction: receipt.transaction,
        };
      },
```

with:

```ts
      async close() {
        // Overlapping calls share one chain: two chains would each send a close, and only one can land.
        closing ??= closeWithFallbacks().finally(() => {
          closing = undefined;
        });
        const receipt = await closing;
        closed = true;
        return receipt;
      },
```

In `packages/client/src/index.ts`, replace:

```ts
  type CloseReceipt,
```

with:

```ts
  type CloseReceipt,
  type CloseVia,
```

- [ ] **Step 5: Give the existing receipts `via`**

In `packages/client/test/client.test.ts`, replace:

```ts
    expect(await session.close()).toEqual({ paid: 8_000n, refunded: 22_000n, transaction: "sig" });
```

with:

```ts
    expect(await session.close()).toEqual({ paid: 8_000n, refunded: 22_000n, transaction: "sig", via: "gate" });
```

and replace:

```ts
    expect(await session.close()).toEqual({ transaction: "sig" });
```

with:

```ts
    expect(await session.close()).toEqual({ transaction: "sig", via: "gate" });
```

In `packages/client/test/tools.test.ts`, replace:

```ts
            closes.push({ id, settle: (error) => (error ? reject(error) : resolve({ transaction: `close-of-${id}` })) });
```

with:

```ts
            closes.push({ id, settle: (error) => (error ? reject(error) : resolve({ transaction: `close-of-${id}`, via: "gate" })) });
```

and replace:

```ts
      settle: () => pending.shift()?.({ transaction: "sig" }),
```

with:

```ts
      settle: () => pending.shift()?.({ transaction: "sig", via: "gate" }),
```

The tools' outputs (spec section 9.5: `paid`, `refunded`, `transaction`) do not change.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm --filter @lxfoundry/stint-client test && pnpm typecheck`
Expected: PASS, every test of the client's suite, the seventeen new ones included; no type error in the workspace (the
MCP server and the example agent use the tools' outputs, which are unchanged).

- [ ] **Step 7: Mutation check**

One at a time, make each change below, run `pnpm --filter @lxfoundry/stint-client test fallback.test.ts`, check that it
fails where stated, and undo it:
1. In `closeThroughGate`, replace the last line, `return { kind: "next", reason: … };`, with
   `throw new StintError(\`Close failed (HTTP ${status})\`, status, body);`: "moves on to closeUrl when the gate refuses
   its close with 401" (and with 409) fails, and so does "closes through closeUrl when the gate answers 404".
2. In `closeThroughFacilitator`, delete the `if (lookup.status === 404 && …) { return { kind: "gone", … }; }` block:
   "reports a session that closeUrl finds closed" fails, and so does "returns a close the gate reported pending when
   closeUrl then finds the session closed".
3. In `awaitGateClose`, `if (response.status === 404)` → `if (response.status === 410)`: "waits for a close the gate
   reports pending" fails on vitest's 5 s limit (the client keeps reading the status for `closeWaitSeconds`, 60 s).
4. In `alreadyClosed`, delete `closed = true;`: "reports a session that closeUrl finds closed" fails (disposing it
   throws).
5. In `alreadyClosed`, delete `if (latest) return latest;`: "returns a close the gate reported pending when closeUrl then
   finds the session closed" fails (`404`), and so does "waits for a close the gate reports pending".
6. In `closeThroughFacilitator`, delete `signal: AbortSignal.timeout(requestTimeoutMs)` from the `GET`: "passes over a
   closeUrl that never answers" fails on vitest's 5 s limit.
7. In `close`, `closing ??=` → `closing =`: "shares one chain between overlapping calls" fails (two sponsored closes).

- [ ] **Step 8: Update the spec**

In `docs/specs/stint-system.md`, section 9.3, replace:

```markdown
4. otherwise, the session runs to expiry and the deposit is spent in full.
```

with:

```markdown
4. otherwise, the session runs to expiry and the deposit is spent in full.

The client moves to the next step on any answer to the gate's close but `200` and `202`, and when the gate cannot be
reached: a refusal of the close itself, such as `409`, is met again by the later steps, which judge the close for
themselves. It also moves on when the facilitator cannot be reached, answers `GET closeUrl` with anything but the
session's fields or `404 unknown_session`, or does not close the session. A request with no answer is given up: a read
after a few seconds, a request that sends a close after `closeWaitSeconds`. A step whose close may still land (a `202`
past `closeWaitSeconds`, or `settlement_pending` from the facilitator) passes its signature on. A check that finds the
session closed ends the chain: the gate's status or `GET closeUrl` answering `404 unknown_session`, or no session of the
program at its address when the client reads it with its `rpc`. A client with an `rpc` takes only its own read for it,
and goes on past the gate's or the facilitator's word. A close passed on is then the receipt: with an `rpc`, the one the
chain shows landed, with its amounts; otherwise the latest. With none, the client reports the session closed by another
party. When no step closes the session, the client names the closes that may still land. Step 3 needs an `rpc`, and the
authority holding the fee of one signature on top of a rent-exempt balance, since a fee payer may not drop below it.
Overlapping closes of one session share one chain. The receipt says which step closed the session.
```

Run: `grep -c "The receipt says which step closed the session" docs/specs/stint-system.md`
Expected: `1`.

- [ ] **Step 9: Commit**

```bash
git add packages/client/src/client.ts packages/client/src/policy.ts packages/client/src/index.ts packages/client/test/gate.ts packages/client/test/fallback.test.ts packages/client/test/client.test.ts packages/client/test/tools.test.ts docs/specs/stint-system.md
git commit -m "Close through the facilitator's closeUrl when the gate cannot, after waiting for a pending gate close"
```

---

### Task 5: The client's own close on the chain

Step 3 of the fallback chain (spec section 9.3): with an `rpc` in its options, the client reads the session account
(none of the program's at the address: the session is closed, which ends the chain), checks that the signer holds the
fee of one signature on top of a rent-exempt balance (a fee payer may not drop below it), and sends a `Standard` close it
builds itself from the stored fields, signed by its signer as both the session's authority and the fee payer. A close
that does not confirm moves the chain on; one still pending is passed on.

With an `rpc`, the client takes only its own read for a closed session: when the gate's status or `GET closeUrl` reports
the session closed, the chain goes on to step 3 instead of ending, and step 3's read decides. And when the session is
found closed with closes of its own pending, the client looks the close up on the chain (`findClose`, Task 1): the
pending close it matches is the receipt, with its amounts; a close that matches none of them was another party's.

**Files:**
- Modify: `packages/client/src/client.ts`
- Create: `packages/client/test/rpc.ts`
- Modify: `packages/client/test/fallback.test.ts`

**Interfaces:**
- Consumes: `buildCloseTransaction`, `fetchClosedEvent`, `findClose`, `waitForConfirmation` (`@lxfoundry/stint-x402`);
  `decodeSession`, `CloseKind`, `STINT_PROGRAM_ADDRESS`, `ClosedEvent` (`@lxfoundry/stint-program-client`);
  `CloseStep`, `closeWithFallbacks`, `alreadyClosed` (Task 4).
- Produces: `ClientOptions` gains `readonly rpc?: Rpc<SolanaRpcApi>`; in the tests, `fakeRpc(node: FakeNode)`,
  `fakeSignature(fill)`, `SENT_SIGNATURE` and `RENT_EXEMPT_LAMPORTS` (`packages/client/test/rpc.ts`).

- [ ] **Step 1: Write a fake node**

Create `packages/client/test/rpc.ts`:

```ts
import { getBase58Decoder, getBase64Decoder, type Rpc, type SolanaRpcApi } from "@solana/kit";
import {
  EVENT_IX_TAG,
  STINT_PROGRAM_ADDRESS,
  getClosedEventEncoder,
  getSessionEncoder,
  type ClosedEventArgs,
  type SessionArgs,
} from "@lxfoundry/stint-program-client";

/** A well-formed signature, one for each `fill`: the scheme package checks the form of the signatures a node lists. */
export const fakeSignature = (fill: number) => getBase58Decoder().decode(new Uint8Array(64).fill(fill));

/** The signature the fake node gives every transaction sent to it. */
export const SENT_SIGNATURE = fakeSignature(7);

/** The rent-exempt minimum of an account with no data, as the fake node reports it. */
export const RENT_EXEMPT_LAMPORTS = 890_880n;

/** A node holding one session account, or none, and the signer's balance. It confirms every transaction it accepts. */
export interface FakeNode {
  /** The session at the address the client reads, or none. */
  session?: SessionArgs;
  /** What the signer holds. */
  lamports: bigint;
  /** What `sendTransaction` throws, as a node refusing a transaction in preflight does. */
  refuse?: Error;
  /** The `Closed` event of the close it accepted; without one, the node cannot return that transaction. */
  closed?: ClosedEventArgs;
  /** The signature that the session address's transactions list shows, the close that `closed` describes; none without it. */
  landed?: string;
  /** The transactions accepted, as base64 wire transactions. */
  readonly sent: string[];
}

const answer = <T>(value: T) => ({ send: async () => value });

export function fakeRpc(node: FakeNode): Rpc<SolanaRpcApi> {
  return {
    getAccountInfo: () => answer({ context: { slot: 1n }, value: node.session ? accountHolding(node.session) : null }),
    getBalance: () => answer({ context: { slot: 1n }, value: node.lamports }),
    getMinimumBalanceForRentExemption: () => answer(RENT_EXEMPT_LAMPORTS),
    getSignaturesForAddress: () =>
      answer(node.landed ? [{ signature: node.landed, err: null, slot: 1n, memo: null, blockTime: null, confirmationStatus: "confirmed" }] : []),
    getLatestBlockhash: () =>
      answer({ context: { slot: 1n }, value: { blockhash: "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N", lastValidBlockHeight: 100n } }),
    sendTransaction: (wire: string) => ({
      send: async () => {
        if (node.refuse) throw node.refuse;
        node.sent.push(wire);
        return SENT_SIGNATURE;
      },
    }),
    getSignatureStatuses: () => answer({ context: { slot: 1n }, value: [{ slot: 1n, confirmations: null, err: null, confirmationStatus: "confirmed" }] }),
    isBlockhashValid: () => answer({ context: { slot: 1n }, value: true }),
    getTransaction: () => answer(node.closed ? closeTransaction(node.closed) : null),
  } as unknown as Rpc<SolanaRpcApi>;
}

function accountHolding(session: SessionArgs) {
  const data = new Uint8Array(getSessionEncoder().encode(session));
  return { data: [getBase64Decoder().decode(data), "base64"], executable: false, lamports: 2_000_000n, owner: STINT_PROGRAM_ADDRESS, space: BigInt(data.length) };
}

/** A confirmed close as `getTransaction` returns it with `json` encoding: one inner `Closed` event. */
function closeTransaction(event: ClosedEventArgs) {
  const data = getBase58Decoder().decode(Uint8Array.from([...EVENT_IX_TAG, ...getClosedEventEncoder().encode(event)]));
  return {
    transaction: { message: { accountKeys: [STINT_PROGRAM_ADDRESS], instructions: [] } },
    meta: { err: null, innerInstructions: [{ index: 0, instructions: [{ programIdIndex: 0, accounts: [], data }] }] },
  };
}
```

- [ ] **Step 2: Write the failing tests**

In `packages/client/test/fallback.test.ts`, replace the imports:

```ts
import { generateKeyPairSigner, type KeyPairSigner } from "@solana/kit";
import { inspectTransaction } from "@lxfoundry/stint-x402";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StintError, createStintClient, type Policy, type StintSession } from "../src/index.js";
import { NETWORK, startTestGate, type TestGate } from "./gate.js";
```

with:

```ts
import { generateKeyPairSigner, type KeyPairSigner } from "@solana/kit";
import {
  CloseKind,
  STINT_PROGRAM_ADDRESS,
  StintInstruction,
  identifyStintInstruction,
  parseCloseInstruction,
  type ClosedEventArgs,
} from "@lxfoundry/stint-program-client";
import { inspectTransaction } from "@lxfoundry/stint-x402";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StintError, createStintClient, type Policy, type StintSession } from "../src/index.js";
import { NETWORK, startTestGate, type TestGate } from "./gate.js";
import { RENT_EXEMPT_LAMPORTS, SENT_SIGNATURE, fakeRpc, fakeSignature, type FakeNode } from "./rpc.js";
```

In the test "says the session runs to the end of its paid time when neither the gate nor the facilitator can close it",
insert after the line `expect((error as Error).message).toMatch(/sponsored close failed/);`:

```ts
    expect((error as Error).message).toMatch(/no rpc/);
```

Append to the end of the file:

```ts
describe("the client's own close on the chain (spec §9.3, step 3)", () => {
  let buyer: KeyPairSigner;
  let gate: TestGate;

  beforeEach(async () => {
    buyer = await generateKeyPairSigner();
    gate = await startTestGate(buyer.address);
  });

  afterEach(async () => {
    await gate.stop();
    expect(gate.escaped).toEqual([]);
  });

  /** The `Closed` event of the client's own close: 8,000 paid, 22,000 refunded. */
  const closedBy = (session: StintSession): ClosedEventArgs => ({
    session: session.id,
    kind: CloseKind.Standard,
    claimed: 0n,
    owed: 8_000n,
    refunded: 22_000n,
    redirected: 0n,
    closedBy: buyer.address,
    paidUntil: BigInt(gate.stored.startedAt) + 30n,
    at: BigInt(gate.stored.startedAt) + 8n,
  });

  /** A 30 s session on the test gate, for a client whose node is `node`; the gate and the facilitator then go down. */
  async function strandedSession(node: FakeNode): Promise<StintSession> {
    const client = createStintClient({ signer: buyer, policy, rpc: fakeRpc(node) });
    const session = await client.open(gate.url, { seconds: 30 });
    gate.gateDown = true;
    gate.facilitatorDown = true;
    return session;
  }

  it("closes the session itself when neither the gate nor the facilitator can: a Standard close by the authority, which also pays the fee", async () => {
    const node: FakeNode = { session: gate.stored, lamports: 1_000_000n, sent: [] };
    const session = await strandedSession(node);
    node.closed = closedBy(session); // the fake node reads `closed` when the close is fetched

    expect(await session.close()).toEqual({ paid: 8_000n, refunded: 22_000n, transaction: SENT_SIGNATURE, via: "unilateral" });

    expect(node.sent).toHaveLength(1);
    const close = inspectTransaction(node.sent[0]!)!;
    expect(close.feePayer).toBe(buyer.address);
    expect([...close.signed]).toEqual([buyer.address]);
    expect(close.instructions).toHaveLength(1);
    const instruction = close.instructions[0]!;
    expect(instruction.programAddress).toBe(STINT_PROGRAM_ADDRESS);
    expect(identifyStintInstruction(instruction.data!)).toBe(StintInstruction.Close);
    const parsed = parseCloseInstruction(instruction as Parameters<typeof parseCloseInstruction>[0]);
    expect(parsed.data.kind).toBe(CloseKind.Standard);
    expect(parsed.accounts.session.address).toBe(session.id);
    expect(parsed.accounts.closer.address).toBe(buyer.address);
  });

  it("sends nothing, and says the session runs to the end of its paid time, when the signer holds no SOL", async () => {
    const node: FakeNode = { session: gate.stored, lamports: 0n, sent: [] };
    const session = await strandedSession(node);

    await expect(session.close()).rejects.toThrow(/holds 0 lamports[\s\S]*runs to the end of its paid time/);
    expect(node.sent).toEqual([]);
  });

  it("ends the chain when the chain holds no session at the address: the session is closed", async () => {
    const node: FakeNode = { lamports: 1_000_000n, sent: [] };
    const session = await strandedSession(node);

    await expect(session.close()).rejects.toMatchObject({ status: 404, message: "The session is already closed" });
    expect(node.sent).toEqual([]);
  });

  it("reports a close that the node refuses, and the session runs on", async () => {
    const session = await strandedSession({ session: gate.stored, lamports: 1_000_000n, refuse: new Error("Transaction simulation failed"), sent: [] });

    const error = await session.close().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(StintError);
    expect((error as Error).message).toMatch(/own close failed \(Transaction simulation failed\)/);
    expect((error as Error).message).toMatch(/runs to the end of its paid time/);
  });

  it("sends nothing to the chain while the gate can close the session", async () => {
    const sent: string[] = [];
    const client = createStintClient({ signer: buyer, policy, rpc: fakeRpc({ session: gate.stored, lamports: 1_000_000n, sent }) });
    const session = await client.open(gate.url, { seconds: 30 });

    expect(await session.close()).toMatchObject({ via: "gate" });
    expect(sent).toEqual([]);
  });

  it("sends nothing when the signer holds less than the fee on top of a rent-exempt balance: a fee payer may not drop below it", async () => {
    const lamports = RENT_EXEMPT_LAMPORTS + 4_999n;
    const node: FakeNode = { session: gate.stored, lamports, sent: [] };
    const session = await strandedSession(node);

    const error = await session.close().catch((caught: unknown) => caught);

    expect((error as Error).message).toContain(`the signer holds ${lamports} lamports, less than`);
    expect(node.sent).toEqual([]);
  });

  it("checks on the chain a session that closeUrl reports closed, and closes it itself when the chain still holds it", async () => {
    const node: FakeNode = { session: gate.stored, lamports: 1_000_000n, sent: [] };
    const session = await strandedSession(node);
    gate.facilitatorDown = false;
    gate.facilitatorSessionOpen = false; // the facilitator's node, lagging or not, finds no session
    node.closed = closedBy(session);

    expect(await session.close()).toMatchObject({ transaction: SENT_SIGNATURE, via: "unilateral" });
    expect(node.sent).toHaveLength(1);
    expect(gate.sponsored).toEqual([]);
  });

  it("returns the pending close that the chain shows landed, with its amounts, when it finds the session closed", async () => {
    const node: FakeNode = { lamports: 1_000_000n, sent: [] };
    const client = createStintClient({ signer: buyer, policy: { ...policy, closeWaitSeconds: 0.2 }, closePollMs: 20, rpc: fakeRpc(node) });
    const session = await client.open(gate.url, { seconds: 30 });
    const [gateClose, sponsoredClose] = [fakeSignature(1), fakeSignature(2)];
    gate.closeSettlement = { success: false, errorReason: "settlement_pending", transaction: gateClose, network: NETWORK };
    gate.sponsoredAnswer = { success: false, errorReason: "settlement_pending", errorMessage: "not confirmed", transaction: sponsoredClose };
    node.closed = closedBy(session);
    node.landed = gateClose; // the gate's close landed, not the facilitator's, which was sent later

    expect(await session.close()).toEqual({ paid: 8_000n, refunded: 22_000n, transaction: gateClose, via: "gate" });
    expect(node.sent).toEqual([]);
  });
});
```

Run: `pnpm --filter @lxfoundry/stint-client test fallback.test.ts`
Expected: FAIL: the test "says the session runs to the end …" (no `no rpc` in the message), and in the new `describe`
every test but "sends nothing to the chain while the gate can close the session" (the client passes `rpc` on to nothing,
so the chain stops after step 2), which passes.

- [ ] **Step 3: Implement step 3**

In `packages/client/src/client.ts`, replace:

```ts
import { address, type Address, type KeyPairSigner } from "@solana/kit";
```

with:

```ts
import {
  address,
  fetchEncodedAccount,
  type Address,
  type Base64EncodedWireTransaction,
  type KeyPairSigner,
  type Rpc,
  type SolanaRpcApi,
} from "@solana/kit";
import { CloseKind, STINT_PROGRAM_ADDRESS, decodeSession, type ClosedEvent, type Session } from "@lxfoundry/stint-program-client";
```

In the import from `@lxfoundry/stint-x402`, replace:

```ts
  buildOpenTransaction,
  buildSponsoredClose,
```

with:

```ts
  buildCloseTransaction,
  buildOpenTransaction,
  buildSponsoredClose,
```

and replace:

```ts
  encodePaymentSignatureHeader,
  readCloseInfo,
```

with:

```ts
  encodePaymentSignatureHeader,
  fetchClosedEvent,
  findClose,
  readCloseInfo,
```

and replace:

```ts
  readElapsedRequirements,
  type ElapsedRequirements,
```

with:

```ts
  readElapsedRequirements,
  waitForConfirmation,
  type ElapsedRequirements,
```

In the interface `ClientOptions`, replace:

```ts
  readonly requestTimeoutMs?: number;
}
```

with:

```ts
  readonly requestTimeoutMs?: number;
  /**
   * A node, for the last step of the close fallback chain: a close the client sends to the chain itself, its fee paid by
   * the signer, which must hold SOL for it (spec §9.1, §9.3). With one, the client takes only its own read of the session
   * account for a closed session. Without one, a session that neither the gate nor the facilitator can close runs to the
   * end of its paid time.
   */
  readonly rpc?: Rpc<SolanaRpcApi>;
}
```

Replace:

```ts
const DEFAULT_CLOSE_POLL_MS = 1_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
```

with:

```ts
const DEFAULT_CLOSE_POLL_MS = 1_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
/**
 * The fee of a transaction with one signature. A fee payer may not drop below the rent-exempt minimum, so a signer must
 * hold this on top of it to send a close of its own.
 */
const SIGNATURE_FEE_LAMPORTS = 5_000n;
/** How the `Closed` event of the client's own close is read while the node does not return the transaction yet. */
const EVENT_READ_RETRY = { attempts: 5, delayMs: 200 };

/**
 * The session at `session`, read at `confirmed`, or undefined if no account of the program is there: anyone can send
 * lamports to the address of a closed session (S12), which leaves a wallet there, not a session.
 */
async function readOwnSession(rpc: Rpc<SolanaRpcApi>, session: Address): Promise<Session | undefined> {
  const account = await fetchEncodedAccount(rpc, session, { commitment: "confirmed" });
  if (!account.exists || account.programAddress !== STINT_PROGRAM_ADDRESS) return undefined;
  return decodeSession(account).data;
}

/** A close's amounts as a receipt reports them, from its `Closed` event: `paid` is all the receiver was paid for the session. */
const amountsOf = (event: ClosedEvent) => ({ paid: event.claimed + event.owed + event.redirected, refunded: event.refunded });
```

In `sessionFrom`, replace the function `closeWithFallbacks` and the function `alreadyClosed` after it, with their
comments:

```ts
    /**
     * The close fallback chain (spec §9.3): the gate's close, then the facilitator's sponsored close through the offer's
     * `closeUrl`. A step that finds the session closed ends the chain, since a close from an earlier step can land late: a
     * close that an earlier step passed on is then the receipt. When no step closes the session, it runs to the end of its
     * paid time.
     */
    async function closeWithFallbacks(): Promise<CloseReceipt> {
      const passed: string[] = [];
      const pending: CloseReceipt[] = [];
      for (const step of [closeThroughGate, closeThroughFacilitator]) {
        const outcome = await step();
        if (outcome.kind === "closed") return outcome.receipt;
        if (outcome.pending) pending.push(outcome.pending);
        if (outcome.kind === "gone") return alreadyClosed(pending);
        passed.push(outcome.reason);
      }
      throw notClosed(passed, pending);
    }

    /**
     * The session is closed: the latest close passed on by an earlier step is the receipt, without amounts. With none,
     * another party closed the session: that is reported, and the session counts as closed.
     */
    function alreadyClosed(pending: readonly CloseReceipt[]): CloseReceipt {
      const latest = pending.at(-1);
      if (latest) return latest;
      closed = true;
      throw new StintError("The session is already closed", 404);
    }
```

with:

```ts
    /**
     * The close fallback chain (spec §9.3): the gate's close, then the facilitator's sponsored close through the offer's
     * `closeUrl`, then a close the client sends to the chain itself. A step that finds the session closed ends the chain,
     * since a close from an earlier step can land late: a close that an earlier step passed on is then the receipt. With
     * an `rpc`, the client takes only its own read for it: the gate's or the facilitator's word moves the chain on to
     * step 3, which reads the account. When no step closes the session, it runs to the end of its paid time.
     */
    async function closeWithFallbacks(): Promise<CloseReceipt> {
      const passed: string[] = [];
      const pending: CloseReceipt[] = [];
      for (const step of [closeThroughGate, closeThroughFacilitator, closeOnChain]) {
        const outcome = await step();
        if (outcome.kind === "closed") return outcome.receipt;
        if (outcome.pending) pending.push(outcome.pending);
        if (outcome.kind === "gone" && (step === closeOnChain || !options.rpc)) return alreadyClosed(pending);
        passed.push(outcome.reason);
      }
      throw notClosed(passed, pending);
    }

    /**
     * The session is closed. A close passed on by an earlier step is the receipt: with the client's `rpc`, the one the
     * chain shows landed (`findClose`), with its amounts; without it, or while the chain shows no close yet, the latest,
     * without amounts. With none passed on, or when the close that landed is none of them, another party closed the
     * session: that is reported, and the session counts as closed.
     */
    async function alreadyClosed(pending: readonly CloseReceipt[]): Promise<CloseReceipt> {
      let mine = pending.at(-1);
      if (options.rpc && mine) {
        const landed = await findClose(options.rpc, address(opened.session)).catch(() => undefined);
        if (landed) {
          const match = pending.find((close) => close.transaction === landed.signature);
          mine = match && { ...match, ...amountsOf(landed.event) };
        }
      }
      if (mine) return mine;
      closed = true;
      throw new StintError("The session is already closed", 404);
    }
```

Insert, directly before `const session: StintSession = {` in `sessionFrom`:

```ts
    /**
     * Step 3: a close of the client's own, sent with its `rpc`, its fee paid by the signer (spec §9.1, §9.3). The session
     * account is read first: no session of the program at the address means it is closed, which ends the chain. The
     * signer must hold the fee on top of a rent-exempt balance. The close is a `Standard` close by the authority, built
     * from the stored fields, and nothing else. One that does not confirm moves the chain on; one still pending is passed
     * on.
     */
    async function closeOnChain(): Promise<CloseStep> {
      const rpc = options.rpc;
      if (!rpc) return { kind: "next", reason: "the client has no rpc to send a close of its own" };
      try {
        const stored = await readOwnSession(rpc, address(opened.session));
        if (!stored) return { kind: "gone", reason: "the chain holds no session at its address" };
        const { value: lamports } = await rpc.getBalance(options.signer.address, { commitment: "confirmed" }).send();
        const needed = SIGNATURE_FEE_LAMPORTS + (await rpc.getMinimumBalanceForRentExemption(0n, { commitment: "confirmed" }).send());
        if (lamports < needed) {
          return {
            kind: "next",
            reason: `the signer holds ${lamports} lamports, less than the fee of a close of its own on top of a rent-exempt balance (${needed})`,
          };
        }
        const { value: lifetime } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
        const transaction = await buildCloseTransaction({
          session: address(opened.session),
          stored,
          closer: options.signer,
          // The signer pays the fee: the one signature covers both roles.
          feePayer: options.signer.address,
          lifetime,
          kind: CloseKind.Standard,
        });
        const signature = await rpc
          .sendTransaction(transaction as Base64EncodedWireTransaction, { encoding: "base64", preflightCommitment: "confirmed" })
          .send();
        const confirmation = await waitForConfirmation(rpc, signature, lifetime.blockhash);
        if (confirmation !== "confirmed") {
          const still = confirmation === "pending" ? { pending: { transaction: signature, via: "unilateral" as const } } : {};
          return { kind: "next", reason: `the client's own close ${signature} is ${confirmation}`, ...still };
        }
        const event = await fetchClosedEvent(rpc, signature, EVENT_READ_RETRY);
        return { kind: "closed", receipt: { ...(event ? amountsOf(event) : {}), transaction: signature, via: "unilateral" } };
      } catch (error) {
        return { kind: "next", reason: `the client's own close failed (${describeError(error)})` };
      }
    }

```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @lxfoundry/stint-client test && pnpm --filter @lxfoundry/stint-client typecheck`
Expected: PASS, every test of the client's suite; no type error.

- [ ] **Step 5: Mutation check**

One at a time, make each change below, run `pnpm --filter @lxfoundry/stint-client test fallback.test.ts`, check that it
fails where stated, and undo it:
1. `feePayer: options.signer.address` → `feePayer: address(stored.rentPayer)`: "closes the session itself …" fails (the
   fee payer is not the buyer, and its signature is missing).
2. `lamports < needed` → `lamports < SIGNATURE_FEE_LAMPORTS`: "sends nothing when the signer holds less than the fee on
   top of a rent-exempt balance" fails (a close is sent).
3. In `readOwnSession`, delete `|| account.programAddress !== STINT_PROGRAM_ADDRESS`: no test fails, because the fake
   node's account is the program's. Undo it anyway; the check guards the case S12 describes, which the chain itself
   shows only on a real network.
4. `kind: CloseKind.Standard` → `kind: CloseKind.AtExpiry`: "closes the session itself …" fails.
5. In `closeWithFallbacks`, `outcome.kind === "gone" && (step === closeOnChain || !options.rpc)` →
   `outcome.kind === "gone"`: "checks on the chain a session that closeUrl reports closed" fails (`404`).
6. In `alreadyClosed`, `pending.find((close) => close.transaction === landed.signature)` → `pending.at(-1)`: "returns
   the pending close that the chain shows landed" fails (the facilitator's close is returned).

- [ ] **Step 6: Commit**

```bash
git add packages/client/src/client.ts packages/client/test/rpc.ts packages/client/test/fallback.test.ts
git commit -m "Close a session on the chain with the client's own rpc and SOL when the gate and the facilitator cannot"
```

---

### Task 6: Scenario 24, the gate unreachable at close

Spec section 12.7: "The gate is unreachable when the buyer closes: the client's fallback (section 9.3) closes through
`closeUrl`; refund as in scenario 1." The buyer opens through the gate, the harness stops the gate, and the buyer's
client, which has no node and no SOL, closes through the facilitator's sponsored close. Scenario 1's checks are written
again as a shared helper for any buyer's close, which scenario 25 uses too; scenario 1 itself is left as it is.

**Files:**
- Modify: `conformance/src/sessions.ts`
- Create: `conformance/src/scenarios/24-gate-unreachable-at-close.ts`
- Modify: `conformance/src/catalogue.ts`, `conformance/test/catalogue.test.ts`, `e2e/test/local-target.test.ts`

**Interfaces:**
- Consumes: `readOpenedSession` (Task 3); `whileGateStopped` (`conformance/src/scenarios/26-expired-session-nobody-closes.ts`);
  `CloseReceipt.via` (Task 4); `dueAt`, `CloseKind`, `ClosedEvent`; `fetchClosedEvent`, `tokenBalanceChanges`,
  `associatedTokenAddress`.
- Produces, in `conformance/src/sessions.ts`: `interface BuyersClose { signature; session; stored; buyer; reported? }` and
  `expectRefunded(context: ScenarioContext, close: BuyersClose): Promise<ClosedEvent>`, the checks of scenario 1 on any
  buyer's close.

- [ ] **Step 1: Add the checks of scenario 1 to `sessions.ts`**

In `conformance/src/sessions.ts`, replace the imports:

```ts
import type { Address } from "@solana/kit";
import { fetchMaybeSession, paidUntil, type Session } from "@lxfoundry/stint-program-client";
import { associatedTokenAddress } from "@lxfoundry/stint-x402";
import { expectTrue } from "./assert.js";
import { readUntil } from "./reads.js";
import type { DirectSession, ScenarioContext } from "./types.js";
```

with:

```ts
import type { Address } from "@solana/kit";
import { CloseKind, dueAt, fetchMaybeSession, paidUntil, type ClosedEvent, type Session } from "@lxfoundry/stint-program-client";
import { associatedTokenAddress, fetchClosedEvent, tokenBalanceChanges } from "@lxfoundry/stint-x402";
import { expectEqual, expectTrue } from "./assert.js";
import { readUntil } from "./reads.js";
import type { Buyer, DirectSession, ScenarioContext } from "./types.js";
```

Append:

```ts
/** A buyer's close of its session, as `expectRefunded` checks it. */
export interface BuyersClose {
  readonly signature: string;
  readonly session: Address;
  /** The session as the program stored it at the open. */
  readonly stored: Session;
  readonly buyer: Buyer;
  /** The amounts the client's receipt reported, when it reported them. */
  readonly reported?: { readonly paid?: bigint; readonly refunded?: bigint };
}

/**
 * Checks a buyer's close as scenario 1 does (spec §12.7): a `Standard` close; `paid = due` and `refunded = deposit − due`,
 * where `due` follows from the chain's clock at the close (spec §4.2); the receiver gains `due` and the buyer `deposit −
 * due` in the close's own transaction (spec §12.2, "Measuring money"), the scenario having made no claim; the receipt, if
 * it carries amounts, says the same; and the session account is closed. Returns the close's `Closed` event.
 */
export async function expectRefunded(context: ScenarioContext, close: BuyersClose): Promise<ClosedEvent> {
  const { signature, session, stored, buyer, reported } = close;
  const event = await fetchClosedEvent(context.rpc, signature, context.readRetry);
  expectTrue(event, "the close emitted Closed");
  expectEqual(event.kind, CloseKind.Standard, "the buyer's close is a Standard close");
  const due = dueAt(stored, event.at);
  expectEqual(event.claimed + event.owed + event.redirected, due, "paid = due");
  expectEqual(event.refunded, stored.deposited - due, "refunded = deposit − due");
  if (reported?.paid !== undefined) expectEqual(reported.paid, due, "the receipt's paid = due");
  if (reported?.refunded !== undefined) expectEqual(reported.refunded, stored.deposited - due, "the receipt's refunded = deposit − due");
  const changes = await tokenBalanceChanges(context.rpc, signature, context.readRetry);
  expectEqual(changes.get(await associatedTokenAddress(stored.receiver, stored.mint)), due, "the receiver's gain in the close");
  expectEqual(changes.get(buyer.usdcAccount), stored.deposited - due, "the buyer's refund in the close");
  const readSession = () => fetchMaybeSession(context.rpc, session, { commitment: "confirmed" });
  expectTrue(!(await readUntil(context.readRetry, readSession, (read) => !read.exists)).exists, "the session account is closed");
  return event;
}
```

Run: `pnpm --filter @lxfoundry/stint-conformance typecheck`
Expected: no type error.

- [ ] **Step 2: Write the scenario, as `pending`**

Create `conformance/src/scenarios/24-gate-unreachable-at-close.ts`:

```ts
import { expectEqual, sleep } from "../assert.js";
import { buyerClient, sessionSeconds } from "../helpers.js";
import { expectRefunded, readOpenedSession } from "../sessions.js";
import type { ScenarioContext } from "../types.js";
import { whileGateStopped } from "./26-expired-session-nobody-closes.js";

/**
 * Scenario 24 (spec §12.7): the gate cannot be reached when the buyer closes. The client's close fallback (spec §9.3)
 * closes through the offer's `closeUrl`: the facilitator's sponsored close, which the client builds from `GET /close` and
 * signs as the session's authority. The buyer holds no SOL and its client has no node, so no other step could close it.
 * Refund as in scenario 1.
 */
export async function gateUnreachableAtClose(context: ScenarioContext): Promise<void> {
  const stack = context.stack;
  if (!stack) throw new Error("scenario 24 needs a target that provides stack control");
  const buyer = await context.newBuyer(100_000n); // the session costs 30,000 (40,000 on devnet)
  const session = await buyerClient(buyer).open(context.gateUrl, { seconds: sessionSeconds(context.target, 30) });
  // A connection keeps the gate's idle timer from closing the session before the gate stops (spec §7.3); the stop drops it.
  const socket = await session.connect();
  socket.on("error", () => {});
  const stored = await readOpenedSession(context, session.id);
  expectEqual(stored.deposited, session.cost, "the deposit credited at open");

  const receipt = await whileGateStopped(stack, async () => {
    // Past the minimum, as in scenario 1, so that the charge is normally the time used rather than minSeconds.
    await sleep((stored.minSeconds + 2) * 1_000);
    return session.close();
  });
  socket.terminate();

  expectEqual(receipt.via, "sponsored", "the client closed through closeUrl, the gate being unreachable");
  const event = await expectRefunded(context, { signature: receipt.transaction, session: session.id, stored, buyer, reported: receipt });
  expectEqual(event.closedBy, buyer.signer.address, "the close was signed by the buyer, as the session's authority");
}
```

In `conformance/src/catalogue.ts`, insert the import in numeric order (before the import of scenario 26's module):

```ts
import { gateUnreachableAtClose } from "./scenarios/24-gate-unreachable-at-close.js";
```

and replace:

```ts
  pending(24, "The gate is unreachable when the buyer closes", ["stack"], "ownStack"),
```

with:

```ts
  pending(24, "The gate is unreachable when the buyer closes", ["stack"], "ownStack", gateUnreachableAtClose),
```

Run: `pnpm --filter @lxfoundry/stint-conformance typecheck && pnpm e2e:local`
Expected: no type error; the report lists scenario 24 as `pending` with result `pass`, flagged as passing while pending;
the run exits 0, and every scenario after 24 passes too (the gate is back).

- [ ] **Step 3: Make scenario 24 `required`**

In `conformance/src/catalogue.ts`, replace:

```ts
  pending(24, "The gate is unreachable when the buyer closes", ["stack"], "ownStack", gateUnreachableAtClose),
```

with:

```ts
  required(24, "The gate is unreachable when the buyer closes", gateUnreachableAtClose, ["stack"], "ownStack"),
```

In `conformance/test/catalogue.test.ts` and `e2e/test/local-target.test.ts`, add `24` to `REQUIRED`, in numeric order
(after Task 3: `[1, 2, 3, 4, 7, 9, 15, 16, 22, 24, 26, 34]`). In the comment above `REQUIRED` in
`e2e/test/local-target.test.ts`, add "24 about 9 s".

Run: `pnpm --filter @lxfoundry/stint-conformance test && pnpm e2e:local`
Expected: PASS; every `required` scenario passes.

- [ ] **Step 4: Commit**

```bash
git add conformance/src/sessions.ts conformance/src/scenarios/24-gate-unreachable-at-close.ts conformance/src/catalogue.ts conformance/test/catalogue.test.ts e2e/test/local-target.test.ts
git commit -m "Add scenario 24, a close through closeUrl while the gate is unreachable, and make it required"
```

---

### Task 7: Stack control of the facilitator, and SOL for a buyer

Scenario 25 needs the facilitator out of reach while the gate is, and a buyer that holds SOL. The harness gains both:
`stopFacilitator` and `startFacilitator` on stack control (the facilitator starts again on the port it had, so that the
gate's facilitator client and the offers' `closeUrl` stay valid; Kora keeps running), and `fundSol` on the scenario
context.

**Files:**
- Modify: `conformance/src/types.ts`
- Modify: `conformance/test/expired-session-nobody-closes.test.ts`
- Modify: `e2e/src/targets/services.ts`, `e2e/src/targets/local.ts`, `e2e/src/targets/devnet.ts`
- Test: `e2e/test/services.test.ts`
- Modify: `docs/specs/stint-system.md` (section 12.2)

**Interfaces:**
- Consumes: `startFacilitator`, `FacilitatorConfig`, `RunningFacilitator` (`@lxfoundry/stint-facilitator`); `sendSol`
  (`e2e/src/devnet/funds.ts`); the local network's `surfnet.fundSol` and `waitForNewSlot`.
- Produces:
  - on `StackControl`: `stopFacilitator(): Promise<void>` and `startFacilitator(): Promise<void>`;
  - on `ScenarioContext`: optional `fundSol?(owner: Address, lamports: bigint): Promise<void>`;
  - on `Services`: `stopFacilitator()`, `startFacilitator()`, and `facilitator` now the current one (a getter);
  - `LocalStack.facilitator` is the current one too.

- [ ] **Step 1: Write the failing test**

In `e2e/test/services.test.ts`, insert after the test "stops the gate and starts it again on the same URL, with the
facilitator and Kora as they were":

```ts
  it("stops the facilitator and starts it again on the same URL, with the gate and Kora as they were, and stops it with the rest", async () => {
    const own = await start();
    const { kora } = own;
    const url = own.facilitator.url;
    const gateUrl = own.stream.url;

    await own.stopFacilitator();

    expect(await unreachable(url)).toBe(true);
    expect(await healthy(gateUrl)).toBe(true);

    await own.startFacilitator();

    expect(own.facilitator.url).toBe(url);
    expect(await healthy(url)).toBe(true);
    expect(own.kora).toBe(kora);
    // The gate settles through the facilitator started again: a session opens and closes on it.
    expect(await openAndClose(gateUrl)).toBe(30_000n);

    await own.stop();
    expect(await unreachable(url)).toBe(true);
  }, 90_000);
```

Run: `pnpm --filter @lxfoundry/stint-e2e test services.test.ts`
Expected: FAIL in the new test: `own.stopFacilitator is not a function`.

- [ ] **Step 2: Add the members to the conformance types**

In `conformance/src/types.ts`, in the interface `StackControl`, replace:

```ts
  startGate(options?: GateStartOptions): Promise<void>;
}
```

with:

```ts
  startGate(options?: GateStartOptions): Promise<void>;
  /** Stops the facilitator, its sweeper included. Kora and the gate keep running; the gate's calls to the facilitator fail meanwhile. */
  stopFacilitator(): Promise<void>;
  /** Starts the facilitator again on the port it had, with the same keys, so that the `closeUrl` in the gate's offers stays valid. */
  startFacilitator(): Promise<void>;
}
```

In the interface `ScenarioContext`, replace:

```ts
  /** Sessions opened and closed straight on the program. Absent where the harness holds none of the keys to do it with. */
  readonly direct?: DirectChain;
}
```

with:

```ts
  /** Sessions opened and closed straight on the program. Absent where the harness holds none of the keys to do it with. */
  readonly direct?: DirectChain;
  /**
   * Gives `owner`, a buyer this context made, `lamports` from the harness, for a scenario whose buyer pays a fee itself
   * (scenario 25); a buyer holds no SOL otherwise (spec §9.1). Give at least the rent-exempt minimum of an empty account,
   * 890,880 lamports, or the network refuses the transfer. Absent where the harness holds no SOL to give.
   */
  fundSol?(owner: Address, lamports: bigint): Promise<void>;
}
```

In `conformance/test/expired-session-nobody-closes.test.ts`, replace:

```ts
  stopGate: async () => void calls.push("stop"),
  startGate: async () => void calls.push("start"),
});
```

with:

```ts
  stopGate: async () => void calls.push("stop"),
  startGate: async () => void calls.push("start"),
  stopFacilitator: async () => void calls.push("stop facilitator"),
  startFacilitator: async () => void calls.push("start facilitator"),
});
```

- [ ] **Step 3: Stop and start the facilitator in the services**

Replace `e2e/src/targets/services.ts` from the line `/** How many times a restart of the gate tries a port that something still holds, and how long it waits between tries. */`
to the end of the file with:

```ts
/** How many times a service that starts again tries a port that something still holds, and how long it waits between tries. */
const RESTART_ATTEMPTS = 10;
const RESTART_DELAY_MS = 200;

/** The keys the services run with. */
export interface ServiceKeys {
  readonly koraFeePayer: HarnessKey;
  readonly rentPayer: HarnessKey;
  readonly receiverAuthorizer: HarnessKey;
  readonly seller: HarnessKey;
}

export interface ServicesOptions {
  readonly rpc: Rpc<SolanaRpcApi>;
  readonly rpcUrl: string;
  readonly rpcWsUrl: string;
  readonly keys: ServiceKeys;
  /** The longest an offer asks a buyer to take; at most the time its blockhash has left (spec §5.1). Default 60. */
  readonly maxTimeoutSeconds?: number;
  /** How the gate and the facilitator re-read what a node does not return yet. */
  readonly readRetry?: RetryOptions;
  /** Milliseconds between the facilitator's sweeps. Default `TEST_SWEEPER_INTERVAL_MS`. */
  readonly sweeperIntervalMs?: number;
  /** An endpoint that lists the program's accounts for the sweeper, if `rpcUrl` refuses that (a provider's free tier may). Default `rpcUrl`. */
  readonly scanRpcUrl?: string;
}

export interface Services {
  readonly kora: KoraProcess;
  /** The facilitator that is current: after `stopFacilitator()` and `startFacilitator()`, the new one, at the same URL. */
  readonly facilitator: RunningFacilitator;
  readonly facilitatorApiKey: string;
  /** The gate and the example stream that are current: after `stopGate()` and `startGate()`, the new ones, at the same URL. */
  readonly stream: RunningStream;
  /**
   * Stops the gate and its connections; the facilitator, its sweeper and Kora keep running. Safe to repeat when the calls are
   * made one after another, not while a `startGate()` is under way: there is no gate to stop yet, and the one that start then
   * brings up keeps running.
   */
  stopGate(): Promise<void>;
  /**
   * Starts the gate again on the port it had. The new gate has no memory of earlier sessions. `options` hold for that gate only:
   * the next start without them brings up an ordinary one. Safe to repeat when the calls are
   * made one after another, not for two that overlap: they race for the port. It does nothing once `stop()` has been called: a
   * gate started then would be one that nothing stops.
   */
  startGate(options?: GateStartOptions): Promise<void>;
  /**
   * Stops the facilitator and its sweeper; Kora and the gate keep running, and the gate's calls to the facilitator fail
   * meanwhile. Safe to repeat when the calls are made one after another, not while a `startFacilitator()` is under way.
   */
  stopFacilitator(): Promise<void>;
  /**
   * Starts the facilitator again on the port it had, with the same keys and API key, so that the gate's facilitator client
   * and the `closeUrl` of its offers stay valid; its sweeper starts with it. Safe to repeat when the calls are made one after
   * another, not for two that overlap. It does nothing once `stop()` has been called.
   */
  startFacilitator(): Promise<void>;
  /** Stops everything that is running, a stopped gate included. Safe to repeat. */
  stop(): Promise<void>;
}

/** Stops each in turn, the last registered first, even when one of them fails to stop. */
export async function stopAll(stops: readonly (() => Promise<void> | void)[]): Promise<void> {
  let failure: unknown;
  for (const stop of stops) {
    try {
      await stop();
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure !== undefined) throw failure;
}

/**
 * Starts a service again with `start`. One that has just stopped may still hold its port for a moment, so a port that is in
 * use is tried again a few times.
 */
async function startOnFreedPort<T>(start: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await start();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE" || attempt >= RESTART_ATTEMPTS) throw error;
      await new Promise((resolve) => setTimeout(resolve, RESTART_DELAY_MS));
    }
  }
}

/**
 * A client's keep-alive socket to a stopped server is seen to be closed only when the event loop polls for I/O. One has to run
 * between the server's sockets being destroyed and the next request, or that request goes out on the dead socket once the
 * server is back on the same port. Two hops through the check phase always have a poll between them; a timer does not.
 */
async function letSocketsClose(): Promise<void> {
  for (let hop = 0; hop < 2; hop++) await new Promise((resolve) => setImmediate(resolve));
}

/** Kora, the facilitator with its sweeper, and the example stream with its gate, against the network at `rpcUrl`. */
export async function startServices(options: ServicesOptions): Promise<Services> {
  const stops: (() => Promise<void> | void)[] = [];
  /** Set by `stop()`: no service starts again after it. */
  let stopped = false;
  try {
    const kora = await startKora({
      rpcUrl: options.rpcUrl,
      config: {
        allowedPrograms: [...KORA_ALLOWED_PROGRAMS, STINT_PROGRAM_ADDRESS, SUBSCRIPTIONS_PROGRAM_ADDRESS],
        allowedTokens: [USDC_DEVNET_MINT],
        maxAllowedLamports: 1_000_000,
      },
      feePayerSecretKey: options.keys.koraFeePayer.secretKey,
      apiKey: randomUUID(),
    });
    stops.unshift(() => kora.stop());
    const facilitatorApiKey = randomUUID();
    const facilitatorConfig: FacilitatorConfig = {
      rpcUrl: options.rpcUrl,
      network: SOLANA_DEVNET,
      kora: { url: kora.url, apiKey: kora.apiKey },
      rentPayerSecretKey: options.keys.rentPayer.secretKey,
      apiKeys: [facilitatorApiKey],
      readRetry: options.readRetry,
      sweeper: { intervalMs: options.sweeperIntervalMs ?? TEST_SWEEPER_INTERVAL_MS, scanRpcUrl: options.scanRpcUrl },
    };
    let facilitator: RunningFacilitator | undefined = await runFacilitator(facilitatorConfig);
    let latestFacilitator: RunningFacilitator = facilitator;
    // A restarted facilitator takes the port it had, so that the gate's client and the offers' closeUrl stay valid.
    const facilitatorPort = Number(new URL(facilitator.url).port);
    const stopFacilitator = async (): Promise<void> => {
      const current = facilitator;
      facilitator = undefined;
      await current?.stop();
      await letSocketsClose();
    };
    const startFacilitator = async (): Promise<void> => {
      if (facilitator || stopped) return;
      const started = await startOnFreedPort(() => runFacilitator({ ...facilitatorConfig, port: facilitatorPort }));
      // A stop that landed during the start's tries found no facilitator to stop: this one would run on, with nothing to stop it.
      if (stopped) return started.stop();
      latestFacilitator = facilitator = started;
    };
    stops.unshift(stopFacilitator);
    const streamConfig: StreamConfig = {
      rpcWsUrl: options.rpcWsUrl,
      gate: {
        network: SOLANA_DEVNET,
        asset: USDC_DEVNET,
        payTo: options.keys.seller.signer.address,
        receiverAuthorizer: options.keys.receiverAuthorizer.signer,
        terms: TEST_TERMS,
        durations: TEST_DURATIONS,
        idleCloseSeconds: TEST_IDLE_CLOSE_SECONDS,
        maxTimeoutSeconds: options.maxTimeoutSeconds,
        readRetry: options.readRetry,
        facilitator: createFacilitatorClient(latestFacilitator.url, facilitatorApiKey),
        // The gate follows each session's account over the node's WebSocket (spec §7.3).
        chain: createRpcChain(options.rpc, createSolanaRpcSubscriptions(options.rpcWsUrl)),
      },
    };
    let running: RunningStream | undefined = await startStream(streamConfig);
    let latest: RunningStream = running;
    // A restarted gate takes the port it had, so that the URL a scenario holds stays valid.
    const port = Number(new URL(running.url).port);
    const stopGate = async (): Promise<void> => {
      const current = running;
      running = undefined;
      await current?.stop();
      await letSocketsClose();
    };
    const startGate = async (options: GateStartOptions = {}): Promise<void> => {
      if (running || stopped) return;
      const ahead = options.sessionClockAheadMs ?? 0;
      // Its idle and end timers fire `ahead` early; the chain's clock still decides every amount.
      const config: StreamConfig =
        ahead === 0 ? streamConfig : { ...streamConfig, gate: { ...streamConfig.gate, sessionClock: () => Date.now() + ahead } };
      const started = await startOnFreedPort(() => startStream({ ...config, port }));
      // A stop that landed during the start's tries found no gate to stop: this one would run on, with nothing to stop it.
      if (stopped) return started.stop();
      latest = running = started;
    };
    stops.unshift(stopGate);
    let stopping: Promise<void> | undefined;
    return {
      kora,
      get facilitator() {
        return latestFacilitator;
      },
      facilitatorApiKey,
      get stream() {
        return latest;
      },
      stopGate,
      startGate,
      stopFacilitator,
      startFacilitator,
      stop: () => ((stopped = true), (stopping ??= stopAll(stops))),
    };
  } catch (error) {
    await stopAll(stops);
    throw error;
  }
}
```

In the same file, replace the import:

```ts
import { startFacilitator, type RunningFacilitator } from "@lxfoundry/stint-facilitator";
```

with:

```ts
import { startFacilitator as runFacilitator, type FacilitatorConfig, type RunningFacilitator } from "@lxfoundry/stint-facilitator";
```

- [ ] **Step 4: Wire the targets**

In `e2e/src/targets/local.ts`, replace:

```ts
      stopGate: () => services.stopGate(),
      startGate: (options) => services.startGate(options),
    };
```

with:

```ts
      stopGate: () => services.stopGate(),
      startGate: (options) => services.startGate(options),
      stopFacilitator: () => services.stopFacilitator(),
      startFacilitator: () => services.startFacilitator(),
    };
```

replace:

```ts
      facilitator: services.facilitator,
```

with:

```ts
      get facilitator() {
        return services.facilitator;
      },
```

and replace:

```ts
        stack: control,
        direct,
      }),
```

with:

```ts
        stack: control,
        direct,
        // A cheatcode sets the balance; the next slot makes it visible.
        fundSol: async (owner, lamports) => {
          chain.network.surfnet.fundSol(owner, Number(lamports));
          await waitForNewSlot(chain.network.rpc);
        },
      }),
```

In `e2e/src/targets/devnet.ts`, insert after the constant `DIRECT_RENT_LAMPORTS` and its comment:

```ts
/**
 * The most a buyer is given by `fundSol`: the fee of a few transactions above the rent-exempt minimum of an empty account
 * (890,880 lamports). The clean-up returns what is left.
 */
const MAX_BUYER_LAMPORTS = 10_000_000n;
```

replace:

```ts
    stopGate: () => services.stopGate(),
    startGate: (options) => services.startGate(options),
  };
```

with:

```ts
    stopGate: () => services.stopGate(),
    startGate: (options) => services.startGate(options),
    stopFacilitator: () => services.stopFacilitator(),
    startFacilitator: () => services.startFacilitator(),
  };
```

and replace:

```ts
      stack: control,
      direct,
    }),
```

with:

```ts
      stack: control,
      direct,
      // From the funding key, to a buyer of the pool, whose SOL the clean-up returns.
      fundSol: async (owner, lamports) => {
        if (!keys.holders.has(owner)) throw new Error(`SOL goes only to a key of the pool, which the clean-up empties: ${owner} is not one`);
        if (lamports > MAX_BUYER_LAMPORTS) throw new Error(`A buyer is given at most ${MAX_BUYER_LAMPORTS} lamports: got ${lamports}`);
        await sendSol(rpc, funding.signer, owner, lamports, send);
      },
    }),
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm typecheck && pnpm --filter @lxfoundry/stint-conformance test && pnpm --filter @lxfoundry/stint-e2e test services.test.ts`
Expected: no type error; PASS, every test of the conformance suite and of `services.test.ts`, the new one included.

- [ ] **Step 6: Update the spec**

In `docs/specs/stint-system.md`, section 12.2, replace:

```markdown
In particular, it can stop the gate and start it again on the same
  address while the facilitator, its sweeper and Kora keep running (scenario 26), and start it with its session
  clock running ahead of the wall clock (scenario 34).
```

with:

```markdown
In particular, it can stop the gate and start it again on the same
  address while the facilitator, its sweeper and Kora keep running (scenario 26), start it with its session
  clock running ahead of the wall clock (scenario 34), and stop the facilitator, its sweeper included, and start it
  again on the same address while Kora keeps running (scenario 25).
```

The line breaks above are the spec's own: match the text, not the breaks, if they differ, and keep the paragraph's
wrapping. Then, in the same section, replace:

```markdown
The rent payer's balance change is read from the close transaction's lamport
balances (`preBalances` and `postBalances`), which are not the token balances that T9 is about.
```

with:

```markdown
The rent payer's balance change is read from the close transaction's lamport
balances (`preBalances` and `postBalances`), which are not the token balances that T9 is about.

A buyer holds no SOL (section 9.1). A scenario whose buyer pays a fee itself gives it SOL through the context's
`fundSol`, from the harness (scenario 25).
```

Run: `grep -c "scenario 25" docs/specs/stint-system.md`
Expected: `2`.

- [ ] **Step 7: Commit**

```bash
git add conformance/src/types.ts conformance/test/expired-session-nobody-closes.test.ts e2e/src/targets/services.ts e2e/src/targets/local.ts e2e/src/targets/devnet.ts e2e/test/services.test.ts docs/specs/stint-system.md
git commit -m "Stop and start the facilitator in the harness, and give a buyer SOL"
```

---

### Task 8: Scenario 25, the gate and the facilitator unreachable at close

Spec section 12.7: "The gate and the facilitator are unreachable when the buyer closes: with SOL on the authority, a
unilateral close, refunded as in scenario 1. Without: the session runs to expiry." Two buyers open through the gate, one
given SOL; both clients have the network's RPC. The harness stops the gate and the facilitator. The client with SOL
closes on the chain itself; the other is told that its session runs to the end of its paid time, and it does: once the
facilitator is back, its sweeper closes the session with `AtExpiry` and the receiver is paid the whole deposit.

**Files:**
- Modify: `conformance/src/helpers.ts`
- Create: `conformance/src/scenarios/25-gate-and-facilitator-unreachable-at-close.ts`
- Create: `conformance/test/gate-and-facilitator-unreachable.test.ts`
- Modify: `conformance/src/catalogue.ts`, `conformance/test/catalogue.test.ts`, `e2e/test/local-target.test.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: `StackControl.stopFacilitator`/`startFacilitator` and `ScenarioContext.fundSol` (Task 7); `ClientOptions.rpc`
  (Task 5); `expectRefunded`, `readOpenedSession` (Tasks 3 and 6); `awaitClose`, `closePollMs`; `lamportBalances`.
- Produces: `buyerClient(buyer: Buyer, options?: { readonly rpc?: Rpc<SolanaRpcApi> }): StintClient`;
  `whileGateAndFacilitatorStopped<T>(stack: StackControl, work: () => Promise<T>): Promise<T>`.

- [ ] **Step 1: Write the failing test of the stop-and-start helper**

Create `conformance/test/gate-and-facilitator-unreachable.test.ts`:

```ts
import type { Address } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { whileGateAndFacilitatorStopped } from "../src/scenarios/25-gate-and-facilitator-unreachable-at-close.js";
import type { StackControl } from "../src/types.js";

/** A stack that records what is done to it. */
const recording = (calls: string[]): StackControl => ({
  rentPayer: "RENT" as Address,
  stopGate: async () => void calls.push("stop gate"),
  startGate: async () => void calls.push("start gate"),
  stopFacilitator: async () => void calls.push("stop facilitator"),
  startFacilitator: async () => void calls.push("start facilitator"),
});

describe("whileGateAndFacilitatorStopped", () => {
  it("stops the gate and the facilitator, runs the work, starts the facilitator then the gate, and returns what the work returned", async () => {
    const calls: string[] = [];
    expect(await whileGateAndFacilitatorStopped(recording(calls), async () => calls.push("work"))).toBe(3);
    expect(calls).toEqual(["stop gate", "stop facilitator", "work", "start facilitator", "start gate"]);
  });

  it("starts both again, and rethrows, when the work throws", async () => {
    const calls: string[] = [];
    const failing = async () => {
      calls.push("work");
      throw new Error("no close");
    };
    await expect(whileGateAndFacilitatorStopped(recording(calls), failing)).rejects.toThrow("no close");
    expect(calls).toEqual(["stop gate", "stop facilitator", "work", "start facilitator", "start gate"]);
  });

  it("starts the gate again even when the facilitator does not start", async () => {
    const calls: string[] = [];
    const stack: StackControl = {
      ...recording(calls),
      startFacilitator: async () => {
        throw new Error("EADDRINUSE");
      },
    };
    await expect(whileGateAndFacilitatorStopped(stack, async () => calls.push("work"))).rejects.toThrow("EADDRINUSE");
    expect(calls).toEqual(["stop gate", "stop facilitator", "work", "start gate"]);
  });
});
```

Run: `pnpm --filter @lxfoundry/stint-conformance test gate-and-facilitator-unreachable.test.ts`
Expected: FAIL: the scenario module cannot be resolved.

- [ ] **Step 2: Give `buyerClient` an `rpc`**

In `conformance/src/helpers.ts`, replace:

```ts
import { SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM, isSolanaError } from "@solana/kit";
```

with:

```ts
import { SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM, isSolanaError, type Rpc, type SolanaRpcApi } from "@solana/kit";
```

and replace:

```ts
/** A client for the buyer's key with the limits the scenarios use: at most 1 USDC a session and an hour, 10,000 base units a second. */
export function buyerClient(buyer: Buyer): StintClient {
  return createStintClient({
    signer: buyer.signer,
    policy: { maxRate: 10_000n, maxPerSession: 1_000_000n, budget: { amount: 1_000_000n, periodSeconds: 3_600 } },
  });
}
```

with:

```ts
/**
 * A client for the buyer's key with the limits the scenarios use: at most 1 USDC a session and an hour, 10,000 base units a
 * second. With `rpc`, the client can close a session on the chain itself, if the buyer holds SOL (spec §9.3).
 */
export function buyerClient(buyer: Buyer, options: { readonly rpc?: Rpc<SolanaRpcApi> } = {}): StintClient {
  return createStintClient({
    signer: buyer.signer,
    policy: { maxRate: 10_000n, maxPerSession: 1_000_000n, budget: { amount: 1_000_000n, periodSeconds: 3_600 } },
    ...(options.rpc === undefined ? {} : { rpc: options.rpc }),
  });
}
```

- [ ] **Step 3: Write the scenario, as `pending`**

Create `conformance/src/scenarios/25-gate-and-facilitator-unreachable-at-close.ts`:

```ts
import { CloseKind, fetchMaybeSession } from "@lxfoundry/stint-program-client";
import { lamportBalances } from "@lxfoundry/stint-x402";
import { expectEqual, expectTrue, sleep } from "../assert.js";
import { awaitClose } from "../closes.js";
import { buyerClient, closePollMs, sessionSeconds } from "../helpers.js";
import { expectRefunded, readOpenedSession } from "../sessions.js";
import type { ScenarioContext, StackControl } from "../types.js";

/** What the buyer with SOL is given: the fee of its own close, 5,000 lamports, with the rent-exempt minimum of an empty account (890,880) to spare. */
const BUYER_LAMPORTS = 2_000_000n;

/**
 * Runs `work` with the gate and the facilitator both stopped, and starts them again afterwards, whatever happened: the
 * facilitator first, so that the gate settles through it as soon as it is back. Kora keeps running. The services are the
 * run's common ones, as in scenario 26: spec §12.2 gives scenario 25 a stack of its own, and stopping the common ones is
 * safe only because the runner runs one scenario at a time.
 */
export async function whileGateAndFacilitatorStopped<T>(stack: StackControl, work: () => Promise<T>): Promise<T> {
  await stack.stopGate();
  try {
    await stack.stopFacilitator();
    return await work();
  } finally {
    // The gate starts again even if the facilitator does not, so that one failure does not take every later scenario down.
    try {
      await stack.startFacilitator();
    } finally {
      await stack.startGate();
    }
  }
}

/**
 * Scenario 25 (spec §12.7): the gate and the facilitator cannot be reached when the buyer closes. With SOL on the
 * authority, and a node, the client's close fallback (spec §9.3) ends with a close of its own on the chain: refunded as
 * in scenario 1. Without SOL, nothing can close the session before its paid time runs out: the client says so, and the
 * session runs to expiry. Once the facilitator is back, its sweeper closes it with `AtExpiry`, and the receiver is paid
 * the whole deposit.
 */
export async function gateAndFacilitatorUnreachableAtClose(context: ScenarioContext): Promise<void> {
  const stack = context.stack;
  if (!stack) throw new Error("scenario 25 needs a target that provides stack control");
  const fundSol = context.fundSol;
  if (!fundSol) throw new Error("scenario 25 needs a target that can give a buyer SOL");
  const withSol = await context.newBuyer(100_000n); // the session costs 30,000 (40,000 on devnet)
  await fundSol(withSol.signer.address, BUYER_LAMPORTS);
  const withoutSol = await context.newBuyer(100_000n); // the session costs 15,000 (25,000 on devnet)

  // Each session gets a connection as soon as it opens: it keeps the gate's idle timer from closing it before the gate stops (spec §7.3).
  const paying = await buyerClient(withSol, { rpc: context.rpc }).open(context.gateUrl, { seconds: sessionSeconds(context.target, 30) });
  const payingSocket = await paying.connect();
  const stranded = await buyerClient(withoutSol, { rpc: context.rpc }).open(context.gateUrl, { seconds: sessionSeconds(context.target, 15) });
  const strandedSocket = await stranded.connect();
  for (const socket of [payingSocket, strandedSocket]) socket.on("error", () => {});
  const storedPaying = await readOpenedSession(context, paying.id);
  const storedStranded = await readOpenedSession(context, stranded.id);
  expectEqual(storedStranded.rentPayer, stack.rentPayer, "the session without SOL names the facilitator's rent payer: the sweeper's to close");

  const outcome = await whileGateAndFacilitatorStopped(stack, async () => {
    await sleep((storedPaying.minSeconds + 2) * 1_000); // past the minimum, as in scenario 1
    const receipt = await paying.close();
    const refusal = await stranded.close().then(
      () => undefined,
      (error: unknown) => error,
    );
    const strandedOpen = (await fetchMaybeSession(context.rpc, stranded.id, { commitment: "confirmed" })).exists;
    return { receipt, refusal, strandedOpen };
  });
  payingSocket.terminate();
  strandedSocket.terminate();

  // With SOL: the client's own close, its fee paid by the buyer.
  const { receipt } = outcome;
  expectEqual(receipt.via, "unilateral", "the client closed the session on the chain itself, the gate and the facilitator being unreachable");
  const event = await expectRefunded(context, { signature: receipt.transaction, session: paying.id, stored: storedPaying, buyer: withSol, reported: receipt });
  expectEqual(event.closedBy, withSol.signer.address, "the close was signed by the buyer, as the session's authority");
  const lamports = (await lamportBalances(context.rpc, receipt.transaction, context.readRetry)).get(withSol.signer.address);
  expectTrue(lamports !== undefined && lamports.post < lamports.pre, "the buyer paid the fee of its own close");

  // Without SOL: no step could close the session, and it runs to expiry.
  const { refusal } = outcome;
  expectTrue(
    refusal instanceof Error && /runs to the end of its paid time/.test(refusal.message),
    `the client says that the session without SOL runs to the end of its paid time (${String(refusal)})`,
  );
  expectTrue(outcome.strandedOpen, "the session without SOL is still open once every step has failed");
  const paidUntilMs = stranded.paidUntil * 1_000;
  const found = await awaitClose(
    context.rpc,
    stranded.id,
    context.readRetry,
    Math.max(0, paidUntilMs - Date.now()) + 30_000,
    "the sweeper closes the session without SOL within 30 s of paid_until",
    closePollMs(context.target),
  );
  expectEqual(found.event.kind, CloseKind.AtExpiry, "the session without SOL ran to expiry, and was closed with AtExpiry");
  expectEqual(found.event.claimed + found.event.owed, storedStranded.deposited, "the whole deposit is charged");
  expectEqual(found.event.refunded + found.event.redirected, 0n, "nothing is refunded");
}
```

Run: `pnpm --filter @lxfoundry/stint-conformance test gate-and-facilitator-unreachable.test.ts`
Expected: PASS, both tests.

In `conformance/src/catalogue.ts`, insert the import in numeric order (after the import of scenario 24's module):

```ts
import { gateAndFacilitatorUnreachableAtClose } from "./scenarios/25-gate-and-facilitator-unreachable-at-close.js";
```

and replace:

```ts
  pending(25, "The gate and the facilitator are unreachable when the buyer closes", ["stack"], "ownStack"),
```

with:

```ts
  pending(25, "The gate and the facilitator are unreachable when the buyer closes", ["stack"], "ownStack", gateAndFacilitatorUnreachableAtClose),
```

Run: `pnpm --filter @lxfoundry/stint-conformance typecheck && pnpm e2e:local`
Expected: no type error; the report lists scenario 25 as `pending` with result `pass` (about 20 s), flagged as passing
while pending; the run exits 0, and every scenario after 25 passes too (the gate and the facilitator are back).

- [ ] **Step 4: Make scenario 25 `required`**

In `conformance/src/catalogue.ts`, replace:

```ts
  pending(25, "The gate and the facilitator are unreachable when the buyer closes", ["stack"], "ownStack", gateAndFacilitatorUnreachableAtClose),
```

with:

```ts
  required(25, "The gate and the facilitator are unreachable when the buyer closes", gateAndFacilitatorUnreachableAtClose, ["stack"], "ownStack"),
```

In `conformance/test/catalogue.test.ts` and `e2e/test/local-target.test.ts`, add `25` to `REQUIRED`, in numeric order
(after Task 6: `[1, 2, 3, 4, 7, 9, 15, 16, 22, 24, 25, 26, 34]`). In `e2e/test/local-target.test.ts`, add "25 about 20 s"
to the comment above `REQUIRED`, and raise the limit of the test "passes every required scenario, and reports the
others" by 120 s (from `420_000` to `540_000`, if part 1 left it at `420_000`).

Run: `pnpm --filter @lxfoundry/stint-conformance test && pnpm e2e:local`
Expected: PASS; every `required` scenario passes.

- [ ] **Step 5: Update the README's Status**

In `README.md`, section "Status", make three changes. With part 1 merged and nothing else, the paragraph holds the text
quoted below; if another stage changed it first, make the same three changes to what is there. The quotes leave out the
paragraph's line breaks, which fall inside them: match the words, not the breaks.

1. Replace `the gate with its timers, the client library, an MCP server and an example agent.` with
   `the gate with its timers, the client library, which falls back on the facilitator's sponsored close, then on a close of its own when it has a node and SOL, an MCP server and an example agent.`
2. Replace `closes a session that nobody connects to, and the sweeper closes` with
   `closes a session that nobody connects to, and drops at once the connections of a session that another party closed; the sweeper closes`.
3. Replace the count and the "Not built yet" list: with part 1 merged, replace
   `Ten of the 35 end-to-end scenarios of the [specification](docs/specs/stint-system.md) (section 12.7) pass on a local network and on devnet, and the run report lists the other 25 as pending. Not built yet: the client's fallback closes (the client does not use the facilitator's sponsored close yet), refusals of bad payments and settlement records, the facilitator's rate limits, and resilience across restarts.`
   (whatever its line breaks) with
   `Thirteen of the 35 end-to-end scenarios of the [specification](docs/specs/stint-system.md) (section 12.7) pass on a local network, ten of them also on devnet, and the run report lists the other 22 as pending. Not built yet: refusals of bad payments and settlement records, the facilitator's rate limits, and resilience across restarts.`

Keep the paragraph wrapped as the rest of the file is (about 115 characters a line).

Run: `pnpm typecheck && pnpm test && pnpm e2e:local`
Expected: PASS. The report's last line counts `required 13` (with part 1 and this part only) and `pass 13, fail 0`.

- [ ] **Step 6: Commit**

```bash
git add conformance/src/helpers.ts conformance/src/scenarios/25-gate-and-facilitator-unreachable-at-close.ts conformance/test/gate-and-facilitator-unreachable.test.ts conformance/src/catalogue.ts conformance/test/catalogue.test.ts e2e/test/local-target.test.ts README.md
git commit -m "Add scenario 25, closes while the gate and the facilitator are unreachable, and make it required"
```

---

### Task 9: Scenarios 7, 24 and 25 on devnet

No program code changes in this part, so the devnet program stays as it is; this task runs the new scenarios there. The
person runs the devnet commands, with their `.env.devnet`.

**Files:**
- Modify: `e2e/test/devnet-target.test.ts`
- Modify: `README.md`

- [ ] **Step 1: Run the new scenarios on the devnet target, against the local network**

In `e2e/test/devnet-target.test.ts`, in the test "passes the required scenarios with buyers funded from the funding key",
add `7`, `24` and `25` to the list `required`, in numeric order (with part 1 merged:
`const required = [1, 2, 3, 4, 7, 9, 15, 16, 22, 24, 25, 26, 34];`), and raise the test's limit by 120 s (from
`420_000` to `540_000`, if part 1 left it at `420_000`).

Run: `pnpm --filter @lxfoundry/stint-e2e test devnet-target.test.ts`
Expected: PASS. Scenario 25 draws SOL from the funding key through the devnet target's `fundSol`, and the clean-up
returns it.

```bash
git add e2e/test/devnet-target.test.ts
git commit -m "Run scenarios 7, 24 and 25 on the devnet target, checked against a local network"
```

- [ ] **Step 2: Check that the program is unchanged**

Run: `git diff --stat main -- programs/`
Expected: no output: the program in this branch is the one deployed.

- [ ] **Step 3: The devnet runs (the person, in WSL)**

Run: `pnpm e2e:devnet funds`
Expected: `✓ Funded`. Otherwise fund the address it prints, as it says.

Run: `pnpm e2e:devnet`, then once more after it ends.
Expected, both times: exit 0, every `required` scenario `pass`, scenarios 7, 24 and 25 among them. Record each run's
report (scenario, result, duration) and the funding key's lines before and after for the pull request.

If a run fails:

| Symptom | Likely cause | What to do |
|---|---|---|
| Scenario 7: "the gate drops the connection within 5 s … not within 5000 ms" | The gate's subscription failed or was not yet in place (a failed one is not replaced, stage 5); or the provider's WebSocket delivered the notification late, or its signature list lagged it, so the gate looked the close up for its whole bound (about 2 s: 5 reads, 500 ms apart) before going by its clock, and the connections' close took the rest | Check `STINT_DEVNET_WS_URL`. The harness keeps no log of the gate's. Rerun once; if it repeats, record the error and the scenario's duration in the pull request and stop. Do not raise the 5 s |
| Scenario 25 fails at `fundSol` | The funding key is short of SOL | `pnpm e2e:devnet funds`, fund it, rerun |
| Scenario 25: the receipt's `via` is not `unilateral`, or its close is refused in preflight | The buyer's SOL was not yet visible to the node that simulated the close | Rerun once; if it repeats, record the error in the pull request and stop |
| Scenario 24 or 25: a later scenario fails to connect or settle | The gate or the facilitator did not start again (`EADDRINUSE` after 10 tries in the log) | Something else holds the port: find it, stop it, rerun |

- [ ] **Step 4: Record the devnet scenarios in the README**

In `README.md`, section "Running the scenarios on devnet", add `7`, `24` and `25` to the sentence that lists the
scenarios passing on devnet (with part 1 merged: `Scenarios 1, 2, 3, 4, 7, 9, 15, 16, 22, 24, 25, 26 and 34 pass on
devnet.`). In the section "Status", replace `pass on a local network, ten of them also on devnet,` with
`pass on a local network and on devnet,`.

```bash
git add README.md
git commit -m "Record the scenarios of the fallback closes that pass on devnet"
```

---

## Done when

- `pnpm typecheck`, `pnpm test` and `pnpm e2e:local` pass, locally in WSL and in continuous integration.
- Scenarios 7, 24 and 25 are `required` and pass on `local` and on devnet, with every earlier required scenario.
- The gate drops the connections of a session that another party closed as soon as its subscription sees the account
  go, with `4402` or `4410` as spec section 7.3 says, sends no close of its own for it, and serves no new connection,
  close or top-up of it meanwhile.
- `session.close()` closes through the gate, through `closeUrl` when the gate cannot, and on the chain with the client's
  `rpc` and SOL when neither can; it waits for a close the gate reports pending; no request holds it up past its time
  limit; with an `rpc`, only its own read finds the session closed; it says which step closed the session, and that the
  session runs to the end of its paid time when none could.
- The pull request's description records the devnet runs and any deviation from this plan.

## Spec edits made by this part

Each states a fact the code relies on:
- §7.3, the row "Account closed by another party" (Task 2): what counts as closed (the account gone, or holding another
  session), that a close of the gate's own in flight decides first, that forwarding stops at once and the session's
  routes answer `404`, and that a lookup that finds nothing is repeated, for a bounded time, before the gate goes by its
  clock;
- §9.3, the close fallback chain (Task 4): which answers move the chain on and which end it, the time limits on its
  requests, how a close that may still land is passed on and which one becomes the receipt, that a client with an `rpc`
  takes only its own read for a closed session, what step 3 needs (the fee on top of a rent-exempt balance), that
  overlapping closes share one chain, and that the receipt says which step closed the session;
- §12.2, stack control and buyers' SOL (Task 7): the facilitator stopped and started again on the same address
  (scenario 25), and `fundSol`.

Not edited, on purpose: §9.1's other uses of `rpc` (refunds checked on-chain, orphaned sessions found at start-up), which
the spec keeps for the client as it is meant to be; this part builds neither (see "What this part builds, and what it
leaves").
