# Stage 6: session tokens and adoption — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or
> executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for
> tracking.

**Goal:** The gate refuses every session token that fails a check of spec section 7.2 with `401`: expired, for another
audience, for another purpose, or used before. It adopts a session opened directly on-chain when its buyer connects, as
if its open had just settled, once the session passes every check of section 7.2 against its account. It refuses one in
another mint with `403`, and adopts nothing. Scenarios 8, 20 and 35 pass on `local`, become `required`, and pass on
devnet.

**Architecture:** No change to the program. In the gate, a connect for a session it does not track reads the account,
checks the token against the account's `authority` (checks 1 to 3), the terms (check 4) and the margin (check 5), then
provisions the session through the same join as a retried open, so that two connects, or a connect and an open,
provision it once. A subscription reports changes only, so the gate then reads the account once more, after its bound
on a node's lag, and treats an account gone as a session another party closed. The gate remembers the sessions it has
ended for ten minutes, so that a node which still shows a closed account cannot bring one back, through a connect or
an open paid again. The conformance library gains connects and closes through the gate with tokens a
scenario signs itself. The harness's direct chain can name the gate's receiver authorizer, and open a session in a
second mint that the harness holds.

**Tech Stack:** TypeScript 7.0.2, vitest 5.0.5, `@solana/kit` 8.5.0, `ws` 8.22.0, `@solana-program/token` 0.18.0,
`@solana-program/system` 0.16.0, Surfpool 1.6.1, Kora 2.0.5.

**Spec:** `docs/specs/stint-system.md`, sections 4.6 (a session with other terms is never served), 7.1 (the gate's
answers to a connect), 7.2 (the session token and the gate's five checks), 7.3 (adoption, and how a session ends), 12.2
(the harness), 12.6 (the devnet funding key and its clean-up) and 12.7 (scenarios 8, 20 and 35).

## Global Constraints

- Platform: Linux x86-64; on Windows, everything runs inside WSL 2 (T1, T2). Run every command from the repository
  root, inside WSL. Do not rely on `/tmp` staying intact while a command runs: keep scratch files under the home
  directory or a git-ignored folder of the repository.
- **Devnet only.** No transaction from this repository's code or scripts reaches another network.
- **The program does not change:** `git diff --stat main -- programs/` stays empty, so the devnet deployment stays as it
  is.
- Transactions are version 0, without address lookup tables (spec section 3.5). Only classic SPL Token mints (the
  program takes `Program<'info, Token>`); the payment token is devnet USDC, `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`,
  6 decimals (spec section 3.4).
- `u64` values on the wire are decimal strings; `u32` values are JSON numbers (spec section 5.1). Amounts are `bigint`
  in TypeScript, never `number`.
- **No secrets, ever, in any commit.** Never print a key's contents or the devnet seed; an RPC URL may carry an API key.
- **A token is never logged** (spec section 7.2), and a connect refused before the upgrade adopts nothing: no
  `provision()`, no subscription, no timer.
- `GateConfig`, `GateChain`, `ScenarioContext` and the client's options gain no required member: tests build them from
  literals.
- Scenario statuses follow the ratchet of spec section 12.2: a scenario is made `required` in the commit where it first
  passes on `local`, and never goes back to `pending`.
- `noUncheckedIndexedAccess` is on (`tsconfig.base.json`): an indexed read is `T | undefined`.
- Test first: write the failing test, run it, implement, run it again, commit.
- Commit messages are neutral, technical and in the present tense.

## What this stage builds, and what it leaves

Built:
- the gate's adoption of a session it does not track, on connect, with a second read of the account;
- the gate's memory of the sessions it has ended, on the connect and the open paths;
- `401` for a connect with no token before anything is read, and `502` for a connect whose chain read fails;
- connects and closes through the gate with a scenario's own tokens (conformance library);
- in the harness's direct chain, the gate's receiver authorizer, and a second mint;
- scenarios 8, 20 and 35.

Not built, and not to be built here:
- **Restoring timers on start** (spec section 7.3, "Restarts"; scenario 23). A gate that restarts still forgets its
  sessions. Each one ends at its `paid_until`: closed by the sweeper when it names the facilitator's rent payer, or else
  left for anyone to close. Adoption serves a buyer who reconnects to a restarted gate, since the connect adopts the
  session again; the end timer of a session nobody reconnects to is not restored.
- **Several gate instances** (spec section 7.8; scenario 11). An instance adopts a session another instance opened, as
  any untracked session is adopted, but nothing decides "gate-wide" yet.
- **The connection limit per session** (spec section 7.3, "One live connection per session"): unchanged by this stage.
- **A close by the clean-up of a session in the second mint** left open by a scenario that stopped half-way. The
  clean-up still reports such a session and leaves it alone (spec section 12.6). Scenario 20 closes its own session,
  failing or passing.
- **A second read for a session the gate opened itself.** Adoption reads the account from a node that may lag, and
  the subscription that follows reports changes only. So it reads the account once more, after the gate's bound on a
  node's lag (Task 1). An open reads the account right after its settlement and subscribes once `provision()` returns. A
  close that lands in between is found by the end timer's re-read, at `paid_until`.

## Before you start: what a person must prepare

Start from a clean tree on a branch of its own, from a `main` that holds stage 3
(`conformance/src/scenarios/32-durations-out-of-bounds.ts` exists, and `REQUIRED` in
`conformance/test/catalogue.test.ts` lists 21 scenarios) and this plan.
- Tasks 1 to 6 need nothing but the repository, except Task 2's `pnpm add`, which needs access to the npm registry.
- Task 7 runs the devnet harness with the person's `.env.devnet` (`STINT_DEVNET_RPC_URL`, `STINT_DEVNET_SEED`, and
  `STINT_DEVNET_SCAN_RPC_URL` if the provider refuses `getProgramAccounts`), and the funding key funded as
  `pnpm e2e:devnet funds` says.
- No other run of the devnet harness may use the same seed at the same time.
- This stage changes no program code, so the devnet deployment stays as it is.

Another stage may have changed some of the same lines first: the `REQUIRED` lists, the devnet scenario list, the
README's status, `DirectChain`. This plan states those edits as rules, with the text as stage 3 leaves it as the
example.

## File map

| File | Change |
|---|---|
| `packages/gate/src/gate.ts` | `authenticate` takes the authority; `track` (from the open path); `adopt`; the memory of ended sessions; `connect` adopts; `502` on an upstream failure during an upgrade |
| `packages/gate/test/adopt.test.ts` | New: the adoption's cases, on the gate's test harness |
| `conformance/src/tokens.ts` | New: `tokenFor`, `connectWith`, `closeCodeOf`, `closeWith` |
| `conformance/test/tokens.test.ts` | New |
| `conformance/package.json`, `pnpm-lock.yaml` | `ws` 8.22.0, `@types/ws` 8.18.2 |
| `conformance/src/types.ts` | `DirectChain.open`'s `receiverAuthorizer` and `mint`; `DirectSession.mint`; `OtherMint`; `DirectChain.otherMint` |
| `conformance/src/sessions.ts` | `directSessionOf` returns `mint` |
| `conformance/test/types.test.ts` | The new members' types |
| `e2e/src/targets/direct.ts` | The options above; the second mint |
| `e2e/src/devnet/keys.ts`, `e2e/src/targets/devnet.ts` | `deriveNamedKey`, `OTHER_MINT_KEY`; the devnet target's second mint |
| `e2e/test/direct-chain.test.ts`, `e2e/test/devnet-keys.test.ts` | New cases |
| `conformance/src/scenarios/08-token-refusals.ts`, `20-other-mint.ts`, `35-adopted-session.ts` | New |
| `conformance/src/catalogue.ts`, `conformance/test/catalogue.test.ts`, `e2e/test/local-target.test.ts`, `e2e/test/devnet-target.test.ts` | The scenarios registered, then required |
| `docs/specs/stint-system.md` | Sections 7.1, 7.3, 12.2 and 12.6 (listed at the end) |
| `README.md` | The status, the devnet sentence, the funding key's sentence |

---

### Task 1: The gate adopts a session it does not track, on connect

**Files:**
- Modify: `packages/gate/src/gate.ts`
- Create: `packages/gate/test/adopt.test.ts`
- Modify: `docs/specs/stint-system.md` (sections 7.1 and 7.3)

**Interfaces:**
- Consumes: the gate's test harness (`packages/gate/test/harness.ts`): `startHarness`, `helpers(...)` with `open`,
  `prepareOpen`, `closeWith`, `connect`, `token`, `settleDown`; `NOW_MS`.
- Produces: no exported name changes. Inside `createGate`:
  - `authenticate(token: string | undefined, session: Address, authority: Address, purpose: TokenPurpose): Promise<boolean>`;
  - `track(session: Address, stored: Session): Promise<Tracked<U>>`;
  - `adopt(session: Address, token: string | undefined): Promise<Tracked<U> | number>`.
  - The gate logs `{ event: "adopt", session }` when it adopts a session.

What the connect does for a session the gate does not track, in this order (spec sections 7.2 and 7.3):

| Step | Refused with |
|---|---|
| No token at all, before anything is read | `401` |
| Read the account at `confirmed`; it holds no session | `404` |
| Checks 1 to 3: the token against the account's `authority` | `401` |
| The account holds a session this gate has ended (same address and `started_at`, within the last ten minutes). Checked after the token, with no `await` from here to `track`, so that a session ended while the token was checked is caught too | `404` |
| Check 4: the terms, the mint and the receiver authorizer included (`sessionMatches`) | `403` |
| Check 5: `paid_until` more than the margin away | `402` |
| Provision it as an open that just settled (`track`) | — |
| Wait the gate's bound on a node's lag (`readRetry.attempts × readRetry.delayMs`), then read the account again. A subscription reports changes only, so a close that landed before it started, read from a node that lagged, would never be heard of. An account gone, or holding another session, goes to `closedElsewhere`, as the subscription's notification would | `404` (the session is ending) |
| Accept the connection | — |

A read that fails is `502`. A connect refused before `track` adopts nothing. The open path gets the same memory check:
an open paid again after this gate ended the session, read from a node that still shows the account, is `404`, not a
second `provision()`.

- [ ] **Step 1: Write the failing tests**

Create `packages/gate/test/adopt.test.ts`:

