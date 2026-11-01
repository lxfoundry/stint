# Stage 7, part 1: the sponsored close — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or
> executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for
> tracking.

**Goal:** A buyer that holds no SOL and has no node access can close its session through the facilitator. `GET /close`
gives it the fee payer, a blockhash and the session's stored fields; it builds the close from them, signs it as the
session's authority, and `POST /close` verifies it, has Kora sign it as fee payer, and settles it. Scenario 15 passes on
`local` and becomes `required`, and passes on devnet.

**Architecture:** Stage 4's stack, with no change to the program, the gate or the client. The scheme package gains the
wire of `closeUrl`: the body of `GET /close`, a validating reader for it, and a builder that turns it into a signed
close. The facilitator gains one module, `close.ts`, which serves `GET /close` (its blockhash cached for a few seconds)
and verifies and settles a sponsored close by the checks of spec section 5.4 (sponsored row), reusing the close checks,
the simulation and the submission it already has. Its server routes both, without an API key. Scenario 15 finds
`closeUrl` in the gate's offer, as any client does, and uses nothing else to build the close.

**Tech Stack:** TypeScript 7.0.2, vitest 5.0.5, `@solana/kit`, Surfpool 1.6.1, Kora 2.0.5.

**Spec:** `docs/specs/stint-system.md`, sections 4.1 (the stored fields), 5.3 (the `close` layout), 5.4 (the sponsored
row), 5.5 (settlement), 6.1 (`GET /close` and `POST /close`), 9.3 (the fallback this serves) and 12.7 (scenario 15).

## Global Constraints

- Platform: Linux x86-64; on Windows, everything runs inside WSL 2 (T1, T2). Run every command from the repository
  root, inside WSL.
- **Devnet only.** No transaction from this repository's code or scripts reaches another network. Every script and the
  harness check devnet's genesis hash before they send anything.
- Transactions are version 0, without address lookup tables (spec section 3.5). Only classic SPL Token mints; the
  payment token is devnet USDC, `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`, 6 decimals (spec section 3.4).
- `u64` values on the wire are decimal strings; `u32` values are JSON numbers (spec section 5.1). Amounts are `bigint`
  in TypeScript, never `number`.
- **No secrets, ever, in any commit.** Keypair files are named by path in `.env`, and the devnet harness's seed is in
  `.env.devnet` (both git-ignored). Never print a key's contents or the seed.
- A client never signs a transaction supplied by a seller or a facilitator (spec section 9.3): the buyer builds the
  close itself, from data, and signs only what it built.
- The facilitator's endpoints for buyers take no API key (spec section 6.1).
- Scenario statuses follow the ratchet of spec section 12.2: a scenario is made `required` in the commit where it
  first passes on `local`, and never goes back to `pending`.
- Test first: write the failing test, run it, implement, run it again, commit.
- Commit messages are neutral, technical and in the present tense.

## What this part builds, and what it leaves

Built: the `closeUrl` wire in the scheme package; `GET /close`, with and without `?session=`; `POST /close`, the
sponsored close, verified by spec section 5.4's sponsored row and settled as `/settle` settles a close; the facilitator's
integration tests for both; scenario 15 on `local` and on devnet.

Part 2 of this stage, scenarios 7, 24 and 25, builds on the gate's subscription to each session's account and on the
client's top-up code, from stage 5, and is planned once those are in. It reuses `readCloseInfo` and
`buildSponsoredClose` for the client's fallback (spec section 9.3, step 2).

Not built here:
- **The gate does not learn of a sponsored close until its end timer.** It keeps forwarding to the session's
  connections until `paid_until`, then finds the account gone and ends the session with `4402`. Dropping the
  connections at once (`4410`, spec section 7.3, "Account closed by another party") is scenario 7's, in part 2. The
  same holds today for a close the buyer sends on-chain with its own SOL.
- **Rate limits** on `GET /close` and `POST /close`, per session and per client address (spec section 6.1), come with
  the facilitator's limits.
- **Settlement records** (spec section 5.5, Idempotency): a sponsored close sent twice is verified twice, as a close
  through `/settle` is today, and the second fails its simulation once the first has landed.
- **`GET /close?session=` with the address of an account that is not a session** answers `500`: `fetchMaybeSession`
  decodes whatever account it finds without checking the owning program, which is an open item of its own across the
  facilitator and the gate.
- `packages/x402/src/offer.ts` keeps its private copies of the field guards that this part adds to
  `packages/x402/src/guards.ts`; moving it onto them is a change of its own.

## Before you start: what a person must prepare

Start from a clean tree on a branch of its own, with this plan already merged. Tasks 1 to 4 need nothing but the
repository. Task 5 runs the devnet harness, with the person's `.env.devnet` (`STINT_DEVNET_RPC_URL`,
`STINT_DEVNET_SEED`, and `STINT_DEVNET_SCAN_RPC_URL` if the provider refuses `getProgramAccounts`) and the funding key
funded as `pnpm e2e:devnet funds` says. No other run of the devnet harness may use the same seed at the same time: its
start-up closes the open sessions of the seed's keys.

---

### Task 1: The scheme: the `closeUrl` wire

`GET /close` answers what a client needs to build a close without a node (spec section 6.1). This task gives the
scheme package the body's type, a reader that refuses any field without its encoding, a function that turns a stored
session into the body's `session`, and a builder that turns the body into a close signed by the given key.

**Files:**
- Create: `packages/x402/src/close-url.ts`, `packages/x402/test/close-url.test.ts`
- Modify: `packages/x402/src/guards.ts`, `packages/x402/src/index.ts`

**Interfaces:**
- Consumes: `buildCloseTransaction` (`packages/x402/src/transactions.ts`), `Session`, `CloseKind`,
  `STINT_PROGRAM_ADDRESS` (`@lxfoundry/stint-program-client`).
- Produces, all exported from `@lxfoundry/stint-x402`:
  - `interface StoredSessionFields { address, authority, seed, mint, receiver, receiverAuthorizer, refundOwner,
    rentPayer, rate, minSeconds, maxSeconds, startedAt, deposited, claimed }`: addresses and `u64` values as strings,
    `minSeconds` and `maxSeconds` as numbers, `startedAt` as a number of Unix seconds;
  - `interface CloseInfo { feePayer, recentBlockhash, lastValidBlockHeight, blockHeight, programId, session? }`, all
    strings except `session`;
  - `type SponsoredCloseResponse = { success: true; transaction; paid?; refunded? } | { success: false; errorReason;
    errorMessage?; transaction }`, all strings;
  - `storedSessionFields(session: Address, stored: Omit<Session, "discriminator" | "version" | "bump">):
    StoredSessionFields`;
  - `readCloseInfo(value: unknown): CloseInfo | undefined`;
  - `buildSponsoredClose(info: CloseInfo, closer: TransactionSigner, kind?: CloseKind): Promise<string>`: a base64
    wire transaction, signed by `closer`, its fee payer's signature missing.

- [ ] **Step 1: Write the failing tests**

Create `packages/x402/test/close-url.test.ts`:

```ts
import { generateKeyPairSigner, type Address, type KeyPairSigner } from "@solana/kit";
import { CloseKind, STINT_PROGRAM_ADDRESS, type Session } from "@lxfoundry/stint-program-client";
import { beforeAll, describe, expect, it } from "vitest";
import {
  buildSponsoredClose,
  checkCloseTransaction,
  inspectTransaction,
  readCloseInfo,
  storedSessionFields,
  type CloseInfo,
} from "../src/index.js";

const BLOCKHASH = "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N";
const MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU" as Address;

describe("the closeUrl wire (spec §6.1)", () => {
  let authority: KeyPairSigner;
  let session: Address;
  let feePayer: Address;
  let stored: Omit<Session, "discriminator" | "version" | "bump">;
  let info: CloseInfo;

  beforeAll(async () => {
    authority = await generateKeyPairSigner();
    session = (await generateKeyPairSigner()).address;
    feePayer = (await generateKeyPairSigner()).address;
    stored = {
      authority: authority.address,
      seed: 7n,
      mint: MINT,
      receiver: (await generateKeyPairSigner()).address,
      receiverAuthorizer: (await generateKeyPairSigner()).address,
      refundOwner: authority.address,
      rentPayer: (await generateKeyPairSigner()).address,
      rate: 1_000n,
      minSeconds: 5,
      maxSeconds: 120,
      startedAt: 1_800_000_000n,
      deposited: 30_000n,
      claimed: 2_000n,
    };
    info = {
      feePayer,
      recentBlockhash: BLOCKHASH,
      lastValidBlockHeight: "1234",
      blockHeight: "1000",
      programId: STINT_PROGRAM_ADDRESS,
      session: storedSessionFields(session, stored),
    };
  });

  it("encodes a session's stored fields: u64 values as decimal strings, u32 values as numbers, startedAt in Unix seconds", () => {
    expect(storedSessionFields(session, stored)).toEqual({
      address: session,
      authority: authority.address,
      seed: "7",
      mint: MINT,
      receiver: stored.receiver,
      receiverAuthorizer: stored.receiverAuthorizer,
      refundOwner: authority.address,
      rentPayer: stored.rentPayer,
      rate: "1000",
      minSeconds: 5,
      maxSeconds: 120,
      startedAt: 1_800_000_000,
      deposited: "30000",
      claimed: "2000",
    });
  });

  it("reads a body with and without a session, as JSON delivers it", () => {
    expect(readCloseInfo(JSON.parse(JSON.stringify(info)))).toEqual(info);
    const { session: _, ...withoutSession } = info;
    expect(readCloseInfo(withoutSession)).toEqual(withoutSession);
  });

  it("refuses a body with a field that lacks its encoding", () => {
    expect(readCloseInfo("nope")).toBeUndefined();
    expect(readCloseInfo({ ...info, feePayer: "not-an-address" })).toBeUndefined();
    expect(readCloseInfo({ ...info, recentBlockhash: "" })).toBeUndefined();
    expect(readCloseInfo({ ...info, lastValidBlockHeight: 1234 })).toBeUndefined();
    expect(readCloseInfo({ ...info, blockHeight: "18446744073709551616" })).toBeUndefined();
    expect(readCloseInfo({ ...info, session: { ...info.session, rate: 1000 } })).toBeUndefined();
    expect(readCloseInfo({ ...info, session: { ...info.session, minSeconds: -1 } })).toBeUndefined();
    const { rentPayer: _, ...sessionWithoutRentPayer } = info.session!;
    expect(readCloseInfo({ ...info, session: sessionWithoutRentPayer })).toBeUndefined();
  });

  it("builds a close of the session, signed by the closer, paid for by the facilitator's fee payer", async () => {
    const tx = inspectTransaction(await buildSponsoredClose(info, authority));
    expect(tx).toBeDefined();
    expect(tx!.feePayer).toBe(feePayer);
    expect(tx!.blockhash).toBe(BLOCKHASH);
    expect(tx!.signed.has(authority.address)).toBe(true);
    expect(tx!.signed.has(feePayer)).toBe(false);
    const checked = await checkCloseTransaction(tx!, { session, closer: authority.address }, { feePayer, rentPayer: stored.rentPayer });
    expect(checked).toEqual({ ok: true, value: { kind: CloseKind.Standard } });
  });

  it("builds an AtExpiry close when asked", async () => {
    const tx = inspectTransaction(await buildSponsoredClose(info, authority, CloseKind.AtExpiry));
    const checked = await checkCloseTransaction(tx!, { session, closer: authority.address }, { feePayer, rentPayer: stored.rentPayer });
    expect(checked).toEqual({ ok: true, value: { kind: CloseKind.AtExpiry } });
  });

  it("refuses to build for another program, or without a session", async () => {
    await expect(buildSponsoredClose({ ...info, programId: feePayer }, authority)).rejects.toThrow("another program");
    const { session: _, ...withoutSession } = info;
    await expect(buildSponsoredClose(withoutSession, authority)).rejects.toThrow("?session=");
  });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `pnpm --filter @lxfoundry/stint-x402 test close-url.test.ts`
Expected: FAIL: `buildSponsoredClose`, `readCloseInfo` and `storedSessionFields` are not exported.

- [ ] **Step 3: Add the field guards**

Replace the whole of `packages/x402/src/guards.ts` with:

```ts
import { isAddress, isBlockhash } from "@solana/kit";

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const U64_MAX = 0xffff_ffff_ffff_ffffn;

/** A `u64` as a decimal string (spec §5.1), without leading zeros and at most `u64::MAX`. */
export const isU64String = (value: unknown): value is string =>
  typeof value === "string" && /^(0|[1-9][0-9]{0,19})$/.test(value) && BigInt(value) <= U64_MAX;

/** A `u32` as a JSON number (spec §5.1). */
export const isU32 = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 0xffff_ffff;

export const isAddressText = (value: unknown): value is string => typeof value === "string" && isAddress(value);

export const isBlockhashText = (value: unknown): value is string => typeof value === "string" && isBlockhash(value);
```

- [ ] **Step 4: Write the module**

Create `packages/x402/src/close-url.ts`:

```ts
import { address, type Address, type TransactionSigner } from "@solana/kit";
import { CloseKind, STINT_PROGRAM_ADDRESS, type Session } from "@lxfoundry/stint-program-client";
import { isAddressText, isBlockhashText, isRecord, isU32, isU64String } from "./guards.js";
import { buildCloseTransaction } from "./transactions.js";

/**
 * A session's stored fields (spec §4.1) as `GET /close?session=` answers them: `u64` values as decimal strings, `u32`
 * values as numbers, `startedAt` in Unix seconds.
 */
export interface StoredSessionFields {
  readonly address: string;
  readonly authority: string;
  readonly seed: string;
  readonly mint: string;
  readonly receiver: string;
  readonly receiverAuthorizer: string;
  readonly refundOwner: string;
  readonly rentPayer: string;
  readonly rate: string;
  readonly minSeconds: number;
  readonly maxSeconds: number;
  readonly startedAt: number;
  readonly deposited: string;
  readonly claimed: string;
}

/** The body of the facilitator's `GET /close` (spec §6.1): what a client needs to build a close without a node. */
export interface CloseInfo {
  readonly feePayer: string;
  readonly recentBlockhash: string;
  readonly lastValidBlockHeight: string;
  /** Read at `confirmed`: a client without a node learns from it when its own transaction can no longer land (spec §9.3). */
  readonly blockHeight: string;
  readonly programId: string;
  /** With `?session=`. */
  readonly session?: StoredSessionFields;
}

/** The facilitator's answer to `POST /close` (spec §6.1). The amounts are absent when the close's `Closed` event cannot be read. */
export type SponsoredCloseResponse =
  | { readonly success: true; readonly transaction: string; readonly paid?: string; readonly refunded?: string }
  | { readonly success: false; readonly errorReason: string; readonly errorMessage?: string; readonly transaction: string };

export function storedSessionFields(session: Address, stored: Omit<Session, "discriminator" | "version" | "bump">): StoredSessionFields {
  return {
    address: session,
    authority: stored.authority,
    seed: stored.seed.toString(),
    mint: stored.mint,
    receiver: stored.receiver,
    receiverAuthorizer: stored.receiverAuthorizer,
    refundOwner: stored.refundOwner,
    rentPayer: stored.rentPayer,
    rate: stored.rate.toString(),
    minSeconds: stored.minSeconds,
    maxSeconds: stored.maxSeconds,
    startedAt: Number(stored.startedAt),
    deposited: stored.deposited.toString(),
    claimed: stored.claimed.toString(),
  };
}

function isStoredSessionFields(value: unknown): boolean {
  return (
    isRecord(value) &&
    isAddressText(value.address) &&
    isAddressText(value.authority) &&
    isU64String(value.seed) &&
    isAddressText(value.mint) &&
    isAddressText(value.receiver) &&
    isAddressText(value.receiverAuthorizer) &&
    isAddressText(value.refundOwner) &&
    isAddressText(value.rentPayer) &&
    isU64String(value.rate) &&
    isU32(value.minSeconds) &&
    isU32(value.maxSeconds) &&
    Number.isSafeInteger(value.startedAt) &&
    isU64String(value.deposited) &&
    isU64String(value.claimed)
  );
}

/**
 * Returns the value as a `GET /close` body if every field has its encoding. The body comes from a URL in a seller's offer,
 * so it is not trusted to have any shape.
 */
export function readCloseInfo(value: unknown): CloseInfo | undefined {
  if (!isRecord(value)) return undefined;
  const valid =
    isAddressText(value.feePayer) &&
    isBlockhashText(value.recentBlockhash) &&
    isU64String(value.lastValidBlockHeight) &&
    isU64String(value.blockHeight) &&
    isAddressText(value.programId) &&
    (value.session === undefined || isStoredSessionFields(value.session));
  return valid ? (value as unknown as CloseInfo) : undefined;
}

/**
 * A `close` of the session `info` describes, signed by `closer` (the session's authority, for a sponsored close: spec
 * §5.3), with the facilitator's fee payer and blockhash. Everything comes from `GET /close?session=`, so the client
 * needs no node (spec §6.1). The fee payer's signature is Kora's to add.
 */