```ts
import { generateKeyPairSigner, type Address } from "@solana/kit";
import type { Session } from "@lxfoundry/stint-program-client";
import { createSessionToken, inspectTransaction, readElapsedPayload } from "@lxfoundry/stint-x402";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NOW_MS, helpers, startHarness, type Harness } from "./harness.js";

describe("the gate's adoption of a session it does not track (spec §7.3)", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await startHarness();
  });

  afterEach(async () => {
    expect(h.escaped).toEqual([]);
    await h.gate.close();
    h.server.closeAllConnections();
    await new Promise((resolve) => h.server.close(resolve));
  });

  const { open, send, prepareOpen, closeWith, connect, token, settleDown } = helpers(() => h);

  /**
   * A session on the fake chain that this gate never settled: opened directly on the program with the gate's terms, mint
   * and receiver authorizer, and a harness key as rent payer, then `change`. Paid for 30 s from `NOW_MS`.
   */
  async function onChain(change: Partial<Session> = {}): Promise<Address> {
    const { session } = await prepareOpen();
    const rentPayer = (await generateKeyPairSigner()).address;
    h.sessions.set(session, { ...h.sessions.get(session)!, rentPayer, ...change });
    return session;
  }

  it("adopts a session opened on-chain when its buyer connects: provisions it once, follows it, and sets its end timer", async () => {
    const session = await onChain();

    const { socket } = await connect(session, await token(session, "connect"));

    expect(socket).toBeDefined();
    expect(h.calls.provision).toEqual([{ session, authority: h.buyer.address, paidUntil: BigInt(NOW_MS / 1000 + 30) }]);
    expect(h.calls.attach).toHaveLength(1);
    expect(h.calls.watch).toEqual([session]);
    expect(h.calls.verify).toEqual([]);
    expect(h.calls.settle).toEqual([]);
    expect(h.logs).toContainEqual({ event: "adopt", session });
    // The connection is live, so the idle timer is off; the end timer is set for paid_until.
    expect(h.timers.pending.map((timer) => timer.dueMs)).toEqual([NOW_MS + 30_000]);
    socket!.close();
  });

  it("closes an adopted session on the buyer's request as one it opened: signed by its receiver authorizer, the rent to the session's own rent payer, then 4410", async () => {
    const session = await onChain();
    const rentPayer = h.sessions.get(session)!.rentPayer;
    const { socket } = await connect(session, await token(session, "connect"));
    const closed = new Promise<number>((resolve) => socket!.once("close", (code) => resolve(code)));

    const response = await closeWith(session);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ paid: "8000", refunded: "22000", transaction: "sig" });
    expect(await closed).toBe(4410);
    expect(h.calls.teardown).toEqual(["closed"]);
    const tx = inspectTransaction(readElapsedPayload(h.calls.settle.at(-1)!)!.transaction)!;
    expect([...tx.signed]).toEqual([h.authorizer.address]);
    expect(tx.accounts).toContain(rentPayer);
  });

  it.each<[string, (other: Address) => Partial<Session>]>([
    ["in another mint", (other) => ({ mint: other })],
    ["naming another receiver authorizer", (other) => ({ receiverAuthorizer: other })],
    ["at another rate", () => ({ rate: 2_000n, deposited: 60_000n })],
  ])("refuses a session on-chain %s with 403, and adopts nothing", async (_, change) => {
    const session = await onChain(change((await generateKeyPairSigner()).address));

    expect((await connect(session, await token(session, "connect"))).status).toBe(403);
    expect((await connect(session, await token(session, "connect"))).status).toBe(403);

    expect(h.calls.provision).toEqual([]);
    expect(h.calls.watch).toEqual([]);
    expect(h.timers.pending).toEqual([]);
    expect((await closeWith(session)).status).toBe(404);
    expect((await fetch(`${h.url}/sessions/${session}`)).status).toBe(404);
  });

  it("refuses a connect without a token with 401 before it reads the chain", async () => {
    const session = await onChain();

    expect((await connect(session)).status).toBe(401);

    expect(h.reads.session).toBe(0);
    expect(h.calls.provision).toEqual([]);
  });

  it.each<[string, (session: Address) => Promise<string>]>([
    ["with a close token", (session) => token(session, "close")],
    ["with a token for another audience", (session) => token(session, "connect", "http://elsewhere")],
    [
      "with an expired token",
      (session) => createSessionToken(h.buyer, { session, audience: h.url, purpose: "connect" }, { nowMs: NOW_MS - 200_000 }),
    ],
    [
      "with a token that another key signed",
      async (session) => createSessionToken(await generateKeyPairSigner(), { session, audience: h.url, purpose: "connect" }, { nowMs: NOW_MS }),
    ],
  ])("refuses a connect %s with 401, and adopts nothing", async (_, make) => {
    const session = await onChain();

    expect((await connect(session, await make(session))).status).toBe(401);

    expect(h.calls.provision).toEqual([]);
    expect(h.calls.watch).toEqual([]);
  });

  it("refuses a token used once already for an adopted session, as for any other: 401", async () => {
    const session = await onChain();
    const once = await token(session, "connect");
    (await connect(session, once)).socket!.close();

    expect((await connect(session, once)).status).toBe(401);
    expect(h.calls.provision).toHaveLength(1);
  });

  it.each([
    ["within the margin of its paid_until", 1n],
    ["past its paid_until", -10n],
  ])("refuses a session on-chain %s with 402, and adopts nothing", async (_, left) => {
    // Paid for 30 s from its start: paid until NOW + `left` seconds.
    const session = await onChain({ startedAt: BigInt(NOW_MS / 1000) - 30n + left });

    expect((await connect(session, await token(session, "connect"))).status).toBe(402);

    expect(h.calls.provision).toEqual([]);
  });

  it("answers 404, and adopts nothing, for a session it has ended while the node still shows its account", async () => {
    const { session } = await open();
    expect((await closeWith(session)).status).toBe(200);
    expect(h.sessions.has(session)).toBe(true); // the fake chain keeps the account, as a node that lags does

    expect((await connect(session, await token(session, "connect"))).status).toBe(404);
    expect(h.calls.provision).toHaveLength(1);
  });

  it("answers 404 to an open paid again after it ended the session, while the node still shows the account, and provisions nothing more", async () => {
    const { session, payload } = await prepareOpen();
    expect((await send(payload)).status).toBe(201);
    expect((await closeWith(session)).status).toBe(200);

    const again = await send(payload); // the fake facilitator answers it as a record would: success

    expect(again.status).toBe(404);
    expect(again.body).toEqual({ error: "unknown_session" });
    expect(h.calls.provision).toHaveLength(1);
  });

  it("ends, and refuses with 404, an adopted session whose account the second read finds gone: closed before the subscription started", async () => {
    const session = await onChain();
    const read = h.chain.readSession.bind(h.chain);
    let reads = 0;
    // The first read, from a node that lags, still shows the account; the second, a moment later, does not.
    h.chain.readSession = async (address) => (reads++ === 0 ? read(address) : undefined);

    expect((await connect(session, await token(session, "connect"))).status).toBe(404);

    expect(reads).toBe(2);
    expect(h.calls.provision).toHaveLength(1);
    expect(h.calls.attach).toEqual([]);
    await expect.poll(() => h.calls.teardown).toEqual(["closedElsewhere"]);
    await expect.poll(() => h.unwatched).toEqual([session]);
  });

  it("adopts a new session opened at the address of one it has ended", async () => {
    const { session } = await open();
    expect((await closeWith(session)).status).toBe(200);
    h.sessions.set(session, { ...h.sessions.get(session)!, startedAt: BigInt(NOW_MS / 1000) + 1n });

    const { socket } = await connect(session, await token(session, "connect"));

    expect(socket).toBeDefined();
    expect(h.calls.provision).toHaveLength(2);
    socket!.close();
  });

  it("remembers a session it has ended for ten minutes, then forgets it", async () => {
    const { session } = await open();
    expect((await closeWith(session)).status).toBe(200);

    h.clock.now = NOW_MS + 10 * 60_000;
    expect((await connect(session, await token(session, "connect"))).status).toBe(404);

    h.clock.now = NOW_MS + 10 * 60_000 + 1;
    // Forgotten: the account the node still shows is then a session past its end, which no connect is accepted for.
    expect((await connect(session, await token(session, "connect"))).status).toBe(402);
    expect(h.calls.provision).toHaveLength(1);
  });

  it("provisions once when two connects for a session it does not track arrive together", async () => {
    const session = await onChain();
    let release!: () => void;
    h.hold.provision = new Promise<void>((resolve) => (release = resolve));

    const first = connect(session, await token(session, "connect"));
    const second = connect(session, await token(session, "connect"));
    await expect.poll(() => h.calls.provision).toHaveLength(1);
    await settleDown(); // the second connect reaches the provisioning in flight
    release();
    const [a, b] = await Promise.all([first, second]);

    expect(a.socket).toBeDefined();
    expect(b.socket).toBeDefined();
    expect(h.calls.provision).toHaveLength(1);
    a.socket!.close();
    b.socket!.close();
  });

  it("refuses with 502 a connect for a session it does not track when the chain cannot be read", async () => {
    const session = await onChain();
    h.chain.readSession = async () => {
      throw new Error("rpc down");
    };

    expect((await connect(session, await token(session, "connect"))).status).toBe(502);
    expect(h.calls.provision).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @lxfoundry/stint-gate test adopt.test.ts`
Expected: FAIL, 19 of the 20 cases. Every connect for a session the gate does not track answers `404` today
(`if (!tracked) return refuseUpgrade(socket, 404)` in `connect`), so every case that expects a socket, `401`, `402`,
`403` or `502` fails. So do these:
- "remembers … for ten minutes": its `402` half;
- "ends, and refuses with 404, an adopted session…": nothing is provisioned today;
- "answers 404 to an open paid again…": today the open provisions a second time and answers `201`.

The one case that passes is "answers 404, and adopts nothing, for a session it has ended…": its `404` still comes from
that line.

- [ ] **Step 3: Remember the sessions the gate has ended**

In `packages/gate/src/gate.ts`, below `const CLOSE_LOOKUP_MS = 2_000;`, add:

```ts
/**
 * How long the gate remembers a session it has ended (spec §7.3): a node can still show a closed account for a moment,
 * and a connect then must not adopt the session again. Far longer than a node lags; the memory is pruned as it is used.
 */
const ENDED_MEMORY_MS = 10 * 60_000;
```

Inside `createGate`, below `const seenTokens = new Map<string, number>();`, add:

```ts
  /** `session/started_at` of each session this gate has ended → when it may be forgotten (ms on the session clock). */
  const endedSessions = new Map<string, number>();
  const endedKey = (session: Address, startedAt: bigint) => `${session}/${startedAt}`;

  function forgetEnded(): void {
    const now = sessionClock();
    for (const [key, forgetAt] of endedSessions) if (forgetAt < now) endedSessions.delete(key);
  }

  /** Whether this gate has ended the session that started at `startedAt` at this address, within `ENDED_MEMORY_MS`. */
  function hasEnded(session: Address, startedAt: bigint): boolean {
    forgetEnded();
    return endedSessions.has(endedKey(session, startedAt));
  }
```

In `end`, replace:

```ts
    if (tracked.ended) return;
    tracked.ended = true;
```

with:

```ts
    if (tracked.ended) return;
    tracked.ended = true;
    forgetEnded();
    endedSessions.set(endedKey(tracked.info.session, tracked.stored.startedAt), sessionClock() + ENDED_MEMORY_MS);
```

- [ ] **Step 4: Check a token against an authority, not a tracked session**

Replace the whole of `authenticate`:

```ts
  /** Checks 1 to 3 of spec §7.2. Check 4 holds for every tracked session: it opened with this gate's terms. */
  async function authenticate(token: string | undefined, tracked: Tracked<U>, purpose: TokenPurpose): Promise<boolean> {
    if (!token) return false;
    const now = tokenClock();
    const check = await verifySessionToken(token, {
      authority: tracked.stored.authority,
      session: tracked.info.session,
      audience: config.origin,
      purpose,
      nowMs: now,
    });
```

with:

```ts
  /**
   * Checks 1 to 3 of spec §7.2, against the session's `authority` as the chain stores it. Check 4 holds for every tracked
   * session: it opened, or was adopted, with this gate's terms.
   */
  async function authenticate(token: string | undefined, session: Address, authority: Address, purpose: TokenPurpose): Promise<boolean> {
    if (!token) return false;
    const now = tokenClock();
    const check = await verifySessionToken(token, { authority, session, audience: config.origin, purpose, nowMs: now });
```

The rest of the function (the `jti` cache) is unchanged. In `closeSession`, replace:

```ts
    if (!(await authenticate(bearer(request), tracked, "close"))) return sendJson(response, 401, { error: "unauthorized" });
```

with:

```ts
    if (!(await authenticate(bearer(request), session, tracked.stored.authority, "close"))) return sendJson(response, 401, { error: "unauthorized" });
```

- [ ] **Step 5: Share the open's provisioning join, and keep an open from bringing back a session the gate ended**

Below `provision`, add:

```ts
  /**
   * The session at `session`, tracked once: an open settled again, and a connect that adopts the session, join a
   * provisioning in flight instead of provisioning again (spec §7.3).
   */
  function track(session: Address, stored: Session): Promise<Tracked<U>> {
    const tracked = sessions.get(session);
    if (tracked) return Promise.resolve(tracked);
    // No `await` between the lookup and the registration: a retried open, or a second connect, joins this provisioning.
    let pending = provisioning.get(session);
    if (!pending) {
      pending = provision(session, stored);
      provisioning.set(session, pending);
      const done = () => void provisioning.delete(session);
      pending.then(done, done);
    }
    return pending;
  }
```

In `open`, replace:

```ts
    let tracked = sessions.get(session);
    if (!tracked) {
      // No `await` between the lookup and the registration: a retried open joins this provisioning.
      let pending = provisioning.get(session);
      if (!pending) {
        pending = provision(session, stored);
        provisioning.set(session, pending);
        const done = () => void provisioning.delete(session);
        pending.then(done, done);
      }
      tracked = await pending;
    }
    sendJson(response, 201, { session, paidUntil: Number(tracked.paidUntil), wsUrl: wsUrl(session) }, paymentResponse);
```

with:

```ts
    const tracked = await track(session, stored);
    sendJson(response, 201, { session, paidUntil: Number(tracked.paidUntil), wsUrl: wsUrl(session) }, paymentResponse);
```

A little above it in `open`, replace:

```ts
    if (!stored) return sendJson(response, 404, { error: "unknown_session" });
```

with:

```ts
    // A repeated payment answered after the session closed: its account is gone, or a node that lags still shows the
    // session this gate ended. No `await` from here to `track`'s registration.
    if (!stored || hasEnded(session, stored.startedAt)) return sendJson(response, 404, { error: "unknown_session" });
```

- [ ] **Step 6: Adopt on connect**

Above `connect`, add:

```ts
  /**
   * A connect for a session this gate does not track (spec §7.3): one opened directly on-chain, or through another of
   * the seller's gates. It is adopted, as if its open had just settled, only once it passes every check of spec §7.2
   * against the account as the chain stores it: the token (checks 1 to 3, `401`), the terms, the mint and the receiver
   * authorizer included (check 4, `403`), and the margin (check 5, `402`). An address that holds no session, or holds one
   * this gate has ended, is `404`. A connect refused before `track` adopts nothing. Once adopted, the account is read
   * once more, after the gate's bound on a node's lag: an account gone then is a session another party closed. Returns
   * the tracked session, or the status the upgrade is refused with.
   */
  async function adopt(session: Address, token: string): Promise<Tracked<U> | number> {
    const stored = await upstream(() => config.chain.readSession(session));
    if (!stored) return 404;
    if (!(await authenticate(token, session, stored.authority, "connect"))) return 401;
    // After the token's check, with no `await` from here to `track`'s registration: a session this gate ended before
    // the connect, or while its token was checked, is not adopted again (the tracked path has the same guard).
    if (hasEnded(session, stored.startedAt)) return 404;
    if (!sessionMatches(stored, seller)) return 403;
    if (Number(paidUntil(stored)) * 1000 - sessionClock() <= marginMs) return 402;
    if (!sessions.has(session) && !provisioning.has(session)) log({ event: "adopt", session });
    const tracked = await track(session, stored);
    // The account was read before the subscription started, and a subscription reports changes only: a close that
    // landed just before, read from a node that lagged, would never be heard of. One more read, once a node has had
    // the time the gate gives it to catch up (`readRetry`), decides: an account gone, or holding another session, is a
    // session another party closed (spec §7.3), and the connect then finds it ending.
    await sleep(readRetry.attempts * readRetry.delayMs);
    const again = await upstream(() => config.chain.readSession(session));
    if (!sameSession(tracked, again)) closedElsewhere(tracked);
    return tracked;
  }
```

`sleep` is the module's own (`const sleep = (ms: number) => …`). It is not one of the gate's `timers`, so the wait does
not show among a test's pending timers. With the harness's `readRetry` of 3 reads 5 ms apart, it lasts 15 ms.

Replace the first lines of `connect`:

```ts
  async function connect(request: IncomingMessage, socket: Duplex, head: Buffer, url: URL, session: Address): Promise<void> {
    const tracked = sessions.get(session);
    if (!tracked) return refuseUpgrade(socket, 404);
    const token = bearer(request) ?? url.searchParams.get("token") ?? undefined;
    if (!(await authenticate(token, tracked, "connect"))) return refuseUpgrade(socket, 401);
```

with:

```ts
  async function connect(request: IncomingMessage, socket: Duplex, head: Buffer, url: URL, session: Address): Promise<void> {
    const token = bearer(request) ?? url.searchParams.get("token") ?? undefined;
    // Before anything is read: a connect with no token costs the chain nothing.
    if (!token) return refuseUpgrade(socket, 401);
    const known = sessions.get(session);
    let tracked: Tracked<U>;
    if (known) {
      if (!(await authenticate(token, session, known.stored.authority, "connect"))) return refuseUpgrade(socket, 401);
      tracked = known;
    } else {
      const adopted = await adopt(session, token);
      if (typeof adopted === "number") return refuseUpgrade(socket, adopted);
      tracked = adopted;
    }
```

The rest of `connect` is unchanged. The checks on `tracked.ended`, `tracked.endingElsewhere`, the terms and the margin
also run for an adopted session. They pass unless the second read handed the session to `closedElsewhere`, which sets
`endingElsewhere` at once, and then the connect is refused with `404`.

In `handleUpgrade`, replace:

```ts
      connect(request, socket, head, url, id).catch((error: unknown) => {
        log({ event: "error", error: error instanceof Error ? error.message : String(error) });
        refuseUpgrade(socket, 500);
      });
```

with:

```ts
      connect(request, socket, head, url, id).catch((error: unknown) => {
        log({ event: "error", error: error instanceof Error ? error.message : String(error) });
        // As on the HTTP routes: a failure of the chain or the facilitator is 502, any other error 500.
        refuseUpgrade(socket, error instanceof UpstreamError ? 502 : 500);
      });
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm --filter @lxfoundry/stint-gate typecheck && pnpm --filter @lxfoundry/stint-gate test`
Expected: PASS, every gate test. The earlier tests that expect `404` on a connect after the gate ended the session, with
the fake chain still holding the account, now pass through the memory of ended sessions:
- `lifecycle.test.ts`, "closes an idle session with a Standard close…";
- `lifecycle.test.ts`, "refuses a connection once it has fired…";
- `gate.test.ts`, "ends the session even when the Closed event cannot be read".

A connect for an address with no account (`gate.test.ts`, "refuses connections before the upgrade") is still `404`.
If one of these answers `101` instead, the memory is not written in `end`.

- [ ] **Step 8: Write the spec's adoption rule**

In `docs/specs/stint-system.md`, section 7.3, replace the row:

```markdown
| Connect for a session this gate has not seen (opened directly on-chain, passing every check of section 7.2, including the mint, and with this gate's receiver authorizer) | Adopt it as if its open had just settled, then accept the connection | — |
```

with:

```markdown
| Connect for a session this gate does not track (opened directly on-chain, or through another of the seller's gates) | Answer `401` to a connect with no token, before anything is read. Otherwise read the session at `confirmed`, and answer `404` if the address holds none. Run checks 1 to 3 of section 7.2 against the account (`401`), then answer `404` if it holds a session this gate has ended: a node can still show a closed account for a moment, so the gate remembers the sessions it ended, for ten minutes. Then check 4 (`403`, the mint and the receiver authorizer included) and check 5 (`402`). A connect refused so far adopts nothing. A session that passes them is adopted as if its open had just settled (`provision()`, the subscription, the idle and end timers; a retried open or a second connect joins that provisioning). Since a subscription reports changes only, the gate then reads the account once more, after its bound on a node's lag. An account gone, or holding another session, is a session another party closed (the row "Account closed by another party"), and the connect is answered `404`. Otherwise the connection is accepted. Each such connect reads the chain before the token's signature can be checked, so a deployment rate-limits the route, as it does the status route | — |
```

In the same table, in the row `Open settled`, replace:

```markdown
If its account is gone (a repeated payment answered after the session closed), answer `404` and do nothing more.
```

with:

```markdown
If its account is gone, or holds a session this gate has ended (a repeated payment answered after the session closed, read from a node that still shows the account), answer `404` and do nothing more.
```

In section 7.1, in the row `GET /sessions/:id/ws`, replace:

```markdown
| Upgrade; `401`; `402` (the session has ended or is within the margin of its end: offers for a new session); `403`; `404`; `503` |
```

with:

```markdown
| Upgrade; `401`; `402` (the session has ended or is within the margin of its end: offers for a new session); `403`; `404`; `502` (the chain cannot be read for a session the gate does not track); `503` |
```

- [ ] **Step 9: Commit**

```bash
git add packages/gate/src/gate.ts packages/gate/test/adopt.test.ts docs/specs/stint-system.md
git commit -m "Adopt a session opened directly on-chain when its buyer connects, once it passes the token and terms checks"
```

---

### Task 2: Connects and closes through the gate with a scenario's own tokens

**Files:**
- Modify: `conformance/package.json`, `pnpm-lock.yaml`
- Create: `conformance/src/tokens.ts`
- Create: `conformance/test/tokens.test.ts`

**Interfaces:**
- Consumes: `createSessionToken`, `verifySessionToken`, `TokenOptions`, `TokenPurpose` from `@lxfoundry/stint-x402`.
- Produces (`conformance/src/tokens.ts`):
  - `tokenFor(signer: KeyPairSigner, gateUrl: string, session: Address, purpose: TokenPurpose, options?: TokenOptions & { readonly audience?: string }): Promise<string>`
  - `type ConnectAnswer = { readonly status: 101; readonly socket: WebSocket } | { readonly status: number; readonly socket?: undefined }`
  - `connectWith(gateUrl: string, session: Address, token?: string): Promise<ConnectAnswer>`
  - `closeCodeOf(socket: WebSocket): Promise<number>`
  - `closeWith(gateUrl: string, session: Address, token: string): Promise<{ readonly status: number; readonly body: unknown }>`

- [ ] **Step 1: Add `ws`**

Run: `pnpm --filter @lxfoundry/stint-conformance add -E ws@8.22.0 && pnpm --filter @lxfoundry/stint-conformance add -E -D @types/ws@8.18.2`

This needs access to the npm registry: `pnpm add` reads the package's metadata even when its store already holds the
version, and `--offline` fails with `ERR_PNPM_NO_OFFLINE_META`.

Expected: `conformance/package.json` gains `"ws": "8.22.0"` under `dependencies` and `"@types/ws": "8.18.2"` under
`devDependencies`. These are exact versions (`-E`), the ones the client and the gate pin, and `pnpm-lock.yaml` records
the same specifiers. Do not edit either file by hand: a specifier in the lockfile that differs from `package.json` makes
`pnpm install --frozen-lockfile` fail.

- [ ] **Step 2: Write the failing test**

Create `conformance/test/tokens.test.ts`:

```ts
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { generateKeyPairSigner, type Address } from "@solana/kit";
import { verifySessionToken } from "@lxfoundry/stint-x402";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { closeCodeOf, closeWith, connectWith, tokenFor } from "../src/tokens.js";

describe("tokens, connects and closes of a scenario's own", () => {
  let server: Server;
  let url: string;
  /** The `Authorization` header of each request the server saw. */
  let seen: (string | undefined)[];

  beforeEach(async () => {
    seen = [];
    const sockets = new WebSocketServer({ noServer: true });
    server = createServer((request, response) => {
      seen.push(request.headers.authorization);
      response.writeHead(request.headers.authorization ? 200 : 401, { "content-type": "application/json" });
      response.end(JSON.stringify({ paid: "5000", refunded: "15000", transaction: "sig" }));
    });
    // Accepts an upgrade with a bearer token, and refuses one without with 401, before the upgrade.
    server.on("upgrade", (request: IncomingMessage, socket, head) => {
      seen.push(request.headers.authorization);
      if (!request.headers.authorization) {
        socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
        return;
      }
      // Closed a moment after the upgrade, so that the test's listener is attached first.
      sockets.handleUpgrade(request, socket, head, (ws) => setTimeout(() => ws.close(4410, "session closed"), 50));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  const someSession = async (): Promise<Address> => (await generateKeyPairSigner()).address;

  it("signs a token for the gate's origin that the gate's check accepts, and one for another audience when asked", async () => {
    const signer = await generateKeyPairSigner();
    const session = await someSession();
    const expected = { authority: signer.address, session, purpose: "connect" as const, nowMs: Date.now() };

    const token = await tokenFor(signer, `${url}/`, session, "connect");
    expect(await verifySessionToken(token, { ...expected, audience: url })).toMatchObject({ ok: true });

    const elsewhere = await tokenFor(signer, url, session, "connect", { audience: "https://elsewhere.invalid" });
    expect(await verifySessionToken(elsewhere, { ...expected, audience: url })).toEqual({ ok: false, reason: "wrong audience" });

    const old = await tokenFor(signer, url, session, "connect", { nowMs: Date.now() - 200_000 });
    expect(await verifySessionToken(old, { ...expected, audience: url })).toEqual({ ok: false, reason: "expired" });
  });

  it("connects with the token as a bearer, and returns the open socket on 101", async () => {
    const answer = await connectWith(url, await someSession(), "a-token");

    expect(answer.status).toBe(101);
    expect(seen).toEqual(["Bearer a-token"]);
    expect(await closeCodeOf(answer.socket!)).toBe(4410);
  });

  it("returns the status an upgrade is refused with, and no socket", async () => {
    const answer = await connectWith(url, await someSession());

    expect(answer).toEqual({ status: 401 });
  });

  it("asks the gate to close with the token as a bearer, and returns its status and body", async () => {
    const session = await someSession();

    expect(await closeWith(url, session, "a-token")).toEqual({
      status: 200,
      body: { paid: "5000", refunded: "15000", transaction: "sig" },
    });
    expect(seen).toEqual(["Bearer a-token"]);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @lxfoundry/stint-conformance test tokens.test.ts`