export async function buildSponsoredClose(info: CloseInfo, closer: TransactionSigner, kind: CloseKind = CloseKind.Standard): Promise<string> {
  if (info.programId !== STINT_PROGRAM_ADDRESS) throw new Error(`GET /close names another program: ${info.programId}`);
  const stored = info.session;
  if (!stored) throw new Error("GET /close was read without ?session=: it carries no session to close");
  return buildCloseTransaction({
    session: address(stored.address),
    stored: {
      mint: address(stored.mint),
      receiver: address(stored.receiver),
      refundOwner: address(stored.refundOwner),
      rentPayer: address(stored.rentPayer),
    },
    closer,
    feePayer: address(info.feePayer),
    lifetime: { blockhash: info.recentBlockhash, lastValidBlockHeight: BigInt(info.lastValidBlockHeight) },
    kind,
  });
}
```

In `packages/x402/src/index.ts`, add after `export * from "./redact.js";`:

```ts
export * from "./close-url.js";
```

- [ ] **Step 5: Run the tests to see them pass**

Run: `pnpm --filter @lxfoundry/stint-x402 test && pnpm --filter @lxfoundry/stint-x402 typecheck`
Expected: PASS, the six new tests and every earlier one.

- [ ] **Step 6: Commit**

```bash
git add packages/x402/src/guards.ts packages/x402/src/close-url.ts packages/x402/src/index.ts packages/x402/test/close-url.test.ts
git commit -m "Add the closeUrl wire to the scheme: GET /close's body, its reader and a close built from it"
```

---

### Task 2: The facilitator: `GET /close`'s body and the sponsored close

The facilitator gains `close.ts`. `createCloseInfoSource` answers `GET /close`: the fee payer, the program, and a
blockhash with its last valid block height and the current block height, all read at `confirmed` and served for
`ttlMs` (spec section 6.1: unauthenticated requests do not each reach the node); with a session, its stored fields,
read on each request. `verifySponsoredClose` applies spec section 5.4's sponsored row, and `settleSponsoredClose` has
Kora sign and submits through the facilitator's existing `submitSettlement`.

The checks, in order, each with its refusal:

| Check | Refusal |
|---|---|
| The body carries a transaction that decodes as version 0 | `invalid_payload` |
| It holds exactly one well-formed `stint.close`, which names the session | `unexpected_instruction` |
| The session exists, at `confirmed` | `unknown_session` |
| Its `rent_payer` is this facilitator's rent payer | `invalid_terms` |
| `checkCloseTransaction` with the session's `authority` as the closer: payer positions, layout (`stint.close` alone), the session, the closer, the signer set | as it answers (`payer_misuse`, `unexpected_instruction`, `invalid_terms`, `invalid_payload`) |
| `kind` is `Standard` or `AtExpiry` | `invalid_terms` |
| The blockhash is still valid | `blockhash_expired` |
| The simulation succeeds, and the rent payer funds nothing | `simulation_failed`, `payer_misuse` |

`simulate` in `verify.ts` becomes exported, unchanged, so that the sponsored close runs the same simulation as
`/verify`.

**Files:**
- Create: `apps/facilitator/src/close.ts`, `apps/facilitator/test/close.test.ts`
- Modify: `apps/facilitator/src/verify.ts` (one word: `export` on `simulate`)

**Interfaces:**
- Consumes: Task 1's `storedSessionFields`, `CloseInfo`, `SponsoredCloseResponse`; `checkCloseTransaction`,
  `inspectTransaction`, `fetchClosedEvent`, `readUntilFound`, `refuse`, `Check` (`@lxfoundry/stint-x402`);
  `FacilitatorContext`, `simulate` (`apps/facilitator/src/verify.ts`); `submitSettlement`, `DEFAULT_READ_RETRY`
  (`apps/facilitator/src/settle.ts`).
- Produces:
  - `DEFAULT_CLOSE_INFO_TTL_MS = 2_000`;
  - `createCloseInfoSource(ctx: Pick<FacilitatorContext, "rpc" | "keys">, options?: { ttlMs?: number; clock?: () =>
    number }): { read(session?: Address): Promise<CloseInfo | undefined> }`: undefined when a session was asked for and
    none exists at its address;
  - `verifySponsoredClose(ctx: FacilitatorContext, transaction: unknown): Promise<Check<{ tx: InspectedTransaction;
    session: Address; payer: Address }>>`;
  - `settleSponsoredClose(ctx: FacilitatorContext, transaction: unknown): Promise<SponsoredCloseResponse>`.

- [ ] **Step 1: Write the failing tests**

Create `apps/facilitator/test/close.test.ts`:

```ts
import {
  generateKeyPairSigner,
  getBase58Decoder,
  getBase64Decoder,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getTransactionDecoder,
  partiallySignTransaction,
  type Address,
  type KeyPairSigner,
  type Rpc,
  type SolanaRpcApi,
} from "@solana/kit";
import { CloseKind, EVENT_IX_TAG, STINT_PROGRAM_ADDRESS, getClosedEventEncoder, getSessionEncoder } from "@lxfoundry/stint-program-client";
import { buildCloseTransaction } from "@lxfoundry/stint-x402";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createCloseInfoSource, settleSponsoredClose, verifySponsoredClose } from "../src/close.js";
import type { KoraClient } from "../src/kora.js";
import type { FacilitatorContext } from "../src/verify.js";

const NETWORK = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const BLOCKHASH = "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N";
const MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU" as Address;

/** What the fake node answers; the defaults are the happy path. */
interface Node {
  accounts: Map<string, Uint8Array>;
  blockhashValid: boolean;
  simulation: { err: unknown; logs?: string[] };
  closedEvent: boolean;
  failLifetime: boolean;
  calls: { simulate: number; send: number; lifetime: number };
}

/** Only the methods the sponsored close calls, each answering from `node`. */
function fakeRpc(node: Node, closed: () => unknown): Rpc<SolanaRpcApi> {
  const call = (answer: () => unknown) => ({ send: async () => answer() });
  const rpc = {
    getAccountInfo: (target: string) =>
      call(() => {
        const data = node.accounts.get(target);
        if (!data) return { value: null };
        return {
          value: {
            data: [getBase64Decoder().decode(data), "base64"],
            executable: false,
            lamports: 1_000_000n,
            owner: STINT_PROGRAM_ADDRESS,
            space: BigInt(data.length),
          },
        };
      }),
    isBlockhashValid: () => call(() => ({ value: node.blockhashValid })),
    simulateTransaction: () =>
      call(() => {
        node.calls.simulate++;
        return { value: { logs: [], innerInstructions: [], ...node.simulation } };
      }),
    getLatestBlockhash: () =>
      call(() => {
        node.calls.lifetime++;
        if (node.failLifetime) throw new Error("node down");
        return { value: { blockhash: BLOCKHASH, lastValidBlockHeight: 1_234n } };
      }),
    getBlockHeight: () => call(() => 1_000n),
    sendTransaction: () =>
      call(() => {
        node.calls.send++;
        return "sent";
      }),
    getSignatureStatuses: () => call(() => ({ value: [{ confirmationStatus: "confirmed", err: null }] })),
    getTransaction: () => call(() => (node.closedEvent ? closed() : null)),
  };
  return rpc as unknown as Rpc<SolanaRpcApi>;
}

/** A confirmed close as `getTransaction` returns it with `json` encoding: one inner `Closed` event. */
function closeTransaction(session: Address, closedBy: Address) {
  const event = getClosedEventEncoder().encode({
    session,
    kind: CloseKind.Standard,
    claimed: 1_000n,
    owed: 7_000n,
    refunded: 22_000n,
    redirected: 500n,
    closedBy,
    paidUntil: 1_800_000_030n,
    at: 1_800_000_008n,
  });
  const data = getBase58Decoder().decode(Uint8Array.from([...EVENT_IX_TAG, ...event]));
  return {
    transaction: { message: { accountKeys: [STINT_PROGRAM_ADDRESS], instructions: [] } },
    meta: { err: null, innerInstructions: [{ index: 0, instructions: [{ programIdIndex: 0, accounts: [], data }] }] },
  };
}

/** Kora, as far as the sponsored close uses it: it adds the fee payer's signature, or refuses. */
function fakeKora(feePayer: KeyPairSigner, refuses = false): KoraClient {
  return {
    getPayerSigner: async () => ({ signer_address: feePayer.address, payment_address: feePayer.address }),
    signTransaction: async (wire) => {
      if (refuses) throw new Error("policy refused");
      const transaction = getTransactionDecoder().decode(getBase64Encoder().encode(wire));
      return getBase64EncodedWireTransaction(await partiallySignTransaction([feePayer.keyPair], transaction));
    },
  };
}