Expected: FAIL with "Cannot find module '../src/tokens.js'" (or "Failed to load url").

- [ ] **Step 4: Write the helpers**

Create `conformance/src/tokens.ts`:

```ts
import type { Address, KeyPairSigner } from "@solana/kit";
import { createSessionToken, type TokenOptions, type TokenPurpose } from "@lxfoundry/stint-x402";
import { WebSocket } from "ws";

/**
 * A session token for `session` signed by `signer` (spec §7.2), as the session client signs one: `aud` is the gate's
 * origin unless `audience` names another, and `nowMs` and `lifetimeSeconds` set its times.
 */
export function tokenFor(
  signer: KeyPairSigner,
  gateUrl: string,
  session: Address,
  purpose: TokenPurpose,
  options: TokenOptions & { readonly audience?: string } = {},
): Promise<string> {
  const { audience = new URL(gateUrl).origin, ...times } = options;
  return createSessionToken(signer, { session, audience, purpose }, times);
}

/** The gate's answer to a WebSocket connect (spec §7.1): the open socket on `101`, or the status of the refusal. */
export type ConnectAnswer = { readonly status: 101; readonly socket: WebSocket } | { readonly status: number; readonly socket?: undefined };

/** Connects to `session` through the gate, with `token` as a bearer in the `Authorization` header (spec §7.2). */
export function connectWith(gateUrl: string, session: Address, token?: string): Promise<ConnectAnswer> {
  const url = `${gateUrl.replace(/^http/, "ws")}/sessions/${session}/ws`;
  const socket = new WebSocket(url, token === undefined ? {} : { headers: { authorization: `Bearer ${token}` } });
  return new Promise((resolve, reject) => {
    socket.once("open", () => resolve({ status: 101, socket }));
    socket.once("unexpected-response", (_, response) => resolve({ status: response.statusCode ?? 0 }));
    socket.once("error", reject);
  });
}

/** The code `socket` is closed with, whichever side closes it. */
export function closeCodeOf(socket: WebSocket): Promise<number> {
  return new Promise((resolve) => socket.once("close", (code) => resolve(code)));
}

/** Asks the gate to close `session` with `token` as a bearer (spec §7.1), and returns its status and its body, as JSON when it is. */
export async function closeWith(gateUrl: string, session: Address, token: string): Promise<{ readonly status: number; readonly body: unknown }> {
  const response = await fetch(`${gateUrl}/sessions/${session}/close`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
  const text = await response.text();
  try {
    return { status: response.status, body: JSON.parse(text) as unknown };
  } catch {
    return { status: response.status, body: text };
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @lxfoundry/stint-conformance typecheck && pnpm --filter @lxfoundry/stint-conformance test`
Expected: PASS, every conformance test.

- [ ] **Step 6: Commit**

```bash
git add conformance/package.json pnpm-lock.yaml conformance/src/tokens.ts conformance/test/tokens.test.ts
git commit -m "Add connects and closes through the gate with tokens a scenario signs itself"
```

---

### Task 3: Scenario 8, tokens refused before the upgrade

**Files:**
- Create: `conformance/src/scenarios/08-token-refusals.ts`
- Modify: `conformance/src/catalogue.ts`, `conformance/test/catalogue.test.ts`, `e2e/test/local-target.test.ts`

**Interfaces:**
- Consumes: `tokenFor`, `connectWith`, `closeCodeOf` (Task 2); `buyerClient`, `sessionSeconds` (`conformance/src/helpers.ts`);
  `StintSession` (`id`, `cost`, `close()`) from `@lxfoundry/stint-client`.
- Produces: `tokenRefusals(context: ScenarioContext): Promise<void>`.

The gate already checks tokens (spec section 7.2, checks 1 to 3: `authenticate` in `packages/gate/src/gate.ts`), so this
scenario passes as soon as it is written. It is registered `pending` first, as rule 8 of `CLAUDE.md` says, and made
`required` once the run shows it passing.

- [ ] **Step 1: Write the scenario and register it as pending**

Create `conformance/src/scenarios/08-token-refusals.ts`:

```ts
import { expectEqual, expectTrue } from "../assert.js";
import { buyerClient, sessionSeconds } from "../helpers.js";
import { closeCodeOf, connectWith, tokenFor } from "../tokens.js";
import type { ScenarioContext } from "../types.js";

/** Longer ago than a token's longest life (120 s) plus the gate's 30 s of tolerance for clock skew (spec §7.2). */
const LONG_AGO_MS = 200_000;

/**
 * Scenario 8 (spec §12.7): a connect with an expired token, with one for another audience, with one for another purpose,
 * and with one already used, is refused with `401` each time, before the upgrade (spec §7.2, checks 2 and 3). The
 * session is untouched: a connect with a fresh token is accepted, and the buyer's close through the gate settles it.
 */
export async function tokenRefusals(context: ScenarioContext): Promise<void> {
  const buyer = await context.newBuyer(100_000n); // the deposit is 20,000 (30,000 on devnet)
  const session = await buyerClient(buyer).open(context.gateUrl, { seconds: sessionSeconds(context.target, 20) });
  const sign = (purpose: "connect" | "close", options: { readonly nowMs?: number; readonly audience?: string } = {}) =>
    tokenFor(buyer.signer, context.gateUrl, session.id, purpose, options);
  const refused = async (token: string, what: string) =>
    expectEqual((await connectWith(context.gateUrl, session.id, token)).status, 401, what);

  await refused(await sign("connect", { nowMs: Date.now() - LONG_AGO_MS }), "a connect with an expired token is refused");
  await refused(await sign("connect", { audience: "https://elsewhere.invalid" }), "a connect with a token for another audience is refused");
  await refused(await sign("close"), "a connect with a close token is refused");

  const once = await sign("connect");
  const accepted = await connectWith(context.gateUrl, session.id, once);
  expectTrue(accepted.socket, "a connect with a fresh token is accepted");
  const dropped = closeCodeOf(accepted.socket);
  await refused(once, "a connect with a token already used is refused");

  const receipt = await session.close();
  expectEqual(receipt.via, "gate", "the buyer's close goes through the gate");
  const { paid, refunded } = receipt;
  expectTrue(paid !== undefined && refunded !== undefined, "the gate reported the close's amounts");
  expectEqual(paid + refunded, session.cost, "paid and refunded add up to the deposit");
  expectEqual(await dropped, 4410, "the accepted connection is dropped with 4410 once the close is confirmed");
}
```

In `conformance/src/catalogue.ts`, add with the other scenario imports, in numeric order:

```ts
import { tokenRefusals } from "./scenarios/08-token-refusals.js";
```

and replace:

```ts
  pending(8, "Token: expired, wrong aud, wrong purpose, replayed"),
```

with:

```ts
  pending(8, "Token: expired, wrong aud, wrong purpose, replayed", [], "shared", tokenRefusals),
```

Run: `pnpm --filter @lxfoundry/stint-conformance typecheck && pnpm e2e:local`
Expected: no type error. The report lists scenario 8 as `pending` with result `pass`, flagged as passing while pending;
the run exits 0. If it fails, its error names the case. A `101` where `401` is expected means the gate accepted that
token: read `authenticate` and `verifySessionToken` (`packages/x402/src/token.ts`) for that case.

- [ ] **Step 2: Make it `required`**

In `conformance/src/catalogue.ts`, replace the line of Step 1 with:

```ts
  required(8, "Token: expired, wrong aud, wrong purpose, replayed", tokenRefusals),
```

In `conformance/test/catalogue.test.ts` and in `e2e/test/local-target.test.ts`, add `8` to `REQUIRED`, in numeric
order. With stage 3 merged and nothing else, both read `const REQUIRED = [1, 2, 3, 4, 5, 6, 7, 9, 13, 14, 15, 16, 17,
18, 19, 22, 24, 25, 26, 32, 34];` and become `const REQUIRED = [1, 2, 3, 4, 5, 6, 7, 8, 9, 13, 14, 15, 16, 17, 18, 19,
22, 24, 25, 26, 32, 34];`.

Run: `pnpm --filter @lxfoundry/stint-conformance test && pnpm e2e:local`
Expected: PASS; the report counts one more `required` scenario than before this task, every one with result `pass`.

- [ ] **Step 3: Commit**

```bash
git add conformance/src/scenarios/08-token-refusals.ts conformance/src/catalogue.ts conformance/test/catalogue.test.ts e2e/test/local-target.test.ts
git commit -m "Add scenario 8, session tokens refused before the upgrade, and make it required"
```

---

### Task 4: Direct sessions that name the gate's receiver authorizer, or open in a second mint

**Files:**
- Modify: `conformance/src/types.ts`, `conformance/src/sessions.ts`, `conformance/test/types.test.ts`,
  `conformance/test/sessions.test.ts`
- Modify: `e2e/src/targets/direct.ts`
- Modify: `e2e/src/devnet/keys.ts`, `e2e/src/targets/devnet.ts`, `e2e/src/devnet/funds.ts` (two comments)
- Test: `e2e/test/direct-chain.test.ts`, `e2e/test/devnet-keys.test.ts`
- Modify: `docs/specs/stint-system.md` (sections 12.2 and 12.6)

**Interfaces:**
- Consumes: `createDirectChain` and `DirectChainOptions` (`e2e/src/targets/direct.ts`); `deriveKey`'s scheme
  (`e2e/src/devnet/keys.ts`).
- Produces:
  - `DirectChain.open(options)` gains `readonly receiverAuthorizer?: Address` and `readonly mint?: Address`.
  - `DirectSession` gains `readonly mint: Address`.
  - `interface OtherMint { readonly mint: Address; fund(owner: Address, amount: bigint): Promise<Address>; reclaim(owner: KeyPairSigner): Promise<void> }`
    (exported from `conformance/src/types.ts`). `reclaim` sends the account's rent to the direct chain's fee payer.
  - `DirectChain.otherMint(): Promise<OtherMint>`.
  - `DirectChainOptions.otherMint?: () => Promise<KeyPairSigner>`.
  - `deriveNamedKey(seed: Uint8Array, name: string): Promise<HarnessKey>` and `OTHER_MINT_KEY = "other-mint"`
    (`e2e/src/devnet/keys.ts`).

The second mint is created by the harness, with 6 decimals, like USDC. Its keypair is its own mint authority, so only
the harness can mint it. `fund` creates an owner's associated token account for it if there is none, and mints into it.
`reclaim` burns what an owner's account holds and closes the account, so that its rent comes back to the harness. The
`local` target makes a fresh keypair for each network. The `devnet` target derives the keypair from the seed, so that
every run finds the same mint (spec section 12.6).

- [ ] **Step 1: Write the failing tests**

In `conformance/test/types.test.ts`, add `OtherMint` to the type import from `"../src/index.js"`. In the test that holds
`expectTypeOf<Awaited<ReturnType<DirectChain["open"]>>>().toEqualTypeOf<DirectSession>();`, add:

```ts
    expectTypeOf<Parameters<DirectChain["open"]>[0]["receiverAuthorizer"]>().toEqualTypeOf<Address | undefined>();
    expectTypeOf<Parameters<DirectChain["open"]>[0]["mint"]>().toEqualTypeOf<Address | undefined>();
    expectTypeOf<DirectSession["mint"]>().toEqualTypeOf<Address>();
    expectTypeOf<Awaited<ReturnType<DirectChain["otherMint"]>>>().toEqualTypeOf<OtherMint>();
    expectTypeOf<OtherMint["mint"]>().toEqualTypeOf<Address>();
    expectTypeOf<Parameters<OtherMint["fund"]>>().toEqualTypeOf<[owner: Address, amount: bigint]>();
    expectTypeOf<ReturnType<OtherMint["fund"]>>().toEqualTypeOf<Promise<Address>>();
    expectTypeOf<Parameters<OtherMint["reclaim"]>>().toEqualTypeOf<[owner: KeyPairSigner]>();
```