describe("the sponsored close (spec §6.1)", () => {
  let buyer: KeyPairSigner;
  let authorizer: KeyPairSigner;
  let feePayer: KeyPairSigner;
  let rentPayer: KeyPairSigner;
  let seller: Address;
  let session: Address;
  let node: Node;

  const sessionData = (rentPayerOf: Address) =>
    Uint8Array.from(
      getSessionEncoder().encode({
        version: 1,
        bump: 255,
        authority: buyer.address,
        seed: 1n,
        mint: MINT,
        receiver: seller,
        receiverAuthorizer: authorizer.address,
        refundOwner: buyer.address,
        rentPayer: rentPayerOf,
        rate: 1_000n,
        minSeconds: 5,
        maxSeconds: 120,
        startedAt: 1_800_000_000n,
        deposited: 30_000n,
        claimed: 0n,
      }),
    );

  const closeBy = (closer: KeyPairSigner, kind: CloseKind = CloseKind.Standard) =>
    buildCloseTransaction({
      session,
      stored: { mint: MINT, receiver: seller, refundOwner: buyer.address, rentPayer: rentPayer.address },
      closer,
      feePayer: feePayer.address,
      lifetime: { blockhash: BLOCKHASH, lastValidBlockHeight: 100n },
      kind,
    });

  const context = (kora: KoraClient = fakeKora(feePayer)): FacilitatorContext => ({
    rpc: fakeRpc(node, () => closeTransaction(session, buyer.address)),
    network: NETWORK,
    keys: { feePayer: feePayer.address, rentPayer: rentPayer.address },
    rentPayer,
    kora,
    confirmTimeoutMs: 1_000,
    readRetry: { attempts: 2, delayMs: 5 },
  });

  beforeAll(async () => {
    buyer = await generateKeyPairSigner();
    authorizer = await generateKeyPairSigner();
    feePayer = await generateKeyPairSigner();
    rentPayer = await generateKeyPairSigner();
    seller = (await generateKeyPairSigner()).address;
    session = (await generateKeyPairSigner()).address;
  });

  // The session exists and names this facilitator's rent payer, the blockhash is valid, the simulation succeeds and the
  // close's event can be read, until a test says otherwise.
  beforeEach(() => {
    node = {
      accounts: new Map<string, Uint8Array>([[session, sessionData(rentPayer.address)]]),
      blockhashValid: true,
      simulation: { err: null },
      closedEvent: true,
      failLifetime: false,
      calls: { simulate: 0, send: 0, lifetime: 0 },
    };
  });

  describe("createCloseInfoSource", () => {
    it("serves the fee payer, a blockhash, the block height and the program", async () => {
      expect(await createCloseInfoSource(context()).read()).toEqual({
        feePayer: feePayer.address,
        recentBlockhash: BLOCKHASH,
        lastValidBlockHeight: "1234",
        blockHeight: "1000",
        programId: STINT_PROGRAM_ADDRESS,
      });
    });

    it("adds the session's stored fields when asked for a session, and answers nothing for an address with no session", async () => {
      const source = createCloseInfoSource(context());
      expect((await source.read(session))?.session).toEqual({
        address: session,
        authority: buyer.address,
        seed: "1",
        mint: MINT,
        receiver: seller,
        receiverAuthorizer: authorizer.address,
        refundOwner: buyer.address,
        rentPayer: rentPayer.address,
        rate: "1000",
        minSeconds: 5,
        maxSeconds: 120,
        startedAt: 1_800_000_000,
        deposited: "30000",
        claimed: "0",
      });
      expect(await source.read((await generateKeyPairSigner()).address)).toBeUndefined();
    });

    it("serves one blockhash for ttlMs, then asks the node again", async () => {
      let now = 0;
      const source = createCloseInfoSource(context(), { ttlMs: 2_000, clock: () => now });
      await source.read();
      now = 1_999;
      await source.read(session);
      expect(node.calls.lifetime).toBe(1);
      now = 2_000;
      await source.read();
      expect(node.calls.lifetime).toBe(2);
    });

    it("does not serve a read that failed: the next request asks the node", async () => {
      const source = createCloseInfoSource(context(), { clock: () => 0 });
      node.failLifetime = true;
      await expect(source.read()).rejects.toThrow("node down");
      node.failLifetime = false;
      expect(await source.read()).toMatchObject({ recentBlockhash: BLOCKHASH });
      expect(node.calls.lifetime).toBe(2);
    });
  });

  describe("verifySponsoredClose (spec §5.4, sponsored row)", () => {
    it("accepts a Standard close signed by the session's authority, and simulates it once", async () => {
      expect(await verifySponsoredClose(context(), await closeBy(buyer))).toMatchObject({
        ok: true,
        value: { session, payer: buyer.address },
      });
      expect(node.calls.simulate).toBe(1);
    });

    it("accepts an AtExpiry close signed by the session's authority", async () => {
      expect(await verifySponsoredClose(context(), await closeBy(buyer, CloseKind.AtExpiry))).toMatchObject({ ok: true });
    });

    it("refuses a body without a transaction, and a transaction that does not decode", async () => {
      expect(await verifySponsoredClose(context(), undefined)).toMatchObject({ ok: false, reason: "invalid_payload" });
      expect(await verifySponsoredClose(context(), "nope")).toMatchObject({ ok: false, reason: "invalid_payload" });
    });

    it("refuses a session that does not exist", async () => {
      node.accounts.clear();
      expect(await verifySponsoredClose(context(), await closeBy(buyer))).toMatchObject({ ok: false, reason: "unknown_session" });
    });

    it("refuses a session whose rent payer is not this facilitator's, before simulating", async () => {
      node.accounts.set(session, sessionData((await generateKeyPairSigner()).address));
      expect(await verifySponsoredClose(context(), await closeBy(buyer))).toEqual({
        ok: false,
        reason: "invalid_terms",
        message: "the session's rent payer is not this facilitator's",
      });
      expect(node.calls.simulate).toBe(0);
    });

    it("refuses a close signed by anyone but the session's authority, the receiver authorizer included", async () => {
      expect(await verifySponsoredClose(context(), await closeBy(authorizer))).toMatchObject({
        ok: false,
        reason: "invalid_payload",
        message: "the closer is not the expected one",
      });
      expect(node.calls.simulate).toBe(0);
    });

    it("refuses a WaiveMinimum close, before simulating", async () => {
      expect(await verifySponsoredClose(context(), await closeBy(buyer, CloseKind.WaiveMinimum))).toEqual({
        ok: false,
        reason: "invalid_terms",
        message: "a sponsored close is Standard or AtExpiry",
      });
      expect(node.calls.simulate).toBe(0);
    });

    it("refuses a transaction whose blockhash is no longer valid", async () => {
      node.blockhashValid = false;
      expect(await verifySponsoredClose(context(), await closeBy(buyer))).toMatchObject({ ok: false, reason: "blockhash_expired" });
    });

    it("refuses a close whose simulation fails", async () => {
      node.simulation = { err: { InstructionError: [0, { Custom: 6000 }] }, logs: ["Program failed"] };
      expect(await verifySponsoredClose(context(), await closeBy(buyer))).toMatchObject({ ok: false, reason: "simulation_failed" });
    });
  });

  describe("settleSponsoredClose", () => {
    it("answers a refusal with success false and no transaction, and sends nothing", async () => {
      node.accounts.clear();
      expect(await settleSponsoredClose(context(), await closeBy(buyer))).toEqual({
        success: false,
        errorReason: "unknown_session",
        errorMessage: "no such session",
        transaction: "",
      });
      expect(node.calls.send).toBe(0);
    });

    it("answers simulation_failed when Kora refuses to sign, and sends nothing", async () => {
      expect(await settleSponsoredClose(context(fakeKora(feePayer, true)), await closeBy(buyer))).toEqual({
        success: false,
        errorReason: "simulation_failed",
        errorMessage: "Kora: policy refused",
        transaction: "",
      });
      expect(node.calls.send).toBe(0);
    });

    it("submits the close with Kora's signature, and reports paid = claimed + owed + redirected, and refunded", async () => {
      expect(await settleSponsoredClose(context(), await closeBy(buyer))).toEqual({
        success: true,
        transaction: expect.any(String),
        paid: "8500",
        refunded: "22000",
      });
      expect(node.calls.send).toBe(1);
    });

    it("reports a confirmed close without amounts when its Closed event cannot be read", async () => {
      node.closedEvent = false;
      expect(await settleSponsoredClose(context(), await closeBy(buyer))).toEqual({ success: true, transaction: expect.any(String) });
    });
  });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `pnpm --filter @lxfoundry/stint-facilitator test close.test.ts`
Expected: FAIL: `../src/close.js` does not exist.

- [ ] **Step 3: Export `simulate`**

In `apps/facilitator/src/verify.ts`, replace:

```ts
async function simulate(ctx: FacilitatorContext, tx: InspectedTransaction, funding: Funding): Promise<Check<null>> {
```

with:

```ts
export async function simulate(ctx: FacilitatorContext, tx: InspectedTransaction, funding: Funding): Promise<Check<null>> {
```

- [ ] **Step 4: Write the module**

Create `apps/facilitator/src/close.ts`:

```ts
import {
  blockhash,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getSignatureFromTransaction,
  getTransactionDecoder,
  isInstructionWithAccounts,
  isInstructionWithData,
  type Address,
} from "@solana/kit";
import {
  CloseKind,
  STINT_PROGRAM_ADDRESS,
  StintInstruction,
  fetchMaybeSession,
  identifyStintInstruction,
  parseCloseInstruction,
} from "@lxfoundry/stint-program-client";
import {
  checkCloseTransaction,
  fetchClosedEvent,
  inspectTransaction,
  readUntilFound,
  refuse,
  storedSessionFields,
  type Check,
  type CloseInfo,
  type InspectedTransaction,
  type SponsoredCloseResponse,
} from "@lxfoundry/stint-x402";
import { DEFAULT_READ_RETRY, submitSettlement } from "./settle.js";
import { simulate, type FacilitatorContext } from "./verify.js";

/** How long `GET /close` serves the same blockhash and block height (spec §6.1: cached for a few seconds). */
export const DEFAULT_CLOSE_INFO_TTL_MS = 2_000;

type Lifetime = Pick<CloseInfo, "recentBlockhash" | "lastValidBlockHeight" | "blockHeight">;

export interface CloseInfoSource {
  /** `GET /close`'s body. With a session, its stored fields too, or undefined if no session exists at that address. */
  read(session?: Address): Promise<CloseInfo | undefined>;
}

/**
 * Answers `GET /close` (spec §6.1). The blockhash and the block height are read at `confirmed` and served for `ttlMs`, so
 * that unauthenticated requests do not each reach the node; a session's stored fields are read on each request.
 */
export function createCloseInfoSource(
  ctx: Pick<FacilitatorContext, "rpc" | "keys">,
  options: { readonly ttlMs?: number; readonly clock?: () => number } = {},
): CloseInfoSource {
  const ttlMs = options.ttlMs ?? DEFAULT_CLOSE_INFO_TTL_MS;
  const clock = options.clock ?? Date.now;
  let cached: { readonly at: number; readonly lifetime: Promise<Lifetime> } | undefined;

  const fetchLifetime = async (): Promise<Lifetime> => {
    const [{ value }, height] = await Promise.all([
      ctx.rpc.getLatestBlockhash({ commitment: "confirmed" }).send(),
      ctx.rpc.getBlockHeight({ commitment: "confirmed" }).send(),
    ]);
    return { recentBlockhash: value.blockhash, lastValidBlockHeight: value.lastValidBlockHeight.toString(), blockHeight: height.toString() };
  };

  const lifetime = (): Promise<Lifetime> => {
    const now = clock();
    if (!cached || now - cached.at >= ttlMs) {
      const entry = { at: now, lifetime: fetchLifetime() };
      // A read that failed is not served again: the next request asks the node.
      entry.lifetime.catch(() => {
        if (cached === entry) cached = undefined;
      });
      cached = entry;
    }
    return cached.lifetime;
  };

  return {
    async read(session) {
      const [current, stored] = await Promise.all([
        lifetime(),
        session ? fetchMaybeSession(ctx.rpc, session, { commitment: "confirmed" }) : undefined,
      ]);
      const info: CloseInfo = { feePayer: ctx.keys.feePayer, ...current, programId: STINT_PROGRAM_ADDRESS };
      if (!session || !stored) return info;
      return stored.exists ? { ...info, session: storedSessionFields(session, stored.data) } : undefined;
    },
  };
}

/** A sponsored close that passed every check of spec §5.4's sponsored row. */
export interface VerifiedSponsoredClose {
  readonly tx: InspectedTransaction;
  readonly session: Address;
  /** The session's authority, which signed the close. */
  readonly payer: Address;
}

/** The session the transaction's `stint.close` names; undefined unless it holds exactly one well-formed `stint.close`. */
function closedSession(tx: InspectedTransaction): Address | undefined {
  const named = tx.instructions.flatMap((ix) => {
    if (ix.programAddress !== STINT_PROGRAM_ADDRESS || !isInstructionWithData(ix) || !isInstructionWithAccounts(ix)) return [];
    try {
      return identifyStintInstruction(ix) === StintInstruction.Close ? [parseCloseInstruction(ix).accounts.session.address] : [];
    } catch {
      return []; // data no instruction of the program has, or too few accounts
    }
  });
  return named.length === 1 ? named[0] : undefined;
}

/** Spec §5.4, the sponsored row. Read-only: it simulates and never submits. */
export async function verifySponsoredClose(ctx: FacilitatorContext, transaction: unknown): Promise<Check<VerifiedSponsoredClose>> {
  if (typeof transaction !== "string" || transaction.length === 0) return refuse("invalid_payload", "the body carries no transaction");
  const tx = inspectTransaction(transaction);
  if (!tx) return refuse("invalid_payload", "the transaction cannot be decoded as version 0");
  const session = closedSession(tx);
  if (!session) return refuse("unexpected_instruction", "a close is stint.close alone");

  const stored = await fetchMaybeSession(ctx.rpc, session, { commitment: "confirmed" });
  if (!stored.exists) return refuse("unknown_session", "no such session");
  if (stored.data.rentPayer !== ctx.keys.rentPayer) return refuse("invalid_terms", "the session's rent payer is not this facilitator's");
  const check = await checkCloseTransaction(tx, { session, closer: stored.data.authority }, ctx.keys);
  if (!check.ok) return check;
  if (check.value.kind !== CloseKind.Standard && check.value.kind !== CloseKind.AtExpiry) {
    return refuse("invalid_terms", "a sponsored close is Standard or AtExpiry");
  }

  const { value: valid } = await ctx.rpc.isBlockhashValid(blockhash(tx.blockhash), { commitment: "confirmed" }).send();
  if (!valid) return refuse("blockhash_expired", "the transaction's blockhash is no longer valid");
  // A close funds nothing: the rent payer only receives the session's rent back.
  const simulated = await simulate(ctx, tx, { destinations: [], budget: 0n });
  if (!simulated.ok) return simulated;
  return { ok: true, value: { tx, session, payer: stored.data.authority } };
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * `POST /close` (spec §6.1): verify, Kora signs as fee payer, then submit and wait for `confirmed` as `/settle` does
 * (spec §5.5, without settlement records). `paid` counts the claims made before the close, as the gate's answer does.
 */
export async function settleSponsoredClose(ctx: FacilitatorContext, transaction: unknown): Promise<SponsoredCloseResponse> {
  const verified = await verifySponsoredClose(ctx, transaction);
  if (!verified.ok) return { success: false, errorReason: verified.reason, errorMessage: verified.message, transaction: "" };
  const { tx, payer } = verified.value;

  let wire;
  try {
    wire = await ctx.kora.signTransaction(getBase64EncodedWireTransaction(tx.transaction));
  } catch (error) {
    return { success: false, errorReason: "simulation_failed", errorMessage: `Kora: ${message(error)}`, transaction: "" };
  }
  const signature = getSignatureFromTransaction(getTransactionDecoder().decode(getBase64Encoder().encode(wire)));
  const settled = await submitSettlement(ctx, { type: "close", wire, signature, blockhash: tx.blockhash, payer, amount: "0" });
  if (!settled.success) {
    return { success: false, errorReason: settled.errorReason ?? "simulation_failed", errorMessage: settled.errorMessage, transaction: settled.transaction };
  }

  // `submitSettlement` reports `owed + redirected` only; the buyer's answer needs the claims and the refund as well.
  const event = await readUntilFound(
    () => fetchClosedEvent(ctx.rpc, signature).catch(() => undefined),
    ctx.readRetry ?? DEFAULT_READ_RETRY,
  );
  if (!event) return { success: true, transaction: signature };
  return {
    success: true,
    transaction: signature,
    paid: (event.claimed + event.owed + event.redirected).toString(),
    refunded: event.refunded.toString(),
  };
}
```

- [ ] **Step 5: Run the tests to see them pass**

Run: `pnpm --filter @lxfoundry/stint-facilitator test && pnpm --filter @lxfoundry/stint-facilitator typecheck`
Expected: PASS, the seventeen new tests and every earlier one.

- [ ] **Step 6: Commit**

```bash
git add apps/facilitator/src/close.ts apps/facilitator/src/verify.ts apps/facilitator/test/close.test.ts
git commit -m "Verify and settle a sponsored close, and answer GET /close with a cached blockhash"
```

---

### Task 3: The facilitator's `/close` routes, the spec, and the integration tests

The server routes `GET /close` and `POST /close`, without an API key, and its configuration gains `closeInfoTtlMs`. The
spec's section 6.1 states the bodies and the answers this part settles, and section 5.4's sponsored row the refusal
each check gives. The integration tests run both on the local network through Kora.

**Files:**
- Modify: `apps/facilitator/src/server.ts`, `apps/facilitator/test/server.test.ts`, `e2e/test/facilitator.test.ts`,
  `docs/specs/stint-system.md` (sections 5.4 and 6.1)

**Interfaces:**
- Consumes: Task 1's `readCloseInfo`, `buildSponsoredClose`, `SponsoredCloseResponse`; Task 2's
  `createCloseInfoSource`, `settleSponsoredClose`.
- Produces: `FacilitatorConfig.closeInfoTtlMs?: number`; `GET {closeUrl}` and `GET {closeUrl}?session=<address>`,
  answering `200 CloseInfo` or `404 {error: "unknown_session"}`; `POST {closeUrl}` with `{transaction}`, answering
  `200 SponsoredCloseResponse`, or `400 {error: "invalid_json"}`.

- [ ] **Step 1: Write the failing tests**

In `apps/facilitator/test/server.test.ts`, add before `it("answers 404 elsewhere", …)`:

```ts
  it("serves /close without an API key: 404 for a session that is not an address, a refusal for a body without a transaction", async () => {
    const lookup = await fetch(`${facilitator.closeUrl}?session=not-an-address`);
    expect(lookup.status).toBe(404);
    expect(await lookup.json()).toEqual({ error: "unknown_session" });

    const empty = await post("/close", {});
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({
      success: false,
      errorReason: "invalid_payload",
      errorMessage: "the body carries no transaction",
      transaction: "",
    });

    const garbled = await post("/close", "{");
    expect(garbled.status).toBe(400);
    expect(await garbled.json()).toEqual({ error: "invalid_json" });
  });
```

In `e2e/test/facilitator.test.ts`, add `buildSponsoredClose`, `readCloseInfo`, `type CloseInfo` and
`type SponsoredCloseResponse` to the import from `@lxfoundry/stint-x402`, in the order its names already follow (values
first, then types, each alphabetical), and add as the file's first import:

```ts
import { blockhash, generateKeyPairSigner } from "@solana/kit";
```

Then add, after `async function openPayment(…) { … }`:

```ts
  /** `GET closeUrl?session=`, read as any client reads it. */
  async function closeInfoFor(session: string): Promise<CloseInfo> {
    const response = await fetch(`${stack.facilitator.closeUrl}?session=${session}`);
    expect(response.status).toBe(200);
    const info = readCloseInfo(await response.json());
    expect(info?.session).toBeDefined();
    return info!;
  }

  /** `POST closeUrl`, with no API key. */
  async function postClose(transaction: string): Promise<SponsoredCloseResponse> {
    const response = await fetch(stack.facilitator.closeUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ transaction }),
    });
    expect(response.status).toBe(200);
    return (await response.json()) as SponsoredCloseResponse;
  }
```

and, at the end of the `describe`:

```ts
  it("answers GET /close with its fee payer, a current blockhash and the block height, and 404 for an address with no session", async () => {
    const info = readCloseInfo(await (await fetch(stack.facilitator.closeUrl)).json());
    expect(info).toMatchObject({ feePayer: stack.facilitator.feePayer, programId: base.facilitator.programId });
    const { value: valid } = await stack.network.rpc.isBlockhashValid(blockhash(info!.recentBlockhash), { commitment: "confirmed" }).send();
    expect(valid).toBe(true);
    expect(BigInt(info!.blockHeight)).toBeLessThanOrEqual(BigInt(info!.lastValidBlockHeight));
    // An address that holds no account: one that holds another program's account is a case of its own ("What this part builds").
    const missing = await fetch(`${stack.facilitator.closeUrl}?session=${(await generateKeyPairSigner()).address}`);
    expect(missing.status).toBe(404);
  });

  it("settles a sponsored close built only from GET /close and signed by the authority, with no API key", async () => {
    const buyer = await newBuyer(stack.network.rpc, stack.keys.mintAuthority.signer, 1_000_000n);
    const { offer, payload, session } = await openPayment(buyer);
    expect(await call("/settle", payload, offer)).toMatchObject({ success: true });

    const info = await closeInfoFor(session);
    expect(info.session).toMatchObject({
      address: session,
      authority: buyer.signer.address,
      rentPayer: stack.facilitator.rentPayer,
      deposited: "30000",
    });
    const closed = await postClose(await buildSponsoredClose(info, buyer.signer));
    expect(closed.success).toBe(true);

    const event = (await fetchClosedEvent(stack.network.rpc, closed.transaction))!;
    expect(event.closedBy).toBe(buyer.signer.address);
    expect(closed).toEqual({
      success: true,
      transaction: closed.transaction,
      paid: (event.claimed + event.owed + event.redirected).toString(),
      refunded: event.refunded.toString(),
    });
    const changes = await tokenBalanceChanges(stack.network.rpc, closed.transaction);
    expect(changes.get(buyer.usdcAccount)).toBe(event.refunded);
    expect((await fetchMaybeSession(stack.network.rpc, session)).exists).toBe(false);
  });

  it("refuses a sponsored close of a session whose rent payer is not the facilitator's, and leaves the session open", async () => {
    const direct = stack.context().direct!;
    const buyer = await newBuyer(stack.network.rpc, stack.keys.mintAuthority.signer, 1_000_000n);
    const opened = await direct.open({ buyer, seconds: 10 });
    try {
      const info = await closeInfoFor(opened.session);
      expect(info.session?.rentPayer).toBe(opened.rentPayer);
      expect(await postClose(await buildSponsoredClose(info, buyer.signer))).toMatchObject({
        success: false,
        errorReason: "invalid_terms",
        transaction: "",
      });
      expect((await fetchMaybeSession(stack.network.rpc, opened.session)).exists).toBe(true);
    } finally {
      await direct.close(opened, buyer.signer);
    }
  });
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `pnpm --filter @lxfoundry/stint-facilitator test server.test.ts && pnpm --filter @lxfoundry/stint-e2e test facilitator.test.ts`
Expected: FAIL: `/close` answers `404 {error: "not_found"}`.

- [ ] **Step 3: Route `/close`**

In `apps/facilitator/src/server.ts`:

1. Replace `import { address, createKeyPairSignerFromBytes, createSolanaRpc, type Address } from "@solana/kit";` with:

```ts
import { address, createKeyPairSignerFromBytes, createSolanaRpc, isAddress, type Address } from "@solana/kit";
```

2. Replace `import { createKoraClient } from "./kora.js";` with:

```ts
import { createCloseInfoSource, settleSponsoredClose } from "./close.js";
import { createKoraClient } from "./kora.js";
```

3. In `FacilitatorConfig`, after `readonly readRetry?: RetryOptions;`, add:

```ts
  /** How long `GET /close` serves the same blockhash and block height (default 2,000 ms; spec §6.1). */
  readonly closeInfoTtlMs?: number;
```

4. Replace:

```ts
  // The sweeper builds and signs its own closes with `ctx`: they do not pass `verifyPayment`, which refuses the rent payer as a closer.
```

with:

```ts
  const closeInfo = createCloseInfoSource(ctx, { ttlMs: config.closeInfoTtlMs });
  // The sweeper builds and signs its own closes with `ctx`: they do not pass `verifyPayment`, which refuses the rent payer as a closer.
```

5. Replace `    const path = new URL(request.url ?? "/", "http://facilitator").pathname;` with:

```ts
    const requested = new URL(request.url ?? "/", "http://facilitator");
    const path = requested.pathname;
```

6. Replace:

```ts
    sendJson(response, 404, { error: "not_found" });
  }
```

with:

```ts
    // The buyers' endpoint (spec §6.1): no API key.
    if (request.method === "GET" && path === "/close") {
      const session = requested.searchParams.get("session");
      if (session !== null && !isAddress(session)) return sendJson(response, 404, { error: "unknown_session" });
      const info = await closeInfo.read(session ?? undefined);
      return info ? sendJson(response, 200, info) : sendJson(response, 404, { error: "unknown_session" });
    }
    if (request.method === "POST" && path === "/close") {
      const { transaction } = ((await readJson(request)) ?? {}) as Record<string, unknown>;
      const settled = await settleSponsoredClose(ctx, transaction);
      log({ event: "sponsored_close", success: settled.success, ...(settled.success ? {} : { reason: settled.errorReason }), transaction: settled.transaction });
      return sendJson(response, 200, settled);
    }
    sendJson(response, 404, { error: "not_found" });
  }
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `pnpm --filter @lxfoundry/stint-facilitator test && pnpm --filter @lxfoundry/stint-e2e test facilitator.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: State the bodies and refusals in the spec**

In `docs/specs/stint-system.md`, section 5.4, replace the row that starts `` | `close` (sponsored, through `closeUrl`) | ``
with:

```markdown
| `close` (sponsored, through `closeUrl`) | The session exists (else `unknown_session`) and its `rent_payer` is one of this facilitator's keys (else `invalid_terms`). The `closer` is its `authority` (else `invalid_payload`), and `kind` is `Standard` or `AtExpiry` (else `invalid_terms`). The payload, `accepted` and requirements checks do not apply: the request carries only the transaction. The fee-payer, facilitator-key, program, layout, simulation and blockhash checks do, and the rent payer funds nothing |
```

In section 6.1, replace the row that starts `` | `GET /close` (the `closeUrl`) | `` with:

```markdown
| `GET /close` (the `closeUrl`) | What a client needs to build a close without access to a Solana node: `{feePayer, recentBlockhash, lastValidBlockHeight, blockHeight, programId}`, current at the time of the request, with `lastValidBlockHeight` and `blockHeight` as decimal strings. `blockHeight` is read at `confirmed`, and also tells a client without node access when one of its own transactions can no longer land (section 9.3). With `?session=<address>`, also `session`: the session's `address` and its stored fields (section 4.1), with `u64` values as decimal strings, `u32` values as numbers and `startedAt` in Unix seconds; or `404 {error: "unknown_session"}` if no session exists at that address (it was never opened, or has closed) |
```

and the row that starts `` | `POST /close` (the `closeUrl`) | `` with:

```markdown
| `POST /close` (the `closeUrl`) | The **sponsored close**. Body: `{transaction}`, a `close` transaction signed by the session's authority. Accepted only for sessions whose `rent_payer` is one of this facilitator's keys. Verified as in section 5.4 (sponsored row) and settled as in section 5.5. Returns `200 {success: true, transaction, paid, refunded}`, with `paid` = `claimed + owed + redirected` from the `Closed` event, as for the gate, or `200 {success: true, transaction}` when the close is confirmed but its `Closed` event cannot be read. A refusal or a failure is `200 {success: false, errorReason, errorMessage, transaction}`, with a reason of section 5.4 or 5.5; `transaction` is empty unless the transaction was sent (`settlement_pending` carries its signature). A body that is not JSON is `400 {error: "invalid_json"}` |
```

Run: `grep -c "sponsored close" docs/specs/stint-system.md && git diff --stat docs/specs/stint-system.md`
Expected: the three rows changed, nothing else.

- [ ] **Step 6: Commit**

```bash
git add apps/facilitator/src/server.ts apps/facilitator/test/server.test.ts e2e/test/facilitator.test.ts docs/specs/stint-system.md
git commit -m "Serve GET /close and POST /close, the sponsored close, without an API key"
```

---

### Task 4: Scenario 15

Scenario 15 (spec section 12.7): a sponsored close through `closeUrl`, built only from what `GET /close` returns, is
closed and refunded; a session whose rent payer is not one of this facilitator's keys (opened directly on-chain with a
harness rent payer) is refused.

The scenario finds `closeUrl` in the gate's offer, as a client does, opens a session through the gate with the session
client, and holds one connection on it: the test gate closes a session that nobody connects to after
`TEST_IDLE_CLOSE_SECONDS` (10 s), which a slow network could otherwise let happen before the buyer's own close. It then
reads `GET closeUrl?session=`, builds the close with `buildSponsoredClose`, signs it as the buyer and sends it. The
amounts are checked as scenario 1 checks them. The refusal needs a session that names another rent payer, which only a
target with direct chain access can open, so a target without `direct` checks the first half only.

The gate is not told of the close (see "What this part builds, and what it leaves"): the scenario closes its own
connection at the end, and the gate ends its record of the session at `paid_until`.

**Files:**
- Create: `conformance/src/scenarios/15-sponsored-close.ts`
- Modify: `conformance/src/catalogue.ts`, `conformance/test/catalogue.test.ts`, `e2e/test/local-target.test.ts`,
  `README.md` (`## Status`)

**Interfaces:**
- Consumes: Task 1's `readCloseInfo`, `buildSponsoredClose`, `CloseInfo`, `SponsoredCloseResponse`; Task 3's routes;
  `buyerClient`, `sessionSeconds` (`conformance/src/helpers.ts`); `assertRentReturned`
  (`conformance/src/scenarios/22-example-agent-task.ts`); `readUntil` (`conformance/src/reads.ts`).
- Produces: `sponsoredClose(context: ScenarioContext): Promise<void>`, required as scenario 15.

- [ ] **Step 1: Write the scenario**

Create `conformance/src/scenarios/15-sponsored-close.ts`:

```ts
import { CloseKind, fetchMaybeSession } from "@lxfoundry/stint-program-client";
import {
  HEADERS,
  associatedTokenAddress,
  buildSponsoredClose,
  decodePaymentRequiredHeader,
  fetchClosedEvent,
  lamportBalances,
  readCloseInfo,
  readElapsedRequirements,
  tokenBalanceChanges,
  type CloseInfo,
  type PaymentRequired,
  type SponsoredCloseResponse,
} from "@lxfoundry/stint-x402";
import { expectEqual, expectTrue } from "../assert.js";
import { buyerClient, sessionSeconds } from "../helpers.js";
import { readUntil } from "../reads.js";
import type { DirectChain, ScenarioContext } from "../types.js";
import { assertRentReturned } from "./22-example-agent-task.js";

/** The `closeUrl` of the gate's offer, which the gate copies from its facilitator's `/supported` (spec §5.1). */
async function offeredCloseUrl(gateUrl: string): Promise<string> {
  const response = await fetch(`${gateUrl}/sessions`, { method: "POST" });
  expectEqual(response.status, 402, "an open without a payment is answered 402");
  const header = response.headers.get(HEADERS.paymentRequired);
  const required = (header ? decodePaymentRequiredHeader(header) : await response.json()) as PaymentRequired;
  const offer = required.accepts.map(readElapsedRequirements).find((entry) => entry?.extra.action === "open");
  expectTrue(offer, "the 402 offers an elapsed open");
  return offer.extra.closeUrl;
}

/** `GET closeUrl?session=`: the facilitator's fee payer, a blockhash and the session's stored fields. */
async function closeInfoFor(closeUrl: string, session: string): Promise<CloseInfo> {
  const response = await fetch(`${closeUrl}?session=${session}`);
  expectEqual(response.status, 200, "GET closeUrl?session= finds the session");
  const info = readCloseInfo(await response.json());
  expectTrue(info !== undefined && info.session !== undefined, "GET closeUrl?session= answers a fee payer, a blockhash and the session's fields");
  return info;
}

/** `POST closeUrl`, as a buyer sends it: no API key. */
async function postClose(closeUrl: string, transaction: string): Promise<SponsoredCloseResponse> {
  const response = await fetch(closeUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ transaction }),
  });
  expectEqual(response.status, 200, "POST closeUrl answers 200");
  return (await response.json()) as SponsoredCloseResponse;
}

/**
 * The second half of scenario 15: a session opened directly on-chain names a harness key as its rent payer, so the
 * facilitator refuses to sponsor its close, and the session stays open. The scenario then closes it on the program.
 */
async function refusesAnotherRentPayer(context: ScenarioContext, closeUrl: string, direct: DirectChain): Promise<void> {
  const buyer = await context.newBuyer(100_000n); // the deposit is 10,000 (20,000 on devnet): the funding key lends no more than that
  const opened = await direct.open({ buyer, seconds: sessionSeconds(context.target, 10) });
  const readSession = () => fetchMaybeSession(context.rpc, opened.session, { commitment: "confirmed" });
  try {
    const info = await closeInfoFor(closeUrl, opened.session);
    expectEqual(info.session?.rentPayer, opened.rentPayer, "GET closeUrl?session= reports the harness's rent payer");
    const answer = await postClose(closeUrl, await buildSponsoredClose(info, buyer.signer));
    expectTrue(
      !answer.success && answer.errorReason === "invalid_terms",
      `the close of a session whose rent payer is not the facilitator's is refused with invalid_terms (${JSON.stringify(answer)})`,
    );
    expectTrue((await readSession()).exists, "the refused close left the session open");
  } finally {
    // No gate or sweeper closes a session whose receiver authorizer and rent payer are harness keys.
    if ((await readSession()).exists) await direct.close(opened, buyer.signer);
  }
}