(`Address` and `KeyPairSigner` are already imported there.)

In `conformance/test/sessions.test.ts`, in the test of `directSessionOf`, the expected object gains the session's
mint. Replace:

```ts
      vault: await associatedTokenAddress(session!, mint!),
      rentPayer,
```

with:

```ts
      vault: await associatedTokenAddress(session!, mint!),
      mint: mint!,
      rentPayer,
```

In `e2e/test/direct-chain.test.ts`, extend the imports:

```ts
import { fetchMaybeToken, fetchMint, fetchToken } from "@solana-program/token";
import { CloseKind, STINT_ERROR__SESSION_EXPIRED, dueAt, fetchMaybeSession, fetchSession, paidUntil } from "@lxfoundry/stint-program-client";
import { generateKeyPairSigner, some, type Address, type KeyPairSigner } from "@solana/kit";
import { USDC_DEVNET_MINT } from "../src/fixtures/usdc.js";
```

(merge them into the file's existing import lines of the same modules), and add these cases inside the `describe`:

```ts
  it("opens a session that names the gate's receiver authorizer when asked to, still with the harness's rent payer", async () => {
    const buyer = await buyerWith(1_000_000n);
    const gateAuthorizer = stack.keys.receiverAuthorizer.signer.address;

    const opened = await direct.open({ buyer, seconds: 30, receiverAuthorizer: gateAuthorizer });

    const stored = (await fetchSession(stack.network.rpc, opened.session, { commitment: "confirmed" })).data;
    expect(stored.receiverAuthorizer).toBe(gateAuthorizer);
    expect(stored.rentPayer).toBe(rentPayer.address);
    expect(opened.mint).toBe(USDC_DEVNET_MINT);
    await direct.close(opened, buyer.signer);
  });

  it("makes one second mint, of 6 decimals and its own authority, funds an owner in it, and gives the account's rent back", async () => {
    const other = await direct.otherMint();
    expect((await direct.otherMint()).mint).toBe(other.mint);
    expect(other.mint).not.toBe(USDC_DEVNET_MINT);
    const mint = (await fetchMint(stack.network.rpc, other.mint, { commitment: "confirmed" })).data;
    expect(mint.decimals).toBe(6);
    expect(mint.mintAuthority).toEqual(some(other.mint));
    const owner = await direct.newKey();

    const account = await other.fund(owner.address, 50_000n);
    expect(await other.fund(owner.address, 0n)).toBe(account);
    expect((await fetchToken(stack.network.rpc, account, { commitment: "confirmed" })).data.amount).toBe(50_000n);

    await other.reclaim(owner);
    expect((await fetchMaybeToken(stack.network.rpc, account, { commitment: "confirmed" })).exists).toBe(false);
  });

  /** A key with SOL, which the test holds. */
  const fundedKey = async (): Promise<KeyPairSigner> => {
    const key = await newHarnessKey();
    fundSol(stack.network, key.signer.address, 5);
    await waitForNewSlot(stack.network.rpc);
    return key.signer;
  };

  /** A direct chain on the stack's chain and seller whose fee payer the test holds, and whose second mint is `mintKey` when given. */
  const directChainPaidBy = (feePayer: KeyPairSigner, mintKey?: KeyPairSigner): DirectChain =>
    createDirectChain({
      rpc: stack.network.rpc,
      terms: TEST_TERMS,
      seller: { wallet: stack.keys.seller.signer.address, usdcAccount: stack.keys.sellerUsdcAccount },
      feePayer,
      rentPayer: async () => rentPayer,
      readRetry: ONE_READ,
      ...(mintKey === undefined ? {} : { otherMint: async () => mintKey }),
    });

  it("gives the rent of a reclaimed account back to the direct chain's fee payer", async () => {
    const payer = await fundedKey();
    const chain = directChainPaidBy(payer);
    const other = await chain.otherMint();
    const owner = await chain.newKey();
    await other.fund(owner.address, 50_000n);
    const rent = await stack.network.rpc.getMinimumBalanceForRentExemption(165n).send();
    const before = await balanceOf(payer.address);

    await other.reclaim(owner);

    // The fee payer pays the fee of two signatures, its own and the owner's, and gets the account's rent back.
    expect((await balanceOf(payer.address)) - before).toBe(rent - 10_000n);
  });

  it("finds the second mint an earlier run made, without creating it again, and mints with it", async () => {
    const mintKey = await generateKeyPairSigner();
    const first = await directChainPaidBy(await fundedKey(), mintKey).otherMint();

    // A second chain with the same key, as the devnet target is on every run: creating the account again would fail.
    const second = await directChainPaidBy(await fundedKey(), mintKey).otherMint();

    expect(second.mint).toBe(first.mint);
    const owner = await direct.newKey();
    const account = await second.fund(owner.address, 1_000n);
    expect((await fetchToken(stack.network.rpc, account, { commitment: "confirmed" })).data.amount).toBe(1_000n);
  });

  it("opens a session in the second mint from the buyer's account for it, and closes it paying the seller's account for it", async () => {
    const other = await direct.otherMint();
    const signer = await direct.newKey();
    const account = await other.fund(signer.address, 30_000n);
    const sellerAccount = await other.fund(stack.keys.seller.signer.address, 0n);

    const opened = await direct.open({ buyer: { signer, usdcAccount: account }, seconds: 30, mint: other.mint });

    const stored = (await fetchSession(stack.network.rpc, opened.session, { commitment: "confirmed" })).data;
    expect(stored.mint).toBe(other.mint);
    expect(opened).toMatchObject({ mint: other.mint, receiverToken: sellerAccount, refundTo: account, deposit: 30_000n });
    expect((await fetchToken(stack.network.rpc, opened.vault, { commitment: "confirmed" })).data.amount).toBe(30_000n);
    const signature = await direct.close(opened, signer);
    const closed = await fetchClosedEvent(stack.network.rpc, signature, ONE_READ);
    expect(closed).toBeDefined();
    const due = dueAt(stored, closed!.at);
    const changes = await tokenBalanceChanges(stack.network.rpc, signature, ONE_READ);
    expect(changes.get(sellerAccount)).toBe(due);
    expect(changes.get(account)).toBe(30_000n - due);
  });
```

In `e2e/test/devnet-keys.test.ts`, add `deriveNamedKey` and `OTHER_MINT_KEY` to the import from `../src/devnet/keys.js`,
and add inside `describe("deriveKeys", …)`:

```ts
  it("derives the second mint's key by name: the same for a seed every time, and none of the numbered keys", async () => {
    const seed = new Uint8Array(32).fill(7);

    const named = await deriveNamedKey(seed, OTHER_MINT_KEY);

    expect((await deriveNamedKey(seed, OTHER_MINT_KEY)).signer.address).toBe(named.signer.address);
    const keys = await deriveKeys(seed);
    expect([keys.funding.signer.address, ...keys.holders.keys()]).not.toContain(named.signer.address);
  });
```

(`deriveKeys` is already imported there; if not, import it from the same module.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @lxfoundry/stint-conformance typecheck; pnpm --filter @lxfoundry/stint-e2e typecheck`
Expected: FAIL with type errors: `OtherMint` is not exported, `receiverAuthorizer`, `mint` and `otherMint` do not exist,
and `deriveNamedKey` is not exported.

- [ ] **Step 3: Extend the interfaces**

In `conformance/src/types.ts`, in `DirectSession`, below `readonly vault: Address;`, add:

```ts
  /** The session's mint: USDC, or the harness's second mint (`DirectChain.otherMint`). */
  readonly mint: Address;
```

Above `/** Opens and closes sessions straight on the program (spec §12.2). */`, add:

```ts
/** The harness's second mint (S5): 6 decimals, like USDC, and a mint authority that only the harness holds. */
export interface OtherMint {
  readonly mint: Address;
  /**
   * Creates `owner`'s associated token account for the mint if it has none (the harness pays its rent), mints `amount`
   * into it, and returns the account. An `amount` of 0 creates the account only.
   */
  fund(owner: Address, amount: bigint): Promise<Address>;
  /** Burns what `owner`'s account for the mint holds and closes the account, so that its rent returns to the harness. `owner` needs no SOL. */
  reclaim(owner: KeyPairSigner): Promise<void>;
}
```

In `DirectSession`, replace:

```ts
  /** The seller's token account, which a close pays. */
  readonly receiverToken: Address;
  /** The buyer's USDC account, which a close refunds. */
  readonly refundTo: Address;
```

with:

```ts
  /** The seller's token account for the session's mint, which a close pays. */
  readonly receiverToken: Address;
  /** The buyer's token account for the session's mint, which a close refunds: its USDC account for a USDC session. */
  readonly refundTo: Address;
```

In `DirectChain`, replace `open`'s docstring and signature:

```ts
  /**
   * Opens a session: the buyer funds the vault, and the rent payer and the receiver authorizer are harness keys, not the
   * stack's. `seconds` is a whole number between the offer's minimum and maximum. `remainder` (default 0) is a number of base
   * units, below the rate, that the buyer adds to the vault: the deposit is `rate x seconds + remainder`, the session is paid
   * for `seconds`, and a close from the paid time on pays `rate x seconds` and refunds the remainder.
   */
  open(options: { readonly buyer: Buyer; readonly seconds: number; readonly remainder?: bigint }): Promise<DirectSession>;
```

with:

```ts
  /**
   * Opens a session: the buyer funds the vault, the rent payer is a harness key, not the stack's, and so is the receiver
   * authorizer unless `receiverAuthorizer` names one. `seconds` is a whole number between the offer's minimum and
   * maximum. `remainder` (default 0) is a number of base units, below the rate, that the buyer adds to the vault: the
   * deposit is `rate x seconds + remainder`, the session is paid for `seconds`, and a close from the paid time on pays
   * `rate x seconds` and refunds the remainder.
   */
  open(options: {
    readonly buyer: Buyer;
    readonly seconds: number;
    readonly remainder?: bigint;
    /**
     * The receiver authorizer the session names. Default: a throwaway harness key, so that no gate or sweeper takes the
     * session up. A gate's own (its offer's `extra.receiverAuthorizer`) makes it a session that gate may adopt (spec §7.3).
     */
    readonly receiverAuthorizer?: Address;
    /**
     * The session's mint. Default: USDC, funded from `buyer.usdcAccount`. Another mint (`otherMint().mint`) is funded from
     * the buyer's associated token account for it, which `OtherMint.fund` fills, and a close then pays the seller's
     * associated token account for it, which must exist.
     */
    readonly mint?: Address;
  }): Promise<DirectSession>;
```

and below `newKey(): Promise<KeyPairSigner>;`, add:

```ts
  /** The harness's second mint: the same one on every call, created at the first call if it does not exist yet. */
  otherMint(): Promise<OtherMint>;
```

In `conformance/src/sessions.ts`, in `directSessionOf`, below `vault: await associatedTokenAddress(session, stored.mint),`,
add:

```ts
    mint: stored.mint,
```

- [ ] **Step 4: Name the second mint's key on devnet**

In `e2e/src/devnet/keys.ts`, replace:

```ts
/** The key at `index` of `seed`, of any length: HMAC-SHA-256 of the index, keyed by the seed, taken as an Ed25519 private key. */
export async function deriveKey(seed: Uint8Array, index: number): Promise<HarnessKey> {
  const privateKey = Uint8Array.from(createHmac("sha256", seed).update(`stint-devnet-harness/${index}`).digest());
  const signer = await createKeyPairSignerFromPrivateKeyBytes(privateKey);
  return { signer, secretKey: Uint8Array.from([...privateKey, ...getAddressEncoder().encode(signer.address)]) };
}
```

with:

```ts
/** The key of `label` under `seed`: HMAC-SHA-256 of the label, keyed by the seed, taken as an Ed25519 private key. */
async function keyOf(seed: Uint8Array, label: string): Promise<HarnessKey> {
  const privateKey = Uint8Array.from(createHmac("sha256", seed).update(`stint-devnet-harness/${label}`).digest());
  const signer = await createKeyPairSignerFromPrivateKeyBytes(privateKey);
  return { signer, secretKey: Uint8Array.from([...privateKey, ...getAddressEncoder().encode(signer.address)]) };
}

/** The key at `index` of `seed`, of any length: HMAC-SHA-256 of the index, keyed by the seed, taken as an Ed25519 private key. */
export function deriveKey(seed: Uint8Array, index: number): Promise<HarnessKey> {
  return keyOf(seed, String(index));
}

/** The name of the second mint's key (spec §12.6): the mint's address, and its mint authority. */
export const OTHER_MINT_KEY = "other-mint";

/**
 * A key of `seed` named rather than numbered: it lies outside `KEY_INDEX` and the buyer pool, so it never moves when the
 * pool grows. It is not one of `holders`: the clean-up neither empties it nor signs with it.
 */
export function deriveNamedKey(seed: Uint8Array, name: string): Promise<HarnessKey> {
  return keyOf(seed, name);
}
```

`String(index)` gives the label `deriveKey` used before (`stint-devnet-harness/0`, `…/1`), so every earlier key keeps its
address. The test of `deriveKey` in `devnet-keys.test.ts` pins that.

- [ ] **Step 5: Implement the options and the second mint in the direct chain**

In `e2e/src/targets/direct.ts`, replace the imports:

```ts
import { getCreateAssociatedTokenIdempotentInstructionAsync, getTransferCheckedInstruction } from "@solana-program/token";
import { generateKeyPairSigner, type Address, type KeyPairSigner, type Rpc, type SolanaRpcApi } from "@solana/kit";
import { readUntil, type DirectChain } from "@lxfoundry/stint-conformance";
```

with:

```ts
import { getCreateAccountInstruction } from "@solana-program/system";
import {
  TOKEN_PROGRAM_ADDRESS,
  fetchMaybeMint,
  fetchMaybeToken,
  getBurnCheckedInstruction,
  getCloseAccountInstruction,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getInitializeMint2Instruction,
  getMintSize,
  getMintToCheckedInstruction,
  getTransferCheckedInstruction,
} from "@solana-program/token";
import { generateKeyPairSigner, type Address, type Instruction, type KeyPairSigner, type Rpc, type SolanaRpcApi } from "@solana/kit";
import { readUntil, type DirectChain, type OtherMint } from "@lxfoundry/stint-conformance";
```

Below the imports, add:

```ts
/** How long `OtherMint.reclaim` waits before it reads a balance again that a node may have shown stale. */
const RECLAIM_RETRY_MS = 2_000;
```

In `DirectChainOptions`, below `readonly send?: SendOptions;`, add:

```ts
  /**
   * The keypair of the harness's second mint (spec §12.6), which is also its mint authority. Called once, at the first
   * `otherMint()`. Default: a fresh key. The devnet target derives it from the seed, so that every run finds the same mint.
   */
  readonly otherMint?: () => Promise<KeyPairSigner>;
```

In `createDirectChain`, below the `partiesOnce` definition, add:

```ts
  /** What the second mint lets the harness do, with `key` as both the mint and its authority. */
  const otherMintOf = (key: KeyPairSigner): OtherMint => ({
    mint: key.address,
    async fund(owner, amount) {
      const account = await associatedTokenAddress(owner, key.address);
      const instructions: Instruction[] = [await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: feePayer, owner, mint: key.address })];
      if (amount > 0n) {
        instructions.push(getMintToCheckedInstruction({ mint: key.address, token: account, mintAuthority: key, amount, decimals: USDC_DECIMALS }));
      }
      await sendInstructions(rpc, feePayer, instructions, send);
      return account;
    },
    async reclaim(owner) {
      const account = await associatedTokenAddress(owner.address, key.address);
      // A node that lags can show an older balance than the account holds, right after the close that refunded it, and
      // then closing the account fails: the balance is read again, after a pause, and the reclaim tried once more.
      for (let attempt = 1; ; attempt++) {
        const held = await fetchMaybeToken(rpc, account, { commitment: "confirmed" });
        if (!held.exists) return;
        const instructions: Instruction[] = [];
        if (held.data.amount > 0n) {
          instructions.push(getBurnCheckedInstruction({ account, mint: key.address, authority: owner, amount: held.data.amount, decimals: USDC_DECIMALS }));
        }
        instructions.push(getCloseAccountInstruction({ account, destination: feePayer.address, owner }));
        try {
          await sendInstructions(rpc, feePayer, instructions, send);
          return;
        } catch (error) {
          if (attempt >= 2) throw error;
          await new Promise((resolve) => setTimeout(resolve, RECLAIM_RETRY_MS));
        }
      }
    },
  });
  let otherMint: Promise<OtherMint> | undefined;
  /** The second mint, created the first time if its account does not exist yet: on devnet, an earlier run made it. */
  const otherMintOnce = (): Promise<OtherMint> =>
    (otherMint ??= (async () => {
      const key = await (options.otherMint ?? generateKeyPairSigner)();
      if (!(await fetchMaybeMint(rpc, key.address, { commitment: "confirmed" })).exists) {
        const space = BigInt(getMintSize());
        const lamports = await rpc.getMinimumBalanceForRentExemption(space).send();
        await sendInstructions(
          rpc,
          feePayer,
          [
            getCreateAccountInstruction({ payer: feePayer, newAccount: key, lamports, space, programAddress: TOKEN_PROGRAM_ADDRESS }),
            getInitializeMint2Instruction({ mint: key.address, decimals: USDC_DECIMALS, mintAuthority: key.address }),
          ],
          send,
        );
      }
      return otherMintOf(key);
    })().catch((error: unknown) => {
      otherMint = undefined;
      throw error;
    }));