/**
 * Scenario 15 (spec §12.7): a sponsored close through `closeUrl`, built only from what `GET /close` returns. Closed and
 * refunded. A session whose rent payer is not one of this facilitator's keys (opened directly on-chain with a harness
 * rent payer) is refused.
 */
export async function sponsoredClose(context: ScenarioContext): Promise<void> {
  const closeUrl = await offeredCloseUrl(context.gateUrl);
  const buyer = await context.newBuyer(1_000_000n);
  const opened = await buyerClient(buyer).open(context.gateUrl, { seconds: sessionSeconds(context.target, 30) });
  // A connection keeps the gate's idle timer from closing the session before the buyer does (spec §7.3).
  const socket = await opened.connect();
  try {
    const readSession = () => fetchMaybeSession(context.rpc, opened.id, { commitment: "confirmed" });
    const account = await readUntil(context.readRetry, readSession, (read) => read.exists);
    expectTrue(account.exists, "the session exists on-chain after the open");
    const stored = account.data;
    expectEqual(stored.deposited, opened.cost, "the deposit credited at open");
    if (context.stack) expectEqual(stored.rentPayer, context.stack.rentPayer, "the facilitator's rent payer fronted the rent");

    const info = await closeInfoFor(closeUrl, opened.id);
    const answer = await postClose(closeUrl, await buildSponsoredClose(info, buyer.signer));
    expectTrue(answer.success, `the sponsored close succeeds (${JSON.stringify(answer)})`);

    const closed = await fetchClosedEvent(context.rpc, answer.transaction, context.readRetry);
    expectTrue(closed, "the close emitted Closed");
    expectEqual(closed.kind, CloseKind.Standard, "the sponsored close is a Standard close");
    expectEqual(closed.closedBy, buyer.signer.address, "the close was signed by the session's authority");
    // Spec §4.2, as in scenario 1: elapsed stops at paid_until, and a close charges at least minSeconds.
    const covered = stored.deposited / stored.rate;
    const elapsed = closed.at - stored.startedAt;
    const used = elapsed < 0n ? 0n : elapsed > covered ? covered : elapsed;
    const charged = used > BigInt(stored.minSeconds) ? used : BigInt(stored.minSeconds);
    const due = stored.rate * charged;
    expectTrue(answer.paid !== undefined && answer.refunded !== undefined, "the facilitator reported the close's amounts");
    expectEqual(BigInt(answer.paid), due, "paid = due");
    expectEqual(BigInt(answer.refunded), stored.deposited - due, "refunded = deposit − due");

    const changes = await tokenBalanceChanges(context.rpc, answer.transaction, context.readRetry);
    expectEqual(changes.get(await associatedTokenAddress(stored.receiver, stored.mint)), due, "the receiver's gain in the close");
    expectEqual(changes.get(buyer.usdcAccount), stored.deposited - due, "the buyer's refund in the close");
    assertRentReturned(await lamportBalances(context.rpc, answer.transaction, context.readRetry), {
      rentPayer: stored.rentPayer,
      session: opened.id,
      vault: await associatedTokenAddress(opened.id, stored.mint),
    });
    expectTrue(!(await readUntil(context.readRetry, readSession, (read) => !read.exists)).exists, "the session account is closed");
  } finally {
    socket.close();
  }

  if (context.direct) await refusesAnotherRentPayer(context, closeUrl, context.direct);
}
```

Run: `pnpm --filter @lxfoundry/stint-conformance typecheck`
Expected: PASS.

- [ ] **Step 2: Run it while pending, to see it pass**

In `conformance/src/catalogue.ts`, add after `import { disconnectAndGrace } from "./scenarios/09-disconnect-and-grace.js";`:

```ts
import { sponsoredClose } from "./scenarios/15-sponsored-close.js";
```

and replace `  pending(15, "Sponsored close through closeUrl"),` with:

```ts
  pending(15, "Sponsored close through closeUrl", [], "shared", sponsoredClose),
```

Run: `pnpm e2e:local`
Expected: scenario 15 passes while pending, and the report says to make it required. Every required scenario passes.
Run it three times in a row; each run passes scenario 15.

- [ ] **Step 3: Make it required**

In `conformance/src/catalogue.ts`, replace `  pending(15, "Sponsored close through closeUrl", [], "shared", sponsoredClose),` with:

```ts
  required(15, "Sponsored close through closeUrl", sponsoredClose),
```

In `conformance/test/catalogue.test.ts` and in `e2e/test/local-target.test.ts`, add `15` to `const REQUIRED = […]`, in
numeric order. On a tree where the list reads `[1, 2, 3, 9, 16, 22, 26]`, it becomes `[1, 2, 3, 9, 15, 16, 22, 26]`;
if another stage has added scenarios since, keep them and insert `15` among them.

In `README.md`, section `## Status`, replace the sentence that counts the scenarios passing on a local network and on
devnet with one that counts one more on the local network, and add the sponsored close to what works. On a tree where
the section reads as it does at the start of this part, replace:

```markdown
the facilitator with its sweeper, the gate with its timers, the client library, an MCP server
and an example agent.
```

with:

```markdown
the facilitator with its sweeper and its sponsored close (a buyer with no SOL closes its session through
the facilitator when the gate cannot), the gate with its timers, the client library, an MCP server and an
example agent.
```