```

In `open`, replace the signature line and the lines from `const { rentPayer, receiverAuthorizer } = await partiesOnce();`
to the end of the `return { … };`:

```ts
    async open({ buyer, seconds, remainder = 0n }) {
```

```ts
      const { rentPayer, receiverAuthorizer } = await partiesOnce();
      const deposit = terms.rate * BigInt(seconds) + remainder;
      const seed = randomSeed();
      const [session] = await findSessionPda(buyer.signer.address, seed);
      const vault = await associatedTokenAddress(session, USDC_DEVNET_MINT);
      await sendInstructions(
        rpc,
        feePayer,
        [
          await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: rentPayer, owner: session, mint: USDC_DEVNET_MINT }),
          getTransferCheckedInstruction({
            source: buyer.usdcAccount,
            mint: USDC_DEVNET_MINT,
            destination: vault,
            authority: buyer.signer,
            amount: deposit,
            decimals: USDC_DECIMALS,
          }),
          getOpenInstruction({
            authority: buyer.signer,
            rentPayer,
            session,
            mint: USDC_DEVNET_MINT,
            vault,
            receiver: seller.wallet,
            receiverAuthorizer,
            refundOwner: buyer.signer.address,
            ...(await eventAccounts()),
            seed,
            rate: terms.rate,
            minSeconds: terms.minSeconds,
            maxSeconds: terms.maxSeconds,
          }),
        ],
        send,
      );
      const opened = await readUntil(readRetry, () => fetchMaybeSession(rpc, session, { commitment: "confirmed" }), (read) => read.exists);
      if (!opened.exists) throw new Error(`The session ${session} is not on the chain after its open was confirmed`);
      return {
        session,
        vault,
        rentPayer: rentPayer.address,
        receiverToken: seller.usdcAccount,
        refundTo: buyer.usdcAccount,
        deposit,
        startedAt: opened.data.startedAt,
        paidUntil: paidUntil(opened.data),
      };
```

with:

```ts
    async open({ buyer, seconds, remainder = 0n, receiverAuthorizer, mint = USDC_DEVNET_MINT }) {
```

```ts
      const parties = await partiesOnce();
      const deposit = terms.rate * BigInt(seconds) + remainder;
      const seed = randomSeed();
      const [session] = await findSessionPda(buyer.signer.address, seed);
      const vault = await associatedTokenAddress(session, mint);
      // USDC comes from the buyer's USDC account and pays the seller's; another mint, from and to their accounts for it.
      const usdc = mint === USDC_DEVNET_MINT;
      const source = usdc ? buyer.usdcAccount : await associatedTokenAddress(buyer.signer.address, mint);
      const receiverToken = usdc ? seller.usdcAccount : await associatedTokenAddress(seller.wallet, mint);
      await sendInstructions(
        rpc,
        feePayer,
        [
          await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: parties.rentPayer, owner: session, mint }),
          getTransferCheckedInstruction({
            source,
            mint,
            destination: vault,
            authority: buyer.signer,
            amount: deposit,
            decimals: USDC_DECIMALS,
          }),
          getOpenInstruction({
            authority: buyer.signer,
            rentPayer: parties.rentPayer,
            session,
            mint,
            vault,
            receiver: seller.wallet,
            receiverAuthorizer: receiverAuthorizer ?? parties.receiverAuthorizer,
            refundOwner: buyer.signer.address,
            ...(await eventAccounts()),
            seed,
            rate: terms.rate,
            minSeconds: terms.minSeconds,
            maxSeconds: terms.maxSeconds,
          }),
        ],
        send,
      );
      const opened = await readUntil(readRetry, () => fetchMaybeSession(rpc, session, { commitment: "confirmed" }), (read) => read.exists);
      if (!opened.exists) throw new Error(`The session ${session} is not on the chain after its open was confirmed`);
      return {
        session,
        vault,
        mint,
        rentPayer: parties.rentPayer.address,
        receiverToken,
        refundTo: source,
        deposit,
        startedAt: opened.data.startedAt,
        paidUntil: paidUntil(opened.data),
      };
```

In the returned object, below `newKey: () => generateKeyPairSigner(),`, add:

```ts
    otherMint: otherMintOnce,
```

In the docstring of `createDirectChain`, replace:

```ts
 * signers: the rent payer creates the vault,
 * the buyer funds it, and the program opens the session. The receiver authorizer is a throwaway key whose secret is
 * dropped: only the buyer can close the session before its paid time, and anyone from then on.
```

with:

```ts
 * signers: the rent payer creates the vault,
 * the buyer funds it, and the program opens the session. The receiver authorizer is a throwaway key whose secret is
 * dropped, unless `open` names another: only the buyer can then close the session before its paid time, and anyone from
 * then on. A session in the second mint (`otherMint`) has a mint other than the offer's asset (S5).
```

- [ ] **Step 6: Give the devnet target its second mint**

In `e2e/src/targets/devnet.ts`, replace the import:

```ts
import { KEY_INDEX, deriveKey, deriveKeys, type DevnetKeys } from "../devnet/keys.js";
```

with:

```ts
import { KEY_INDEX, OTHER_MINT_KEY, deriveKey, deriveKeys, deriveNamedKey, type DevnetKeys } from "../devnet/keys.js";
```

and in the `createDirectChain({ … })` call, below `send,`, add:

```ts
    // Derived from the seed, so that every run finds the mint an earlier run made (spec §12.6).
    otherMint: async () => (await deriveNamedKey(options.seed, OTHER_MINT_KEY)).signer,
```

In `e2e/src/devnet/funds.ts`, two comments say the harness never opens a session in another mint. In `FoundSessions`,
replace:

```ts
  /** Sessions of any other mint: the harness never opens one, closing it would create accounts it cannot recover, and it is not its to fix. */
```

with:

```ts
  /**
   * Sessions of any other mint, left alone. The one scenario that opens a session in another mint, scenario 20, closes it
   * itself; closing a stray one here would create accounts for a mint the clean-up does not hold.
   */
```

and in the docstring of `cleanUp`, replace:

```ts
 * none. Sessions of a mint other than USDC that name a held key are reported as a note and left alone: they
 * do not stop a start, and closing one would create accounts for a mint the harness does not hold. So are
```

with:

```ts
 * none. Sessions of a mint other than USDC that name a held key are reported as a note and left alone: they
 * do not stop a start, and closing one would create accounts for a mint the clean-up does not hold (scenario 20
 * closes the session it opens in the harness's second mint itself). So are
```

The clean-up's behaviour does not change.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm typecheck && pnpm --filter @lxfoundry/stint-conformance test && pnpm --filter @lxfoundry/stint-e2e test direct-chain.test.ts devnet-keys.test.ts`
Expected: PASS. If the case "opens a session in the second mint" fails at the open with a token-program error, check
that the vault is the session's associated token account for the second mint, not for USDC.

- [ ] **Step 8: Describe the harness's direct sessions in the spec**

In `docs/specs/stint-system.md`, section 12.2, below the paragraph that ends "it is reported as not applicable, not as
failed.", add:

```markdown
**Sessions opened directly on-chain** (scenarios 15, 16, 20 and 35). Where the harness holds the keys to do so, it
opens a session straight on the program, with no gate and no facilitator. The buyer funds the vault, and a harness key
pays the rent, so the facilitator neither sweeps the session nor closes it for its buyer (scenarios 15 and 16). The
receiver authorizer is one of two keys:
- a throwaway key, so that no gate takes the session up;
- or the gate's own, read from its offer, so that the gate may adopt the session (scenarios 20 and 35).

For scenario 20 it opens the session in a second mint that it holds, of 6 decimals like USDC, so that only the mint
differs from the gate's terms (S5).
```

In section 12.6, in the prerequisite that begins "a funding key with SOL and the offer's asset", after the sentence that
ends "and returns what its keys hold to the funding key." (it breaks across lines), add the following, inside the same
bullet, at its two-space indentation, rewrapping the bullet's lines as needed:

```markdown
The second mint of scenario 20 is derived from the seed too, as its own mint authority: the first run that needs it
creates it, with the seller's token account for it, and both are kept for later runs. The scenario closes its own
session in that mint and gives back the buyer's account for it.
```

- [ ] **Step 9: Commit**

```bash
git add conformance/src/types.ts conformance/src/sessions.ts conformance/test/types.test.ts conformance/test/sessions.test.ts e2e/src/targets/direct.ts e2e/src/devnet/keys.ts e2e/src/targets/devnet.ts e2e/src/devnet/funds.ts e2e/test/direct-chain.test.ts e2e/test/devnet-keys.test.ts docs/specs/stint-system.md
git commit -m "Let the harness open sessions that name the gate's receiver authorizer, or in a second mint it holds"
```

---

### Task 5: Scenario 35, a session opened on-chain and adopted

**Files:**
- Create: `conformance/src/scenarios/35-adopted-session.ts`
- Modify: `conformance/src/catalogue.ts`, `conformance/test/catalogue.test.ts`, `e2e/test/local-target.test.ts`

**Interfaces:**
- Consumes:
  - Task 1's adoption;
  - `tokenFor`, `connectWith`, `closeCodeOf`, `closeWith` (Task 2);
  - `DirectChain.open({ receiverAuthorizer })` (Task 4);
  - `openOffers` (`conformance/src/payments.ts`);
  - `readOpenedSession`, `expectRefunded` (`conformance/src/sessions.ts`);
  - `assertRentReturned` (`conformance/src/scenarios/22-example-agent-task.ts`);
  - `readUntil` (`conformance/src/reads.ts`);
  - `lamportBalances` (`@lxfoundry/stint-x402`).
- Produces: `adoptedSession(context: ScenarioContext): Promise<void>`, and, exported for scenario 20,
  `expectOfferTerms(stored: Session, offer: ElapsedRequirements): void` and
  `connectOnceSeen(context: ScenarioContext, sign: () => Promise<string>, session: Address): Promise<ConnectAnswer>`.

- [ ] **Step 1: Write the scenario and register it as pending**

Create `conformance/src/scenarios/35-adopted-session.ts`:

```ts
import { address, type Address } from "@solana/kit";
import type { Session } from "@lxfoundry/stint-program-client";
import { lamportBalances, type ElapsedRequirements } from "@lxfoundry/stint-x402";
import { expectEqual, expectTrue } from "../assert.js";
import { sessionSeconds } from "../helpers.js";
import { openOffers } from "../payments.js";
import { readUntil } from "../reads.js";
import { expectRefunded, readOpenedSession } from "../sessions.js";
import { closeCodeOf, closeWith, connectWith, tokenFor, type ConnectAnswer } from "../tokens.js";
import type { ScenarioContext } from "../types.js";
import { assertRentReturned } from "./22-example-agent-task.js";

/** Checks that `stored` has the terms of the gate's `offer` besides its mint: receiver, receiver authorizer, rate and bounds (spec §7.2, check 4). */
export function expectOfferTerms(stored: Session, offer: ElapsedRequirements): void {
  expectEqual(stored.receiver, address(offer.payTo), "the session pays the offer's payTo");
  expectEqual(stored.receiverAuthorizer, address(offer.extra.receiverAuthorizer), "the session names the gate's receiver authorizer");
  expectEqual(stored.rate, BigInt(offer.extra.rate), "the session has the offer's rate");
  expectEqual(stored.minSeconds, offer.extra.minSeconds, "the session has the offer's minSeconds");
  expectEqual(stored.maxSeconds, offer.extra.maxSeconds, "the session has the offer's maxSeconds");
}

/**
 * A connect for `session` with a fresh token each time, tried again within `readRetry` while the gate answers `404`: the
 * gate reads the account from its own node, which can answer from behind right after the open (spec §12.2).
 */
export function connectOnceSeen(context: ScenarioContext, sign: () => Promise<string>, session: Address): Promise<ConnectAnswer> {
  return readUntil(context.readRetry, async () => connectWith(context.gateUrl, session, await sign()), (answer) => answer.status !== 404);
}

/**
 * Scenario 35 (spec §12.7): a session opened directly on-chain with the gate's terms, mint and receiver authorizer, and a
 * harness key as rent payer, then a connect. The gate adopts it (spec §7.3): it accepts the connection, and the buyer's
 * close through the gate settles the session, refunded as in scenario 1, with the rent returned to the harness's rent
 * payer.
 */
export async function adoptedSession(context: ScenarioContext): Promise<void> {
  const direct = context.direct;
  if (!direct) throw new Error("scenario 35 needs a target that provides direct chain access");
  const { offer } = await openOffers(context.gateUrl);
  const buyer = await context.newBuyer(100_000n); // the deposit is 20,000 (30,000 on devnet)
  const seconds = sessionSeconds(context.target, 20);
  const opened = await direct.open({ buyer, seconds, receiverAuthorizer: address(offer.extra.receiverAuthorizer) });
  const stored = await readOpenedSession(context, opened.session);
  expectEqual(stored.mint, address(offer.asset), "the session is in the offer's asset");
  expectOfferTerms(stored, offer);
  if (context.stack) expectTrue(stored.rentPayer !== context.stack.rentPayer, "the rent payer is a harness key, not the facilitator's");

  const sign = (purpose: "connect" | "close") => tokenFor(buyer.signer, context.gateUrl, opened.session, purpose);
  const connected = await connectOnceSeen(context, () => sign("connect"), opened.session);
  expectTrue(connected.socket, `the gate accepts a connect for a session it never sold, and adopts it (status ${connected.status})`);
  const dropped = closeCodeOf(connected.socket);

  const close = await closeWith(context.gateUrl, opened.session, await sign("close"));
  expectEqual(close.status, 200, "the gate closes the adopted session on the buyer's request");
  const { paid, refunded, transaction } = close.body as { paid?: string; refunded?: string; transaction?: string };
  expectTrue(transaction, "the close's answer names its transaction");
  expectTrue(paid !== undefined && refunded !== undefined, "the gate reported the close's amounts");
  await expectRefunded(context, {
    signature: transaction,
    session: opened.session,
    stored,
    buyer,
    reported: { paid: BigInt(paid), refunded: BigInt(refunded) },
  });
  assertRentReturned(await lamportBalances(context.rpc, transaction, context.readRetry), {
    rentPayer: opened.rentPayer,
    session: opened.session,
    vault: opened.vault,
  });
  expectEqual(await dropped, 4410, "the connection is dropped with 4410 once the close is confirmed");
}
```

In `conformance/src/catalogue.ts`, add with the other scenario imports, in numeric order:

```ts
import { adoptedSession } from "./scenarios/35-adopted-session.js";
```

and replace:

```ts
  pending(35, "A session opened on-chain with the gate's terms is adopted"),
```

with:

```ts
  pending(35, "A session opened on-chain with the gate's terms is adopted", [], "shared", adoptedSession),
```

Run: `pnpm --filter @lxfoundry/stint-conformance typecheck && pnpm e2e:local`
Expected: no type error. The report lists scenario 35 as `pending` with result `pass`, flagged as passing while pending;
the run exits 0. If it fails:

| Error | What to check |
|---|---|
| "the gate accepts a connect … (status 404)" | Task 1's `adopt` is not reached: `connect` still refuses an untracked session before reading the account |
| "… (status 403)" | The session's terms differ from the gate's: compare the assertions of `expectOfferTerms`, which pass, with `sessionMatches` (`packages/x402/src/checks.ts`) |
| "the gate closes the adopted session …: expected 200, got 502" | The facilitator refused the close: read its log for the reason (a close of a session with a harness rent payer is checked by `checkCloseTransaction` only, which does not look at the rent payer) |

- [ ] **Step 2: Make it `required`**

In `conformance/src/catalogue.ts`, replace the line of Step 1 with:

```ts
  required(35, "A session opened on-chain with the gate's terms is adopted", adoptedSession),
```

In `conformance/test/catalogue.test.ts` and in `e2e/test/local-target.test.ts`, add `35` at the end of `REQUIRED`.

Run: `pnpm --filter @lxfoundry/stint-conformance test && pnpm e2e:local`
Expected: PASS; one more `required` scenario than before this task, every one with result `pass`.

- [ ] **Step 3: Commit**

```bash
git add conformance/src/scenarios/35-adopted-session.ts conformance/src/catalogue.ts conformance/test/catalogue.test.ts e2e/test/local-target.test.ts
git commit -m "Add scenario 35, a session opened on-chain and adopted by the gate on connect, and make it required"
```

---

### Task 6: Scenario 20, a session in another mint, refused and not adopted

**Files:**
- Create: `conformance/src/scenarios/20-other-mint.ts`
- Modify: `conformance/src/catalogue.ts`, `conformance/test/catalogue.test.ts`, `e2e/test/local-target.test.ts`

**Interfaces:**
- Consumes:
  - `DirectChain.otherMint()`, `DirectChain.open({ mint, receiverAuthorizer })`, `DirectChain.close`, `DirectChain.newKey`
    (Task 4);
  - `tokenFor`, `closeWith` (Task 2);
  - `expectOfferTerms`, `connectOnceSeen` (Task 5);
  - `openOffers`, `readOpenedSession`, `sessionSeconds`.
- Produces: `otherMintRefused(context: ScenarioContext): Promise<void>`.

- [ ] **Step 1: Write the scenario and register it as pending**

Create `conformance/src/scenarios/20-other-mint.ts`:

```ts
import { address } from "@solana/kit";
import { fetchMaybeSession } from "@lxfoundry/stint-program-client";
import { expectEqual, expectTrue } from "../assert.js";
import { sessionSeconds } from "../helpers.js";
import { openOffers } from "../payments.js";
import { readUntil } from "../reads.js";
import { readOpenedSession } from "../sessions.js";
import { closeWith, tokenFor } from "../tokens.js";
import type { ScenarioContext } from "../types.js";
import { connectOnceSeen, expectOfferTerms } from "./35-adopted-session.js";

/**
 * Scenario 20 (spec §12.7): a session opened directly on-chain with the gate's terms and receiver authorizer, but in
 * another mint, which anyone can create (S5). A connect with a valid token is refused with `403`, and so is a second
 * one. The gate does not adopt the session (spec §7.2, check 4; §7.3): it has no such session to close, and it reports
 * no status for it. The scenario then closes the session itself, on the program, and gives back the buyer's account for
 * the mint, whether or not a check failed.
 */
export async function otherMintRefused(context: ScenarioContext): Promise<void> {
  const direct = context.direct;
  if (!direct) throw new Error("scenario 20 needs a target that provides direct chain access");
  const { offer } = await openOffers(context.gateUrl);
  const other = await direct.otherMint();
  expectTrue(other.mint !== address(offer.asset), "the second mint is not the offer's asset");
  const signer = await direct.newKey();
  const seconds = sessionSeconds(context.target, 20);
  const account = await other.fund(signer.address, BigInt(offer.extra.rate) * BigInt(seconds));
  // A close pays the seller in the session's mint, so the seller's account for it must exist.
  await other.fund(address(offer.payTo), 0n);
  const opened = await direct.open({
    buyer: { signer, usdcAccount: account },
    seconds,
    mint: other.mint,
    receiverAuthorizer: address(offer.extra.receiverAuthorizer),
  });

  let checked = false;
  try {
    const stored = await readOpenedSession(context, opened.session);
    expectEqual(stored.mint, other.mint, "the session is in the second mint");
    expectOfferTerms(stored, offer);
    const sign = (purpose: "connect" | "close") => tokenFor(signer, context.gateUrl, opened.session, purpose);

    // Each connect is tried again while the gate answers 404: its node can answer from behind right after the open.
    const first = await connectOnceSeen(context, () => sign("connect"), opened.session);
    expectEqual(first.status, 403, "a connect for a session in another mint is refused with 403");
    const second = await connectOnceSeen(context, () => sign("connect"), opened.session);
    expectEqual(second.status, 403, "a second connect is refused with 403 too");
    // The gate tracks a session it adopted, and would answer a close request for it.
    expectEqual((await closeWith(context.gateUrl, opened.session, await sign("close"))).status, 404, "the gate has no such session to close: it adopted nothing");
    const status = await fetch(`${context.gateUrl}/sessions/${opened.session}`);
    await status.body?.cancel();
    expectEqual(status.status, 404, "the gate reports no status for a session in another mint");
    checked = true;
  } finally {
    // The gate never took the session up: its buyer closes it on the program, and gives back its account for the mint.
    const cleanUp = async () => {
      await direct.close(opened, signer);
      await other.reclaim(signer);
    };
    // A failed check is the scenario's result; a clean-up that fails after every check passed is one too.
    if (checked) await cleanUp();
    else await cleanUp().catch(() => undefined);
  }
  const readSession = () => fetchMaybeSession(context.rpc, opened.session, { commitment: "confirmed" });
  expectTrue(!(await readUntil(context.readRetry, readSession, (read) => !read.exists)).exists, "the scenario's own close leaves no session on chain");
}
```

In `conformance/src/catalogue.ts`, add with the other scenario imports, in numeric order:

```ts
import { otherMintRefused } from "./scenarios/20-other-mint.js";
```

and replace:

```ts
  pending(20, "Session opened on-chain with the gate's terms but another mint"),
```

with:

```ts
  pending(20, "Session opened on-chain with the gate's terms but another mint", [], "shared", otherMintRefused),
```

Run: `pnpm --filter @lxfoundry/stint-conformance typecheck && pnpm e2e:local`
Expected: no type error. The report lists scenario 20 as `pending` with result `pass`, flagged as passing while pending;
the run exits 0. A `101` where `403` is expected means the gate adopted a session in another mint: `sessionMatches`
must compare the mint with the offer's `asset` (spec §7.2, check 4).

- [ ] **Step 2: Make it `required`**

In `conformance/src/catalogue.ts`, replace the line of Step 1 with:

```ts
  required(20, "Session opened on-chain with the gate's terms but another mint", otherMintRefused),
```

In `conformance/test/catalogue.test.ts` and in `e2e/test/local-target.test.ts`, add `20` to `REQUIRED`, in numeric
order. Both then read `const REQUIRED = [1, 2, 3, 4, 5, 6, 7, 8, 9, 13, 14, 15, 16, 17, 18, 19, 20, 22, 24, 25, 26, 32,
34, 35];`.

Run: `pnpm --filter @lxfoundry/stint-conformance test && pnpm e2e:local`
Expected: PASS; 24 `required` scenarios, every one with result `pass`.

- [ ] **Step 3: Commit**

```bash
git add conformance/src/scenarios/20-other-mint.ts conformance/src/catalogue.ts conformance/test/catalogue.test.ts e2e/test/local-target.test.ts
git commit -m "Add scenario 20, a session on-chain in another mint refused with 403 and not adopted, and make it required"
```

---

### Task 7: The new scenarios on devnet, and the README

**Files:**
- Modify: `e2e/test/devnet-target.test.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: the catalogue with 24 required scenarios (Tasks 3, 5 and 6).
- Produces: nothing new.

- [ ] **Step 1: Run the new scenarios through the devnet target, against a local network**

In `e2e/test/devnet-target.test.ts`, in the test "passes the required scenarios with buyers funded from the funding
key", replace:

```ts
    const required = [1, 2, 3, 4, 5, 6, 7, 9, 13, 14, 15, 16, 17, 18, 19, 22, 24, 25, 26, 32, 34];
```

with:

```ts
    const required = [1, 2, 3, 4, 5, 6, 7, 8, 9, 13, 14, 15, 16, 17, 18, 19, 20, 22, 24, 25, 26, 32, 34, 35];
```

Scenario 20 now leaves rent behind on purpose: the second mint and the seller's account for it, 3,500,880 lamports,
kept for later runs (spec §12.6). The test "closes a session left open at the end, returns the funds, and stops"
bounds what the funding key spent at 5,000,000 lamports, on fees only. In that test, replace:

```ts
    const lamportsAfter = (await chain.network.rpc.getBalance(main.funding, { commitment: "confirmed" }).send()).value;
    // The funding key paid fees only: the rent it lent for token accounts, and the SOL it gave the stack, came back.
    expect(lamportsBefore - lamportsAfter).toBeLessThan(5_000_000n);
```

with:

```ts
    const lamportsOf = async (account: Address) => (await chain.network.rpc.getBalance(account, { commitment: "confirmed" }).send()).value;
    const lamportsAfter = await lamportsOf(main.funding);
    // Scenario 20's second mint and the seller's account for it keep their rent, once for a seed (spec §12.6).
    const otherMint = (await deriveNamedKey(main.seed, OTHER_MINT_KEY)).signer.address;
    const kept = (await lamportsOf(otherMint)) + (await lamportsOf(await associatedTokenAddress(stack.keys.seller.signer.address, otherMint)));
    // Apart from that, the funding key paid fees only: the rent it lent for token accounts, and the SOL it gave the stack, came back.
    expect(lamportsBefore - lamportsAfter - kept).toBeLessThan(5_000_000n);
```

Replace the file's import `import { deriveKeys } from "../src/devnet/keys.js";` with
`import { OTHER_MINT_KEY, deriveKeys, deriveNamedKey } from "../src/devnet/keys.js";`. The file already imports
`associatedTokenAddress` and the type `Address`.

Run: `pnpm --filter @lxfoundry/stint-e2e test devnet-target.test.ts`
Expected: PASS. Scenario 20 runs here with the devnet target's second mint, derived from the test's seed and created on
the local network at its first use. Without the edit above, the lamports test fails with "expected 5475880 to be less
than 5000000" (the fees and the kept rent together).

- [ ] **Step 2: The whole suite, and the program**

Run: `pnpm typecheck && pnpm test && pnpm e2e:local && git diff --stat main -- programs/`
Expected: PASS everywhere; `pnpm e2e:local` reports `required 24`, every one `pass`; the `git diff` prints nothing.

- [ ] **Step 3: The devnet runs (the person, in WSL)**

Run: `pnpm e2e:devnet funds`
Expected: `✓ Funded`. Otherwise fund the address it prints, as it says. The first run that reaches scenario 20 creates
the second mint and the seller's account for it: about 0.0035 SOL of rent, once for the seed.

Run: `pnpm e2e:devnet`, then once more after it ends.
Expected, both times: exit 0, every `required` scenario `pass`, scenarios 8, 20 and 35 among them. Record each run's
report (scenario, result, duration) and the funding key's lines before and after for the pull request.

If a run fails:

| Symptom | Likely cause | What to do |
|---|---|---|
| Scenario 35 or 20: "… (status 404)" after the connect's retries | The gate's node still does not show the account the direct open created | Rerun once. If it repeats, the devnet target's `readRetry` (`e2e/src/targets/devnet.ts`) is too short for the provider |
| Scenario 35: the connect takes about 10 s | Expected: an adopted session is read again after the gate's bound on a node's lag, which the devnet target sets at 20 reads 500 ms apart | Nothing |
| Scenario 20: the second mint's creation fails for want of SOL | The funding key is low | `pnpm e2e:devnet funds`, then fund it |
| Scenario 8: "a connect with an expired token is refused: expected 401, got 101" | The gate's clock is 110 to 230 s behind the scenario's: the token was issued 200 s ago for 60 s, and the gate allows 30 s of skew either side | Check the machine's clock; the two run on the same machine on devnet |
| The clean-up reports a session of another mint | A run stopped inside scenario 20 before its own close | It does not stop a run. From its `paid_until` on, anyone can close it: the buyer's key is gone, so it stays until someone does |

- [ ] **Step 4: Record the scenarios in the README**

In `README.md`, section "Running the scenarios on devnet", replace:

```markdown
Scenarios 1, 2, 3, 4, 5, 6, 7, 9, 13, 14, 15, 16, 17, 18, 19, 22, 24, 25, 26, 32 and 34 pass on devnet.
```

with:

```markdown
Scenarios 1, 2, 3, 4, 5, 6, 7, 8, 9, 13, 14, 15, 16, 17, 18, 19, 20, 22, 24, 25, 26, 32, 34 and 35 pass on devnet.
```

In the same section, replace:

```markdown
watch: it plays no part in any scenario, and the fees that runs spend are the only thing that does not
come back to it.
```

with:

```markdown
watch: it plays no part in any scenario, and the fees that runs spend are the only thing that does not
come back to it, apart from about 0.0035 SOL of rent, paid once for a seed, for scenario 20's second mint and the
seller's account for it.
```

In the section "Status", replace:

```markdown
payment sent twice is settled once and answered twice. Twenty-one of the 35 end-to-end scenarios of the
[specification](docs/specs/stint-system.md) (section 12.7) pass on a local network and on devnet, and the run report
lists the other 14 as pending.
```

with:

```markdown
payment sent twice is settled once and answered twice. The gate refuses a session token that has expired, names
another audience or purpose, or was used before, and adopts a session opened directly on-chain on the seller's terms
when its buyer connects; one in another mint is refused. Twenty-four of the 35 end-to-end scenarios of the
[specification](docs/specs/stint-system.md) (section 12.7) pass on a local network and on devnet, and the run report
lists the other 11 as pending.
```

(If the README's line breaks differ, replace the same sentences wherever they break, and rewrap the paragraph at the
width of the lines around it.)

```bash
git add e2e/test/devnet-target.test.ts README.md
git commit -m "Record the scenarios of session tokens and adoption that pass on devnet"
```

---

## Done when

- `pnpm typecheck`, `pnpm test` and `pnpm e2e:local` pass, locally in WSL and in continuous integration.
- Scenarios 8, 20 and 35 are `required`, and pass on `local` and on devnet with every earlier required scenario.
- A connect with a token that is expired, for another audience or purpose, or used before, is refused with `401`
  before the upgrade.
- A connect for a session the gate does not track adopts the session once the account passes checks 1 to 5, as an open
  that just settled. It provisions the session once however many connects or opens arrive together, and refuses it with
  `404` when a second read, after the gate's bound on a node's lag, finds the account gone. A connect refused before
  `track` (`401`, `402`, `403`, `404`) adopts nothing.
- A session the gate has ended is not brought back while a node still shows its account, neither by a connect nor by
  an open paid again.
- `git diff --stat main -- programs/` is empty.
- The pull request's description records the devnet runs and any deviation from this plan.

## Spec edits made by this stage

- Section 7.1, `GET /sessions/:id/ws`: `502` when the chain cannot be read for a session the gate does not track (Task 1).
- Section 7.3, the adoption row: `401` for a connect with no token before anything is read; the order of the checks
  and what each refusal answers; the memory of ended sessions; the second read after the gate's bound on a node's lag;
  the rate-limit note. The row `Open settled`: the memory of ended sessions (Task 1).
- Section 12.2: the sessions the harness opens directly on-chain, with the gate's receiver authorizer and in a second
  mint (Task 4).
- Section 12.6: the devnet target's second mint, derived from the seed and kept (Task 4).