and:

```markdown
facilitator's own rent payer. Seven of the 35 end-to-end scenarios of the
[specification](docs/specs/stint-system.md) (section 12.7) pass on a local network and on devnet, and the run
report lists the other 28 as pending. Not built yet: top-ups, fallback closes, refusals of bad payments and
```

with:

```markdown
facilitator's own rent payer. Eight of the 35 end-to-end scenarios of the
[specification](docs/specs/stint-system.md) (section 12.7) pass on a local network and on devnet, and the run
report lists the other 27 as pending. Not built yet: top-ups, the other fallback closes, refusals of bad payments and
```

Task 5 runs scenario 15 on devnet before this part is merged, so the count holds for both networks once it is.

- [ ] **Step 4: Run every check**

Run: `pnpm typecheck && pnpm test && pnpm e2e:local`
Expected: PASS. On a tree with seven required scenarios before this part, the report reads `Status: required 8,
pending 27 · Result: pass 8, fail 0, pending 26, not applicable 1`, with no "Make required" line.

- [ ] **Step 5: Commit**

```bash
git add conformance/src/scenarios/15-sponsored-close.ts conformance/src/catalogue.ts conformance/test/catalogue.test.ts e2e/test/local-target.test.ts README.md
git commit -m "Add scenario 15, the sponsored close through closeUrl, and make it required"
```

---

### Task 5: Scenario 15 on devnet

The program is unchanged, so the devnet deployment stays as it is: this task runs the required scenarios on devnet,
scenario 15 among them, and records the result. It needs the person's `.env.devnet` and the funding key (see "Before
you start").

**Files:**
- Modify: `e2e/test/devnet-target.test.ts`, `README.md` (the devnet section)

**Interfaces:**
- Consumes: Task 4's scenario; the `devnet` target.
- Produces: nothing new in code.

- [ ] **Step 1: Add scenario 15 to the devnet run**

In `e2e/test/devnet-target.test.ts`, in the test `passes the required scenarios with buyers funded from the funding
key`, add `15` to `const required = […]`, in numeric order, as Task 4 did for `REQUIRED`.

- [ ] **Step 2: Run the devnet harness twice**

Run: `pnpm e2e:devnet funds`
Expected: it ends with `✓ Funded`.

Run: `pnpm e2e:devnet`, then once more.
Expected: both runs pass every required scenario, scenario 15 included; no session is left open, and the funding
key's USDC is unchanged at the end of each run. If scenario 15 fails on devnet only, read its error before changing
anything: a timing value the run measures to be too short is changed in the target's configuration, never in the
scenario's pass condition.

- [ ] **Step 3: Record it**

In `README.md`, in the devnet section, add `15` to the sentence that lists the scenarios passing on devnet, in numeric
order. On a tree where it reads `Scenarios 1, 2, 3, 9, 16, 22 and 26 pass on devnet.`, it becomes:

```markdown
Scenarios 1, 2, 3, 9, 15, 16, 22 and 26 pass on devnet.
```

Run: `pnpm --filter @lxfoundry/stint-e2e test devnet-target.test.ts`
Expected: PASS, against devnet.

- [ ] **Step 4: Commit**

```bash
git add e2e/test/devnet-target.test.ts README.md
git commit -m "Run scenario 15 on devnet with the other required scenarios"
```

## Done when

- `pnpm typecheck`, `pnpm test` and `pnpm e2e:local` pass, locally in WSL and in continuous integration.
- Scenario 15 is `required` and passes on `local` and on devnet, with every earlier required scenario.
- `GET /close` answers the fee payer, a blockhash cached for a few seconds and the block height, and with `?session=`
  the session's stored fields or `404`; `POST /close` settles a close signed by the session's authority for a session
  whose rent payer is the facilitator's, and refuses every other case of spec section 5.4's sponsored row with its
  reason, without sending anything.
- The pull request's description records the devnet run and any deviation from this plan.

## Spec edits made by this part

Each is made in Task 3, and states a fact the code relies on:
- §5.4, sponsored row: the refusal each check gives, and that the rent payer funds nothing;
- §6.1, `GET /close`: the encoding of the heights and of `session`, and the `404` body;
- §6.1, `POST /close`: the success without amounts, the refusal's body, and `400 invalid_json`.

Not edited, on purpose: §6.1's rate limits and §5.5's settlement records, which the spec keeps for the facilitator as it
is meant to be; this part builds neither (see "What this part builds, and what it leaves").
