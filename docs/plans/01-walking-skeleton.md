# Stage 1: Walking Skeleton Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or
> executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for
> tracking.

**Goal:** A buyer opens a session through a gate's 402, connects to the example stream over
WebSocket, and closes early: the program pays the seller for the elapsed time and refunds the rest,
all through the facilitator and Kora. Scenario 1 passes on `local` and becomes `required`.

**Architecture:** One vertical cut through every component, each in its minimal form.
- The program gains `open` and a `Standard` close.
- `@lxfoundry/stint-x402` holds the scheme's wire format: offers, payloads, session tokens, the
  transactions a client builds, and the pure checks a facilitator runs on them.
- The facilitator (`apps/facilitator`) verifies and settles through Kora.
- The gate (`@lxfoundry/stint-gate`) runs as middleware inside the example stream
  (`examples/solana-stream`).
- The client (`@lxfoundry/stint-client`) opens, connects and closes, and exposes the first four
  agent tools.
- The harness starts the facilitator and the stream on the local network, and scenario 1 drives
  the tools as a scripted buyer.

**Tech Stack:** stage 0's pins, plus `anchor-spl` 1.2.1, npm `litesvm` 1.6.1, `@x402/core` 2.28.0,
`ws` 8.22.0 and `@types/ws` 8.18.2.

**Spec:** [`docs/specs/stint-system.md`](../specs/stint-system.md). Read before starting:
- §4.1 to §4.5: the program;
- §5.1, §5.3 to §5.5: the scheme;
- §6.1 and §6.2: the facilitator;
- §7.1 to §7.3, §7.6: the gate;
- §8: the stream;
- §9.2 to §9.5: the client;
- §12.2: the harness and scenario 1.
§14 questions 1, 2, 4, 5 and 7 are answered here (see "Spec §14 answers" at the end).

## Global Constraints

- Platform: Linux x86-64 or macOS; on Windows, everything runs inside WSL 2 (T1, T2). npm `litesvm`
  ships no Windows binary either. Run every command from the repository root, inside WSL.
- Transactions are version 0, without address lookup tables (spec §3.5). A transaction with any
  other version, or with a lookup table, is refused as `invalid_payload`.
- Only classic SPL Token mints. The payment token is devnet USDC,
  `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`, 6 decimals (spec §3.4). The network identifier is
  `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` on every target (spec §12.3).
- `u64` values on the wire are decimal strings; `u32` values are JSON numbers (spec §5.1). Amounts
  are `bigint` in TypeScript, never `number`.
- The facilitator's fee payer appears in no instruction's accounts. Its rent payer appears only as
  the payer of the vault's creation and as `stint.open`'s `rent_payer` (spec §5.3). Every check of
  this rule runs before any other layout check, so a misplaced key is reported as `payer_misuse`.
- A client never signs a transaction supplied by a seller: it builds the transaction from the
  offer's terms (spec §9.3).
- Program errors keep the order of spec §4.5. Anchor numbers them from 6000: `InvalidTerms` 6000,
  `DepositTooSmall` 6001, `DepositTooLarge` 6002, `SessionExpired` 6003, `NotExpired` 6004,
  `NothingToTopUp` 6005, `Unauthorized` 6006, `MintMismatch` 6007, `AccountMismatch` 6008,
  `MathOverflow` 6009.
- No secrets in any commit. Keys are generated for each run.
- Scenario statuses follow the ratchet of spec §12.2: scenario 1 is made `required` in the commit
  where it first passes.
- Commit messages are neutral, technical and in the present tense.

## Version pins added in this stage

| Package | Version | Used by |
|---|---|---|
| `anchor-spl` (crate) | 1.2.1, default features | The program: `Mint`, `TokenAccount`, `Token`, CPIs, associated-token-address derivation |
| `litesvm` (npm) | 1.6.1 | Program tests. CommonJS; bundles its own older `@solana-program/token`, which is harmless |
| `@x402/core` | 2.28.0 | Types and the v2 header helpers only. Its one runtime dependency is `zod` 3 |
| `ws` | 8.22.0 | The gate's WebSocket server; the client's WebSocket (it can send `Authorization`) |
| `@types/ws` | 8.18.2 | Types for `ws` |

`@x402/svm` is **not** used: its dependencies require `@solana/kit` 5 and would install a second
copy of Kit next to 8.5.0.

## What stage 1 leaves out

Each item is built by a later stage of [README.md](README.md). Stage 1 must not half-build
them:
- settlement records, retries and `settlement_pending` handling beyond answering `202` (stage 3);
- the gate's idle and end timers, `AtExpiry`, `claim`, the sweeper (stage 4). The offer still
  announces `idleCloseSeconds` and `closeOnOutage`, since spec §5.1 makes them part of every offer;
- top-up (stage 5); adoption of sessions opened on-chain, which this stage answers `404` (stage 6);
- the status endpoint, `GET /close`, the sponsored and unilateral closes (stages 2 and 7);
- `WaiveMinimum`, outage and admin closes (stage 8); a redirected residual, recreating a closed
  `receiver_token`, `409 refund_account_closed` (stage 9);
- the connection limit and `4429`, several gate instances (stage 10);
- the gate proxy, assertions and the JWKS: the stream mounts the gate as middleware (spec §7.6),
  so nothing is forwarded across a process boundary yet;
- the stream's `slot` messages.

`close` with a kind other than `Standard` fails with `InvalidTerms` until stages 4 and 8 add them.
The scheme checker accepts only `SetComputeUnitLimit` among compute-budget instructions, so a
client cannot raise the fee the facilitator pays with a priority fee.

## File structure

| Path | Responsibility |
|---|---|
| `programs/stint/Cargo.toml` | Adds `anchor-spl` and its `idl-build` feature |
| `programs/stint/src/maths.rs` | The arithmetic of spec §4.2, as pure functions with unit tests |
| `programs/stint/src/instructions/{mod,open,close}.rs` | The two instructions |
| `programs/stint/src/lib.rs` | Declares the instructions |
| `packages/program-client/src/helpers.ts` | Session and event-authority PDAs, `paidUntil`, reading `emit_cpi!` events |
| `packages/program-client/test/program/*.ts` | LiteSVM program tests (spec §12.1, "Program") |
| `conformance/src/{runner,report}.ts` | Error descriptions, escaping, duplicate IDs |
| `packages/x402/src/*` | `@lxfoundry/stint-x402`: constants, offers, wire headers, session tokens, transaction builders, transaction inspection and the open and close checks, chain reads |
| `apps/facilitator/src/*` | `@lxfoundry/stint-facilitator`: `startFacilitator`, Kora's client, `/supported`, `/verify`, `/settle` |
| `packages/gate/src/*` | `@lxfoundry/stint-gate`: `createGate`, its facilitator client, its chain reader, session registry, routes |
| `examples/solana-stream/src/*` | `@lxfoundry/stint-example-stream`: `startStream`, the stream adapter |
| `packages/client/src/*` | `@lxfoundry/stint-client`: policy, `createStintClient`, sessions, the first four tools |
| `e2e/src/targets/chain.ts` | The local network with its fixtures and the common keys, split out of `local.ts` |
| `e2e/src/targets/local.ts` | Adds the facilitator and the stream to the local target |
| `e2e/src/fixtures/buyers.ts` | Fresh buyer keys holding USDC and no SOL |
| `conformance/src/scenarios/01-open-connect-close.ts` | Scenario 1 |
| `pnpm-workspace.yaml` | Adds `apps/*` and `examples/*` |

Every new package follows stage 0's shape: `"private": true`, `"type": "module"`,
`"exports": { ".": "./src/index.ts" }`, scripts `typecheck` (`tsc -p tsconfig.json`) and `test`
(`vitest run`), and a `tsconfig.json` that extends the base file and includes `src` and `test`.

Work on the branch `feat/stage-1-walking-skeleton`, created from `main`:

    git switch main && git pull && git switch -c feat/stage-1-walking-skeleton

---

### Task 1: The program's `open`

**Files:**
- Modify: `programs/stint/Cargo.toml`, `programs/stint/src/lib.rs`
- Create: `programs/stint/src/maths.rs`, `programs/stint/src/instructions/mod.rs`,
  `programs/stint/src/instructions/open.rs`
- Create: `packages/program-client/src/helpers.ts`; modify `packages/program-client/src/index.ts`
- Regenerate: `packages/program-client/src/generated/` (`pnpm generate:client`)
- Test: `packages/program-client/test/program/fixture.ts`,
  `packages/program-client/test/program/open.test.ts`; modify
  `packages/program-client/test/generated.test.ts`

**Interfaces:**
- Consumes: stage 0's `Session` account, events and errors.
- Produces:
  - instruction `open(seed: u64, rate: u64, min_seconds: u32, max_seconds: u32)` with accounts, in
    this order: `authority` (signer), `rent_payer` (signer, writable), `session` (PDA, created),
    `mint`, `vault`, `receiver`, `receiver_authorizer`, `refund_owner`, `token_program`,
    `system_program`, then `event_authority` and `program` (added by `#[event_cpi]`);
  - in Rust, `maths::{covered, paid_until, elapsed, charged, due, owed}`;
  - in `@lxfoundry/stint-program-client`:
    - generated `getOpenInstruction`, `parseOpenInstruction`, `identifyStintInstruction`,
      `StintInstruction`, `fetchSession`, `fetchMaybeSession`, `getSessionDecoder`, `Session`;
    - `findSessionPda(authority: Address, seed: bigint): Promise<ProgramDerivedAddress>`;
    - `eventAccounts(): Promise<{ eventAuthority: Address; program: Address }>`;
    - `paidUntil(session: { startedAt: bigint; deposited: bigint; rate: bigint }): bigint`;
    - `interface ProgramInstruction { programAddress: Address; data: ReadonlyUint8Array }`;
    - `findOpenedEvent(instructions: Iterable<ProgramInstruction>): OpenedEvent | undefined`;
    - `findClosedEvent(instructions: Iterable<ProgramInstruction>): ClosedEvent | undefined`.
  - Test fixture `Fixture` (Task 2 extends it).

- [ ] **Step 1: Add `anchor-spl`**

In `programs/stint/Cargo.toml`, replace the `idl-build` feature and the dependencies:

```toml
idl-build = ["anchor-lang/idl-build", "anchor-spl/idl-build"]

[dependencies]
anchor-lang = { version = "1.2.1", features = ["event-cpi"] }
anchor-spl = "1.2.1"
```

`anchor-spl/idl-build` is required: it is where the IDL learns the `Mint` and `TokenAccount`
types. `anchor-spl` 1.2.1 defaults to the Solana 3.x crates, like `anchor-lang`.

- [ ] **Step 2: Write the failing maths tests**

Create `programs/stint/src/maths.rs`:

```rust
//! The arithmetic of spec section 4.2. Every product goes through `u128`, so no intermediate
//! overflows; a result that does not fit its type fails with `MathOverflow`.

use anchor_lang::prelude::*;

use crate::errors::StintError;

/// Seconds the deposit buys: `floor(deposited / rate)`. `rate` is never zero once a session is open.
pub fn covered(deposited: u64, rate: u64) -> Result<u64> {
    deposited.checked_div(rate).ok_or_else(|| error!(StintError::MathOverflow))
}

/// The moment the deposit runs out: `started_at + covered`.
pub fn paid_until(started_at: i64, deposited: u64, rate: u64) -> Result<i64> {
    let covered = i64::try_from(covered(deposited, rate)?).map_err(|_| error!(StintError::MathOverflow))?;
    started_at.checked_add(covered).ok_or_else(|| error!(StintError::MathOverflow))
}

/// `max(0, min(now, paid_until) - started_at)`. A clock behind `started_at` gives zero.
pub fn elapsed(started_at: i64, paid_until: i64, now: i64) -> u64 {
    let end = i128::from(now.min(paid_until));
    let elapsed = (end - i128::from(started_at)).max(0);
    // end <= paid_until = started_at + covered, and covered fits in a u64.
    u64::try_from(elapsed).unwrap_or(u64::MAX)
}

/// The seconds a close charges: the elapsed time, raised to the minimum unless it is waived.
pub fn charged(min_seconds: u32, elapsed: u64, waive_minimum: bool) -> u64 {
    if waive_minimum {
        elapsed
    } else {
        elapsed.max(u64::from(min_seconds))
    }
}

/// `min(deposited, rate × charged)`: the session's total charge at a close.
pub fn due(deposited: u64, rate: u64, charged: u64) -> u64 {
    let due = u128::from(rate) * u128::from(charged);
    // The minimum with a u64 always fits in a u64.
    u64::try_from(due.min(u128::from(deposited))).unwrap_or(deposited)
}

/// `max(claimed, due) - claimed`: what a close still pays the receiver.
pub fn owed(claimed: u64, due: u64) -> u64 {
    claimed.max(due) - claimed
}

/// `rate × seconds`, for the deposit bounds of `open`.
pub fn cost(rate: u64, seconds: u32) -> u128 {
    u128::from(rate) * u128::from(seconds)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn covered_rounds_down() {
        assert_eq!(covered(10_500, 1_000).unwrap(), 10);
    }

    #[test]
    fn paid_until_adds_the_covered_seconds() {
        assert_eq!(paid_until(1_000, 30_000, 1_000).unwrap(), 1_030);
    }

    #[test]
    fn paid_until_overflows_with_an_error() {
        assert!(paid_until(i64::MAX, 2_000, 1_000).is_err());
    }

    #[test]
    fn elapsed_stops_at_paid_until() {
        assert_eq!(elapsed(1_000, 1_030, 1_010), 10);
        assert_eq!(elapsed(1_000, 1_030, 5_000), 30);
    }

    #[test]
    fn elapsed_is_zero_when_the_clock_is_behind_the_start() {
        assert_eq!(elapsed(1_000, 1_030, 900), 0);
    }

    #[test]
    fn charged_applies_the_minimum_unless_waived() {
        assert_eq!(charged(5, 2, false), 5);
        assert_eq!(charged(5, 8, false), 8);
        assert_eq!(charged(5, 2, true), 2);
    }

    #[test]
    fn due_is_capped_by_the_deposit() {
        assert_eq!(due(30_000, 1_000, 8), 8_000);
        assert_eq!(due(30_000, 1_000, 40), 30_000);
        assert_eq!(due(u64::MAX, u64::MAX, u64::MAX), u64::MAX);
    }

    #[test]
    fn owed_excludes_what_claims_paid() {
        assert_eq!(owed(0, 8_000), 8_000);
        assert_eq!(owed(3_000, 8_000), 5_000);
        assert_eq!(owed(9_000, 8_000), 0);
    }

    #[test]
    fn cost_does_not_overflow() {
        assert_eq!(cost(u64::MAX, u32::MAX), u128::from(u64::MAX) * u128::from(u32::MAX));
    }
}
```

Add `pub mod maths;` to `programs/stint/src/lib.rs` (after `pub mod events;`).

- [ ] **Step 3: Run the maths tests**

Run: `cargo test -p stint`
Expected: PASS: the nine maths tests and stage 0's `session_account_is_250_bytes`. The functions
are written with their tests in one step because they are one line each. If a test fails, fix
the function, not the test: the expected values come from spec §4.2.

- [ ] **Step 4: Write the client helpers**

Create `packages/program-client/src/helpers.ts`:

```ts
import {
  containsBytes,
  getAddressEncoder,
  getProgramDerivedAddress,
  getU64Encoder,
  type Address,
  type ProgramDerivedAddress,
  type ReadonlyUint8Array,
} from "@solana/kit";
import { CLOSED_EVENT_DISCRIMINATOR, parseClosedEvent, type ClosedEvent } from "./generated/events/closed.js";
import { OPENED_EVENT_DISCRIMINATOR, parseOpenedEvent, type OpenedEvent } from "./generated/events/opened.js";
import { STINT_PROGRAM_ADDRESS } from "./generated/programs/stint.js";

/** The session PDA: `["session", authority, seed]`, the seed as little-endian bytes (spec §4.1). */
export function findSessionPda(authority: Address, seed: bigint): Promise<ProgramDerivedAddress> {
  return getProgramDerivedAddress({
    programAddress: STINT_PROGRAM_ADDRESS,
    seeds: ["session", getAddressEncoder().encode(authority), getU64Encoder().encode(seed)],
  });
}

/** The two accounts `#[event_cpi]` adds to an instruction that emits events (spec §4.4). */
export async function eventAccounts(): Promise<{ eventAuthority: Address; program: Address }> {
  const [eventAuthority] = await getProgramDerivedAddress({
    programAddress: STINT_PROGRAM_ADDRESS,
    seeds: ["__event_authority"],
  });
  return { eventAuthority, program: STINT_PROGRAM_ADDRESS };
}

/** `started_at + floor(deposited / rate)` (spec §4.2). */
export function paidUntil(session: { startedAt: bigint; deposited: bigint; rate: bigint }): bigint {
  return session.startedAt + session.deposited / session.rate;
}

/** An instruction as it appears in a transaction's inner instructions. */
export interface ProgramInstruction {
  readonly programAddress: Address;
  readonly data: ReadonlyUint8Array;
}

/** Anchor's `EVENT_IX_TAG`, `0x1d9acb512ea545e4`, little-endian: it starts every `emit_cpi!`. */
export const EVENT_IX_TAG = new Uint8Array([0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d]);

/** The event payloads (discriminator and fields) that the Stint program emitted. */
export function eventPayloads(instructions: Iterable<ProgramInstruction>): ReadonlyUint8Array[] {
  const payloads: ReadonlyUint8Array[] = [];
  for (const instruction of instructions) {
    if (instruction.programAddress !== STINT_PROGRAM_ADDRESS) continue;
    if (!containsBytes(instruction.data, EVENT_IX_TAG, 0)) continue;
    payloads.push(instruction.data.slice(EVENT_IX_TAG.length));
  }
  return payloads;
}

export function findOpenedEvent(instructions: Iterable<ProgramInstruction>): OpenedEvent | undefined {
  const payload = eventPayloads(instructions).find((data) => containsBytes(data, OPENED_EVENT_DISCRIMINATOR, 0));
  return payload && parseOpenedEvent(payload);
}

export function findClosedEvent(instructions: Iterable<ProgramInstruction>): ClosedEvent | undefined {
  const payload = eventPayloads(instructions).find((data) => containsBytes(data, CLOSED_EVENT_DISCRIMINATOR, 0));
  return payload && parseClosedEvent(payload);
}
```

Replace `packages/program-client/src/index.ts`:

```ts
export * from "./generated/index.js";
export * from "./helpers.js";
```

- [ ] **Step 5: Add the LiteSVM fixture**

Add the test dependencies: `pnpm --filter @lxfoundry/stint-program-client add -D litesvm@1.6.1 @solana-program/token@0.18.0`

Create `packages/program-client/test/program/fixture.ts`:

```ts
import { fileURLToPath } from "node:url";
import {
  AccountState,
  TOKEN_PROGRAM_ADDRESS,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  getMintEncoder,
  getMintSize,
  getTokenDecoder,
  getTokenEncoder,
  getTokenSize,
  getTransferCheckedInstruction,
} from "@solana-program/token";
import {
  appendTransactionMessageInstructions,
  blockhash,
  createTransactionMessage,
  generateKeyPairSigner,
  getCompiledTransactionMessageDecoder,
  lamports,
  none,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  some,
  type Address,
  type Instruction,
  type KeyPairSigner,
} from "@solana/kit";
import { FailedTransactionMetadata, LiteSVM } from "litesvm";
import {
  STINT_PROGRAM_ADDRESS,
  eventAccounts,
  findSessionPda,
  getOpenInstruction,
  type ProgramInstruction,
} from "../../src/index.js";

const STINT_SO = fileURLToPath(new URL("../../../../target/deploy/stint.so", import.meta.url));
export const DECIMALS = 6;

export interface Wallet {
  readonly signer: KeyPairSigner;
  /** Its associated token account for the fixture's mint. */
  readonly token: Address;
}

export interface Sent {
  readonly ok: boolean;
  readonly logs: readonly string[];
  /** The custom program error, when the transaction failed with one. */
  readonly errorCode?: number;
  /** Inner instructions with their program address, in order. */
  readonly inner: readonly ProgramInstruction[];
}

export interface OpenOptions {
  readonly authority: Wallet;
  readonly deposit: bigint;
  readonly rate?: bigint;
  readonly minSeconds?: number;
  readonly maxSeconds?: number;
  readonly seed?: bigint;
  readonly receiver?: Address;
  readonly refundOwner?: Address;
  readonly vault?: Address;
}

export interface Opened {
  readonly session: Address;
  readonly vault: Address;
  readonly sent: Sent;
}

/** Writes an SPL Token account at any address, so tests can also place non-canonical ones. */
function writeTokenAccount(svm: LiteSVM, mint: Address, address: Address, owner: Address, amount: bigint): void {
  const data = getTokenEncoder().encode({
    mint,
    owner,
    amount,
    delegate: none(),
    state: AccountState.Initialized,
    isNative: none(),
    delegatedAmount: 0n,
    closeAuthority: none(),
  });
  svm.setAccount({
    address,
    lamports: lamports(svm.minimumBalanceForRentExemption(BigInt(getTokenSize()))),
    data: Uint8Array.from(data),
    programAddress: TOKEN_PROGRAM_ADDRESS,
    executable: false,
    space: BigInt(getTokenSize()),
  });
}

/** A new key with 1 SOL, and its associated token account holding `amount`. */
async function newWallet(svm: LiteSVM, mint: Address, amount: bigint): Promise<Wallet> {
  const signer = await generateKeyPairSigner();
  svm.airdrop(signer.address, lamports(1_000_000_000n));
  const [token] = await findAssociatedTokenPda({ owner: signer.address, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  writeTokenAccount(svm, mint, token, signer.address, amount);
  return { signer, token };
}

/** A LiteSVM instance with the Stint program, a mint, a seller and a rent payer. */
export class Fixture {
  private constructor(
    readonly svm: LiteSVM,
    readonly payer: KeyPairSigner,
    readonly mint: Address,
    readonly rentPayer: KeyPairSigner,
    readonly seller: Wallet,
    readonly receiverAuthorizer: KeyPairSigner,
  ) {}

  static async create(): Promise<Fixture> {
    const svm = new LiteSVM();
    svm.addProgramFromFile(STINT_PROGRAM_ADDRESS, STINT_SO);
    const payer = await generateKeyPairSigner();
    const rentPayer = await generateKeyPairSigner();
    const receiverAuthorizer = await generateKeyPairSigner();
    for (const key of [payer, rentPayer, receiverAuthorizer]) svm.airdrop(key.address, lamports(10_000_000_000n));
    const mint = (await generateKeyPairSigner()).address;
    const mintData = getMintEncoder().encode({
      mintAuthority: some(payer.address),
      supply: 0n,
      decimals: DECIMALS,
      isInitialized: true,
      freezeAuthority: none(),
    });
    svm.setAccount({
      address: mint,
      lamports: lamports(svm.minimumBalanceForRentExemption(BigInt(getMintSize()))),
      data: Uint8Array.from(mintData),
      programAddress: TOKEN_PROGRAM_ADDRESS,
      executable: false,
      space: BigInt(getMintSize()),
    });
    const seller = await newWallet(svm, mint, 0n);
    return new Fixture(svm, payer, mint, rentPayer, seller, receiverAuthorizer);
  }

  wallet(amount: bigint): Promise<Wallet> {
    return newWallet(this.svm, this.mint, amount);
  }

  writeTokenAccount(address: Address, owner: Address, amount: bigint): void {
    writeTokenAccount(this.svm, this.mint, address, owner, amount);
  }

  /** The token amount at an address, or undefined when no token account is there. */
  tokenAmount(address: Address): bigint | undefined {
    const account = this.svm.getAccount(address);
    if (!account.exists || account.programAddress !== TOKEN_PROGRAM_ADDRESS) return undefined;
    return getTokenDecoder().decode(account.data).amount;
  }

  lamportsOf(address: Address): bigint {
    return this.svm.getBalance(address) ?? 0n;
  }

  exists(address: Address): boolean {
    return this.svm.getAccount(address).exists;
  }

  now(): bigint {
    return this.svm.getClock().unixTimestamp;
  }

  setNow(unixTimestamp: bigint): void {
    const clock = this.svm.getClock();
    clock.unixTimestamp = unixTimestamp;
    this.svm.setClock(clock);
  }

  async ata(owner: Address): Promise<Address> {
    const [token] = await findAssociatedTokenPda({ owner, mint: this.mint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    return token;
  }

  /** Sends a version 0 transaction paid by the fixture's payer, then expires the blockhash. */
  async send(instructions: readonly Instruction[]): Promise<Sent> {
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(this.payer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: blockhash(this.svm.latestBlockhash()), lastValidBlockHeight: 0n }, m),
      (m) => appendTransactionMessageInstructions(instructions, m),
    );
    const transaction = await signTransactionMessageWithSigners(message);
    const { staticAccounts } = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
    const result = this.svm.sendTransaction(transaction);
    // Identical transactions are refused while their blockhash is valid: always start afresh.
    this.svm.expireBlockhash();
    const failed = result instanceof FailedTransactionMetadata;
    const meta = failed ? result.meta() : result;
    const inner = meta
      .innerInstructions()
      .flat()
      .map((entry) => ({
        programAddress: staticAccounts[entry.instruction().programIdIndex()]!,
        data: entry.instruction().data(),
      }));
    const errorCode = failed
      ? (result.err() as { err?: () => { code?: number } }).err?.()?.code
      : undefined;
    return { ok: !failed, logs: meta.logs(), inner, ...(errorCode === undefined ? {} : { errorCode }) };
  }

  /** The transaction layout of spec §5.3: create the vault, fund it, then `open`. */
  async open(options: OpenOptions): Promise<Opened> {
    const seed = options.seed ?? BigInt(Math.floor(Math.random() * 2 ** 48));
    const [session] = await findSessionPda(options.authority.signer.address, seed);
    const canonicalVault = await this.ata(session);
    const vault = options.vault ?? canonicalVault;
    const fund: Instruction[] = [
      getCreateAssociatedTokenIdempotentInstruction({
        payer: this.rentPayer,
        ata: canonicalVault,
        owner: session,
        mint: this.mint,
      }),
      getTransferCheckedInstruction({
        source: options.authority.token,
        mint: this.mint,
        destination: vault,
        authority: options.authority.signer,
        amount: options.deposit,
        decimals: DECIMALS,
      }),
    ];
    const open = getOpenInstruction({
      authority: options.authority.signer,
      rentPayer: this.rentPayer,
      session,
      mint: this.mint,
      vault,
      receiver: options.receiver ?? this.seller.signer.address,
      receiverAuthorizer: this.receiverAuthorizer.address,
      refundOwner: options.refundOwner ?? options.authority.signer.address,
      ...(await eventAccounts()),
      seed,
      rate: options.rate ?? 1_000n,
      minSeconds: options.minSeconds ?? 5,
      maxSeconds: options.maxSeconds ?? 120,
    });
    const sent = await this.send([...fund, open]);
    return { session, vault, sent };
  }
}
```

- [ ] **Step 6: Write the failing `open` tests**

Create `packages/program-client/test/program/open.test.ts`:

```ts
import { generateKeyPairSigner } from "@solana/kit";
import { beforeEach, describe, expect, it } from "vitest";
import {
  STINT_ERROR__ACCOUNT_MISMATCH,
  STINT_ERROR__DEPOSIT_TOO_LARGE,
  STINT_ERROR__DEPOSIT_TOO_SMALL,
  STINT_ERROR__INVALID_TERMS,
  findOpenedEvent,
  findSessionPda,
  getSessionDecoder,
} from "../../src/index.js";
import { Fixture, type Wallet } from "./fixture.js";

describe("open", () => {
  let fixture: Fixture;
  let buyer: Wallet;

  beforeEach(async () => {
    fixture = await Fixture.create();
    buyer = await fixture.wallet(1_000_000n);
  });

  it("stores the terms, credits the vault and emits Opened", async () => {
    const now = fixture.now();
    const { session, vault, sent } = await fixture.open({ authority: buyer, deposit: 30_000n, seed: 7n });
    expect(sent.ok, sent.logs.join("\n")).toBe(true);

    const account = fixture.svm.getAccount(session);
    if (!account.exists) throw new Error("no session");
    const stored = getSessionDecoder().decode(account.data);
    expect(stored).toMatchObject({
      version: 1,
      authority: buyer.signer.address,
      seed: 7n,
      mint: fixture.mint,
      receiver: fixture.seller.signer.address,
      receiverAuthorizer: fixture.receiverAuthorizer.address,
      refundOwner: buyer.signer.address,
      rentPayer: fixture.rentPayer.address,
      rate: 1_000n,
      minSeconds: 5,
      maxSeconds: 120,
      startedAt: now,
      deposited: 30_000n,
      claimed: 0n,
    });
    expect(fixture.tokenAmount(vault)).toBe(30_000n);
    expect(findOpenedEvent(sent.inner)).toMatchObject({
      session,
      authority: buyer.signer.address,
      deposited: 30_000n,
      startedAt: now,
      paidUntil: now + 30n,
    });
  });

  it("has the rent payer fund the session and the vault", async () => {
    const before = fixture.lamportsOf(fixture.rentPayer.address);
    const { session, vault } = await fixture.open({ authority: buyer, deposit: 30_000n });
    const spent = before - fixture.lamportsOf(fixture.rentPayer.address);
    expect(spent).toBe(fixture.lamportsOf(session) + fixture.lamportsOf(vault));
  });

  it.each([
    ["a zero rate", { rate: 0n }],
    ["a zero minimum", { minSeconds: 0 }],
    ["a minimum above the maximum", { minSeconds: 10, maxSeconds: 9 }],
  ])("refuses %s with InvalidTerms", async (_, terms) => {
    const { sent } = await fixture.open({ authority: buyer, deposit: 30_000n, ...terms });
    expect(sent.errorCode).toBe(STINT_ERROR__INVALID_TERMS);
  });

  it("refuses a deposit below rate × minSeconds", async () => {
    const { sent } = await fixture.open({ authority: buyer, deposit: 4_999n });
    expect(sent.errorCode).toBe(STINT_ERROR__DEPOSIT_TOO_SMALL);
  });

  it("refuses a deposit above rate × maxSeconds", async () => {
    const { sent } = await fixture.open({ authority: buyer, deposit: 120_001n });
    expect(sent.errorCode).toBe(STINT_ERROR__DEPOSIT_TOO_LARGE);
  });

  it("refuses the session itself as receiver or refund owner", async () => {
    const [session] = await findSessionPda(buyer.signer.address, 11n);
    const asReceiver = await fixture.open({ authority: buyer, deposit: 30_000n, seed: 11n, receiver: session });
    expect(asReceiver.sent.errorCode).toBe(STINT_ERROR__INVALID_TERMS);
    const asRefundOwner = await fixture.open({ authority: buyer, deposit: 30_000n, seed: 11n, refundOwner: session });
    expect(asRefundOwner.sent.errorCode).toBe(STINT_ERROR__INVALID_TERMS);
  });

  it("refuses a vault that is a token account of the session but not its associated one (S6)", async () => {
    const [session] = await findSessionPda(buyer.signer.address, 12n);
    const impostor = (await generateKeyPairSigner()).address;
    fixture.writeTokenAccount(impostor, session, 0n);
    const { sent } = await fixture.open({ authority: buyer, deposit: 30_000n, seed: 12n, vault: impostor });
    expect(sent.errorCode).toBe(STINT_ERROR__ACCOUNT_MISMATCH);
  });

  it("never resets a live session: a second open at its address fails and changes nothing", async () => {
    const first = await fixture.open({ authority: buyer, deposit: 30_000n, seed: 13n });
    const second = await fixture.open({ authority: buyer, deposit: 10_000n, seed: 13n });
    expect(second.sent.ok).toBe(false);
    const account = fixture.svm.getAccount(first.session);
    if (!account.exists) throw new Error("no session");
    expect(getSessionDecoder().decode(account.data).deposited).toBe(30_000n);
  });
});
```

- [ ] **Step 7: Assert all ten error codes in the generated client**

In `packages/program-client/test/generated.test.ts`, replace the test
`"numbers the program errors from 6000, in the order of spec section 4.5"`:

```ts
  it("numbers the program errors from 6000, in the order of spec section 4.5", () => {
    expect([
      STINT_ERROR__INVALID_TERMS,
      STINT_ERROR__DEPOSIT_TOO_SMALL,
      STINT_ERROR__DEPOSIT_TOO_LARGE,
      STINT_ERROR__SESSION_EXPIRED,
      STINT_ERROR__NOT_EXPIRED,
      STINT_ERROR__NOTHING_TO_TOP_UP,
      STINT_ERROR__UNAUTHORIZED,
      STINT_ERROR__MINT_MISMATCH,
      STINT_ERROR__ACCOUNT_MISMATCH,
      STINT_ERROR__MATH_OVERFLOW,
    ]).toEqual([6000, 6001, 6002, 6003, 6004, 6005, 6006, 6007, 6008, 6009]);
  });
```

and import the ten constants from `../src/index.js`.

- [ ] **Step 8: Run the tests and see them fail**

Run: `pnpm --filter @lxfoundry/stint-program-client test`
Expected: FAIL: `getOpenInstruction` and the `STINT_ERROR__…` constants it imports are not
exported yet, since the program has no instruction to generate them from.

- [ ] **Step 9: Write the `open` instruction**

Create `programs/stint/src/instructions/mod.rs`:

```rust
pub mod open;

pub use open::*;
```

Create `programs/stint/src/instructions/open.rs`:

```rust
use anchor_lang::prelude::*;
use anchor_spl::associated_token::get_associated_token_address;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::errors::StintError;
use crate::events::Opened;
use crate::maths;
use crate::state::{Session, SESSION_SEED, SESSION_VERSION};

/// Opens a session (spec section 4.3). The vault is funded by an earlier instruction of the same
/// transaction; `open` credits what the vault holds.
#[event_cpi]
#[derive(Accounts)]
#[instruction(seed: u64)]
pub struct Open<'info> {
    pub authority: Signer<'info>,

    #[account(mut)]
    pub rent_payer: Signer<'info>,

    /// `init`, never `init_if_needed`: an open at the address of a live session fails (S12).
    #[account(
        init,
        payer = rent_payer,
        space = Session::SIZE,
        seeds = [SESSION_SEED, authority.key().as_ref(), &seed.to_le_bytes()],
        bump,
    )]
    pub session: Account<'info, Session>,

    pub mint: Account<'info, Mint>,

    /// Exactly the associated token account of the session for the mint (S6, S7).
    #[account(
        address = get_associated_token_address(&session.key(), &mint.key()) @ StintError::AccountMismatch,
    )]
    pub vault: Account<'info, TokenAccount>,

    /// CHECK: the seller's wallet, stored as the payout owner. Payouts go to its associated token
    /// account, which `close` derives and checks.
    pub receiver: UncheckedAccount<'info>,

    /// CHECK: the seller's gate key, stored. It signs closes; it never receives funds.
    pub receiver_authorizer: UncheckedAccount<'info>,

    /// CHECK: the wallet whose associated token account receives refunds, stored.
    pub refund_owner: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn open_handler(
    ctx: Context<Open>,
    seed: u64,
    rate: u64,
    min_seconds: u32,
    max_seconds: u32,
) -> Result<()> {
    require!(rate > 0, StintError::InvalidTerms);
    require!(min_seconds > 0 && min_seconds <= max_seconds, StintError::InvalidTerms);

    let session_key = ctx.accounts.session.key();
    // A payout account equal to the vault could never be emptied, so the vault could never close.
    require_keys_neq!(ctx.accounts.receiver.key(), session_key, StintError::InvalidTerms);
    require_keys_neq!(ctx.accounts.refund_owner.key(), session_key, StintError::InvalidTerms);

    let deposited = ctx.accounts.vault.amount;
    require!(
        u128::from(deposited) >= maths::cost(rate, min_seconds),
        StintError::DepositTooSmall
    );
    require!(
        u128::from(deposited) <= maths::cost(rate, max_seconds),
        StintError::DepositTooLarge
    );

    let started_at = Clock::get()?.unix_timestamp;
    let paid_until = maths::paid_until(started_at, deposited, rate)?;
    let authority = ctx.accounts.authority.key();

    ctx.accounts.session.set_inner(Session {
        version: SESSION_VERSION,
        bump: ctx.bumps.session,
        authority,
        seed,
        mint: ctx.accounts.mint.key(),
        receiver: ctx.accounts.receiver.key(),
        receiver_authorizer: ctx.accounts.receiver_authorizer.key(),
        refund_owner: ctx.accounts.refund_owner.key(),
        rent_payer: ctx.accounts.rent_payer.key(),
        rate,
        min_seconds,
        max_seconds,
        started_at,
        deposited,
        claimed: 0,
    });

    emit_cpi!(Opened {
        session: session_key,
        authority,
        rate,
        min_seconds,
        max_seconds,
        deposited,
        started_at,
        paid_until,
    });
    Ok(())
}
```

Notes for the implementer:
- `#[instruction(seed: u64)]` must list a leading prefix of the handler's arguments, with the
  same types (Anchor 1.x checks this at compile time), so `seed` comes first.
- `emit_cpi!` refers to `ctx` by name: keep the parameter named `ctx`.
- The handler is named `open_handler`, not `handler`. `lib.rs` re-exports every instruction
  module with a glob, and two functions named `handler` would collide.
- The vault is declared after the session, so the session's address is known when the vault's
  `address` constraint runs.

Replace `programs/stint/src/lib.rs`:

```rust
use anchor_lang::prelude::*;

pub mod errors;
pub mod events;
pub mod instructions;
pub mod maths;
pub mod state;

use instructions::*;

declare_id!("5iCYPqLjCWw5KzQTU6NBUhR2hxg5SWGmS1ctUn3qESvr");

#[program]
pub mod stint {
    use super::*;

    pub fn open(ctx: Context<Open>, seed: u64, rate: u64, min_seconds: u32, max_seconds: u32) -> Result<()> {
        instructions::open::open_handler(ctx, seed, rate, min_seconds, max_seconds)
    }
}
```

- [ ] **Step 10: Build, regenerate the client and inspect the IDL**

Run: `anchor build && pnpm generate:client && cargo test -p stint`
Expected: the build succeeds, `packages/program-client/src/generated/instructions/open.ts` appears,
and the Rust tests pass.

Then, to see how the IDL describes the event accounts, run: `node -e 'const i=require("./target/idl/stint.json");console.log(JSON.stringify(i.instructions[0].accounts.map(a=>[a.name,!!a.address,!!a.pda]),null,0))'`
Record in the task's commit message body whether `event_authority` carries an address or a PDA.
The code below passes `eventAuthority` and `program` explicitly either way.

- [ ] **Step 11: Run the tests**

Run: `pnpm --filter @lxfoundry/stint-program-client test && pnpm typecheck`
Expected: PASS. A failure in `open.test.ts` is a program defect: fix `open.rs`, then rerun
`anchor build && pnpm generate:client` before the tests. If `getOpenInstruction`'s generated
input type has no `eventAuthority` or `program` (the IDL gave them fixed addresses), drop those
two inputs from the fixture's call; keep every other account.

- [ ] **Step 12: Commit**

```bash
git add programs/stint packages/program-client Cargo.lock pnpm-lock.yaml
git commit -m "Add the open instruction, its maths and its program tests"
```

---

### Task 2: The program's `Standard` close

**Files:**
- Create: `programs/stint/src/instructions/close.rs`
- Modify: `programs/stint/src/instructions/mod.rs`, `programs/stint/src/lib.rs`
- Regenerate: `packages/program-client/src/generated/`
- Modify: `packages/program-client/test/program/fixture.ts`
- Test: `packages/program-client/test/program/close.test.ts`

**Interfaces:**
- Consumes: Task 1's `open`, `maths`, `Fixture`.
- Produces:
  - instruction `close(kind: CloseKind)` with accounts, in order: `closer` (signer), `session`
    (writable), `vault` (writable), `receiver_token` (writable), `refund_to` (writable),
    `rent_payer` (writable), `token_program`, then `event_authority` and `program`;
  - generated `getCloseInstruction`, `parseCloseInstruction`, `CloseKind`;
  - `Fixture.close(options): Promise<Sent>`.

- [ ] **Step 1: Write the failing close tests**

Add to `packages/program-client/test/program/fixture.ts` (and import `getCloseInstruction`,
`CloseKind` and `getSessionDecoder` from `../../src/index.js`):

```ts
export interface CloseOptions {
  readonly session: Address;
  readonly closer: KeyPairSigner;
  readonly kind?: CloseKind;
  readonly vault?: Address;
  readonly receiverToken?: Address;
  readonly refundTo?: Address;
  readonly rentPayer?: Address;
}
```

and the method:

```ts
  /** `close`, with each account derived from the stored session unless overridden. */
  async close(options: CloseOptions): Promise<Sent> {
    const account = this.svm.getAccount(options.session);
    if (!account.exists) throw new Error(`no session at ${options.session}`);
    const stored = getSessionDecoder().decode(account.data);
    const instruction = getCloseInstruction({
      closer: options.closer,
      session: options.session,
      vault: options.vault ?? (await this.ata(options.session)),
      receiverToken: options.receiverToken ?? (await this.ata(stored.receiver)),
      refundTo: options.refundTo ?? (await this.ata(stored.refundOwner)),
      rentPayer: options.rentPayer ?? stored.rentPayer,
      ...(await eventAccounts()),
      kind: options.kind ?? CloseKind.Standard,
    });
    return this.send([instruction]);
  }
```

Create `packages/program-client/test/program/close.test.ts`:

```ts
import { generateKeyPairSigner } from "@solana/kit";
import { getTransferCheckedInstruction } from "@solana-program/token";
import { beforeEach, describe, expect, it } from "vitest";
import {
  CloseKind,
  STINT_ERROR__ACCOUNT_MISMATCH,
  STINT_ERROR__INVALID_TERMS,
  STINT_ERROR__UNAUTHORIZED,
  findClosedEvent,
} from "../../src/index.js";
import { DECIMALS, Fixture, type Wallet } from "./fixture.js";

describe("close (Standard)", () => {
  let fixture: Fixture;
  let buyer: Wallet;
  let startedAt: bigint;

  beforeEach(async () => {
    fixture = await Fixture.create();
    buyer = await fixture.wallet(1_000_000n);
    startedAt = fixture.now();
  });

  /** Opens 30 s at 1,000 per second (minimum 5 s), then moves the clock `seconds` forward. */
  async function openAndWait(seconds: bigint) {
    const opened = await fixture.open({ authority: buyer, deposit: 30_000n });
    expect(opened.sent.ok, opened.sent.logs.join("\n")).toBe(true);
    fixture.setNow(startedAt + seconds);
    return opened;
  }

  it("by the authority before paid_until: pays the elapsed time and refunds the rest", async () => {
    const { session, vault } = await openAndWait(8n);
    const buyerBefore = fixture.tokenAmount(buyer.token)!;
    const rentBefore = fixture.lamportsOf(fixture.rentPayer.address);
    const deposits = fixture.lamportsOf(session) + fixture.lamportsOf(vault);

    const sent = await fixture.close({ session, closer: buyer.signer });
    expect(sent.ok, sent.logs.join("\n")).toBe(true);

    expect(fixture.tokenAmount(fixture.seller.token)).toBe(8_000n);
    expect(fixture.tokenAmount(buyer.token)! - buyerBefore).toBe(22_000n);
    expect(fixture.exists(session)).toBe(false);
    expect(fixture.exists(vault)).toBe(false);
    expect(fixture.lamportsOf(fixture.rentPayer.address) - rentBefore).toBe(deposits);
    expect(findClosedEvent(sent.inner)).toMatchObject({
      session,
      kind: CloseKind.Standard,
      claimed: 0n,
      owed: 8_000n,
      refunded: 22_000n,
      redirected: 0n,
      closedBy: buyer.signer.address,
      paidUntil: startedAt + 30n,
      at: startedAt + 8n,
    });
  });

  it("charges minSeconds when closed before it", async () => {
    const { session } = await openAndWait(2n);
    const sent = await fixture.close({ session, closer: buyer.signer });
    expect(findClosedEvent(sent.inner)?.owed).toBe(5_000n);
  });

  it("charges minSeconds when the clock is behind started_at", async () => {
    const { session } = await openAndWait(0n);
    fixture.setNow(startedAt - 100n);
    const sent = await fixture.close({ session, closer: buyer.signer });
    expect(findClosedEvent(sent.inner)?.owed).toBe(5_000n);
  });

  it("may be signed by the receiver authorizer before paid_until", async () => {
    const { session } = await openAndWait(8n);
    const sent = await fixture.close({ session, closer: fixture.receiverAuthorizer });
    expect(sent.ok).toBe(true);
    expect(findClosedEvent(sent.inner)?.closedBy).toBe(fixture.receiverAuthorizer.address);
  });

  it("refuses any other key before paid_until", async () => {
    const { session } = await openAndWait(8n);
    const stranger = await generateKeyPairSigner();
    const sent = await fixture.close({ session, closer: stranger });
    expect(sent.errorCode).toBe(STINT_ERROR__UNAUTHORIZED);
  });

  it("accepts any key from paid_until on, and charges the whole deposit", async () => {
    const { session } = await openAndWait(30n);
    const stranger = await generateKeyPairSigner();
    const sent = await fixture.close({ session, closer: stranger });
    expect(sent.ok, sent.logs.join("\n")).toBe(true);
    expect(findClosedEvent(sent.inner)).toMatchObject({ owed: 30_000n, refunded: 0n });
  });

  it("refunds tokens that reached the vault without being credited", async () => {
    const { session, vault } = await openAndWait(8n);
    await fixture.send([
      getTransferCheckedInstruction({
        source: buyer.token,
        mint: fixture.mint,
        destination: vault,
        authority: buyer.signer,
        amount: 500n,
        decimals: DECIMALS,
      }),
    ]);
    const sent = await fixture.close({ session, closer: buyer.signer });
    expect(findClosedEvent(sent.inner)).toMatchObject({ owed: 8_000n, refunded: 22_500n });
  });

  it.each(["vault", "receiverToken", "refundTo", "rentPayer"] as const)(
    "refuses a substituted %s with AccountMismatch (S2)",
    async (field) => {
      const { session } = await openAndWait(8n);
      const other = await fixture.wallet(0n);
      const impostor = field === "rentPayer" ? other.signer.address : other.token;
      const sent = await fixture.close({ session, closer: buyer.signer, [field]: impostor });
      expect(sent.errorCode).toBe(STINT_ERROR__ACCOUNT_MISMATCH);
    },
  );

  it.each([CloseKind.AtExpiry, CloseKind.WaiveMinimum])("does not support kind %s yet", async (kind) => {
    const { session } = await openAndWait(30n);
    const sent = await fixture.close({ session, closer: fixture.receiverAuthorizer, kind });
    expect(sent.errorCode).toBe(STINT_ERROR__INVALID_TERMS);
  });
});
```

The stranger needs no SOL: the fixture's payer pays every fee. For the vault, `other.token` is a
token account of the right mint that is not the session's associated one, the case the check
exists for.

Run: `pnpm --filter @lxfoundry/stint-program-client test`
Expected: FAIL: `getCloseInstruction` is not exported yet.

- [ ] **Step 2: Write the instruction**

Create `programs/stint/src/instructions/close.rs`:

```rust
use anchor_lang::prelude::*;
use anchor_spl::associated_token::get_associated_token_address;
use anchor_spl::token::{self, CloseAccount, Token, TokenAccount, Transfer};

use crate::errors::StintError;
use crate::events::{CloseKind, Closed};
use crate::maths;
use crate::state::{Session, SESSION_SEED};

/// Closes a session (spec section 4.3): pays what is owed, refunds the rest, and returns the rent.
#[event_cpi]
#[derive(Accounts)]
pub struct Close<'info> {
    pub closer: Signer<'info>,

    #[account(mut, close = rent_payer)]
    pub session: Account<'info, Session>,

    #[account(
        mut,
        address = get_associated_token_address(&session.key(), &session.mint) @ StintError::AccountMismatch,
    )]
    pub vault: Account<'info, TokenAccount>,

    /// CHECK: the receiver's associated token account. Unchecked so that a closed account arrives as
    /// a System-owned one (S12); SPL Token validates it whenever a non-zero amount moves.
    #[account(
        mut,
        address = get_associated_token_address(&session.receiver, &session.mint) @ StintError::AccountMismatch,
    )]
    pub receiver_token: UncheckedAccount<'info>,

    /// CHECK: the refund owner's associated token account; unchecked for the same reason.
    #[account(
        mut,
        address = get_associated_token_address(&session.refund_owner, &session.mint) @ StintError::AccountMismatch,
    )]
    pub refund_to: UncheckedAccount<'info>,

    /// CHECK: receives the rent deposits; must be the stored rent payer.
    #[account(mut, address = session.rent_payer @ StintError::AccountMismatch)]
    pub rent_payer: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
}

pub fn close_handler(ctx: Context<Close>, kind: CloseKind) -> Result<()> {
    // Only `Standard` is supported so far; the other kinds are refused rather than guessed at.
    require!(kind == CloseKind::Standard, StintError::InvalidTerms);

    let now = Clock::get()?.unix_timestamp;
    let session = &ctx.accounts.session;
    let paid_until = maths::paid_until(session.started_at, session.deposited, session.rate)?;
    let closer = ctx.accounts.closer.key();
    if now < paid_until {
        require!(
            closer == session.authority || closer == session.receiver_authorizer,
            StintError::Unauthorized
        );
    }

    let elapsed = maths::elapsed(session.started_at, paid_until, now);
    let charged = maths::charged(session.min_seconds, elapsed, false);
    let due = maths::due(session.deposited, session.rate, charged);
    let owed = maths::owed(session.claimed, due);
    let refunded = ctx
        .accounts
        .vault
        .amount
        .checked_sub(owed)
        .ok_or_else(|| error!(StintError::MathOverflow))?;

    let authority = session.authority;
    let seed = session.seed.to_le_bytes();
    let bump = [session.bump];
    let signer_seeds: &[&[&[u8]]] = &[&[SESSION_SEED, authority.as_ref(), &seed, &bump]];
    let token_program = ctx.accounts.token_program.key();

    // A transfer of zero is skipped: its destination need not exist (spec section 4.3).
    for (amount, destination) in [
        (owed, ctx.accounts.receiver_token.to_account_info()),
        (refunded, ctx.accounts.refund_to.to_account_info()),
    ] {
        if amount > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    token_program,
                    Transfer {
                        from: ctx.accounts.vault.to_account_info(),
                        to: destination,
                        authority: ctx.accounts.session.to_account_info(),
                    },
                    signer_seeds,
                ),
                amount,
            )?;
        }
    }

    token::close_account(CpiContext::new_with_signer(
        token_program,
        CloseAccount {
            account: ctx.accounts.vault.to_account_info(),
            destination: ctx.accounts.rent_payer.to_account_info(),
            authority: ctx.accounts.session.to_account_info(),
        },
        signer_seeds,
    ))?;

    let claimed = ctx.accounts.session.claimed;
    emit_cpi!(Closed {
        session: ctx.accounts.session.key(),
        kind,
        claimed,
        owed,
        refunded,
        redirected: 0,
        closed_by: closer,
        paid_until,
        at: now,
    });
    Ok(())
}
```

`token::transfer` moves the vault's balance after its last credit, so `vault.amount` read before the
transfers is the balance being distributed. The session account itself is closed by `close =
rent_payer` when the instruction returns.

Update `programs/stint/src/instructions/mod.rs`:

```rust
pub mod close;
pub mod open;

pub use close::*;
pub use open::*;
```

Add to the `stint` module in `programs/stint/src/lib.rs`, and import `crate::events::CloseKind` at
the top (`use events::CloseKind;`):

```rust
    pub fn close(ctx: Context<Close>, kind: CloseKind) -> Result<()> {
        instructions::close::close_handler(ctx, kind)
    }
```

- [ ] **Step 3: Build, regenerate and run the tests**

Run: `anchor build && pnpm generate:client && cargo test -p stint && pnpm --filter @lxfoundry/stint-program-client test`
Expected: PASS, the open and close tests together.

- [ ] **Step 4: Commit**

```bash
git add programs/stint packages/program-client
git commit -m "Add the Standard close: pay the elapsed time, refund the rest, return the rent"
```

---
### Task 3: The runner, ready for implemented scenarios

**Files:**
- Modify: `conformance/src/runner.ts`, `conformance/src/report.ts`, `conformance/src/index.ts`
- Test: `conformance/test/runner.test.ts`, `conformance/test/report.test.ts`

**Interfaces:**
- Consumes: stage 0's runner and report.
- Produces: `describeError(error: unknown): string`; `runScenarios` throws
  `Error("Duplicate scenario id N")` before running anything when two scenarios share an ID; report
  rows and error lines stay on one line whatever the title or error contains.

- [ ] **Step 1: Write the failing tests**

Append to `conformance/test/runner.test.ts` (and import `describeError` and the
`ScenarioContext` type):

```ts
describe("runScenarios, with implemented scenarios", () => {
  it("refuses duplicate scenario ids before running any", async () => {
    let ran = false;
    const run = async () => {
      ran = true;
    };
    await expect(runScenarios([scenario({ run }), scenario({ run })], local, context(local))).rejects.toThrow(
      "Duplicate scenario id 1",
    );
    expect(ran).toBe(false);
  });

  it("measures each scenario's duration with the injected clock", async () => {
    const ticks = [100, 350];
    const [outcome] = await runScenarios([scenario({ run: passes })], local, context(local), () => ticks.shift()!);
    expect(outcome?.durationMs).toBe(250);
  });

  it("passes each scenario the context made for it", async () => {
    const seen: string[] = [];
    const makeContext = (s: Scenario) => ({ ...context(local)(), target: s.id === 1 ? local : external });
    const run = async (ctx: ScenarioContext) => {
      seen.push(ctx.target.name);
    };
    await runScenarios([scenario({ id: 2, run }), scenario({ id: 1, run })], local, makeContext);
    expect(seen).toEqual(["local", "external"]);
  });
});

describe("describeError", () => {
  it("gives an error's message and its causes", () => {
    const error = new Error("settle failed", { cause: new Error("connection refused") });
    expect(describeError(error)).toBe("settle failed (cause: connection refused)");
  });

  it("describes thrown values that are not errors", () => {
    expect(describeError("plain")).toBe("plain");
    expect(describeError({ code: 7, amount: 5n })).toBe('{"code":7,"amount":"5"}');
    expect(describeError(undefined)).toBe("undefined");
  });
});
```

Append to `conformance/test/report.test.ts` (and import `writeReport`, `mkdtempSync`,
`readFileSync`, `tmpdir`, `join`):

```ts
  it("keeps each row and each error on one line", () => {
    const report = renderReport([
      outcome({ title: "two\nlines", status: "required", result: "fail", error: "first\n  second | third" }),
    ]);
    expect(report).toContain("| 1. two lines | local |");
    expect(report).toContain("- 1. two lines: first second \\| third");
  });

  it("writes report.md and report.json", () => {
    const directory = mkdtempSync(join(tmpdir(), "stint-report-"));
    writeReport(directory, [outcome({})]);
    expect(readFileSync(join(directory, "report.md"), "utf8")).toContain("| 1. Open, connect, close early |");
    expect(JSON.parse(readFileSync(join(directory, "report.json"), "utf8"))).toHaveLength(1);
  });
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @lxfoundry/stint-conformance test`
Expected: FAIL: `describeError` is not exported, duplicates run twice, line breaks reach the table.

- [ ] **Step 3: Implement**

In `conformance/src/runner.ts`, add:

```ts
/** One line describing anything thrown: an error's message with its causes, or the value itself. */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    const cause = error.cause === undefined ? "" : ` (cause: ${describeError(error.cause)})`;
    return `${error.message || error.name}${cause}`;
  }
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error, (_, value) => (typeof value === "bigint" ? value.toString() : value)) ?? String(error);
  } catch {
    return String(error);
  }
}
```

At the start of `runScenarios`, before the loop:

```ts
  const ids = new Set<number>();
  for (const scenario of scenarios) {
    if (ids.has(scenario.id)) throw new Error(`Duplicate scenario id ${scenario.id}`);
    ids.add(scenario.id);
  }
```

and in its `catch`, replace `error: error instanceof Error ? error.message : String(error),` with
`error: describeError(error),`.

In `conformance/src/report.ts`, replace `escapeCell` and use it for the error lines:

```ts
const oneLine = (text: string) => text.replaceAll(/\s*\r?\n\s*/g, " ");
const escapeCell = (text: string) => oneLine(text).replaceAll("|", "\\|");
```

```ts
    .map((o) => `- ${o.id}. ${escapeCell(o.title)}: ${escapeCell(o.error ?? "")}`);
```

Export `describeError` from `conformance/src/index.ts`:
`export { describeError, exitCodeFor, runScenarios } from "./runner.js";`

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @lxfoundry/stint-conformance test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add conformance
git commit -m "Describe any thrown value, keep report lines whole, refuse duplicate scenario ids"
```

---

### Task 4: The scheme package: offers, wire format and session tokens

**Files:**
- Create: `packages/x402/package.json`, `packages/x402/tsconfig.json`,
  `packages/x402/src/{index,constants,types,offer,wire,token}.ts`
- Test: `packages/x402/test/{fixtures.ts,offer.test.ts,wire.test.ts,token.test.ts}`

**Interfaces:**
- Consumes: `@x402/core/types` and `@x402/core/http`; `STINT_PROGRAM_ADDRESS`.
- Produces (all exported from `@lxfoundry/stint-x402`):
  - constants `SCHEME = "elapsed"`, `X402_VERSION = 2`, `SOLANA_DEVNET`, `SOLANA_MAINNET`,
    `USDC_DEVNET: { mint: Address; decimals: 6 }`, `HEADERS`;
  - types `ElapsedExtra`, `ElapsedRequirements`, `Terms`, `SellerTerms`, `FacilitatorExtra`,
    `OpenPayload`, `ClosePayload`, `ElapsedPayload`, `InvalidReason`, `Check<T>`, and the
    re-exported x402 types `PaymentRequirements`, `PaymentRequired`, `PaymentPayload`,
    `VerifyResponse`, `SettleResponse`, `SupportedResponse`, `Network`;
  - `refuse(reason, message)`;
  - `amountFor(rate: bigint, seconds: number): bigint`;
  - `buildOpenOffer(input: OfferInput): ElapsedRequirements`;
  - `buildCloseRequirements(input: CloseRequirementsInput): ElapsedRequirements`;
  - `checkOpenDuration(terms: Terms, seconds: number): DurationCheck`;
  - `readElapsedRequirements(value: unknown): ElapsedRequirements | undefined`;
  - `sameRequirements(a: unknown, b: unknown): boolean`;
  - `sellerTermsOf(requirements: ElapsedRequirements): SellerTerms`;
  - `readElapsedPayload(payload: PaymentPayload): ElapsedPayload | undefined`;
  - the six `encode…Header` and `decode…Header` functions of `@x402/core/http`;
  - `createSessionToken(signer, claims, options?): Promise<string>`;
  - `verifySessionToken(token, expected): Promise<TokenCheck>`.

- [ ] **Step 1: Create the package**

Create `packages/x402/package.json`:

```json
{
  "name": "@lxfoundry/stint-x402",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "typecheck": "tsc -p tsconfig.json",
    "test": "vitest run"
  },
  "dependencies": {
    "@lxfoundry/stint-program-client": "workspace:*",
    "@solana-program/compute-budget": "0.20.0",
    "@solana-program/token": "0.18.0",
    "@solana/kit": "8.5.0",
    "@x402/core": "2.28.0"
  }
}
```

Create `packages/x402/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src", "test"]
}
```

Run: `pnpm install`

Create `packages/x402/src/constants.ts`:

```ts
import { address } from "@solana/kit";

export const SCHEME = "elapsed";
export const X402_VERSION = 2;

/** CAIP-2 network identifiers (spec §5.1). The local target uses devnet's (spec §12.3). */
export const SOLANA_DEVNET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
export const SOLANA_MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";

/** Devnet USDC (spec §3.4). */
export const USDC_DEVNET = { mint: address("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"), decimals: 6 } as const;

/** The x402 v2 HTTP headers. Node lower-cases incoming header names. */
export const HEADERS = {
  paymentRequired: "PAYMENT-REQUIRED",
  paymentSignature: "PAYMENT-SIGNATURE",
  paymentResponse: "PAYMENT-RESPONSE",
} as const;
```

Create `packages/x402/src/types.ts`:

```ts
import type { Address } from "@solana/kit";
import type { PaymentRequirements } from "@x402/core/types";

export type {
  Network,
  PaymentPayload,
  PaymentRequired,
  PaymentRequirements,
  SettleResponse,
  SupportedResponse,
  VerifyResponse,
} from "@x402/core/types";

export type ElapsedAction = "open" | "topUp" | "close";

/** `extra` of an `elapsed` entry (spec §5.1): `u64` values as decimal strings, `u32` as numbers. */
export interface ElapsedExtra {
  readonly paymentFlow: "escrow";
  readonly action: ElapsedAction;
  /** Set for `topUp` and `close`. */
  readonly session?: string;
  readonly programId: string;
  readonly rate: string;
  readonly seconds: number;
  readonly minSeconds: number;
  readonly maxSeconds: number;
  readonly receiverAuthorizer: string;
  readonly feePayer: string;
  readonly rentPayer: string;
  readonly closeUrl: string;
  readonly recentBlockhash: string;
  readonly lastValidBlockHeight: string;
  readonly idleCloseSeconds: number;
  readonly closeOnOutage: boolean;
}

export type ElapsedRequirements = PaymentRequirements & {
  readonly scheme: "elapsed";
  readonly extra: ElapsedExtra & Record<string, unknown>;
};

/** A resource's terms (spec §4.1): rate in base units per second. */
export interface Terms {
  readonly rate: bigint;
  readonly minSeconds: number;
  readonly maxSeconds: number;
}

/** Everything a session must match to be served by a seller (spec §7.2, check 4). */
export interface SellerTerms {
  readonly programId: Address;
  readonly asset: Address;
  readonly payTo: Address;
  readonly receiverAuthorizer: Address;
  readonly terms: Terms;
}

/** What a facilitator publishes in `/supported` (spec §6.1). */
export interface FacilitatorExtra {
  readonly feePayer: string;
  readonly rentPayer: string;
  readonly programId: string;
  readonly closeUrl: string;
}

export interface OpenPayload {
  readonly type: "open";
  readonly transaction: string;
  /** Informative: the facilitator derives the address itself (spec §5.3). */
  readonly session: string;
}

export interface ClosePayload {
  readonly type: "close";
  readonly transaction: string;
}

export type ElapsedPayload = OpenPayload | ClosePayload;

/** Refusal reasons (spec §5.4). */
export type InvalidReason =
  | "invalid_x402_version"
  | "invalid_payload"
  | "invalid_payment_requirements"
  | "invalid_terms"
  | "invalid_amount"
  | "unexpected_instruction"
  | "payer_misuse"
  | "blockhash_expired"
  | "session_expired"
  | "simulation_failed"
  | "unknown_session"
  | "already_processed";

export type Check<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: InvalidReason; readonly message: string };

export const refuse = (reason: InvalidReason, message: string) => ({ ok: false, reason, message }) as const;
```

- [ ] **Step 2: Write the failing offer and wire tests**

Create `packages/x402/test/fixtures.ts`, the offer input every test starts from (the facilitator
keys are placeholders: sysvar addresses, valid but owned by nobody):

```ts
import { address } from "@solana/kit";
import type { OfferInput } from "../src/index.js";

export function offerInput(overrides: Partial<OfferInput> = {}): OfferInput {
  return {
    network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
    asset: address("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"),
    payTo: address("9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin"),
    receiverAuthorizer: address("Hq8i9ZoCdUuY6bEcUd5V2nhZqGPAiyxS5fTuQUe3tGLL"),
    terms: { rate: 1_000n, minSeconds: 5, maxSeconds: 120 },
    seconds: 30,
    facilitator: {
      feePayer: "SysvarC1ock11111111111111111111111111111111",
      rentPayer: "SysvarRent111111111111111111111111111111111",
      programId: "5iCYPqLjCWw5KzQTU6NBUhR2hxg5SWGmS1ctUn3qESvr",
      closeUrl: "http://127.0.0.1:4021/close",
    },
    lifetime: { blockhash: "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N", lastValidBlockHeight: 1_234n },
    maxTimeoutSeconds: 60,
    idleCloseSeconds: 10,
    closeOnOutage: true,
    ...overrides,
  };
}
```

Create `packages/x402/test/offer.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  amountFor,
  buildCloseRequirements,
  buildOpenOffer,
  checkOpenDuration,
  readElapsedRequirements,
  sameRequirements,
  sellerTermsOf,
} from "../src/index.js";
import { offerInput } from "./fixtures.js";

const input = offerInput();

describe("offers", () => {
  it("quotes the exact deposit, rate × seconds, as a decimal string (spec §5.1)", () => {
    expect(amountFor(1_000n, 30)).toBe(30_000n);
    const offer = buildOpenOffer(input);
    expect(offer).toEqual({
      scheme: "elapsed",
      network: input.network,
      amount: "30000",
      asset: input.asset,
      payTo: input.payTo,
      maxTimeoutSeconds: 60,
      extra: {
        paymentFlow: "escrow",
        action: "open",
        programId: input.facilitator.programId,
        rate: "1000",
        seconds: 30,
        minSeconds: 5,
        maxSeconds: 120,
        receiverAuthorizer: input.receiverAuthorizer,
        feePayer: input.facilitator.feePayer,
        rentPayer: input.facilitator.rentPayer,
        closeUrl: input.facilitator.closeUrl,
        recentBlockhash: input.lifetime.blockhash,
        lastValidBlockHeight: "1234",
        idleCloseSeconds: 10,
        closeOnOutage: true,
      },
    });
  });

  it("builds a close's requirements: amount 0, action close, the session set (spec §5.5)", () => {
    const { seconds: _, ...rest } = input;
    const requirements = buildCloseRequirements({ ...rest, session: input.payTo });
    expect(requirements.amount).toBe("0");
    expect(requirements.extra.action).toBe("close");
    expect(requirements.extra.session).toBe(input.payTo);
  });

  it("accepts open durations from minSeconds to maxSeconds only (spec §5.2)", () => {
    const terms = input.terms;
    expect(checkOpenDuration(terms, 5)).toEqual({ ok: true });
    expect(checkOpenDuration(terms, 120)).toEqual({ ok: true });
    for (const seconds of [4, 121, 7.5, Number.NaN]) {
      expect(checkOpenDuration(terms, seconds)).toEqual({ ok: false, minSeconds: 5, maxSeconds: 120 });
    }
  });

  it("reads an elapsed entry back, and rejects malformed ones", () => {
    const offer = buildOpenOffer(input);
    expect(readElapsedRequirements(JSON.parse(JSON.stringify(offer)))).toEqual(offer);
    expect(readElapsedRequirements({ ...offer, scheme: "exact" })).toBeUndefined();
    expect(readElapsedRequirements({ ...offer, extra: { ...offer.extra, rate: 1000 } })).toBeUndefined();
    expect(readElapsedRequirements({ ...offer, extra: { ...offer.extra, paymentFlow: "upfront" } })).toBeUndefined();
  });

  it("compares requirements by value, whatever the key order", () => {
    const offer = buildOpenOffer(input);
    const reordered = JSON.parse(JSON.stringify({ extra: offer.extra, ...offer }));
    expect(sameRequirements(offer, reordered)).toBe(true);
    expect(sameRequirements(offer, { ...offer, amount: "30001" })).toBe(false);
  });

  it("extracts the seller's terms", () => {
    expect(sellerTermsOf(buildOpenOffer(input))).toEqual({
      programId: input.facilitator.programId,
      asset: input.asset,
      payTo: input.payTo,
      receiverAuthorizer: input.receiverAuthorizer,
      terms: input.terms,
    });
  });
});
```

Create `packages/x402/test/wire.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  buildOpenOffer,
  decodePaymentRequiredHeader,
  encodePaymentRequiredHeader,
  readElapsedPayload,
  type PaymentPayload,
} from "../src/index.js";
import { offerInput } from "./fixtures.js";

const input = offerInput();

describe("wire format", () => {
  it("round-trips a 402 through the PAYMENT-REQUIRED header", () => {
    const required = { x402Version: 2, resource: { url: "http://127.0.0.1:1/sessions" }, accepts: [buildOpenOffer(input)] };
    expect(decodePaymentRequiredHeader(encodePaymentRequiredHeader(required))).toEqual(required);
  });

  it("reads open and close payloads, and nothing else", () => {
    const base = { x402Version: 2, accepted: buildOpenOffer(input) } as const;
    const open: PaymentPayload = { ...base, payload: { type: "open", transaction: "AQ==", session: "x" } };
    expect(readElapsedPayload(open)).toEqual({ type: "open", transaction: "AQ==", session: "x" });
    expect(readElapsedPayload({ ...base, payload: { type: "close", transaction: "AQ==" } })).toEqual({
      type: "close",
      transaction: "AQ==",
    });
    expect(readElapsedPayload({ ...base, payload: { type: "open", transaction: 1 } })).toBeUndefined();
    expect(readElapsedPayload({ ...base, payload: { type: "topUp", transaction: "AQ==" } })).toBeUndefined();
  });
});
```

Run: `pnpm --filter @lxfoundry/stint-x402 test`
Expected: FAIL: `../src/index.js` does not exist.

- [ ] **Step 3: Implement offers and the wire format**

Create `packages/x402/src/offer.ts`:

```ts
import { address, type Address } from "@solana/kit";
import { SCHEME } from "./constants.js";
import type { ElapsedExtra, ElapsedRequirements, FacilitatorExtra, Network, SellerTerms, Terms } from "./types.js";

export interface OfferInput {
  readonly network: string;
  readonly asset: Address;
  readonly payTo: Address;
  readonly receiverAuthorizer: Address;
  readonly terms: Terms;
  readonly seconds: number;
  readonly facilitator: FacilitatorExtra;
  readonly lifetime: { readonly blockhash: string; readonly lastValidBlockHeight: bigint };
  readonly maxTimeoutSeconds: number;
  readonly idleCloseSeconds: number;
  readonly closeOnOutage: boolean;
}

export type CloseRequirementsInput = Omit<OfferInput, "seconds"> & { readonly session: Address };

/** The exact deposit for a duration: `rate × seconds` (spec §5.1). */
export function amountFor(rate: bigint, seconds: number): bigint {
  return rate * BigInt(seconds);
}

function build(input: Omit<OfferInput, "seconds">, seconds: number, amount: bigint, action: ElapsedExtra["action"], session?: Address): ElapsedRequirements {
  return {
    scheme: SCHEME,
    network: input.network as Network,
    amount: amount.toString(),
    asset: input.asset,
    payTo: input.payTo,
    maxTimeoutSeconds: input.maxTimeoutSeconds,
    extra: {
      paymentFlow: "escrow",
      action,
      ...(session === undefined ? {} : { session }),
      programId: input.facilitator.programId,
      rate: input.terms.rate.toString(),
      seconds,
      minSeconds: input.terms.minSeconds,
      maxSeconds: input.terms.maxSeconds,
      receiverAuthorizer: input.receiverAuthorizer,
      feePayer: input.facilitator.feePayer,
      rentPayer: input.facilitator.rentPayer,
      closeUrl: input.facilitator.closeUrl,
      recentBlockhash: input.lifetime.blockhash,
      lastValidBlockHeight: input.lifetime.lastValidBlockHeight.toString(),
      idleCloseSeconds: input.idleCloseSeconds,
      closeOnOutage: input.closeOnOutage,
    },
  };
}

/** One `accepts` entry for an open of `seconds` (spec §5.1). */
export function buildOpenOffer(input: OfferInput): ElapsedRequirements {
  return build(input, input.seconds, amountFor(input.terms.rate, input.seconds), "open");
}

/** The requirements a gate sends with a close: nothing deposited (spec §5.5). */
export function buildCloseRequirements(input: CloseRequirementsInput): ElapsedRequirements {
  return build(input, 0, 0n, "close", input.session);
}

export type DurationCheck = { readonly ok: true } | { readonly ok: false; readonly minSeconds: number; readonly maxSeconds: number };

/** Valid open durations: whole seconds from `minSeconds` to `maxSeconds` (spec §5.2). */
export function checkOpenDuration(terms: Terms, seconds: number): DurationCheck {
  return Number.isInteger(seconds) && seconds >= terms.minSeconds && seconds <= terms.maxSeconds
    ? { ok: true }
    : { ok: false, minSeconds: terms.minSeconds, maxSeconds: terms.maxSeconds };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isU64String = (value: unknown) => typeof value === "string" && /^(0|[1-9][0-9]{0,19})$/.test(value);
const isU32 = (value: unknown) => Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 0xffff_ffff;
const isText = (value: unknown) => typeof value === "string" && value.length > 0;

/** Returns the value as an `elapsed` entry if it has every field of spec §5.1 with its encoding. */
export function readElapsedRequirements(value: unknown): ElapsedRequirements | undefined {
  if (!isRecord(value) || value.scheme !== SCHEME || !isRecord(value.extra)) return undefined;
  const extra = value.extra;
  const valid =
    isText(value.network) &&
    isU64String(value.amount) &&
    isText(value.asset) &&
    isText(value.payTo) &&
    Number.isInteger(value.maxTimeoutSeconds) &&
    extra.paymentFlow === "escrow" &&
    (extra.action === "open" || extra.action === "topUp" || extra.action === "close") &&
    (extra.session === undefined || isText(extra.session)) &&
    isText(extra.programId) &&
    isU64String(extra.rate) &&
    isU32(extra.seconds) &&
    isU32(extra.minSeconds) &&
    isU32(extra.maxSeconds) &&
    isText(extra.receiverAuthorizer) &&
    isText(extra.feePayer) &&
    isText(extra.rentPayer) &&
    isText(extra.closeUrl) &&
    isText(extra.recentBlockhash) &&
    isU64String(extra.lastValidBlockHeight) &&
    isU32(extra.idleCloseSeconds) &&
    typeof extra.closeOnOutage === "boolean";
  return valid ? (value as ElapsedRequirements) : undefined;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (isRecord(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

/** Requirements are equal when every field has the same value, whatever the key order. */
export function sameRequirements(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

export function sellerTermsOf(requirements: ElapsedRequirements): SellerTerms {
  const extra = requirements.extra;
  return {
    programId: address(extra.programId),
    asset: address(requirements.asset),
    payTo: address(requirements.payTo),
    receiverAuthorizer: address(extra.receiverAuthorizer),
    terms: { rate: BigInt(extra.rate), minSeconds: extra.minSeconds, maxSeconds: extra.maxSeconds },
  };
}
```

Create `packages/x402/src/wire.ts`:

```ts
import type { ElapsedPayload, PaymentPayload } from "./types.js";

export {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
  encodePaymentSignatureHeader,
} from "@x402/core/http";

/** The scheme-specific part of a payment payload (spec §5.3), or undefined if it is malformed. */
export function readElapsedPayload(payload: PaymentPayload): ElapsedPayload | undefined {
  const inner = payload.payload;
  if (typeof inner.transaction !== "string" || inner.transaction.length === 0) return undefined;
  if (inner.type === "open" && typeof inner.session === "string") {
    return { type: "open", transaction: inner.transaction, session: inner.session };
  }
  if (inner.type === "close") return { type: "close", transaction: inner.transaction };
  return undefined;
}
```

Create `packages/x402/src/index.ts`:

```ts
export * from "./constants.js";
export * from "./types.js";
export * from "./offer.js";
export * from "./wire.js";
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @lxfoundry/stint-x402 test`
Expected: PASS (offer and wire).

- [ ] **Step 5: Write the failing session-token tests**

Create `packages/x402/test/token.test.ts`:

```ts
import { generateKeyPairSigner, type KeyPairSigner } from "@solana/kit";
import { beforeAll, describe, expect, it } from "vitest";
import { createSessionToken, verifySessionToken } from "../src/index.js";

const session = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const audience = "http://127.0.0.1:4000";
const now = 1_800_000_000_000;

describe("session tokens (spec §7.2)", () => {
  let authority: KeyPairSigner;
  const expected = (overrides: object = {}) => ({
    authority: authority.address,
    session,
    audience,
    purpose: "connect" as const,
    nowMs: now,
    ...overrides,
  });

  beforeAll(async () => {
    authority = await generateKeyPairSigner();
  });

  it("verifies a token signed by the session's authority", async () => {
    const token = await createSessionToken(authority, { session, audience, purpose: "connect" }, { nowMs: now });
    const check = await verifySessionToken(token, expected());
    expect(check.ok).toBe(true);
    if (check.ok) expect(check.claims).toMatchObject({ sub: session, aud: audience, purpose: "connect" });
  });

  it("accepts the older EdDSA algorithm name", async () => {
    const token = await createSessionToken(authority, { session, audience, purpose: "connect" }, { nowMs: now, alg: "EdDSA" });
    expect((await verifySessionToken(token, expected())).ok).toBe(true);
  });

  it.each([
    ["another signer", async () => createSessionToken(await generateKeyPairSigner(), { session, audience, purpose: "connect" }, { nowMs: now })],
    ["another purpose", () => createSessionToken(authority, { session, audience, purpose: "close" }, { nowMs: now })],
    ["another audience", () => createSessionToken(authority, { session, audience: "http://other", purpose: "connect" }, { nowMs: now })],
    ["another session", () => createSessionToken(authority, { session: authority.address, audience, purpose: "connect" }, { nowMs: now })],
    ["an expired token", () => createSessionToken(authority, { session, audience, purpose: "connect" }, { nowMs: now - 200_000 })],
    ["a lifetime above 120 s", () => createSessionToken(authority, { session, audience, purpose: "connect" }, { nowMs: now, lifetimeSeconds: 121 })],
  ])("refuses %s", async (_, make) => {
    expect((await verifySessionToken(await make(), expected())).ok).toBe(false);
  });

  it("allows 30 s of clock skew on iat and exp", async () => {
    const ahead = await createSessionToken(authority, { session, audience, purpose: "connect" }, { nowMs: now + 25_000 });
    expect((await verifySessionToken(ahead, expected())).ok).toBe(true);
    const tooFar = await createSessionToken(authority, { session, audience, purpose: "connect" }, { nowMs: now + 40_000 });
    expect((await verifySessionToken(tooFar, expected())).ok).toBe(false);
  });

  it("refuses a malformed token", async () => {
    expect((await verifySessionToken("a.b", expected())).ok).toBe(false);
    expect((await verifySessionToken("a.b.c", expected())).ok).toBe(false);
  });
});
```

Run: `pnpm --filter @lxfoundry/stint-x402 test`
Expected: FAIL: `createSessionToken` is not exported.

- [ ] **Step 6: Implement session tokens**

Create `packages/x402/src/token.ts`:

```ts
import { randomUUID } from "node:crypto";
import {
  createSignableMessage,
  getPublicKeyFromAddress,
  verifySignature,
  type Address,
  type MessagePartialSigner,
  type SignatureBytes,
} from "@solana/kit";

export type TokenPurpose = "connect" | "close";

/** The claims of spec §7.2. Times are in seconds. */
export interface SessionTokenClaims {
  readonly sub: string;
  readonly aud: string;
  readonly purpose: TokenPurpose;
  readonly iat: number;
  readonly exp: number;
  readonly jti: string;
}

export interface TokenOptions {
  readonly nowMs?: number;
  /** At most 120 s (spec §7.2). Default 60. */
  readonly lifetimeSeconds?: number;
  /** Clients emit `Ed25519` (RFC 9864); `EdDSA` exists for testing the gate's acceptance of it. */
  readonly alg?: "Ed25519" | "EdDSA";
}

const MAX_LIFETIME_SECONDS = 120;
const SKEW_SECONDS = 30;
const encoder = new TextEncoder();
const base64url = (bytes: Uint8Array | string) => Buffer.from(bytes).toString("base64url");

/** A JWS signed by the session's authority over the raw signing input, with no envelope. */
export async function createSessionToken(
  signer: MessagePartialSigner,
  claims: { readonly session: string; readonly audience: string; readonly purpose: TokenPurpose },
  options: TokenOptions = {},
): Promise<string> {
  const iat = Math.floor((options.nowMs ?? Date.now()) / 1000);
  const payload: SessionTokenClaims = {
    sub: claims.session,
    aud: claims.audience,
    purpose: claims.purpose,
    iat,
    exp: iat + (options.lifetimeSeconds ?? 60),
    jti: randomUUID(),
  };
  const signingInput = `${base64url(JSON.stringify({ alg: options.alg ?? "Ed25519", typ: "JWT" }))}.${base64url(JSON.stringify(payload))}`;
  const [signatures] = await signer.signMessages([createSignableMessage(encoder.encode(signingInput))]);
  const signature = signatures?.[signer.address];
  if (!signature) throw new Error("The signer returned no signature");
  return `${signingInput}.${base64url(signature)}`;
}

export interface ExpectedToken {
  readonly authority: Address;
  readonly session: string;
  readonly audience: string;
  readonly purpose: TokenPurpose;
  /** The gate's token clock (spec §7.3). */
  readonly nowMs: number;
}

export type TokenCheck =
  | { readonly ok: true; readonly claims: SessionTokenClaims }
  | { readonly ok: false; readonly reason: string };

const fail = (reason: string): TokenCheck => ({ ok: false, reason });

function parseJson(segment: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** Checks 1 and 2 of spec §7.2: the signature, `sub`, `aud`, `purpose` and the times. */
export async function verifySessionToken(token: string, expected: ExpectedToken): Promise<TokenCheck> {
  const parts = token.split(".");
  if (parts.length !== 3) return fail("malformed");
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
  const header = parseJson(headerPart);
  const claims = parseJson(payloadPart);
  if (!header || !claims) return fail("malformed");
  if (header.alg !== "Ed25519" && header.alg !== "EdDSA") return fail("unsupported algorithm");

  const signature = Buffer.from(signaturePart, "base64url");
  if (signature.length !== 64) return fail("bad signature");
  const key = await getPublicKeyFromAddress(expected.authority);
  const signed = encoder.encode(`${headerPart}.${payloadPart}`);
  if (!(await verifySignature(key, Uint8Array.from(signature) as SignatureBytes, signed))) return fail("bad signature");

  const { sub, aud, purpose, iat, exp, jti } = claims;
  if (sub !== expected.session) return fail("wrong session");
  if (aud !== expected.audience) return fail("wrong audience");
  if (purpose !== expected.purpose) return fail("wrong purpose");
  if (typeof jti !== "string" || jti.length === 0) return fail("missing jti");
  if (!Number.isInteger(iat) || !Number.isInteger(exp)) return fail("missing times");
  const now = Math.floor(expected.nowMs / 1000);
  if ((exp as number) - (iat as number) > MAX_LIFETIME_SECONDS) return fail("lifetime too long");
  if ((iat as number) > now + SKEW_SECONDS) return fail("issued in the future");
  if ((exp as number) < now - SKEW_SECONDS) return fail("expired");
  return { ok: true, claims: claims as unknown as SessionTokenClaims };
}
```

Add `export * from "./token.js";` to `packages/x402/src/index.ts`.

- [ ] **Step 7: Run the tests**

Run: `pnpm --filter @lxfoundry/stint-x402 test && pnpm typecheck`
Expected: PASS. In the "expired" case, the token was issued 200 s before `now` with a 60 s
lifetime, so it expired 140 s ago, beyond the 30 s tolerance.

- [ ] **Step 8: Commit**

```bash
git add packages/x402 pnpm-lock.yaml
git commit -m "Add the elapsed scheme's offers, wire format and session tokens"
```

---

### Task 5: The scheme package: transactions, their checks, and chain reads

**Files:**
- Create: `packages/x402/src/{transactions,inspect,checks,chain}.ts`; modify `packages/x402/src/index.ts`
- Test: `packages/x402/test/checks.test.ts`, `packages/x402/test/rebuild.ts`

**Interfaces:**
- Consumes: Task 1 and 2's program client (`getOpenInstruction`, `getCloseInstruction`,
  `parseOpenInstruction`, `parseCloseInstruction`, `identifyStintInstruction`, `StintInstruction`,
  `findSessionPda`, `eventAccounts`, `findClosedEvent`, `Session`, `CloseKind`); Task 4's types.
- Produces:
  - `randomSeed(): bigint`;
  - `buildOpenTransaction(input: BuildOpenInput): Promise<BuiltOpen>`, where
    `BuiltOpen = { transaction: string; session: Address; seed: bigint }`;
  - `buildCloseTransaction(input: BuildCloseInput): Promise<string>` (base64, signed by the closer,
    the fee payer's slot left empty);
  - `inspectTransaction(wire: string): InspectedTransaction | undefined`;
  - `checkOpenTransaction(tx, requirements, keys): Promise<Check<OpenFacts>>`;
  - `checkCloseTransaction(tx, expected, keys): Check<CloseFacts>`;
  - `sessionMatches(session: Session, seller: SellerTerms): boolean`;
  - `fetchProgramInstructions(rpc, signature)`, `fetchClosedEvent(rpc, signature)`,
    `tokenBalanceChanges(rpc, signature)`, `waitForConfirmation(rpc, signature, blockhash, timeoutMs?)`.

- [ ] **Step 1: Write the failing tests**

Create `packages/x402/test/checks.test.ts`:

```ts
import {
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  partiallySignTransaction,
  type Address,
  type KeyPairSigner,
} from "@solana/kit";
import { getSetComputeUnitPriceInstruction } from "@solana-program/compute-budget";
import { beforeAll, describe, expect, it } from "vitest";
import { CloseKind, type Session } from "@lxfoundry/stint-program-client";
import {
  buildCloseTransaction,
  buildOpenOffer,
  buildOpenTransaction,
  checkCloseTransaction,
  checkOpenTransaction,
  inspectTransaction,
  sessionMatches,
  sellerTermsOf,
  type ElapsedRequirements,
} from "../src/index.js";
import { offerInput } from "./fixtures.js";
import { rebuild } from "./rebuild.js";

describe("open transactions (spec §5.3, §5.4)", () => {
  let buyer: KeyPairSigner;
  let feePayer: Address;
  let rentPayer: Address;
  let offer: ElapsedRequirements;

  beforeAll(async () => {
    buyer = await generateKeyPairSigner();
    feePayer = (await generateKeyPairSigner()).address;
    rentPayer = (await generateKeyPairSigner()).address;
    offer = buildOpenOffer(
      offerInput({ facilitator: { ...offerInput().facilitator, feePayer, rentPayer } }),
    );
  });

  const keys = () => ({ feePayer, rentPayer });

  it("builds what the facilitator accepts, signed by the authority only", async () => {
    const built = await buildOpenTransaction({ requirements: offer, authority: buyer, decimals: 6, seed: 42n });
    const tx = inspectTransaction(built.transaction)!;
    expect(tx.feePayer).toBe(feePayer);
    expect([...tx.signed]).toEqual([buyer.address]);
    const check = await checkOpenTransaction(tx, offer, keys());
    expect(check).toMatchObject({ ok: true, value: { session: built.session, authority: buyer.address, seed: 42n } });
  });

  it("refuses a deposit that is not exactly the amount", async () => {
    const built = await buildOpenTransaction({ requirements: { ...offer, amount: "29999" }, authority: buyer, decimals: 6 });
    const check = await checkOpenTransaction(inspectTransaction(built.transaction)!, offer, keys());
    expect(check).toMatchObject({ ok: false, reason: "invalid_amount" });
  });

  it("refuses terms that differ from the offer", async () => {
    const other = { ...offer, extra: { ...offer.extra, rate: "999", minSeconds: 1 } };
    const built = await buildOpenTransaction({ requirements: other, authority: buyer, decimals: 6 });
    const check = await checkOpenTransaction(inspectTransaction(built.transaction)!, offer, keys());
    expect(check).toMatchObject({ ok: false, reason: "invalid_terms" });
  });

  it("refuses the fee payer anywhere but as fee payer", async () => {
    const misplaced = { ...offer, extra: { ...offer.extra, rentPayer: feePayer } };
    const built = await buildOpenTransaction({ requirements: misplaced, authority: buyer, decimals: 6 });
    const check = await checkOpenTransaction(inspectTransaction(built.transaction)!, offer, keys());
    expect(check).toMatchObject({ ok: false, reason: "payer_misuse" });
  });

  it("refuses a priority fee, and an instruction outside the layout", async () => {
    const built = await buildOpenTransaction({ requirements: offer, authority: buyer, decimals: 6 });
    const withPrice = await rebuild(built.transaction, buyer, (ixs) => [getSetComputeUnitPriceInstruction({ microLamports: 1n }), ...ixs]);
    expect(await checkOpenTransaction(inspectTransaction(withPrice)!, offer, keys())).toMatchObject({ ok: false, reason: "unexpected_instruction" });
    const reversed = await rebuild(built.transaction, buyer, (ixs) => [...ixs].reverse());
    expect(await checkOpenTransaction(inspectTransaction(reversed)!, offer, keys())).toMatchObject({ ok: false, reason: "unexpected_instruction" });
  });

  it("refuses a transaction whose fee payer has already signed", async () => {
    const payer = await generateKeyPairSigner();
    const payerOffer = { ...offer, extra: { ...offer.extra, feePayer: payer.address } };
    const built = await buildOpenTransaction({ requirements: payerOffer, authority: buyer, decimals: 6 });
    const signed = await partiallySignTransaction([payer.keyPair], inspectTransaction(built.transaction)!.transaction);
    const check = await checkOpenTransaction(inspectTransaction(getBase64EncodedWireTransaction(signed))!, payerOffer, {
      feePayer: payer.address,
      rentPayer,
    });
    expect(check).toMatchObject({ ok: false, reason: "payer_misuse" });
  });

  it("returns undefined for bytes that are not a version 0 transaction", () => {
    expect(inspectTransaction("AQ==")).toBeUndefined();
  });
});

describe("close transactions (spec §5.3, §5.4)", () => {
  it("accepts a close signed by the expected closer, and nothing else", async () => {
    const closer = await generateKeyPairSigner();
    const authority = await generateKeyPairSigner();
    const feePayer = (await generateKeyPairSigner()).address;
    const rentPayer = (await generateKeyPairSigner()).address;
    const session = (await generateKeyPairSigner()).address;
    const stored = {
      authority: authority.address,
      mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU" as Address,
      receiver: (await generateKeyPairSigner()).address,
      refundOwner: authority.address,
      rentPayer,
    };
    const wire = await buildCloseTransaction({
      session,
      stored,
      closer,
      feePayer,
      lifetime: { blockhash: "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N", lastValidBlockHeight: 100n },
    });
    const tx = inspectTransaction(wire)!;
    expect(checkCloseTransaction(tx, { session, closer: closer.address }, { feePayer, rentPayer })).toMatchObject({
      ok: true,
      value: { kind: CloseKind.Standard },
    });
    expect(checkCloseTransaction(tx, { session, closer: authority.address }, { feePayer, rentPayer })).toMatchObject({
      ok: false,
      reason: "invalid_payload",
    });
    expect(checkCloseTransaction(tx, { session: closer.address, closer: closer.address }, { feePayer, rentPayer })).toMatchObject({
      ok: false,
      reason: "invalid_terms",
    });
  });
});

describe("sessionMatches (spec §7.2, check 4)", () => {
  it("requires the program's terms, the mint, the receiver and the receiver authorizer", () => {
    const seller = sellerTermsOf(buildOpenOffer(offerInput()));
    const session = {
      mint: seller.asset,
      receiver: seller.payTo,
      receiverAuthorizer: seller.receiverAuthorizer,
      rate: 1_000n,
      minSeconds: 5,
      maxSeconds: 120,
    } as Session;
    expect(sessionMatches(session, seller)).toBe(true);
    expect(sessionMatches({ ...session, mint: seller.payTo }, seller)).toBe(false);
    expect(sessionMatches({ ...session, rate: 999n }, seller)).toBe(false);
    expect(sessionMatches({ ...session, receiverAuthorizer: seller.payTo }, seller)).toBe(false);
  });
});
```

Create `packages/x402/test/rebuild.ts`, which re-signs a transaction after changing its
instructions, so tests can produce layouts that `buildOpenTransaction` never would:

```ts
import {
  appendTransactionMessageInstructions,
  blockhash,
  createNoopSigner,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  partiallySignTransactionMessageWithSigners,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Instruction,
  type KeyPairSigner,
} from "@solana/kit";
import { inspectTransaction } from "../src/index.js";

export async function rebuild(
  wire: string,
  signer: KeyPairSigner,
  change: (instructions: readonly Instruction[]) => readonly Instruction[],
): Promise<string> {
  const tx = inspectTransaction(wire)!;
  // Re-attach the signer to every account meta it appears in, so signing finds it.
  const instructions = change(tx.instructions).map((instruction) => ({
    ...instruction,
    accounts: instruction.accounts?.map((meta) =>
      meta.address === signer.address ? { ...meta, signer } : tx.signers.includes(meta.address) ? { ...meta, signer: createNoopSigner(meta.address) } : meta,
    ),
  }));
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(tx.feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: blockhash(tx.blockhash), lastValidBlockHeight: 0n }, m),
    (m) => appendTransactionMessageInstructions(instructions as Instruction[], m),
  );
  return getBase64EncodedWireTransaction(await partiallySignTransactionMessageWithSigners(message));
}
```

Run: `pnpm --filter @lxfoundry/stint-x402 test`
Expected: FAIL: `buildOpenTransaction` and the checks are not exported.

- [ ] **Step 2: Implement the transaction builders**

Create `packages/x402/src/transactions.ts`:

```ts
import {
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  TOKEN_PROGRAM_ADDRESS,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  getTransferCheckedInstruction,
} from "@solana-program/token";
import {
  address,
  appendTransactionMessageInstructions,
  blockhash,
  createNoopSigner,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  partiallySignTransactionMessageWithSigners,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Blockhash,
  type Instruction,
  type TransactionSigner,
} from "@solana/kit";
import {
  CloseKind,
  eventAccounts,
  findSessionPda,
  getCloseInstruction,
  getOpenInstruction,
  type Session,
} from "@lxfoundry/stint-program-client";
import type { ElapsedRequirements } from "./types.js";

/** A fresh random seed for every session (spec §4.1). */
export function randomSeed(): bigint {
  return crypto.getRandomValues(new BigUint64Array(1))[0]!;
}

export async function associatedTokenAddress(owner: Address, mint: Address): Promise<Address> {
  const [account] = await findAssociatedTokenPda({ owner, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  return account;
}

async function compile(
  feePayer: Address,
  lifetime: { blockhash: Blockhash; lastValidBlockHeight: bigint },
  instructions: readonly Instruction[],
): Promise<string> {
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(lifetime, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  // Only the client's own signers sign; the fee payer's and rent payer's slots stay empty.
  return getBase64EncodedWireTransaction(await partiallySignTransactionMessageWithSigners(message));
}

export interface BuildOpenInput {
  readonly requirements: ElapsedRequirements;
  readonly authority: TransactionSigner;
  /** The asset's decimals, from the client's allowlist (spec §5.1, "Decimals"). */
  readonly decimals: number;
  readonly seed?: bigint;
}

export interface BuiltOpen {
  readonly transaction: string;
  readonly session: Address;
  readonly seed: bigint;
}

/**
 * The `open` layout of spec §5.3: create the vault (funded by the rent payer), fund it with
 * exactly `amount` from the authority's associated token account, then `stint.open`. Refunds go
 * back to the authority's account.
 */
export async function buildOpenTransaction(input: BuildOpenInput): Promise<BuiltOpen> {
  const { requirements, authority } = input;
  const extra = requirements.extra;
  const mint = address(requirements.asset);
  const seed = input.seed ?? randomSeed();
  const [session] = await findSessionPda(authority.address, seed);
  const vault = await associatedTokenAddress(session, mint);
  const source = await associatedTokenAddress(authority.address, mint);
  // One signer object per address: the rent payer appears in two instructions.
  const rentPayer = createNoopSigner(address(extra.rentPayer));

  const instructions = [
    getCreateAssociatedTokenIdempotentInstruction({ payer: rentPayer, ata: vault, owner: session, mint }),
    getTransferCheckedInstruction({
      source,
      mint,
      destination: vault,
      authority,
      amount: BigInt(requirements.amount),
      decimals: input.decimals,
    }),
    getOpenInstruction({
      authority,
      rentPayer,
      session,
      mint,
      vault,
      receiver: address(requirements.payTo),
      receiverAuthorizer: address(extra.receiverAuthorizer),
      refundOwner: authority.address,
      ...(await eventAccounts()),
      seed,
      rate: BigInt(extra.rate),
      minSeconds: extra.minSeconds,
      maxSeconds: extra.maxSeconds,
    }),
  ];
  const transaction = await compile(
    address(extra.feePayer),
    { blockhash: blockhash(extra.recentBlockhash), lastValidBlockHeight: BigInt(extra.lastValidBlockHeight) },
    instructions,
  );
  return { transaction, session, seed };
}

export interface BuildCloseInput {
  readonly session: Address;
  /** The stored fields a close derives its accounts from (spec §4.1). */
  readonly stored: Pick<Session, "mint" | "receiver" | "refundOwner" | "rentPayer">;
  readonly closer: TransactionSigner;
  readonly feePayer: Address;
  readonly lifetime: { readonly blockhash: string; readonly lastValidBlockHeight: bigint };
  readonly kind?: CloseKind;
}

/** The `close` layout of spec §5.3, without a recreated `receiver_token`. */
export async function buildCloseTransaction(input: BuildCloseInput): Promise<string> {
  const { stored } = input;
  const instruction = getCloseInstruction({
    closer: input.closer,
    session: input.session,
    vault: await associatedTokenAddress(input.session, stored.mint),
    receiverToken: await associatedTokenAddress(stored.receiver, stored.mint),
    refundTo: await associatedTokenAddress(stored.refundOwner, stored.mint),
    rentPayer: stored.rentPayer,
    ...(await eventAccounts()),
    kind: input.kind ?? CloseKind.Standard,
  });
  return compile(
    input.feePayer,
    { blockhash: blockhash(input.lifetime.blockhash), lastValidBlockHeight: input.lifetime.lastValidBlockHeight },
    [instruction],
  );
}

export { ASSOCIATED_TOKEN_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS };
```

- [ ] **Step 3: Implement inspection and the checks**

Create `packages/x402/src/inspect.ts`:

```ts
import { createHash } from "node:crypto";
import {
  assertIsTransactionWithinSizeLimit,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getInstructionsFromCompiledTransactionMessage,
  getTransactionDecoder,
  type Address,
  type Instruction,
  type Transaction,
} from "@solana/kit";

export interface InspectedTransaction {
  readonly wire: string;
  readonly transaction: Transaction;
  /** The first account (S14). */
  readonly feePayer: Address;
  /** The message's static accounts, in index order. */
  readonly accounts: readonly Address[];
  /** Every account the message requires a signature from, in order. */
  readonly signers: readonly Address[];
  /** The signers whose signature is present. */
  readonly signed: ReadonlySet<Address>;
  readonly blockhash: string;
  readonly instructions: readonly Instruction[];
  /** SHA-256 of the message bytes, hex: the key a later stage's settlement records use (spec §5.5). */
  readonly messageHash: string;
}

/** Decodes a base64 wire transaction. Only version 0 without lookup tables is accepted (spec §3.5). */
export function inspectTransaction(wire: string): InspectedTransaction | undefined {
  try {
    const transaction = getTransactionDecoder().decode(getBase64Encoder().encode(wire));
    assertIsTransactionWithinSizeLimit(transaction);
    const compiled = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
    if (compiled.version !== 0) return undefined;
    if ((compiled.addressTableLookups?.length ?? 0) > 0) return undefined;
    const signers = compiled.staticAccounts.slice(0, compiled.header.numSignerAccounts);
    const signed = new Set(
      Object.entries(transaction.signatures)
        .filter(([, signature]) => signature !== null)
        .map(([signer]) => signer as Address),
    );
    return {
      wire,
      transaction,
      feePayer: compiled.staticAccounts[0]!,
      accounts: compiled.staticAccounts,
      signers,
      signed,
      blockhash: compiled.lifetimeToken,
      instructions: getInstructionsFromCompiledTransactionMessage(compiled),
      messageHash: createHash("sha256").update(transaction.messageBytes).digest("hex"),
    };
  } catch {
    return undefined;
  }
}
```

Create `packages/x402/src/checks.ts`:

```ts
import {
  COMPUTE_BUDGET_PROGRAM_ADDRESS,
  ComputeBudgetInstruction,
  identifyComputeBudgetInstruction,
} from "@solana-program/compute-budget";
import {
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  AssociatedTokenInstruction,
  TOKEN_PROGRAM_ADDRESS,
  TokenInstruction,
  identifyAssociatedTokenInstruction,
  identifyTokenInstruction,
  parseCreateAssociatedTokenIdempotentInstruction,
  parseTransferCheckedInstruction,
} from "@solana-program/token";
import {
  address,
  isInstructionWithAccounts,
  isInstructionWithData,
  type AccountMeta,
  type Address,
  type Instruction,
  type InstructionWithAccounts,
  type InstructionWithData,
  type ReadonlyUint8Array,
} from "@solana/kit";
import {
  STINT_PROGRAM_ADDRESS,
  StintInstruction,
  findSessionPda,
  identifyStintInstruction,
  parseCloseInstruction,
  parseOpenInstruction,
  type CloseKind,
  type Session,
} from "@lxfoundry/stint-program-client";
import type { InspectedTransaction } from "./inspect.js";
import { associatedTokenAddress } from "./transactions.js";
import { refuse, type Check, type ElapsedRequirements, type SellerTerms } from "./types.js";

export interface FacilitatorKeys {
  readonly feePayer: Address;
  readonly rentPayer: Address;
}

type Full = Instruction & InstructionWithAccounts<readonly AccountMeta[]> & InstructionWithData<ReadonlyUint8Array>;

const full = (ix: Instruction): ix is Full => isInstructionWithAccounts(ix) && isInstructionWithData(ix);

function is<T>(identify: (ix: Full) => T, ix: Instruction, programAddress: Address, kind: T): ix is Full {
  if (ix.programAddress !== programAddress || !full(ix)) return false;
  try {
    return identify(ix) === kind;
  } catch {
    return false; // data no known instruction of that program has
  }
}

const isVaultCreation = (ix: Instruction): ix is Full =>
  is(identifyAssociatedTokenInstruction, ix, ASSOCIATED_TOKEN_PROGRAM_ADDRESS, AssociatedTokenInstruction.CreateAssociatedTokenIdempotent);
const isTransferChecked = (ix: Instruction): ix is Full =>
  is(identifyTokenInstruction, ix, TOKEN_PROGRAM_ADDRESS, TokenInstruction.TransferChecked);
const isStint = (ix: Instruction, kind: StintInstruction): ix is Full =>
  is(identifyStintInstruction, ix, STINT_PROGRAM_ADDRESS, kind);

/**
 * Where the facilitator's keys may appear (spec §5.3). The fee payer: only as the first account,
 * unsigned. The rent payer: only where `rentPayerAllowed` says.
 */
function checkPayerPositions(
  tx: InspectedTransaction,
  keys: FacilitatorKeys,
  rentPayerAllowed: (ix: Instruction, accountIndex: number) => boolean,
): Check<null> {
  if (tx.feePayer !== keys.feePayer) return refuse("payer_misuse", "the fee payer is not the facilitator's");
  if (tx.signed.has(keys.feePayer)) return refuse("payer_misuse", "the fee payer's signature slot is not empty");
  for (const ix of tx.instructions) {
    if (ix.programAddress === keys.feePayer || ix.programAddress === keys.rentPayer) {
      return refuse("payer_misuse", "a facilitator key is invoked as a program");
    }
    for (const [index, meta] of (ix.accounts ?? []).entries()) {
      if (meta.address === keys.feePayer) return refuse("payer_misuse", "the fee payer appears in an instruction");
      if (meta.address === keys.rentPayer && !rentPayerAllowed(ix, index)) {
        return refuse("payer_misuse", "the rent payer appears where it may not");
      }
    }
  }
  return { ok: true, value: null };
}

/** Leading compute-budget instructions, which may only set a compute-unit limit. */
function layoutBody(tx: InspectedTransaction): Check<readonly Instruction[]> {
  let start = 0;
  while (tx.instructions[start]?.programAddress === COMPUTE_BUDGET_PROGRAM_ADDRESS) {
    const ix = tx.instructions[start]!;
    if (!is(identifyComputeBudgetInstruction, ix, COMPUTE_BUDGET_PROGRAM_ADDRESS, ComputeBudgetInstruction.SetComputeUnitLimit)) {
      return refuse("unexpected_instruction", "only a compute-unit limit is allowed among compute-budget instructions");
    }
    start++;
  }
  return { ok: true, value: tx.instructions.slice(start) };
}

export interface OpenFacts {
  readonly session: Address;
  readonly authority: Address;
  readonly seed: bigint;
  readonly vault: Address;
  readonly refundOwner: Address;
}

/** The static checks of spec §5.4 for an `open`. Simulation and the blockhash are the caller's. */
export async function checkOpenTransaction(
  tx: InspectedTransaction,
  requirements: ElapsedRequirements,
  keys: FacilitatorKeys,
): Promise<Check<OpenFacts>> {
  const positions = checkPayerPositions(
    tx,
    keys,
    (ix, index) => (isVaultCreation(ix) && index === 0) || (isStint(ix, StintInstruction.Open) && index === 1),
  );
  if (!positions.ok) return positions;

  const body = layoutBody(tx);
  if (!body.ok) return body;
  const [create, transfer, open, ...rest] = body.value;
  if (!create || !transfer || !open || rest.length > 0) {
    return refuse("unexpected_instruction", "an open is: create the vault, one funding transfer, stint.open");
  }
  if (!isVaultCreation(create) || !isTransferChecked(transfer) || !isStint(open, StintInstruction.Open)) {
    return refuse("unexpected_instruction", "an open is: create the vault, one funding transfer, stint.open");
  }

  const c = parseCreateAssociatedTokenIdempotentInstruction(create);
  const t = parseTransferCheckedInstruction(transfer);
  const o = parseOpenInstruction(open);
  const extra = requirements.extra;
  const asset = address(requirements.asset);

  if (extra.programId !== STINT_PROGRAM_ADDRESS) return refuse("invalid_payment_requirements", "another program");
  if (
    o.data.rate !== BigInt(extra.rate) ||
    o.data.minSeconds !== extra.minSeconds ||
    o.data.maxSeconds !== extra.maxSeconds ||
    o.accounts.receiver.address !== requirements.payTo ||
    o.accounts.receiverAuthorizer.address !== extra.receiverAuthorizer ||
    o.accounts.mint.address !== asset ||
    o.accounts.rentPayer.address !== keys.rentPayer
  ) {
    return refuse("invalid_terms", "the open's terms differ from the offer");
  }

  const authority = o.accounts.authority.address;
  const [session] = await findSessionPda(authority, o.data.seed);
  const vault = await associatedTokenAddress(session, asset);
  if (
    o.accounts.session.address !== session ||
    o.accounts.vault.address !== vault ||
    c.accounts.ata.address !== vault ||
    c.accounts.owner.address !== session ||
    c.accounts.mint.address !== asset ||
    c.accounts.payer.address !== keys.rentPayer
  ) {
    return refuse("invalid_terms", "the session or its vault is not the canonical one");
  }

  const refundOwner = o.accounts.refundOwner.address;
  if (
    t.accounts.mint.address !== asset ||
    t.accounts.destination.address !== vault ||
    t.accounts.source.address !== (await associatedTokenAddress(refundOwner, asset))
  ) {
    return refuse("invalid_terms", "the funding must move the asset from the refund owner's account into the vault");
  }
  if (t.data.amount !== BigInt(requirements.amount)) {
    return refuse("invalid_amount", `the funding moves ${t.data.amount}, not ${requirements.amount}`);
  }
  if (!tx.signed.has(authority) || !tx.signed.has(t.accounts.authority.address)) {
    return refuse("invalid_payload", "the authority has not signed");
  }
  return { ok: true, value: { session, authority, seed: o.data.seed, vault, refundOwner } };
}

export interface CloseFacts {
  readonly kind: CloseKind;
}

/** The static checks of spec §5.4 for a `close` sent by a gate through `/settle`. */
export function checkCloseTransaction(
  tx: InspectedTransaction,
  expected: { readonly session: Address; readonly closer: Address },
  keys: FacilitatorKeys,
): Check<CloseFacts> {
  // `rent_payer` is the sixth account of `close`: it receives lamports and does not sign.
  const positions = checkPayerPositions(tx, keys, (ix, index) => isStint(ix, StintInstruction.Close) && index === 5);
  if (!positions.ok) return positions;
  const body = layoutBody(tx);
  if (!body.ok) return body;
  const [close, ...rest] = body.value;
  if (!close || rest.length > 0 || !isStint(close, StintInstruction.Close)) {
    return refuse("unexpected_instruction", "a close is stint.close alone");
  }
  const parsed = parseCloseInstruction(close);
  if (parsed.accounts.session.address !== expected.session) return refuse("invalid_terms", "another session");
  if (parsed.accounts.closer.address !== expected.closer || !tx.signed.has(expected.closer)) {
    return refuse("invalid_payload", "the close is not signed by the expected closer");
  }
  return { ok: true, value: { kind: parsed.data.kind } };
}

/** Check 4 of spec §7.2: the session's terms match the seller's offer, mint included (S5). */
export function sessionMatches(
  session: Pick<Session, "mint" | "receiver" | "receiverAuthorizer" | "rate" | "minSeconds" | "maxSeconds">,
  seller: SellerTerms,
): boolean {
  return (
    seller.programId === STINT_PROGRAM_ADDRESS &&
    session.mint === seller.asset &&
    session.receiver === seller.payTo &&
    session.receiverAuthorizer === seller.receiverAuthorizer &&
    session.rate === seller.terms.rate &&
    session.minSeconds === seller.terms.minSeconds &&
    session.maxSeconds === seller.terms.maxSeconds
  );
}
```

The close test's `stored` object has only the four fields a close derives accounts from, which is
what `BuildCloseInput.stored` takes.

- [ ] **Step 4: Implement the chain reads**

Create `packages/x402/src/chain.ts`:

```ts
import {
  blockhash as toBlockhash,
  getBase58Encoder,
  signature as toSignature,
  type Address,
  type Rpc,
  type SolanaRpcApi,
} from "@solana/kit";
import { findClosedEvent, type ClosedEvent, type ProgramInstruction } from "@lxfoundry/stint-program-client";

const json = (value: unknown) => JSON.stringify(value, (_, inner) => (typeof inner === "bigint" ? inner.toString() : inner));

async function fetchConfirmed(rpc: Rpc<SolanaRpcApi>, signature: string) {
  return rpc
    .getTransaction(toSignature(signature), { commitment: "confirmed", encoding: "json", maxSupportedTransactionVersion: 0 })
    .send();
}

/** Every account key of a fetched transaction, lookup-table addresses included, in index order. */
function accountKeysOf(transaction: NonNullable<Awaited<ReturnType<typeof fetchConfirmed>>>): Address[] {
  const loaded = transaction.meta?.loadedAddresses;
  return [...transaction.transaction.message.accountKeys, ...(loaded?.writable ?? []), ...(loaded?.readonly ?? [])];
}

/** The inner instructions of a confirmed transaction, with their program address. */
export async function fetchProgramInstructions(rpc: Rpc<SolanaRpcApi>, signature: string): Promise<ProgramInstruction[] | undefined> {
  const transaction = await fetchConfirmed(rpc, signature);
  if (!transaction) return undefined;
  const keys = accountKeysOf(transaction);
  const base58 = getBase58Encoder();
  return (transaction.meta?.innerInstructions ?? []).flatMap((group) =>
    group.instructions.map((ix) => ({ programAddress: keys[ix.programIdIndex]!, data: base58.encode(ix.data) })),
  );
}

/** The `Closed` event a confirmed close emitted (spec §4.4). */
export async function fetchClosedEvent(rpc: Rpc<SolanaRpcApi>, signature: string): Promise<ClosedEvent | undefined> {
  const instructions = await fetchProgramInstructions(rpc, signature);
  return instructions && findClosedEvent(instructions);
}

/** Token balance changes recorded in a confirmed transaction, by token account (spec §12.2). */
export async function tokenBalanceChanges(rpc: Rpc<SolanaRpcApi>, signature: string): Promise<Map<Address, bigint>> {
  const transaction = await fetchConfirmed(rpc, signature);
  if (!transaction?.meta) throw new Error(`Transaction ${signature} not found at confirmed`);
  const keys = accountKeysOf(transaction);
  const changes = new Map<Address, bigint>();
  const add = (index: number, amount: bigint) => {
    const key = keys[index]!;
    changes.set(key, (changes.get(key) ?? 0n) + amount);
  };
  for (const balance of transaction.meta.preTokenBalances ?? []) add(balance.accountIndex, -BigInt(balance.uiTokenAmount.amount));
  for (const balance of transaction.meta.postTokenBalances ?? []) add(balance.accountIndex, BigInt(balance.uiTokenAmount.amount));
  return changes;
}

export type Confirmation = "confirmed" | "expired" | "pending";

/**
 * Waits for `confirmed`. Throws if the transaction failed. Returns `expired` once its blockhash is
 * no longer valid and one last status read finds nothing (spec §7.1), and `pending` at the timeout.
 */
export async function waitForConfirmation(
  rpc: Rpc<SolanaRpcApi>,
  signature: string,
  blockhash: string,
  timeoutMs = 30_000,
): Promise<Confirmation> {
  const read = async () => {
    const { value } = await rpc.getSignatureStatuses([toSignature(signature)]).send();
    const status = value[0];
    if (status?.err) throw new Error(`Transaction ${signature} failed: ${json(status.err)}`);
    return status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized";
  };
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await read()) return "confirmed";
    const { value: valid } = await rpc.isBlockhashValid(toBlockhash(blockhash), { commitment: "confirmed" }).send();
    if (!valid) return (await read()) ? "confirmed" : "expired";
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return "pending";
}
```

Update `packages/x402/src/index.ts`:

```ts
export * from "./constants.js";
export * from "./types.js";
export * from "./offer.js";
export * from "./wire.js";
export * from "./token.js";
export * from "./transactions.js";
export * from "./inspect.js";
export * from "./checks.js";
export * from "./chain.js";
```

The chain reads are exercised against a real network in Task 6.

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter @lxfoundry/stint-x402 test && pnpm typecheck`
Expected: PASS.
- If `assertIsTransactionWithinSizeLimit` or `isInstructionWithAccounts` is not exported under that
  name by `@solana/kit` 8.5.0, look it up in `node_modules/@solana/kit/dist/types/index.d.ts` and
  use the exported name. Do not remove the check.
- If `getTransaction`'s typed result has no `loadedAddresses`, keep `accountKeys` alone: the
  transactions are version 0 without lookup tables.

- [ ] **Step 6: Commit**

```bash
git add packages/x402 pnpm-lock.yaml
git commit -m "Build and check open and close transactions, and read their outcome on chain"
```

---
### Task 6: The facilitator

**Files:**
- Modify: `pnpm-workspace.yaml` (adds `apps/*` and `examples/*`)
- Create: `packages/x402/src/http.ts`; modify `packages/x402/src/index.ts`
- Create: `apps/facilitator/package.json`, `apps/facilitator/tsconfig.json`,
  `apps/facilitator/src/{index,kora,verify,settle,server}.ts`
- Delete: `e2e/src/kora/client.ts` (moved to `apps/facilitator/src/kora.ts`)
- Create: `e2e/src/targets/chain.ts`, `e2e/src/fixtures/buyers.ts`; modify
  `e2e/src/targets/local.ts`, `e2e/src/index.ts`, `e2e/package.json`, `e2e/test/kora.test.ts`
- Test: `apps/facilitator/test/server.test.ts`, `e2e/test/facilitator.test.ts`

**Interfaces:**
- Consumes: Task 5's `inspectTransaction`, `checkOpenTransaction`, `checkCloseTransaction`,
  `sessionMatches`, `associatedTokenAddress`, `waitForConfirmation`, `fetchClosedEvent`; Task 4's
  `readElapsedRequirements`, `readElapsedPayload`, `sameRequirements`, `sellerTermsOf`.
- Produces:
  - `@lxfoundry/stint-x402`: `readJson(request, limitBytes?): Promise<unknown>` (throws
    `HttpError(400, "invalid_json")`), `sendJson(response, status, body, headers?)`, `HttpError`;
  - `@lxfoundry/stint-facilitator`:
    - `startFacilitator(config: FacilitatorConfig): Promise<RunningFacilitator>`, where
      `RunningFacilitator = { url; closeUrl; feePayer: Address; rentPayer: Address; stop() }`;
    - `createKoraClient(url, apiKey): KoraClient`;
    - `verifyPayment(ctx, payload, requirements): Promise<Verified>`;
    - `settlePayment(ctx, payload, requirements): Promise<SettleResponse>`;
  - `e2e`:
    - `startLocalChain(): Promise<LocalChain>`, where `LocalChain = { network, keys, stop() }`;
    - `startLocalStack()` now also starts the facilitator: `LocalStack` gains
      `facilitator: RunningFacilitator` and `facilitatorApiKey: string`;
    - `newBuyer(rpc, mintAuthority, usdc: bigint): Promise<Buyer>`, where
      `Buyer = { signer: KeyPairSigner; usdcAccount: Address }`.
- HTTP interface:
  - `GET /health` → `200 {ok: true}`;
  - `GET /supported` → `SupportedResponse`;
  - `POST /verify` and `POST /settle`, with `Authorization: Bearer <api key>`, body
    `{x402Version: 2, paymentPayload, paymentRequirements}` → `VerifyResponse` / `SettleResponse`;
  - a missing or unknown key gets `401 {error: "unauthorized"}`.

- [ ] **Step 1: Workspace, HTTP helpers and the package**

Replace the `packages` list in `pnpm-workspace.yaml`:

```yaml
packages:
  - packages/*
  - apps/*
  - examples/*
  - conformance
  - e2e
```

Create `packages/x402/src/http.ts` (shared by the facilitator and the gate):

```ts
import type { IncomingMessage, ServerResponse } from "node:http";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

/** Reads a JSON body of at most `limitBytes`. */
export async function readJson(request: IncomingMessage, limitBytes = 64 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > limitBytes) throw new HttpError(413, "body_too_large");
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid_json");
  }
}

const replacer = (_: string, value: unknown) => (typeof value === "bigint" ? value.toString() : value);

export function sendJson(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body, replacer);
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text), ...headers });
  response.end(text);
}
```

Add `export * from "./http.js";` to `packages/x402/src/index.ts`.

Create `apps/facilitator/package.json`:

```json
{
  "name": "@lxfoundry/stint-facilitator",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "typecheck": "tsc -p tsconfig.json",
    "test": "vitest run"
  },
  "dependencies": {
    "@lxfoundry/stint-program-client": "workspace:*",
    "@lxfoundry/stint-x402": "workspace:*",
    "@solana-program/token": "0.18.0",
    "@solana/kit": "8.5.0"
  }
}
```

and `apps/facilitator/tsconfig.json` (`"extends": "../../tsconfig.base.json"`, `"include": ["src", "test"]`).

Move Kora's client: `git mv e2e/src/kora/client.ts apps/facilitator/src/kora.ts`. In
`e2e/test/kora.test.ts`, import `createKoraClient` from `@lxfoundry/stint-facilitator`, and add
`"@lxfoundry/stint-facilitator": "workspace:*"` and `"@lxfoundry/stint-x402": "workspace:*"` to the
dependencies in `e2e/package.json`. Run `pnpm install`.

- [ ] **Step 2: Write the failing server tests**

Create `apps/facilitator/test/server.test.ts`:

```ts
import { generateKeyPairSync } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { generateKeyPairSigner } from "@solana/kit";
import { STINT_PROGRAM_ADDRESS } from "@lxfoundry/stint-program-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFacilitator, type RunningFacilitator } from "../src/index.js";

/** A fresh 64-byte Solana secret key: the 32-byte seed, then the public key. */
function newSecretKey(): Uint8Array {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const seed = privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
  const pub = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  return Uint8Array.from([...seed, ...pub]);
}

/** Answers Kora's `getPayerSigner` only: enough for the routes that never reach the chain. */
async function startFakeKora(feePayer: string): Promise<{ url: string; server: Server }> {
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const { id } = JSON.parse(body) as { id: number };
      response.end(JSON.stringify({ jsonrpc: "2.0", id, result: { signer_address: feePayer, payment_address: feePayer } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server };
}

describe("facilitator HTTP interface (spec §6.1)", () => {
  let kora: { url: string; server: Server };
  let facilitator: RunningFacilitator;
  let feePayer: string;

  beforeAll(async () => {
    feePayer = (await generateKeyPairSigner()).address;
    kora = await startFakeKora(feePayer);
    facilitator = await startFacilitator({
      rpcUrl: "http://127.0.0.1:9",
      network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
      kora: { url: kora.url, apiKey: "kora-key" },
      rentPayerSecretKey: newSecretKey(),
      apiKeys: ["seller-key"],
    });
  });

  afterAll(async () => {
    await facilitator?.stop();
    kora?.server.close();
  });

  const post = (path: string, body: unknown, apiKey?: string) =>
    fetch(`${facilitator.url}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });

  it("answers its health check", async () => {
    expect(await (await fetch(`${facilitator.url}/health`)).json()).toEqual({ ok: true });
  });

  it("lists elapsed in /supported, with its fee payer, rent payer, program and closeUrl", async () => {
    const supported = await (await fetch(`${facilitator.url}/supported`)).json();
    expect(supported.kinds).toEqual([
      {
        x402Version: 2,
        scheme: "elapsed",
        network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
        extra: {
          feePayer,
          rentPayer: facilitator.rentPayer,
          programId: STINT_PROGRAM_ADDRESS,
          closeUrl: `${facilitator.url}/close`,
        },
      },
    ]);
  });

  it("requires an API key on /verify and /settle", async () => {
    for (const path of ["/verify", "/settle"]) {
      expect((await post(path, {})).status).toBe(401);
      expect((await post(path, {}, "wrong")).status).toBe(401);
    }
  });

  it("refuses a body that is not JSON", async () => {
    const response = await post("/verify", "{", "seller-key");
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_json" });
  });

  it("refuses x402 version 1 before reading anything else", async () => {
    const response = await post(
      "/verify",
      { x402Version: 2, paymentPayload: { x402Version: 1 }, paymentRequirements: {} },
      "seller-key",
    );
    expect(await response.json()).toMatchObject({ isValid: false, invalidReason: "invalid_x402_version" });
  });

  it("answers 404 elsewhere", async () => {
    expect((await fetch(`${facilitator.url}/nowhere`)).status).toBe(404);
  });
});
```

Run: `pnpm --filter @lxfoundry/stint-facilitator test`
Expected: FAIL: `../src/index.js` does not exist.

- [ ] **Step 3: Implement verification**

Create `apps/facilitator/src/verify.ts`:

```ts
import { fetchMaybeToken, getTokenSize } from "@solana-program/token";
import {
  address,
  blockhash,
  type Address,
  type Base64EncodedWireTransaction,
  type KeyPairSigner,
  type Rpc,
  type SolanaRpcApi,
} from "@solana/kit";
import { STINT_PROGRAM_ADDRESS, fetchMaybeSession, getSessionSize } from "@lxfoundry/stint-program-client";
import {
  X402_VERSION,
  associatedTokenAddress,
  checkCloseTransaction,
  checkOpenTransaction,
  inspectTransaction,
  readElapsedPayload,
  readElapsedRequirements,
  refuse,
  sameRequirements,
  sellerTermsOf,
  sessionMatches,
  type Check,
  type FacilitatorKeys,
  type InspectedTransaction,
  type InvalidReason,
  type PaymentPayload,
} from "@lxfoundry/stint-x402";
import type { KoraClient } from "./kora.js";

export interface FacilitatorContext {
  readonly rpc: Rpc<SolanaRpcApi>;
  readonly network: string;
  readonly keys: FacilitatorKeys;
  readonly rentPayer: KeyPairSigner;
  readonly kora: KoraClient;
  /** How long `/settle` waits for `confirmed` before answering `settlement_pending`. */
  readonly confirmTimeoutMs: number;
}

export type Verified =
  | {
      readonly ok: true;
      readonly type: "open" | "close";
      readonly tx: InspectedTransaction;
      /** The session's authority (spec §5.5: `payer`). */
      readonly payer: Address;
      readonly session: Address;
    }
  | { readonly ok: false; readonly reason: InvalidReason; readonly message: string };

const LAMPORTS_PER_SIGNATURE = 5_000n;
const json = (value: unknown) => JSON.stringify(value, (_, inner) => (typeof inner === "bigint" ? inner.toString() : inner));
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/** Spec §5.4. Read-only: it simulates and never submits. */
export async function verifyPayment(ctx: FacilitatorContext, payload: unknown, requirementsValue: unknown): Promise<Verified> {
  if (!isRecord(payload)) return refuse("invalid_payload", "the payload is not an object");
  if (payload.x402Version !== X402_VERSION) return refuse("invalid_x402_version", "x402Version must be 2");

  const requirements = readElapsedRequirements(requirementsValue);
  if (!requirements) return refuse("invalid_payment_requirements", "not elapsed requirements");
  const extra = requirements.extra;
  if (
    requirements.network !== ctx.network ||
    extra.programId !== STINT_PROGRAM_ADDRESS ||
    extra.feePayer !== ctx.keys.feePayer ||
    extra.rentPayer !== ctx.keys.rentPayer
  ) {
    return refuse("invalid_payment_requirements", "the requirements name another network, program or facilitator");
  }
  // Compared with the requirements the resource server issued, never with the client's echo alone.
  if (!sameRequirements(payload.accepted, requirements)) {
    return refuse("invalid_payment_requirements", "accepted differs from the issued requirements");
  }

  const elapsed = readElapsedPayload(payload as unknown as PaymentPayload);
  if (!elapsed || elapsed.type !== extra.action) return refuse("invalid_payload", "the payload does not match the action");
  const tx = inspectTransaction(elapsed.transaction);
  if (!tx) return refuse("invalid_payload", "the transaction cannot be decoded as version 0");

  let facts: { payer: Address; session: Address };
  let rentBudget = 0n;
  if (elapsed.type === "open") {
    const check = await checkOpenTransaction(tx, requirements, ctx.keys);
    if (!check.ok) return check;
    const receiverToken = await associatedTokenAddress(address(requirements.payTo), address(requirements.asset));
    if (!(await fetchMaybeToken(ctx.rpc, receiverToken)).exists) {
      return refuse("invalid_terms", "payTo has no token account for the asset");
    }
    facts = { payer: check.value.authority, session: check.value.session };
    const [sessionRent, vaultRent] = await Promise.all([
      ctx.rpc.getMinimumBalanceForRentExemption(BigInt(getSessionSize())).send(),
      ctx.rpc.getMinimumBalanceForRentExemption(BigInt(getTokenSize())).send(),
    ]);
    rentBudget = sessionRent + vaultRent;
  } else {
    if (!extra.session) return refuse("invalid_payment_requirements", "a close names its session");
    const session = address(extra.session);
    const stored = await fetchMaybeSession(ctx.rpc, session, { commitment: "confirmed" });
    if (!stored.exists) return refuse("unknown_session", "no such session");
    if (!sessionMatches(stored.data, sellerTermsOf(requirements))) {
      return refuse("invalid_terms", "the session's terms differ from the requirements");
    }
    const check = checkCloseTransaction(tx, { session, closer: stored.data.receiverAuthorizer }, ctx.keys);
    if (!check.ok) return check;
    facts = { payer: stored.data.authority, session };
  }

  const { value: valid } = await ctx.rpc.isBlockhashValid(blockhash(tx.blockhash), { commitment: "confirmed" }).send();
  if (!valid) return refuse("blockhash_expired", "the transaction's blockhash is no longer valid");

  const simulated = await simulate(ctx, tx, rentBudget);
  if (!simulated.ok) return simulated;
  return { ok: true, type: elapsed.type, tx, ...facts };
}

/**
 * Simulates with inner instructions (spec §5.4): the transaction succeeds, the fee payer pays only
 * the fee, and the rent payer funds at most the session's accounts.
 */
async function simulate(ctx: FacilitatorContext, tx: InspectedTransaction, rentBudget: bigint): Promise<Check<null>> {
  const { value } = await ctx.rpc
    .simulateTransaction(tx.wire as Base64EncodedWireTransaction, {
      encoding: "base64",
      commitment: "confirmed",
      sigVerify: false,
      replaceRecentBlockhash: false,
      innerInstructions: true,
    })
    .send();
  if (value.err) {
    const last = value.logs?.at(-1) ?? "";
    return refuse("simulation_failed", `${json(value.err)} ${last}`.trim());
  }
  const pre = value.preBalances;
  const post = value.postBalances;
  if (!pre || !post) throw new Error("The node's simulation returned no balances");
  const debit = (key: Address) => {
    const index = tx.accounts.indexOf(key);
    return index < 0 ? 0n : BigInt(pre[index]!) - BigInt(post[index]!);
  };
  if (debit(ctx.keys.feePayer) > LAMPORTS_PER_SIGNATURE * BigInt(tx.signers.length)) {
    return refuse("payer_misuse", "the fee payer would pay more than the fee");
  }
  if (debit(ctx.keys.rentPayer) > rentBudget) {
    return refuse("payer_misuse", "the rent payer would fund more than the session's accounts");
  }
  return { ok: true, value: null };
}
```

`preBalances` and `postBalances` come from the simulation itself, so concurrent settlements that
move the rent payer's balance between two reads cannot cause a false refusal. If Surfpool 1.6.1
omits them, the integration test of Step 7 fails with "The node's simulation returned no
balances". Do not replace this with balance reads before and after: stop and report it.

- [ ] **Step 4: Implement settlement and the server**

Create `apps/facilitator/src/settle.ts`:

```ts
import {
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getSignatureFromTransaction,
  getTransactionDecoder,
  partiallySignTransaction,
} from "@solana/kit";
import { fetchClosedEvent, waitForConfirmation, type Network, type SettleResponse } from "@lxfoundry/stint-x402";
import { verifyPayment, type FacilitatorContext } from "./verify.js";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Spec §5.5, without settlement records (a later stage adds them): re-verify, the rent payer signs
 * an open, Kora signs as fee payer, then submit and wait for `confirmed`.
 */
export async function settlePayment(
  ctx: FacilitatorContext,
  payload: unknown,
  requirements: { readonly amount?: unknown },
): Promise<SettleResponse> {
  const network = ctx.network as Network;
  const verified = await verifyPayment(ctx, payload, requirements);
  if (!verified.ok) {
    return { success: false, errorReason: verified.reason, errorMessage: verified.message, transaction: "", network };
  }
  const payer = verified.payer;

  let transaction = verified.tx.transaction;
  if (verified.type === "open") transaction = await partiallySignTransaction([ctx.rentPayer.keyPair], transaction);

  let wire;
  try {
    wire = await ctx.kora.signTransaction(getBase64EncodedWireTransaction(transaction));
  } catch (error) {
    return { success: false, errorReason: "simulation_failed", errorMessage: `Kora: ${message(error)}`, transaction: "", network, payer };
  }
  const signature = getSignatureFromTransaction(getTransactionDecoder().decode(getBase64Encoder().encode(wire)));

  try {
    await ctx.rpc.sendTransaction(wire, { encoding: "base64", preflightCommitment: "confirmed" }).send();
    const outcome = await waitForConfirmation(ctx.rpc, signature, verified.tx.blockhash, ctx.confirmTimeoutMs);
    if (outcome !== "confirmed") {
      const errorReason = outcome === "pending" ? "settlement_pending" : "blockhash_expired";
      return { success: false, errorReason, transaction: signature, network, payer };
    }
  } catch (error) {
    return { success: false, errorReason: "simulation_failed", errorMessage: message(error), transaction: signature, network, payer };
  }

  let amount = String(requirements.amount);
  if (verified.type === "close") {
    // What this transaction paid the receiver; earlier claims are the gate's to add (spec §5.5).
    const event = await fetchClosedEvent(ctx.rpc, signature);
    if (!event) throw new Error(`Close ${signature} confirmed without a Closed event`);
    amount = (event.owed + event.redirected).toString();
  }
  return { success: true, transaction: signature, network, payer, amount };
}
```

Create `apps/facilitator/src/server.ts`:

```ts
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { address, createKeyPairSignerFromBytes, createSolanaRpc, type Address } from "@solana/kit";
import { STINT_PROGRAM_ADDRESS } from "@lxfoundry/stint-program-client";
import { HttpError, SCHEME, X402_VERSION, readJson, sendJson, type Network, type SupportedResponse } from "@lxfoundry/stint-x402";
import { createKoraClient } from "./kora.js";
import { settlePayment } from "./settle.js";
import { verifyPayment, type FacilitatorContext } from "./verify.js";

export interface FacilitatorConfig {
  readonly host?: string;
  /** 0 picks a free port (spec §12.4). */
  readonly port?: number;
  readonly rpcUrl: string;
  readonly network: string;
  readonly kora: { readonly url: string; readonly apiKey: string };
  /** The rent payer's 64-byte secret key (spec §6.3). */
  readonly rentPayerSecretKey: Uint8Array;
  /** One per resource server; required on `/verify` and `/settle` (spec §6.5). */
  readonly apiKeys: readonly string[];
  readonly confirmTimeoutMs?: number;
  readonly log?: (entry: Record<string, unknown>) => void;
}

export interface RunningFacilitator {
  readonly url: string;
  readonly closeUrl: string;
  readonly feePayer: Address;
  readonly rentPayer: Address;
  stop(): Promise<void>;
}

export async function startFacilitator(config: FacilitatorConfig): Promise<RunningFacilitator> {
  const kora = createKoraClient(config.kora.url, config.kora.apiKey);
  const feePayer = address((await kora.getPayerSigner()).signer_address);
  const rentPayer = await createKeyPairSignerFromBytes(config.rentPayerSecretKey);
  const log = config.log ?? (() => {});
  const ctx: FacilitatorContext = {
    rpc: createSolanaRpc(config.rpcUrl),
    network: config.network,
    keys: { feePayer, rentPayer: rentPayer.address },
    rentPayer,
    kora,
    confirmTimeoutMs: config.confirmTimeoutMs ?? 30_000,
  };
  const host = config.host ?? "127.0.0.1";
  let url = "";

  const supported = (): SupportedResponse => ({
    kinds: [
      {
        x402Version: X402_VERSION,
        scheme: SCHEME,
        network: config.network as Network,
        extra: { feePayer, rentPayer: rentPayer.address, programId: STINT_PROGRAM_ADDRESS, closeUrl: `${url}/close` },
      },
    ],
    extensions: [],
    signers: { "solana:*": [feePayer] },
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = new URL(request.url ?? "/", "http://facilitator").pathname;
    if (request.method === "GET" && path === "/health") return sendJson(response, 200, { ok: true });
    if (request.method === "GET" && path === "/supported") return sendJson(response, 200, supported());
    if (request.method === "POST" && (path === "/verify" || path === "/settle")) {
      const key = request.headers.authorization?.replace(/^Bearer /, "");
      if (!key || !config.apiKeys.includes(key)) return sendJson(response, 401, { error: "unauthorized" });
      const body = await readJson(request);
      const { paymentPayload, paymentRequirements } = (body ?? {}) as Record<string, unknown>;
      if (path === "/verify") {
        const verified = await verifyPayment(ctx, paymentPayload, paymentRequirements);
        log({ event: "verify", ok: verified.ok, ...(verified.ok ? {} : { reason: verified.reason }) });
        return sendJson(
          response,
          200,
          verified.ok
            ? { isValid: true, payer: verified.payer }
            : { isValid: false, invalidReason: verified.reason, invalidMessage: verified.message },
        );
      }
      const settled = await settlePayment(ctx, paymentPayload, (paymentRequirements ?? {}) as { amount?: unknown });
      log({ event: "settle", success: settled.success, reason: settled.errorReason, transaction: settled.transaction });
      return sendJson(response, 200, settled);
    }
    sendJson(response, 404, { error: "not_found" });
  }

  const server = createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      if (error instanceof HttpError) return sendJson(response, error.status, { error: error.code });
      log({ event: "error", error: error instanceof Error ? error.message : String(error) });
      if (!response.headersSent) sendJson(response, 500, { error: "internal" });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port ?? 0, host, resolve);
  });
  url = `http://${host}:${(server.address() as AddressInfo).port}`;

  return {
    url,
    closeUrl: `${url}/close`,
    feePayer,
    rentPayer: rentPayer.address,
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
```

Create `apps/facilitator/src/index.ts`:

```ts
export { startFacilitator, type FacilitatorConfig, type RunningFacilitator } from "./server.js";
export { createKoraClient, type KoraClient } from "./kora.js";
export { verifyPayment, type FacilitatorContext, type Verified } from "./verify.js";
export { settlePayment } from "./settle.js";
```

- [ ] **Step 5: Run the server tests**

Run: `pnpm --filter @lxfoundry/stint-facilitator test && pnpm typecheck`
Expected: PASS. If `getSessionSize` is not generated (Codama renders it only for fixed-size
accounts), use `250`, the size stage 0's `session_account_is_250_bytes` pins, through a constant
`SESSION_SIZE = 250` in `verify.ts`.

- [ ] **Step 6: Split the local target and add buyers**

Create `e2e/src/targets/chain.ts`, with the network half of `startLocalStack` moved out of
`local.ts` unchanged:

```ts
import type { Address } from "@solana/kit";
import { fundSol, newHarnessKey, type HarnessKey } from "../fixtures/keys.js";
import { deployStintProgram, deploySubscriptionsProgram } from "../fixtures/programs.js";
import { createUsdcAccount, writeUsdcMint } from "../fixtures/usdc.js";
import { startLocalNetwork, waitForNewSlot, type LocalNetwork } from "../network/surfnet.js";

/** The common stack's keys (spec §12.3). */
export interface CommonKeys {
  readonly mintAuthority: HarnessKey;
  readonly freezeAuthority: HarnessKey;
  readonly koraFeePayer: HarnessKey;
  readonly rentPayer: HarnessKey;
  readonly receiverAuthorizer: HarnessKey;
  readonly seller: HarnessKey;
  readonly sellerUsdcAccount: Address;
}

export interface LocalChain {
  readonly network: LocalNetwork;
  readonly keys: CommonKeys;
  stop(): void;
}

/** Surfpool, offline and embedded, with the fixtures of spec §12.3 and the common keys. */
export async function startLocalChain(): Promise<LocalChain> {
  const network = startLocalNetwork();
  try {
    const mintAuthority = await newHarnessKey();
    const freezeAuthority = await newHarnessKey();
    const koraFeePayer = await newHarnessKey();
    const rentPayer = await newHarnessKey();
    const receiverAuthorizer = await newHarnessKey();
    const seller = await newHarnessKey();
    for (const key of [mintAuthority, koraFeePayer, rentPayer, receiverAuthorizer, seller]) {
      fundSol(network, key.signer.address, 10);
    }
    await writeUsdcMint(network, {
      mintAuthority: mintAuthority.signer.address,
      freezeAuthority: freezeAuthority.signer.address,
    });
    deployStintProgram(network);
    deploySubscriptionsProgram(network);
    await waitForNewSlot(network.rpc);
    const sellerUsdcAccount = await createUsdcAccount(network.rpc, mintAuthority.signer, seller.signer.address);
    const keys = { mintAuthority, freezeAuthority, koraFeePayer, rentPayer, receiverAuthorizer, seller, sellerUsdcAccount };
    return { network, keys, stop: () => network.stop() };
  } catch (error) {
    network.stop();
    throw error;
  }
}
```

Create `e2e/src/fixtures/buyers.ts`:

```ts
import { generateKeyPairSigner, type Address, type KeyPairSigner, type Rpc, type SolanaRpcApi, type TransactionSigner } from "@solana/kit";
import { mintUsdc } from "./usdc.js";

export interface Buyer {
  readonly signer: KeyPairSigner;
  readonly usdcAccount: Address;
}

/** A fresh buyer key holding `usdc` base units in its associated token account, and no SOL (spec §9.1). */
export async function newBuyer(rpc: Rpc<SolanaRpcApi>, mintAuthority: TransactionSigner, usdc: bigint): Promise<Buyer> {
  const signer = await generateKeyPairSigner();
  const usdcAccount = await mintUsdc(rpc, mintAuthority, signer.address, usdc);
  return { signer, usdcAccount };
}
```

Replace `e2e/src/targets/local.ts`:

```ts
import { randomUUID } from "node:crypto";
import { STINT_PROGRAM_ADDRESS } from "@lxfoundry/stint-program-client";
import type { Target } from "@lxfoundry/stint-conformance";
import { startFacilitator, type RunningFacilitator } from "@lxfoundry/stint-facilitator";
import { SOLANA_DEVNET } from "@lxfoundry/stint-x402";
import { SUBSCRIPTIONS_PROGRAM_ADDRESS } from "../fixtures/programs.js";
import { USDC_DEVNET_MINT } from "../fixtures/usdc.js";
import { KORA_ALLOWED_PROGRAMS } from "../kora/config.js";
import { startKora, type KoraProcess } from "../kora/process.js";
import type { LocalNetwork } from "../network/surfnet.js";
import { startLocalChain, type CommonKeys } from "./chain.js";

export type { CommonKeys } from "./chain.js";

export interface LocalStack {
  readonly target: Target;
  readonly network: LocalNetwork;
  readonly keys: CommonKeys;
  readonly kora: KoraProcess;
  readonly facilitator: RunningFacilitator;
  readonly facilitatorApiKey: string;
  stop(): Promise<void>;
}

/** Stops each service in turn, and the network last, even when one of them fails to stop. */
async function stopAll(stops: readonly (() => Promise<void> | void)[]): Promise<void> {
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
 * The `local` target (spec §12.2): the local chain, Kora and the facilitator. Allowance funding
 * joins its capabilities once the facilitator supports it.
 */
export async function startLocalStack(): Promise<LocalStack> {
  const chain = await startLocalChain();
  const stops: (() => Promise<void> | void)[] = [() => chain.stop()];
  try {
    const kora = await startKora({
      rpcUrl: chain.network.rpcUrl,
      config: {
        allowedPrograms: [...KORA_ALLOWED_PROGRAMS, STINT_PROGRAM_ADDRESS, SUBSCRIPTIONS_PROGRAM_ADDRESS],
        allowedTokens: [USDC_DEVNET_MINT],
        maxAllowedLamports: 1_000_000,
      },
      feePayerSecretKey: chain.keys.koraFeePayer.secretKey,
      apiKey: randomUUID(),
    });
    stops.unshift(() => kora.stop());
    const facilitatorApiKey = randomUUID();
    const facilitator = await startFacilitator({
      rpcUrl: chain.network.rpcUrl,
      network: SOLANA_DEVNET,
      kora: { url: kora.url, apiKey: kora.apiKey },
      rentPayerSecretKey: chain.keys.rentPayer.secretKey,
      apiKeys: [facilitatorApiKey],
    });
    stops.unshift(() => facilitator.stop());

    const target: Target = { name: "local", capabilities: new Set(["chain", "stack", "facilitatorApi"]) };
    return {
      target,
      network: chain.network,
      keys: chain.keys,
      kora,
      facilitator,
      facilitatorApiKey,
      stop: () => stopAll(stops),
    };
  } catch (error) {
    await stopAll(stops);
    throw error;
  }
}
```

Update `e2e/src/index.ts`:

```ts
export { startLocalStack, type CommonKeys, type LocalStack } from "./targets/local.js";
export { startLocalChain, type LocalChain } from "./targets/chain.js";
export { newBuyer, type Buyer } from "./fixtures/buyers.js";
export { startLocalNetwork, waitForNewSlot, type LocalNetwork } from "./network/surfnet.js";
export { startKora, type KoraProcess } from "./kora/process.js";
```

Run: `pnpm --filter @lxfoundry/stint-e2e test`
Expected: PASS: the existing network, Kora and local-target tests, unchanged in behaviour.

- [ ] **Step 7: Write the integration tests**

Add to `e2e/test/kora.test.ts`, inside `describe("Kora on the local network")` (import
`createNoopSigner` is already there; add `mintUsdc` to the existing import):

```ts
  it("refuses a transaction in which its fee payer is an SPL transfer authority", async () => {
    const recipient = await newHarnessKey();
    const source = await mintUsdc(network.rpc, mintAuthority.signer, feePayer.signer.address, 1_000_000n);
    const destination = await createUsdcAccount(network.rpc, mintAuthority.signer, recipient.signer.address);
    const { value: latestBlockhash } = await network.rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayer(feePayer.signer.address, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
      (m) =>
        appendTransactionMessageInstructions(
          [
            getTransferCheckedInstruction({
              source,
              mint: USDC_DEVNET_MINT,
              destination,
              authority: createNoopSigner(feePayer.signer.address),
              amount: 1n,
              decimals: USDC_DECIMALS,
            }),
          ],
          m,
        ),
    );
    const partiallySigned = await partiallySignTransactionMessageWithSigners(message);
    const client = createKoraClient(kora.url, kora.apiKey);
    await expect(client.signTransaction(getBase64EncodedWireTransaction(partiallySigned))).rejects.toThrow(
      /Fee payer cannot be used for 'SPL Token Transfer'/,
    );
  });
```

Create `e2e/test/facilitator.test.ts`:

```ts
import { fetchMaybeSession, fetchSession } from "@lxfoundry/stint-program-client";
import {
  SOLANA_DEVNET,
  USDC_DEVNET,
  buildCloseRequirements,
  buildCloseTransaction,
  buildOpenOffer,
  buildOpenTransaction,
  fetchClosedEvent,
  tokenBalanceChanges,
  type ElapsedRequirements,
  type FacilitatorExtra,
  type OfferInput,
  type PaymentPayload,
} from "@lxfoundry/stint-x402";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newBuyer, type Buyer } from "../src/fixtures/buyers.js";
import { startLocalStack, type LocalStack } from "../src/targets/local.js";

describe("facilitator on the local network, through Kora", () => {
  let stack: LocalStack;
  let base: Omit<OfferInput, "seconds" | "lifetime">;

  beforeAll(async () => {
    stack = await startLocalStack();
    const supported = await (await fetch(`${stack.facilitator.url}/supported`)).json();
    base = {
      network: SOLANA_DEVNET,
      asset: USDC_DEVNET.mint,
      payTo: stack.keys.seller.signer.address,
      receiverAuthorizer: stack.keys.receiverAuthorizer.signer.address,
      terms: { rate: 1_000n, minSeconds: 5, maxSeconds: 120 },
      facilitator: supported.kinds[0].extra as FacilitatorExtra,
      maxTimeoutSeconds: 60,
      idleCloseSeconds: 10,
      closeOnOutage: true,
    };
  });

  afterAll(async () => {
    await stack?.stop();
  });

  async function lifetime() {
    const { value } = await stack.network.rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
    return value;
  }

  async function call(path: "/verify" | "/settle", paymentPayload: PaymentPayload, paymentRequirements: ElapsedRequirements) {
    const response = await fetch(`${stack.facilitator.url}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${stack.facilitatorApiKey}` },
      body: JSON.stringify({ x402Version: 2, paymentPayload, paymentRequirements }),
    });
    return response.json();
  }

  async function openPayment(buyer: Buyer, offerOverride?: ElapsedRequirements) {
    const offer = buildOpenOffer({ ...base, seconds: 30, lifetime: await lifetime() });
    const built = await buildOpenTransaction({ requirements: offerOverride ?? offer, authority: buyer.signer, decimals: 6 });
    const payload: PaymentPayload = {
      x402Version: 2,
      resource: { url: "http://gate.test/sessions" },
      accepted: offer,
      payload: { type: "open", transaction: built.transaction, session: built.session },
    };
    return { offer, payload, session: built.session };
  }

  it("verifies an open without changing the chain", async () => {
    const buyer = await newBuyer(stack.network.rpc, stack.keys.mintAuthority.signer, 1_000_000n);
    const { offer, payload, session } = await openPayment(buyer);
    expect(await call("/verify", payload, offer)).toEqual({ isValid: true, payer: buyer.signer.address });
    expect((await fetchMaybeSession(stack.network.rpc, session)).exists).toBe(false);
  });

  it("refuses the fee payer as the vault's funder (payer_misuse)", async () => {
    const buyer = await newBuyer(stack.network.rpc, stack.keys.mintAuthority.signer, 1_000_000n);
    const honest = buildOpenOffer({ ...base, seconds: 30, lifetime: await lifetime() });
    const misplaced = { ...honest, extra: { ...honest.extra, rentPayer: honest.extra.feePayer } };
    const { payload } = await openPayment(buyer, misplaced);
    expect(await call("/verify", { ...payload, accepted: honest }, honest)).toMatchObject({
      isValid: false,
      invalidReason: "payer_misuse",
    });
  });

  it("settles an open, with the rent payer funding the session inside the program (spec §14 Q2), then a close", async () => {
    const buyer = await newBuyer(stack.network.rpc, stack.keys.mintAuthority.signer, 1_000_000n);
    const { offer, payload, session } = await openPayment(buyer);
    const opened = await call("/settle", payload, offer);
    expect(opened).toMatchObject({ success: true, payer: buyer.signer.address, amount: "30000", network: SOLANA_DEVNET });
    const stored = await fetchSession(stack.network.rpc, session);
    expect(stored.data).toMatchObject({ deposited: 30_000n, rentPayer: stack.facilitator.rentPayer, refundOwner: buyer.signer.address });

    const closeLifetime = await lifetime();
    const transaction = await buildCloseTransaction({
      session,
      stored: stored.data,
      closer: stack.keys.receiverAuthorizer.signer,
      feePayer: stack.facilitator.feePayer,
      lifetime: closeLifetime,
    });
    const requirements = buildCloseRequirements({ ...base, lifetime: closeLifetime, session });
    const closed = await call(
      "/settle",
      { x402Version: 2, accepted: requirements, payload: { type: "close", transaction } },
      requirements,
    );
    expect(closed).toMatchObject({ success: true, payer: buyer.signer.address });

    const event = (await fetchClosedEvent(stack.network.rpc, closed.transaction))!;
    expect(closed.amount).toBe((event.owed + event.redirected).toString());
    expect(event.owed + event.refunded).toBe(30_000n);
    const changes = await tokenBalanceChanges(stack.network.rpc, closed.transaction);
    expect(changes.get(stack.keys.sellerUsdcAccount)).toBe(event.owed);
    expect(changes.get(buyer.usdcAccount)).toBe(event.refunded);
    expect((await fetchMaybeSession(stack.network.rpc, session)).exists).toBe(false);
  });
});
```

Run: `pnpm --filter @lxfoundry/stint-e2e test`
Expected: PASS. The third test is the run-time answer to spec §14 question 2: Kora co-signs a
transaction in which the rent payer, not the fee payer, funds `create_account` inside `stint.open`.
If Kora refuses it, the error names the policy rule. Record it and stop: the fallback (the
facilitator signs as fee payer without Kora) changes the design and is not this task's to make.

- [ ] **Step 8: Commit**

```bash
git add pnpm-workspace.yaml packages/x402 apps/facilitator e2e pnpm-lock.yaml
git commit -m "Add the facilitator: verify and settle opens and closes through Kora"
```

---

### Task 7: The gate

**Files:**
- Create: `packages/gate/package.json`, `packages/gate/tsconfig.json`,
  `packages/gate/src/{index,types,facilitator,chain,gate}.ts`
- Test: `packages/gate/test/gate.test.ts`

**Interfaces:**
- Consumes: Task 4 and 5's offers, payloads, tokens, transaction builders, `sessionMatches`;
  `paidUntil`, `parseOpenInstruction`, `identifyStintInstruction` from the program client.
- Produces (`@lxfoundry/stint-gate`):
  - `createGate<U>(config: GateConfig<U>): Gate`, with
    `Gate = { handleRequest(req, res): Promise<boolean>; handleUpgrade(req, socket, head): boolean; close(): Promise<void> }`;
  - `ResourceAdapter<U>`, `SessionInfo = { session: Address; authority: Address; paidUntil: bigint }`,
    `EndReason = "closed" | "expired" | "outage" | "admin" | "closedElsewhere"`;
  - `FacilitatorClient` and `createFacilitatorClient(url, apiKey)`;
  - `GateChain` and `createRpcChain(rpc)`.
- HTTP interface (spec §7.1, the stage 1 subset):
  - `POST /sessions?seconds=N` → `402` (offers), `201 {session, paidUntil, wsUrl}`,
    `202 {session, transaction}`, `400 {error: "invalid_duration", minSeconds, maxSeconds}`,
    `404 {error: "unknown_session"}`;
  - `POST /sessions/:id/close` with a `close` token → `200 {paid, refunded, transaction}` (decimal
    strings), `202 {transaction}`, `401`, `404`, `502 {error, message}`;
  - `GET /sessions/:id/ws` with a `connect` token, in `Authorization: Bearer` or `?token=` →
    upgrade, `401`, `402`, `403`, `404`.
  - `paidUntil` is Unix seconds, as a JSON number.

- [ ] **Step 1: Create the package**

`packages/gate/package.json`:

```json
{
  "name": "@lxfoundry/stint-gate",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "typecheck": "tsc -p tsconfig.json",
    "test": "vitest run"
  },
  "dependencies": {
    "@lxfoundry/stint-program-client": "workspace:*",
    "@lxfoundry/stint-x402": "workspace:*",
    "@solana/kit": "8.5.0",
    "ws": "8.22.0"
  },
  "devDependencies": {
    "@types/ws": "8.18.2"
  }
}
```

and `packages/gate/tsconfig.json` (extends `../../tsconfig.base.json`, includes `src` and `test`).
Run `pnpm install`.

Create `packages/gate/src/types.ts`:

```ts
import type { Address, KeyPairSigner } from "@solana/kit";
import type { Terms } from "@lxfoundry/stint-x402";
import type { WebSocket } from "ws";
import type { GateChain } from "./chain.js";
import type { FacilitatorClient } from "./facilitator.js";

/** What the gate hands the resource (spec §7.6, middleware mode). */
export interface SessionInfo {
  readonly session: Address;
  readonly authority: Address;
  /** Unix seconds. */
  readonly paidUntil: bigint;
}

export type EndReason = "closed" | "expired" | "outage" | "admin" | "closedElsewhere";

/** Spec §7.6. `provision` once when the open settles, `attach` per connection, `teardown` once. */
export interface ResourceAdapter<U = unknown> {
  provision(session: SessionInfo): Promise<U>;
  attach(session: SessionInfo, socket: WebSocket, upstream: U): void;
  teardown(session: SessionInfo, reason: EndReason): Promise<void>;
}

export interface GateConfig<U = unknown> {
  /** The gate's origin, e.g. `http://127.0.0.1:4000`: the `aud` of session tokens (spec §7.2). */
  readonly origin: string;
  readonly network: string;
  readonly asset: { readonly mint: Address; readonly decimals: number };
  /** The seller's wallet (spec §5.1). */
  readonly payTo: Address;
  /** One per resource (spec §7.1); signs closes. */
  readonly receiverAuthorizer: KeyPairSigner;
  readonly terms: Terms;
  /** Durations offered when a request names none (spec §5.2). Default: `[terms.minSeconds]`. */
  readonly durations?: readonly number[];
  /** Default 60 (spec §7.5). Announced in offers; enforced by a later stage. */
  readonly idleCloseSeconds?: number;
  /** Default true (spec §7.5). Announced in offers; enforced by a later stage. */
  readonly closeOnOutage?: boolean;
  /** Default 60. At most the time an offer's blockhash has left (spec §5.1). */
  readonly maxTimeoutSeconds?: number;
  /** A connect within this many seconds of `paidUntil` is refused (spec §7.2, check 5). Default 2. */
  readonly marginSeconds?: number;
  readonly facilitator: FacilitatorClient;
  readonly chain: GateChain;
  readonly adapter: ResourceAdapter<U>;
  /** Milliseconds. Checks token times and the `jti` cache (spec §7.3). Default `Date.now`. */
  readonly tokenClock?: () => number;
  /** Milliseconds. Runs the margin (spec §7.3). Default `Date.now`. */
  readonly sessionClock?: () => number;
  readonly log?: (entry: Record<string, unknown>) => void;
}
```

Create `packages/gate/src/facilitator.ts`:

```ts
import type { PaymentPayload, PaymentRequirements, SettleResponse, SupportedResponse, VerifyResponse } from "@lxfoundry/stint-x402";

/** The facilitator's interface for resource servers (spec §6.1). */
export interface FacilitatorClient {
  supported(): Promise<SupportedResponse>;
  verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse>;
  settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse>;
}

export function createFacilitatorClient(url: string, apiKey: string): FacilitatorClient {
  async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${url}${path}`, {
      method,
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new Error(`Facilitator ${path}: HTTP ${response.status} ${await response.text()}`);
    return (await response.json()) as T;
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

Create `packages/gate/src/chain.ts`:

```ts
import type { Address, Rpc, SolanaRpcApi } from "@solana/kit";
import { fetchMaybeSession, type ClosedEvent, type Session } from "@lxfoundry/stint-program-client";
import { fetchClosedEvent } from "@lxfoundry/stint-x402";

/** The chain reads the gate needs, so tests can replace them. */
export interface GateChain {
  latestBlockhash(): Promise<{ readonly blockhash: string; readonly lastValidBlockHeight: bigint }>;
  /** The session at `confirmed`, or undefined when no account is there. */
  readSession(session: Address): Promise<Session | undefined>;
  closedEvent(signature: string): Promise<ClosedEvent | undefined>;
}

export function createRpcChain(rpc: Rpc<SolanaRpcApi>): GateChain {
  return {
    latestBlockhash: async () => (await rpc.getLatestBlockhash({ commitment: "confirmed" }).send()).value,
    readSession: async (session) => {
      const account = await fetchMaybeSession(rpc, session, { commitment: "confirmed" });
      return account.exists ? account.data : undefined;
    },
    closedEvent: (signature) => fetchClosedEvent(rpc, signature),
  };
}
```

- [ ] **Step 2: Write the failing gate tests**

Create `packages/gate/test/gate.test.ts`:

```ts
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { generateKeyPairSigner, type Address, type KeyPairSigner } from "@solana/kit";
import { CloseKind, type ClosedEvent, type Session } from "@lxfoundry/stint-program-client";
import {
  USDC_DEVNET,
  buildOpenTransaction,
  createSessionToken,
  decodePaymentRequiredHeader,
  encodePaymentSignatureHeader,
  inspectTransaction,
  readElapsedPayload,
  type PaymentPayload,
  type PaymentRequired,
  type SettleResponse,
  type VerifyResponse,
} from "@lxfoundry/stint-x402";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { createGate, type EndReason, type Gate, type GateChain, type SessionInfo } from "../src/index.js";

const NOW_MS = 1_800_000_000_000;

interface Harness {
  readonly url: string;
  readonly gate: Gate;
  readonly server: Server;
  readonly buyer: KeyPairSigner;
  readonly authorizer: KeyPairSigner;
  readonly calls: { verify: PaymentPayload[]; settle: PaymentPayload[]; provision: SessionInfo[]; attach: SessionInfo[]; teardown: EndReason[] };
  verifyAnswer: VerifyResponse;
  settleAnswer: (payload: PaymentPayload) => SettleResponse;
  sessions: Map<Address, Session>;
}

async function startHarness(): Promise<Harness> {
  const buyer = await generateKeyPairSigner();
  const authorizer = await generateKeyPairSigner();
  const seller = await generateKeyPairSigner();
  const feePayer = (await generateKeyPairSigner()).address;
  const rentPayer = (await generateKeyPairSigner()).address;
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const harness = {
    url,
    server,
    buyer,
    authorizer,
    calls: { verify: [], settle: [], provision: [], attach: [], teardown: [] },
    verifyAnswer: { isValid: true },
    settleAnswer: () => ({ success: true, transaction: "sig", network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" }),
    sessions: new Map<Address, Session>(),
  } as unknown as Harness;

  const chain: GateChain = {
    latestBlockhash: async () => ({ blockhash: "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N", lastValidBlockHeight: 100n }),
    readSession: async (session) => harness.sessions.get(session),
    closedEvent: async () =>
      ({ claimed: 0n, owed: 8_000n, refunded: 22_000n, redirected: 0n, kind: CloseKind.Standard }) as ClosedEvent,
  };
  const gate = createGate({
    origin: url,
    network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
    asset: USDC_DEVNET,
    payTo: seller.address,
    receiverAuthorizer: authorizer,
    terms: { rate: 1_000n, minSeconds: 5, maxSeconds: 120 },
    durations: [30, 60],
    idleCloseSeconds: 10,
    facilitator: {
      supported: async () => ({
        kinds: [
          {
            x402Version: 2,
            scheme: "elapsed",
            network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
            extra: { feePayer, rentPayer, programId: "5iCYPqLjCWw5KzQTU6NBUhR2hxg5SWGmS1ctUn3qESvr", closeUrl: "http://f/close" },
          },
        ],
        extensions: [],
        signers: {},
      }),
      verify: async (payload) => (harness.calls.verify.push(payload), harness.verifyAnswer),
      settle: async (payload) => (harness.calls.settle.push(payload), harness.settleAnswer(payload)),
    },
    chain,
    adapter: {
      provision: async (info) => void harness.calls.provision.push(info),
      attach: (info, socket) => {
        harness.calls.attach.push(info);
        socket.send(JSON.stringify({ type: "hello" }));
      },
      teardown: async (_, reason) => void harness.calls.teardown.push(reason),
    },
    tokenClock: () => NOW_MS,
    sessionClock: () => NOW_MS,
  });
  server.on("request", (req, res) => {
    void gate.handleRequest(req, res).then((handled) => {
      if (!handled) res.writeHead(404).end();
    });
  });
  server.on("upgrade", (req, socket, head) => {
    if (!gate.handleUpgrade(req, socket, head)) socket.destroy();
  });
  return Object.assign(harness, { gate });
}

describe("gate", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await startHarness();
  });

  afterEach(async () => {
    await h.gate.close();
    h.server.closeAllConnections();
    await new Promise((resolve) => h.server.close(resolve));
  });

  async function offers(seconds?: number): Promise<{ status: number; body: PaymentRequired; header: string | null }> {
    const response = await fetch(`${h.url}/sessions${seconds === undefined ? "" : `?seconds=${seconds}`}`, { method: "POST" });
    return { status: response.status, body: await response.json(), header: response.headers.get("payment-required") };
  }

  /** Pays for the first offer and records the session on the fake chain as the program would. */
  async function open(): Promise<{ session: Address; status: number; body: Record<string, unknown> }> {
    const { body: required } = await offers(30);
    const offer = required.accepts[0]!;
    const built = await buildOpenTransaction({ requirements: offer as never, authority: h.buyer, decimals: 6 });
    h.sessions.set(built.session, {
      authority: h.buyer.address,
      mint: USDC_DEVNET.mint,
      receiver: offer.payTo as Address,
      receiverAuthorizer: h.authorizer.address,
      refundOwner: h.buyer.address,
      rentPayer: offer.extra.rentPayer as Address,
      rate: 1_000n,
      minSeconds: 5,
      maxSeconds: 120,
      startedAt: BigInt(NOW_MS / 1000),
      deposited: 30_000n,
      claimed: 0n,
    } as Session);
    const payload: PaymentPayload = {
      x402Version: 2,
      resource: required.resource,
      accepted: offer,
      payload: { type: "open", transaction: built.transaction, session: built.session },
    };
    const response = await fetch(`${h.url}/sessions?seconds=30`, {
      method: "POST",
      headers: { "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(payload) },
    });
    return { session: built.session, status: response.status, body: await response.json() };
  }

  const token = (session: Address, purpose: "connect" | "close", audience = h.url) =>
    createSessionToken(h.buyer, { session, audience, purpose }, { nowMs: NOW_MS });

  function connect(session: Address, bearer?: string, query?: string): Promise<{ status?: number; socket?: WebSocket }> {
    const url = `${h.url.replace("http", "ws")}/sessions/${session}/ws${query ? `?token=${query}` : ""}`;
    const socket = new WebSocket(url, bearer ? { headers: { authorization: `Bearer ${bearer}` } } : {});
    return new Promise((resolve) => {
      socket.once("open", () => resolve({ socket }));
      socket.once("unexpected-response", (_, response) => resolve({ status: response.statusCode }));
    });
  }

  it("answers 402 with one entry per menu duration, in the body and the header", async () => {
    const { status, body, header } = await offers();
    expect(status).toBe(402);
    expect(body.accepts.map((entry) => [entry.extra.seconds, entry.amount])).toEqual([
      [30, "30000"],
      [60, "60000"],
    ]);
    expect(decodePaymentRequiredHeader(header!)).toEqual(body);
  });

  it("answers 400 invalid_duration, with the bounds, outside minSeconds..maxSeconds", async () => {
    const response = await fetch(`${h.url}/sessions?seconds=3`, { method: "POST" });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_duration", minSeconds: 5, maxSeconds: 120 });
  });

  it("opens a session the facilitator settles: 201, and provision once", async () => {
    const { session, status, body } = await open();
    expect(status).toBe(201);
    expect(body).toEqual({
      session,
      paidUntil: NOW_MS / 1000 + 30,
      wsUrl: `${h.url.replace("http", "ws")}/sessions/${session}/ws`,
    });
    expect(h.calls.provision).toHaveLength(1);
    expect(h.calls.verify).toHaveLength(1);
    expect(h.calls.settle).toHaveLength(1);
  });

  it("answers 402 with the facilitator's reason when verification fails, and settles nothing", async () => {
    h.verifyAnswer = { isValid: false, invalidReason: "invalid_amount" };
    const { status, body } = await open();
    expect(status).toBe(402);
    expect(body.error).toBe("invalid_amount");
    expect(h.calls.settle).toHaveLength(0);
  });

  it("accepts a connection with a connect token, in the header or the URL, and attaches it", async () => {
    const { session } = await open();
    const viaHeader = await connect(session, await token(session, "connect"));
    expect(viaHeader.socket).toBeDefined();
    const viaQuery = await connect(session, undefined, await token(session, "connect"));
    expect(viaQuery.socket).toBeDefined();
    expect(h.calls.attach).toHaveLength(2);
    viaHeader.socket!.close();
    viaQuery.socket!.close();
  });

  it("refuses connections before the upgrade: 401 without, with a wrong or a replayed token; 404 unknown", async () => {
    const { session } = await open();
    expect((await connect(session)).status).toBe(401);
    expect((await connect(session, await token(session, "close"))).status).toBe(401);
    expect((await connect(session, await token(session, "connect", "http://elsewhere"))).status).toBe(401);
    const once = await token(session, "connect");
    (await connect(session, once)).socket!.close();
    expect((await connect(session, once)).status).toBe(401);
    expect((await connect(h.buyer.address, await token(h.buyer.address, "connect"))).status).toBe(404);
  });

  it("closes on the buyer's request: settles a close signed by the receiver authorizer, then drops connections with 4410", async () => {
    const { session } = await open();
    const { socket } = await connect(session, await token(session, "connect"));
    const closed = new Promise<number>((resolve) => socket!.once("close", (code) => resolve(code)));

    const response = await fetch(`${h.url}/sessions/${session}/close`, {
      method: "POST",
      headers: { authorization: `Bearer ${await token(session, "close")}` },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ paid: "8000", refunded: "22000", transaction: "sig" });
    expect(await closed).toBe(4410);
    expect(h.calls.teardown).toEqual(["closed"]);

    const closePayload = h.calls.settle.at(-1)!;
    expect(closePayload.accepted.extra).toMatchObject({ action: "close", session });
    expect(closePayload.accepted.amount).toBe("0");
    const tx = inspectTransaction(readElapsedPayload(closePayload)!.transaction)!;
    expect([...tx.signed]).toEqual([h.authorizer.address]);
  });

  it("refuses a close without a close token", async () => {
    const { session } = await open();
    const response = await fetch(`${h.url}/sessions/${session}/close`, {
      method: "POST",
      headers: { authorization: `Bearer ${await token(session, "connect")}` },
    });
    expect(response.status).toBe(401);
  });
});
```

Run: `pnpm --filter @lxfoundry/stint-gate test`
Expected: FAIL: `../src/index.js` does not exist.

- [ ] **Step 3: Implement the gate**

Create `packages/gate/src/gate.ts`:

```ts
import { STATUS_CODES, type IncomingMessage, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { address, type Address } from "@solana/kit";
import {
  STINT_PROGRAM_ADDRESS,
  StintInstruction,
  identifyStintInstruction,
  paidUntil,
  parseOpenInstruction,
  type Session,
} from "@lxfoundry/stint-program-client";
import {
  HEADERS,
  SCHEME,
  X402_VERSION,
  buildCloseRequirements,
  buildCloseTransaction,
  buildOpenOffer,
  checkOpenDuration,
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
  inspectTransaction,
  readElapsedPayload,
  readElapsedRequirements,
  sendJson,
  sessionMatches,
  verifySessionToken,
  type FacilitatorExtra,
  type OfferInput,
  type PaymentPayload,
  type PaymentRequired,
  type SellerTerms,
  type TokenPurpose,
} from "@lxfoundry/stint-x402";
import { WebSocketServer, type WebSocket } from "ws";
import type { EndReason, GateConfig, SessionInfo } from "./types.js";

export interface Gate {
  /** Serves the gate's HTTP routes; resolves false for any other request, which the host serves. */
  handleRequest(request: IncomingMessage, response: ServerResponse): Promise<boolean>;
  /** Serves `GET /sessions/:id/ws`; returns false for any other upgrade. */
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): boolean;
  /** Drops every connection. */
  close(): Promise<void>;
}

interface Tracked<U> {
  readonly info: SessionInfo;
  readonly stored: Session;
  readonly upstream: U;
  readonly connections: Set<WebSocket>;
}

const SESSION_PATH = /^\/sessions\/([1-9A-HJ-NP-Za-km-z]{32,44})\/(ws|close)$/;
const TOKEN_SKEW_MS = 30_000;

/** The gate (spec §7), as middleware: it hands the resource a verified `SessionInfo` (spec §7.6). */
export function createGate<U>(config: GateConfig<U>): Gate {
  const tokenClock = config.tokenClock ?? Date.now;
  const sessionClock = config.sessionClock ?? Date.now;
  const log = config.log ?? (() => {});
  const menu = config.durations ?? [config.terms.minSeconds];
  const marginMs = (config.marginSeconds ?? 2) * 1000;
  const wss = new WebSocketServer({ noServer: true });
  const sessions = new Map<Address, Tracked<U>>();
  /** `jti` → when it may be forgotten (ms on the token clock). */
  const seenTokens = new Map<string, number>();
  let facilitatorExtra: FacilitatorExtra | undefined;

  const seller: SellerTerms = {
    programId: STINT_PROGRAM_ADDRESS,
    asset: config.asset.mint,
    payTo: config.payTo,
    receiverAuthorizer: config.receiverAuthorizer.address,
    terms: config.terms,
  };
  const wsUrl = (session: Address) => `${config.origin.replace(/^http/, "ws")}/sessions/${session}/ws`;

  /** `feePayer`, `rentPayer`, `programId` and `closeUrl` are copied from `/supported` (spec §5.1). */
  async function fromFacilitator(): Promise<FacilitatorExtra> {
    if (facilitatorExtra) return facilitatorExtra;
    const supported = await config.facilitator.supported();
    const kind = supported.kinds.find(
      (entry) => entry.x402Version === X402_VERSION && entry.scheme === SCHEME && entry.network === config.network,
    );
    const extra = (kind?.extra ?? {}) as Partial<Record<keyof FacilitatorExtra, unknown>>;
    const { feePayer, rentPayer, programId, closeUrl } = extra;
    if (typeof feePayer !== "string" || typeof rentPayer !== "string" || typeof closeUrl !== "string" || programId !== STINT_PROGRAM_ADDRESS) {
      throw new Error(`The facilitator does not support ${SCHEME} for this program on ${config.network}`);
    }
    facilitatorExtra = { feePayer, rentPayer, programId, closeUrl };
    return facilitatorExtra;
  }

  async function offerBase(lifetime?: OfferInput["lifetime"]): Promise<Omit<OfferInput, "seconds">> {
    return {
      network: config.network,
      asset: config.asset.mint,
      payTo: config.payTo,
      receiverAuthorizer: config.receiverAuthorizer.address,
      terms: config.terms,
      facilitator: await fromFacilitator(),
      lifetime: lifetime ?? (await config.chain.latestBlockhash()),
      maxTimeoutSeconds: config.maxTimeoutSeconds ?? 60,
      idleCloseSeconds: config.idleCloseSeconds ?? 60,
      closeOnOutage: config.closeOnOutage ?? true,
    };
  }

  async function paymentRequired(response: ServerResponse, durations: readonly number[], error?: string): Promise<void> {
    const base = await offerBase();
    const body: PaymentRequired = {
      x402Version: X402_VERSION,
      ...(error === undefined ? {} : { error }),
      resource: { url: `${config.origin}/sessions` },
      accepts: durations.map((seconds) => buildOpenOffer({ ...base, seconds })),
    };
    sendJson(response, 402, body, { [HEADERS.paymentRequired]: encodePaymentRequiredHeader(body) });
  }

  /** The session the payload's `stint.open` creates, read from the transaction itself. */
  function sessionOpenedBy(payload: PaymentPayload): Address | undefined {
    const elapsed = readElapsedPayload(payload);
    const tx = elapsed?.type === "open" ? inspectTransaction(elapsed.transaction) : undefined;
    for (const ix of tx?.instructions ?? []) {
      if (ix.programAddress !== STINT_PROGRAM_ADDRESS || !ix.accounts || !ix.data) continue;
      try {
        if (identifyStintInstruction(ix.data) !== StintInstruction.Open) continue;
        return parseOpenInstruction(ix as Parameters<typeof parseOpenInstruction>[0]).accounts.session.address;
      } catch {
        return undefined;
      }
    }
    return undefined;
  }

  async function open(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    const requested = url.searchParams.get("seconds");
    const durations = requested === null ? menu : [Number(requested)];
    for (const seconds of durations) {
      const check = checkOpenDuration(config.terms, seconds);
      if (!check.ok) return sendJson(response, 400, { error: "invalid_duration", minSeconds: check.minSeconds, maxSeconds: check.maxSeconds });
    }

    const header = request.headers[HEADERS.paymentSignature.toLowerCase()];
    if (typeof header !== "string") return paymentRequired(response, durations);
    let payload: PaymentPayload;
    try {
      payload = decodePaymentSignatureHeader(header);
    } catch {
      return paymentRequired(response, durations, "invalid_payload");
    }
    const accepted = readElapsedRequirements(payload.accepted);
    if (!accepted || accepted.extra.action !== "open" || !durations.includes(accepted.extra.seconds)) {
      return paymentRequired(response, durations, "invalid_payment_requirements");
    }
    const session = sessionOpenedBy(payload);
    if (!session) return paymentRequired(response, durations, "invalid_payload");

    // The requirements as this gate issues them: its own terms, with the advisory fields of the
    // entry the client accepted, which only a fresh offer changes (spec §5.5, "Idempotency").
    const requirements = buildOpenOffer({
      ...(await offerBase({
        blockhash: accepted.extra.recentBlockhash,
        lastValidBlockHeight: BigInt(accepted.extra.lastValidBlockHeight),
      })),
      maxTimeoutSeconds: accepted.maxTimeoutSeconds,
      seconds: accepted.extra.seconds,
    });

    const verified = await config.facilitator.verify(payload, requirements);
    if (!verified.isValid) return paymentRequired(response, durations, verified.invalidReason ?? "invalid_payload");
    const settled = await config.facilitator.settle(payload, requirements);
    const paymentResponse = { [HEADERS.paymentResponse]: encodePaymentResponseHeader(settled) };
    log({ event: "open", session, success: settled.success, reason: settled.errorReason });
    if (!settled.success) {
      if (settled.errorReason === "settlement_pending") {
        return sendJson(response, 202, { session, transaction: settled.transaction }, paymentResponse);
      }
      return paymentRequired(response, durations, settled.errorReason ?? "simulation_failed");
    }

    const stored = await config.chain.readSession(session);
    if (!stored) return sendJson(response, 404, { error: "unknown_session" });
    let tracked = sessions.get(session);
    if (!tracked) {
      const info: SessionInfo = { session, authority: stored.authority, paidUntil: paidUntil(stored) };
      tracked = { info, stored, upstream: await config.adapter.provision(info), connections: new Set() };
      sessions.set(session, tracked);
    }
    sendJson(response, 201, { session, paidUntil: Number(tracked.info.paidUntil), wsUrl: wsUrl(session) }, paymentResponse);
  }

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
    if (!check.ok) return false;
    for (const [jti, forgetAt] of seenTokens) if (forgetAt < now) seenTokens.delete(jti);
    if (seenTokens.has(check.claims.jti)) return false;
    seenTokens.set(check.claims.jti, check.claims.exp * 1000 + TOKEN_SKEW_MS);
    return true;
  }

  const bearer = (request: IncomingMessage) => {
    const value = request.headers.authorization;
    return value?.startsWith("Bearer ") ? value.slice("Bearer ".length) : undefined;
  };

  async function end(tracked: Tracked<U>, reason: EndReason, code: number): Promise<void> {
    sessions.delete(tracked.info.session);
    for (const socket of tracked.connections) socket.close(code, "session closed");
    await config.adapter.teardown(tracked.info, reason);
  }

  async function closeSession(request: IncomingMessage, response: ServerResponse, session: Address): Promise<void> {
    const tracked = sessions.get(session);
    if (!tracked) return sendJson(response, 404, { error: "unknown_session" });
    if (!(await authenticate(bearer(request), tracked, "close"))) return sendJson(response, 401, { error: "unauthorized" });

    const base = await offerBase();
    const transaction = await buildCloseTransaction({
      session,
      stored: tracked.stored,
      closer: config.receiverAuthorizer,
      feePayer: address(base.facilitator.feePayer),
      lifetime: base.lifetime,
    });
    const requirements = buildCloseRequirements({ ...base, session });
    const payload: PaymentPayload = {
      x402Version: X402_VERSION,
      resource: { url: `${config.origin}/sessions/${session}/close` },
      accepted: requirements,
      payload: { type: "close", transaction },
    };
    const settled = await config.facilitator.settle(payload, requirements);
    log({ event: "close", session, success: settled.success, reason: settled.errorReason });
    if (!settled.success) {
      if (settled.errorReason === "settlement_pending") return sendJson(response, 202, { transaction: settled.transaction });
      return sendJson(response, 502, { error: settled.errorReason ?? "settlement_failed", message: settled.errorMessage });
    }
    const event = await config.chain.closedEvent(settled.transaction);
    // The close is confirmed: connections are dropped only now (spec §7.3).
    await end(tracked, "closed", 4410);
    if (!event) return sendJson(response, 502, { error: "no_closed_event", transaction: settled.transaction });
    sendJson(response, 200, {
      paid: (event.claimed + event.owed + event.redirected).toString(),
      refunded: event.refunded.toString(),
      transaction: settled.transaction,
    });
  }

  function refuseUpgrade(socket: Duplex, status: number): void {
    socket.end(`HTTP/1.1 ${status} ${STATUS_CODES[status]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  }

  async function connect(request: IncomingMessage, socket: Duplex, head: Buffer, url: URL, session: Address): Promise<void> {
    const tracked = sessions.get(session);
    if (!tracked) return refuseUpgrade(socket, 404);
    const token = bearer(request) ?? url.searchParams.get("token") ?? undefined;
    if (!(await authenticate(token, tracked, "connect"))) return refuseUpgrade(socket, 401);
    if (!sessionMatches(tracked.stored, seller)) return refuseUpgrade(socket, 403);
    if (Number(tracked.info.paidUntil) * 1000 - sessionClock() <= marginMs) return refuseUpgrade(socket, 402);
    wss.handleUpgrade(request, socket, head, (ws) => {
      tracked.connections.add(ws);
      ws.once("close", () => tracked.connections.delete(ws));
      config.adapter.attach(tracked.info, ws, tracked.upstream);
    });
  }

  return {
    async handleRequest(request, response) {
      const url = new URL(request.url ?? "/", config.origin);
      if (request.method === "POST" && url.pathname === "/sessions") {
        await open(request, response, url);
        return true;
      }
      const match = SESSION_PATH.exec(url.pathname);
      if (request.method === "POST" && match?.[2] === "close") {
        await closeSession(request, response, address(match[1]!));
        return true;
      }
      return false;
    },
    handleUpgrade(request, socket, head) {
      const url = new URL(request.url ?? "/", config.origin);
      const match = SESSION_PATH.exec(url.pathname);
      if (match?.[2] !== "ws") return false;
      connect(request, socket, head, url, address(match[1]!)).catch((error: unknown) => {
        log({ event: "error", error: error instanceof Error ? error.message : String(error) });
        refuseUpgrade(socket, 500);
      });
      return true;
    },
    async close() {
      for (const tracked of sessions.values()) for (const socket of tracked.connections) socket.close(1001, "gate stopping");
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}
```

`sessionOpenedBy` reads the session from the payment's own transaction, never from
`payload.session`, which spec §5.3 makes informative only. The `parseOpenInstruction` cast is
needed because `inspectTransaction` returns Kit's general `Instruction` type; the guards before it
ensure accounts and data are present.

Create `packages/gate/src/index.ts`:

```ts
export { createGate, type Gate } from "./gate.js";
export type { EndReason, GateConfig, ResourceAdapter, SessionInfo } from "./types.js";
export { createFacilitatorClient, type FacilitatorClient } from "./facilitator.js";
export { createRpcChain, type GateChain } from "./chain.js";
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @lxfoundry/stint-gate test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/gate pnpm-lock.yaml
git commit -m "Add the gate: offers, opens through the facilitator, session tokens, the buyer's close"
```

---
### Task 8: The example stream

**Files:**
- Create: `examples/solana-stream/package.json`, `examples/solana-stream/tsconfig.json`,
  `examples/solana-stream/src/{index,adapter,server}.ts`
- Test: `examples/solana-stream/test/adapter.test.ts`

**Interfaces:**
- Consumes: Task 7's `createGate`, `GateConfig`, `ResourceAdapter`.
- Produces (`@lxfoundry/stint-example-stream`):
  - `startStream(config: StreamConfig): Promise<RunningStream>`, where
    `StreamConfig = { host?; port?; rpcWsUrl: string; gate: Omit<GateConfig<null>, "origin" | "adapter"> }`
    and `RunningStream = { url: string; stop(): Promise<void> }`;
  - `createStreamAdapter(subscriptions): ResourceAdapter<null>`;
  - `parseClientMessage(text): Parsed`; `MAX_ACCOUNTS = 10`.
- Wire messages (spec §8):
  - client → server: `{"op": "subscribe" | "unsubscribe", "accounts": [...]}`;
  - server → client:
    - `{"type": "account", "address", "slot", "lamports", "owner", "encoding", "data"}`, with
      `slot` and `lamports` as decimal strings (the `u64` rule of spec §5.1);
    - `{"type": "error", "code", "message"}`, where `code` is one of `invalid_json`,
      `invalid_message`, `invalid_address`, `too_many_accounts`, `subscription_failed`.
  - The limit of 10 accounts applies per connection. A gate allows one live connection per session
    (spec §7.3), so this is also the per-session limit. A reconnecting client subscribes again.

- [ ] **Step 1: Create the package**

`examples/solana-stream/package.json`:

```json
{
  "name": "@lxfoundry/stint-example-stream",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "typecheck": "tsc -p tsconfig.json",
    "test": "vitest run"
  },
  "dependencies": {
    "@lxfoundry/stint-gate": "workspace:*",
    "@lxfoundry/stint-x402": "workspace:*",
    "@solana/kit": "8.5.0",
    "ws": "8.22.0"
  },
  "devDependencies": {
    "@types/ws": "8.18.2"
  }
}
```

and `examples/solana-stream/tsconfig.json` (extends `../../tsconfig.base.json`, includes `src`
and `test`). Run `pnpm install`.

- [ ] **Step 2: Write the failing adapter tests**

Create `examples/solana-stream/test/adapter.test.ts`:

```ts
import { EventEmitter } from "node:events";
import { generateKeyPairSigner, type RpcSubscriptions, type SolanaRpcSubscriptionsApi } from "@solana/kit";
import { describe, expect, it } from "vitest";
import type { WebSocket } from "ws";
import { MAX_ACCOUNTS, createStreamAdapter, parseClientMessage } from "../src/index.js";

class FakeSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  readonly sent: Record<string, unknown>[] = [];
  send(text: string): void {
    this.sent.push(JSON.parse(text));
  }
}

/** Account subscriptions that yield `notifications` once each, then wait until aborted. */
function fakeSubscriptions(notifications: unknown[]) {
  const signals: AbortSignal[] = [];
  const subscriptions = {
    accountNotifications: () => ({
      subscribe: async ({ abortSignal }: { abortSignal: AbortSignal }) => {
        signals.push(abortSignal);
        return (async function* () {
          yield* notifications;
          await new Promise((resolve) => abortSignal.addEventListener("abort", resolve));
        })();
      },
    }),
  };
  return { subscriptions: subscriptions as unknown as RpcSubscriptions<SolanaRpcSubscriptionsApi>, signals };
}

const info = { session: "11111111111111111111111111111111", authority: "11111111111111111111111111111111", paidUntil: 0n } as never;
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

describe("stream messages (spec §8)", () => {
  it("parses subscribe and unsubscribe, and refuses anything else", () => {
    const account = "So11111111111111111111111111111111111111112";
    expect(parseClientMessage(JSON.stringify({ op: "subscribe", accounts: [account] }))).toEqual({
      ok: true,
      message: { op: "subscribe", accounts: [account] },
    });
    expect(parseClientMessage("{")).toMatchObject({ ok: false, code: "invalid_json" });
    expect(parseClientMessage(JSON.stringify({ op: "watch", accounts: [] }))).toMatchObject({ ok: false, code: "invalid_message" });
    expect(parseClientMessage(JSON.stringify({ op: "subscribe", accounts: ["nope"] }))).toMatchObject({ ok: false, code: "invalid_address" });
  });
});

describe("stream adapter", () => {
  it("forwards account notifications, with u64 values as decimal strings", async () => {
    const account = (await generateKeyPairSigner()).address;
    const { subscriptions } = fakeSubscriptions([
      {
        context: { slot: 42n },
        value: { lamports: 2_039_280n, owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", data: { parsed: { info: { tokenAmount: { amount: "5" } } } } },
      },
    ]);
    const socket = new FakeSocket();
    createStreamAdapter(subscriptions).attach(info, socket as unknown as WebSocket, null);
    socket.emit("message", JSON.stringify({ op: "subscribe", accounts: [account] }));
    await tick();
    expect(socket.sent).toEqual([
      {
        type: "account",
        address: account,
        slot: "42",
        lamports: "2039280",
        owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
        encoding: "jsonParsed",
        data: { parsed: { info: { tokenAmount: { amount: "5" } } } },
      },
    ]);
  });

  it("refuses more than 10 accounts on a connection", async () => {
    const { subscriptions } = fakeSubscriptions([]);
    const socket = new FakeSocket();
    createStreamAdapter(subscriptions).attach(info, socket as unknown as WebSocket, null);
    const accounts = await Promise.all(Array.from({ length: MAX_ACCOUNTS + 1 }, async () => (await generateKeyPairSigner()).address));
    socket.emit("message", JSON.stringify({ op: "subscribe", accounts }));
    expect(socket.sent).toEqual([{ type: "error", code: "too_many_accounts", message: "at most 10 accounts per connection" }]);
  });

  it("ends every subscription when the connection closes", async () => {
    const { subscriptions, signals } = fakeSubscriptions([]);
    const socket = new FakeSocket();
    createStreamAdapter(subscriptions).attach(info, socket as unknown as WebSocket, null);
    const account = (await generateKeyPairSigner()).address;
    socket.emit("message", JSON.stringify({ op: "subscribe", accounts: [account] }));
    await tick();
    socket.emit("close");
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });
});
```

Run: `pnpm --filter @lxfoundry/stint-example-stream test`
Expected: FAIL: `../src/index.js` does not exist.

- [ ] **Step 3: Implement the adapter and the server**

Create `examples/solana-stream/src/adapter.ts`:

```ts
import { address, type Address, type RpcSubscriptions, type SolanaRpcSubscriptionsApi } from "@solana/kit";
import type { ResourceAdapter } from "@lxfoundry/stint-gate";

/** Accounts one connection may watch (spec §8). */
export const MAX_ACCOUNTS = 10;

export interface ClientMessage {
  readonly op: "subscribe" | "unsubscribe";
  readonly accounts: readonly Address[];
}

export type Parsed =
  | { readonly ok: true; readonly message: ClientMessage }
  | { readonly ok: false; readonly code: "invalid_json" | "invalid_message" | "invalid_address"; readonly message: string };

export function parseClientMessage(text: string): Parsed {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, code: "invalid_json", message: "messages are JSON" };
  }
  const record = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  if ((record.op !== "subscribe" && record.op !== "unsubscribe") || !Array.isArray(record.accounts)) {
    return { ok: false, code: "invalid_message", message: 'expected {"op": "subscribe" | "unsubscribe", "accounts": [...]}' };
  }
  try {
    return { ok: true, message: { op: record.op, accounts: record.accounts.map((account) => address(String(account))) } };
  } catch {
    return { ok: false, code: "invalid_address", message: "accounts are base58 addresses" };
  }
}

const toJson = (value: unknown) => JSON.stringify(value, (_, inner) => (typeof inner === "bigint" ? inner.toString() : inner));

/**
 * Streams account changes at `confirmed` (spec §8). Nothing is provisioned: the stream needs no
 * per-session resource. Subscriptions belong to a connection and end with it.
 */
export function createStreamAdapter(subscriptions: RpcSubscriptions<SolanaRpcSubscriptionsApi>): ResourceAdapter<null> {
  return {
    provision: async () => null,
    attach(_session, socket) {
      const watching = new Map<Address, AbortController>();
      const send = (message: object) => {
        if (socket.readyState === socket.OPEN) socket.send(toJson(message));
      };

      async function watch(account: Address, controller: AbortController): Promise<void> {
        try {
          const notifications = await subscriptions
            .accountNotifications(account, { commitment: "confirmed", encoding: "jsonParsed" })
            .subscribe({ abortSignal: controller.signal });
          for await (const { context, value } of notifications) {
            const parsed = !Array.isArray(value.data);
            send({
              type: "account",
              address: account,
              slot: context.slot,
              lamports: value.lamports,
              owner: value.owner,
              encoding: parsed ? "jsonParsed" : "base64",
              data: Array.isArray(value.data) ? value.data[0] : value.data,
            });
          }
        } catch (error) {
          if (!controller.signal.aborted) {
            send({ type: "error", code: "subscription_failed", message: `${account}: ${error instanceof Error ? error.message : String(error)}` });
          }
        }
      }

      socket.on("message", (data) => {
        const parsed = parseClientMessage(String(data));
        if (!parsed.ok) return send({ type: "error", code: parsed.code, message: parsed.message });
        const { op, accounts } = parsed.message;
        if (op === "unsubscribe") {
          for (const account of accounts) {
            watching.get(account)?.abort();
            watching.delete(account);
          }
          return;
        }
        const added = [...new Set(accounts)].filter((account) => !watching.has(account));
        if (watching.size + added.length > MAX_ACCOUNTS) {
          return send({ type: "error", code: "too_many_accounts", message: `at most ${MAX_ACCOUNTS} accounts per connection` });
        }
        for (const account of added) {
          const controller = new AbortController();
          watching.set(account, controller);
          void watch(account, controller);
        }
      });

      socket.on("close", () => {
        for (const controller of watching.values()) controller.abort();
        watching.clear();
      });
    },
    teardown: async () => {},
  };
}
```

Create `examples/solana-stream/src/server.ts`:

```ts
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createSolanaRpcSubscriptions } from "@solana/kit";
import { createGate, type GateConfig } from "@lxfoundry/stint-gate";
import { sendJson } from "@lxfoundry/stint-x402";
import { createStreamAdapter } from "./adapter.js";

export interface StreamConfig {
  readonly host?: string;
  /** 0 picks a free port (spec §12.4). */
  readonly port?: number;
  /** The node's WebSocket endpoint (spec §8, §12.4). */
  readonly rpcWsUrl: string;
  /** The gate's configuration, but its origin and adapter, which the stream supplies. */
  readonly gate: Omit<GateConfig<null>, "origin" | "adapter">;
}

export interface RunningStream {
  readonly url: string;
  stop(): Promise<void>;
}

/** The example resource with its gate mounted as middleware (spec §7.6, §8). */
export async function startStream(config: StreamConfig): Promise<RunningStream> {
  const host = config.host ?? "127.0.0.1";
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port ?? 0, host, resolve);
  });
  const url = `http://${host}:${(server.address() as AddressInfo).port}`;
  const gate = createGate({
    ...config.gate,
    origin: url,
    adapter: createStreamAdapter(createSolanaRpcSubscriptions(config.rpcWsUrl)),
  });

  server.on("request", (request, response) => {
    gate
      .handleRequest(request, response)
      .then((handled) => {
        if (handled) return;
        if (request.method === "GET" && request.url === "/health") return sendJson(response, 200, { ok: true });
        sendJson(response, 404, { error: "not_found" });
      })
      .catch((error: unknown) => {
        config.gate.log?.({ event: "error", error: error instanceof Error ? error.message : String(error) });
        if (!response.headersSent) sendJson(response, 500, { error: "internal" });
      });
  });
  server.on("upgrade", (request, socket, head) => {
    if (!gate.handleUpgrade(request, socket, head)) socket.destroy();
  });

  return {
    url,
    stop: async () => {
      await gate.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
```

Create `examples/solana-stream/src/index.ts`:

```ts
export { MAX_ACCOUNTS, createStreamAdapter, parseClientMessage, type ClientMessage, type Parsed } from "./adapter.js";
export { startStream, type RunningStream, type StreamConfig } from "./server.js";
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @lxfoundry/stint-example-stream test && pnpm typecheck`
Expected: PASS. The server itself runs end to end in Task 10.

- [ ] **Step 5: Commit**

```bash
git add examples/solana-stream pnpm-lock.yaml
git commit -m "Add the example stream of Solana account changes behind the gate"
```

---

### Task 9: The session client and its first tools

**Files:**
- Create: `packages/client/package.json`, `packages/client/tsconfig.json`,
  `packages/client/src/{index,policy,client,tools}.ts`
- Test: `packages/client/test/{gate.ts,policy.test.ts,client.test.ts,tools.test.ts}`

**Interfaces:**
- Consumes: Task 4 and 5's offers, payloads, tokens and `buildOpenTransaction`; in tests, Task 7's
  `createGate`, as the reference gate with a fake facilitator and chain.
- Produces (`@lxfoundry/stint-client`):
  - `Policy`, `checkOffer(policy, offer, requested, locked): PolicyCheck`;
  - `createStintClient(options: { signer: KeyPairSigner; policy: Policy; now?: () => number }): StintClient`,
    where `StintClient = { open(url, options?: { seconds?: number }): Promise<StintSession>; remainingBudget(): bigint }`;
  - `StintSession = { id: Address; gateUrl; paidUntil: number; wsUrl; cost: bigint; connect(): Promise<WebSocket>; close(): Promise<CloseReceipt>; [Symbol.asyncDispose]() }`;
  - `CloseReceipt = { paid: bigint; refunded: bigint; transaction: string }`;
  - `StintError` (`status?`, `body?`), `ToolError`;
  - `createSessionTools(client): SessionTools`. This has `tools.stint_open_session`,
    `tools.stint_send`, `tools.stint_receive`, `tools.stint_close_session` (each a
    `Tool = { name; description; inputSchema; run(input) }`) and
    `closeCode(sessionId): number | undefined`.
- Tool inputs and outputs: spec §9.5. `u64` amounts are decimal strings. `paidUntil` is Unix
  seconds.

- [ ] **Step 1: Create the package**

`packages/client/package.json`:

```json
{
  "name": "@lxfoundry/stint-client",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "typecheck": "tsc -p tsconfig.json",
    "test": "vitest run"
  },
  "dependencies": {
    "@lxfoundry/stint-program-client": "workspace:*",
    "@lxfoundry/stint-x402": "workspace:*",
    "@solana/kit": "8.5.0",
    "ws": "8.22.0"
  },
  "devDependencies": {
    "@lxfoundry/stint-gate": "workspace:*",
    "@types/ws": "8.18.2"
  }
}
```

and `packages/client/tsconfig.json` (extends `../../tsconfig.base.json`, includes `src` and
`test`). Run `pnpm install`.

- [ ] **Step 2: Write the failing tests**

Create `packages/client/test/gate.ts`, a reference gate whose facilitator and chain are fakes:

```ts
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { generateKeyPairSigner, type Address } from "@solana/kit";
import { CloseKind, type ClosedEvent, type Session } from "@lxfoundry/stint-program-client";
import { createGate, type Gate } from "@lxfoundry/stint-gate";
import { USDC_DEVNET, type PaymentPayload } from "@lxfoundry/stint-x402";
import type { WebSocket } from "ws";

export interface TestGate {
  readonly url: string;
  readonly payments: PaymentPayload[];
  stop(): Promise<void>;
}

/** A gate selling 1,000 per second, 5 to 120 s, whose chain holds one session per buyer. */
export async function startTestGate(buyer: Address, onAttach: (socket: WebSocket) => void = () => {}): Promise<TestGate> {
  const authorizer = await generateKeyPairSigner();
  const seller = (await generateKeyPairSigner()).address;
  const feePayer = (await generateKeyPairSigner()).address;
  const rentPayer = (await generateKeyPairSigner()).address;
  const payments: PaymentPayload[] = [];
  const now = Date.now();
  const server: Server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const gate: Gate = createGate({
    origin: url,
    network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
    asset: USDC_DEVNET,
    payTo: seller,
    receiverAuthorizer: authorizer,
    terms: { rate: 1_000n, minSeconds: 5, maxSeconds: 120 },
    durations: [30, 60],
    facilitator: {
      supported: async () => ({
        kinds: [
          {
            x402Version: 2,
            scheme: "elapsed",
            network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
            extra: { feePayer, rentPayer, programId: "5iCYPqLjCWw5KzQTU6NBUhR2hxg5SWGmS1ctUn3qESvr", closeUrl: `${url}/close` },
          },
        ],
        extensions: [],
        signers: {},
      }),
      verify: async () => ({ isValid: true }),
      settle: async (payload) => {
        payments.push(payload);
        return { success: true, transaction: "sig", network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" };
      },
    },
    chain: {
      latestBlockhash: async () => ({ blockhash: "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N", lastValidBlockHeight: 100n }),
      readSession: async () =>
        ({
          authority: buyer,
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
        }) as Session,
      closedEvent: async () => ({ claimed: 0n, owed: 8_000n, refunded: 22_000n, redirected: 0n, kind: CloseKind.Standard }) as ClosedEvent,
    },
    adapter: {
      provision: async () => null,
      attach: (_, socket) => onAttach(socket),
      teardown: async () => {},
    },
  });
  server.on("request", (req, res) => void gate.handleRequest(req, res).then((handled) => handled || res.writeHead(404).end()));
  server.on("upgrade", (req, socket, head) => gate.handleUpgrade(req, socket, head) || socket.destroy());
  return {
    url,
    payments,
    stop: async () => {
      await gate.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
```

The fake facilitator records only `settle` calls; an open makes one, a close another.

Create `packages/client/test/policy.test.ts`:

```ts
import { buildOpenOffer, type ElapsedRequirements } from "@lxfoundry/stint-x402";
import { address } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { checkOffer, type Policy } from "../src/index.js";

const policy: Policy = { maxRate: 1_000n, maxPerSession: 100_000n, budget: { amount: 200_000n, periodSeconds: 3_600 } };

const offer: ElapsedRequirements = buildOpenOffer({
  network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
  asset: address("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"),
  payTo: address("9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin"),
  receiverAuthorizer: address("Hq8i9ZoCdUuY6bEcUd5V2nhZqGPAiyxS5fTuQUe3tGLL"),
  terms: { rate: 1_000n, minSeconds: 5, maxSeconds: 120 },
  seconds: 30,
  facilitator: {
    feePayer: "SysvarC1ock11111111111111111111111111111111",
    rentPayer: "SysvarRent111111111111111111111111111111111",
    programId: "5iCYPqLjCWw5KzQTU6NBUhR2hxg5SWGmS1ctUn3qESvr",
    closeUrl: "http://f/close",
  },
  lifetime: { blockhash: "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N", lastValidBlockHeight: 1n },
  maxTimeoutSeconds: 60,
  idleCloseSeconds: 10,
  closeOnOutage: true,
});

const withExtra = (extra: object): ElapsedRequirements => ({ ...offer, extra: { ...offer.extra, ...extra } });

describe("checkOffer (spec §9.2, §9.3)", () => {
  it("accepts an offer within every limit, with the asset's decimals", () => {
    expect(checkOffer(policy, offer, 30, 0n)).toEqual({ ok: true, decimals: 6, amount: 30_000n });
  });

  it.each<[string, ElapsedRequirements, number, bigint, Policy?]>([
    ["another network", { ...offer, network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" }, 30, 0n],
    ["another program", withExtra({ programId: "11111111111111111111111111111111" }), 30, 0n],
    ["another asset", { ...offer, asset: "So11111111111111111111111111111111111111112" }, 30, 0n],
    ["a seller off the list", offer, 30, 0n, { ...policy, sellers: [address("11111111111111111111111111111111")] }],
    ["a rate above maxRate", withExtra({ rate: "1001" }), 30, 0n],
    ["a minimum above maxMinSeconds", withExtra({ minSeconds: 301, maxSeconds: 400 }), 30, 0n],
    ["another duration than requested", offer, 60, 0n],
    ["an amount that is not rate × seconds", { ...offer, amount: "30001" }, 30, 0n],
    ["more than maxPerSession", offer, 30, 0n, { ...policy, maxPerSession: 29_999n }],
    ["more than the period budget", offer, 30, 170_001n],
  ])("refuses %s", (_, candidate, requested, locked, override) => {
    expect(checkOffer(override ?? policy, candidate, requested, locked).ok).toBe(false);
  });
});
```

Create `packages/client/test/client.test.ts`:

```ts
import { generateKeyPairSigner, type KeyPairSigner } from "@solana/kit";
import { inspectTransaction, readElapsedPayload } from "@lxfoundry/stint-x402";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createStintClient, type Policy } from "../src/index.js";
import { startTestGate, type TestGate } from "./gate.js";

const policy: Policy = { maxRate: 1_000n, maxPerSession: 100_000n, budget: { amount: 40_000n, periodSeconds: 3_600 } };

describe("session client (spec §9.3, §9.4)", () => {
  let buyer: KeyPairSigner;
  let gate: TestGate;

  beforeEach(async () => {
    buyer = await generateKeyPairSigner();
    gate = await startTestGate(buyer.address);
  });

  afterEach(async () => {
    await gate.stop();
  });

  it("pays the offer it asked for: echoes it, builds the transaction itself, signs only as the authority", async () => {
    const client = createStintClient({ signer: buyer, policy });
    const session = await client.open(gate.url, { seconds: 30 });
    expect(session.cost).toBe(30_000n);
    const [payment] = gate.payments;
    expect(payment?.accepted.extra).toMatchObject({ seconds: 30, rate: "1000" });
    const tx = inspectTransaction(readElapsedPayload(payment!)!.transaction)!;
    expect([...tx.signed]).toEqual([buyer.address]);
    expect(readElapsedPayload(payment!)).toMatchObject({ type: "open", session: session.id });
  });

  it("refuses an offer its policy does not allow, before signing anything", async () => {
    const client = createStintClient({ signer: buyer, policy: { ...policy, maxRate: 999n } });
    await expect(client.open(gate.url, { seconds: 30 })).rejects.toThrow(/maxRate/);
    expect(gate.payments).toHaveLength(0);
  });

  it("keeps to the period budget", async () => {
    const client = createStintClient({ signer: buyer, policy });
    await client.open(gate.url, { seconds: 30 });
    expect(client.remainingBudget()).toBe(10_000n);
    await expect(client.open(gate.url, { seconds: 30 })).rejects.toThrow(/budget/);
  });

  it("connects with a connect token, and closes with a close token", async () => {
    const client = createStintClient({ signer: buyer, policy });
    const session = await client.open(gate.url, { seconds: 30 });
    const socket = await session.connect();
    const dropped = new Promise<number>((resolve) => socket.once("close", (code) => resolve(code)));
    expect(await session.close()).toEqual({ paid: 8_000n, refunded: 22_000n, transaction: "sig" });
    expect(await dropped).toBe(4410);
  });
});
```

Create `packages/client/test/tools.test.ts`:

```ts
import { generateKeyPairSigner } from "@solana/kit";
import { afterEach, describe, expect, it } from "vitest";
import { createSessionTools, createStintClient } from "../src/index.js";
import { startTestGate, type TestGate } from "./gate.js";

describe("session tools (spec §9.5)", () => {
  let gate: TestGate | undefined;

  afterEach(async () => {
    await gate?.stop();
  });

  it("opens, sends, receives the messages that match, and closes", async () => {
    const buyer = await generateKeyPairSigner();
    gate = await startTestGate(buyer.address, (socket) => {
      socket.on("message", () => {
        socket.send(JSON.stringify({ type: "slot", slot: "1" }));
        socket.send(JSON.stringify({ type: "account", address: "A", lamports: "5" }));
      });
    });
    const client = createStintClient({
      signer: buyer,
      policy: { maxRate: 1_000n, maxPerSession: 100_000n, budget: { amount: 100_000n, periodSeconds: 3_600 } },
    });
    const { tools, closeCode } = createSessionTools(client);

    const opened = await tools.stint_open_session.run({ url: gate.url, seconds: 30, reason: "test" });
    expect(opened).toMatchObject({ cost: "30000", remainingBudget: "70000" });
    expect(await tools.stint_send.run({ sessionId: opened.sessionId, message: { op: "subscribe", accounts: ["A"] } })).toEqual({ ok: true });

    const matched = await tools.stint_receive.run({ sessionId: opened.sessionId, timeoutSeconds: 5, match: { type: "account" } });
    expect(matched).toEqual({ messages: [{ type: "account", address: "A", lamports: "5" }], timedOut: false });
    const rest = await tools.stint_receive.run({ sessionId: opened.sessionId, timeoutSeconds: 5 });
    expect(rest).toEqual({ messages: [{ type: "slot", slot: "1" }], timedOut: false });
    const nothing = await tools.stint_receive.run({ sessionId: opened.sessionId, timeoutSeconds: 0.2 });
    expect(nothing).toEqual({ messages: [], timedOut: true });

    expect(await tools.stint_close_session.run({ sessionId: opened.sessionId })).toEqual({
      paid: "8000",
      refunded: "22000",
      transaction: "sig",
    });
    await expect.poll(() => closeCode(opened.sessionId)).toBe(4410);
  });

  it("answers an unknown session with a readable error", async () => {
    const client = createStintClient({
      signer: await generateKeyPairSigner(),
      policy: { maxRate: 1n, maxPerSession: 1n, budget: { amount: 1n, periodSeconds: 1 } },
    });
    const { tools } = createSessionTools(client);
    await expect(tools.stint_close_session.run({ sessionId: "nope" })).rejects.toThrow(/Unknown session nope/);
  });

  it("describes every tool with a strict schema", () => {
    const { tools } = createSessionTools(
      createStintClient({ signer: undefined as never, policy: { maxRate: 1n, maxPerSession: 1n, budget: { amount: 1n, periodSeconds: 1 } } }),
    );
    for (const tool of Object.values(tools)) {
      expect(tool.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
      expect(tool.description.length).toBeGreaterThan(20);
    }
    expect(tools.stint_close_session.description).toMatch(/as soon as/);
  });
});
```

Run: `pnpm --filter @lxfoundry/stint-client test`
Expected: FAIL: `../src/index.js` does not exist.

- [ ] **Step 3: Implement the policy and the client**

Create `packages/client/src/policy.ts`:

```ts
import type { Address } from "@solana/kit";
import { STINT_PROGRAM_ADDRESS } from "@lxfoundry/stint-program-client";
import { SOLANA_DEVNET, USDC_DEVNET, type ElapsedRequirements } from "@lxfoundry/stint-x402";

export interface Asset {
  readonly mint: Address;
  readonly decimals: number;
}

/** Spec §9.2. The limits a buyer's code enforces, whatever a seller offers. */
export interface Policy {
  /** Default: devnet. */
  readonly networks?: readonly string[];
  /** Default: the Stint program. */
  readonly programs?: readonly Address[];
  /** Default: devnet USDC, 6 decimals. */
  readonly assets?: readonly Asset[];
  readonly sellers?: readonly Address[];
  readonly maxRate: bigint;
  readonly maxPerSession: bigint;
  readonly budget: { readonly amount: bigint; readonly periodSeconds: number };
  /** Default 300. */
  readonly maxMinSeconds?: number;
}

export type PolicyCheck =
  | { readonly ok: true; readonly decimals: number; readonly amount: bigint }
  | { readonly ok: false; readonly reason: string };

const no = (reason: string): PolicyCheck => ({ ok: false, reason });

/** The checks before signing any payment (spec §9.3). `locked` is what this period already locked. */
export function checkOffer(policy: Policy, offer: ElapsedRequirements, requested: number, locked: bigint): PolicyCheck {
  const extra = offer.extra;
  if (extra.action !== "open") return no("not an open offer");
  if (!(policy.networks ?? [SOLANA_DEVNET]).includes(offer.network)) return no(`network ${offer.network} is not allowed`);
  if (!(policy.programs ?? [STINT_PROGRAM_ADDRESS]).includes(extra.programId as Address)) {
    return no(`program ${extra.programId} is not allowed`);
  }
  const asset = (policy.assets ?? [USDC_DEVNET]).find((candidate) => candidate.mint === offer.asset);
  if (!asset) return no(`asset ${offer.asset} is not allowed`);
  if (policy.sellers && !policy.sellers.includes(offer.payTo as Address)) return no(`seller ${offer.payTo} is not allowed`);

  const rate = BigInt(extra.rate);
  if (rate > policy.maxRate) return no(`rate ${rate} exceeds maxRate ${policy.maxRate}`);
  if (extra.minSeconds > (policy.maxMinSeconds ?? 300)) return no(`minSeconds ${extra.minSeconds} exceeds maxMinSeconds`);
  if (extra.seconds !== requested) return no(`the offer is for ${extra.seconds} s, not the ${requested} s requested`);
  if (!Number.isInteger(extra.seconds) || extra.seconds < extra.minSeconds || extra.seconds > extra.maxSeconds) {
    return no(`${extra.seconds} s is outside ${extra.minSeconds}..${extra.maxSeconds}`);
  }
  const amount = BigInt(offer.amount);
  if (amount !== rate * BigInt(extra.seconds)) return no("the amount is not rate × seconds");
  if (amount > policy.maxPerSession) return no(`${amount} exceeds maxPerSession ${policy.maxPerSession}`);
  if (locked + amount > policy.budget.amount) return no(`${amount} would exceed the period budget`);
  return { ok: true, decimals: asset.decimals, amount };
}
```

Create `packages/client/src/client.ts`:

```ts
import { address, type Address, type KeyPairSigner } from "@solana/kit";
import {
  HEADERS,
  X402_VERSION,
  buildOpenTransaction,
  createSessionToken,
  decodePaymentRequiredHeader,
  encodePaymentSignatureHeader,
  readElapsedRequirements,
  type PaymentPayload,
  type PaymentRequired,
  type TokenPurpose,
} from "@lxfoundry/stint-x402";
import { WebSocket } from "ws";
import { checkOffer, type Policy } from "./policy.js";

export class StintError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "StintError";
  }
}

export interface CloseReceipt {
  readonly paid: bigint;
  readonly refunded: bigint;
  readonly transaction: string;
}

export interface StintSession {
  readonly id: Address;
  readonly gateUrl: string;
  /** Unix seconds. */
  readonly paidUntil: number;
  readonly wsUrl: string;
  /** The deposit, in base units. */
  readonly cost: bigint;
  connect(): Promise<WebSocket>;
  close(): Promise<CloseReceipt>;
  [Symbol.asyncDispose](): Promise<void>;
}

export interface StintClient {
  open(url: string, options?: { readonly seconds?: number }): Promise<StintSession>;
  /** What the period budget still allows. */
  remainingBudget(): bigint;
}

export interface ClientOptions {
  readonly signer: KeyPairSigner;
  readonly policy: Policy;
  /** Milliseconds; runs the period budget. Default `Date.now`. */
  readonly now?: () => number;
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const describeBody = (body: unknown) => (typeof body === "string" ? body : JSON.stringify(body));

/** The buyer's runtime (spec §9.4). It needs only a signer: no SOL and no node access (spec §9.1). */
export function createStintClient(options: ClientOptions): StintClient {
  const now = options.now ?? Date.now;
  const ledger: { readonly at: number; readonly amount: bigint }[] = [];
  const locked = () => {
    const since = now() - options.policy.budget.periodSeconds * 1000;
    return ledger.filter((entry) => entry.at > since).reduce((sum, entry) => sum + entry.amount, 0n);
  };

  function sessionFrom(gateUrl: string, opened: { session: string; paidUntil: number; wsUrl: string }, cost: bigint): StintSession {
    const audience = new URL(gateUrl).origin;
    const token = (purpose: TokenPurpose) => createSessionToken(options.signer, { session: opened.session, audience, purpose });
    let closed = false;
    const session: StintSession = {
      id: address(opened.session),
      gateUrl,
      paidUntil: opened.paidUntil,
      wsUrl: opened.wsUrl,
      cost,
      async connect() {
        const socket = new WebSocket(opened.wsUrl, { headers: { authorization: `Bearer ${await token("connect")}` } });
        await new Promise<void>((resolve, reject) => {
          socket.once("open", () => resolve());
          socket.once("unexpected-response", (_, response) =>
            reject(new StintError(`The gate refused the connection (HTTP ${response.statusCode})`, response.statusCode)),
          );
          socket.once("error", reject);
        });
        return socket;
      },
      async close() {
        const response = await fetch(`${gateUrl}/sessions/${opened.session}/close`, {
          method: "POST",
          headers: { authorization: `Bearer ${await token("close")}` },
        });
        const body = await readBody(response);
        if (response.status !== 200) throw new StintError(`Close failed (HTTP ${response.status}): ${describeBody(body)}`, response.status, body);
        closed = true;
        const receipt = body as { paid: string; refunded: string; transaction: string };
        return { paid: BigInt(receipt.paid), refunded: BigInt(receipt.refunded), transaction: receipt.transaction };
      },
      async [Symbol.asyncDispose]() {
        if (!closed) await session.close();
      },
    };
    return session;
  }

  return {
    remainingBudget: () => options.policy.budget.amount - locked(),

    async open(url, { seconds } = {}) {
      const gateUrl = url.replace(/\/+$/, "");
      const endpoint = `${gateUrl}/sessions${seconds === undefined ? "" : `?seconds=${seconds}`}`;
      const first = await fetch(endpoint, { method: "POST" });
      if (first.status !== 402) {
        const body = await readBody(first);
        throw new StintError(`Expected 402 from ${endpoint}, got ${first.status}: ${describeBody(body)}`, first.status, body);
      }
      const header = first.headers.get(HEADERS.paymentRequired);
      const required = (header ? decodePaymentRequiredHeader(header) : await first.json()) as PaymentRequired;
      if (required.x402Version !== X402_VERSION) throw new StintError(`x402Version ${required.x402Version} is not supported`);

      // The entry is echoed exactly as received: the object decoded from the gate's response.
      const offer = required.accepts
        .map(readElapsedRequirements)
        .find((entry) => entry?.extra.action === "open" && (seconds === undefined || entry.extra.seconds === seconds));
      if (!offer) throw new StintError(`No elapsed offer${seconds === undefined ? "" : ` for ${seconds} s`}`);
      const check = checkOffer(options.policy, offer, seconds ?? offer.extra.seconds, locked());
      if (!check.ok) throw new StintError(`Policy refuses the offer: ${check.reason}`);

      const built = await buildOpenTransaction({ requirements: offer, authority: options.signer, decimals: check.decimals });
      const payload: PaymentPayload = {
        x402Version: X402_VERSION,
        resource: required.resource,
        accepted: offer,
        payload: { type: "open", transaction: built.transaction, session: built.session },
      };
      // Counted before sending: once signed, the payment may land whatever the answer.
      const entry = { at: now(), amount: check.amount };
      ledger.push(entry);
      const second = await fetch(endpoint, {
        method: "POST",
        headers: { [HEADERS.paymentSignature]: encodePaymentSignatureHeader(payload) },
      });
      const body = await readBody(second);
      if (second.status === 402 || second.status === 400) {
        ledger.splice(ledger.indexOf(entry), 1); // refused before settlement: nothing was charged
        throw new StintError(`The gate refused the payment: ${describeBody(body)}`, second.status, body);
      }
      if (second.status !== 201) {
        throw new StintError(`The open is not confirmed (HTTP ${second.status}); the payment may still land`, second.status, body);
      }
      const opened = body as { session: string; paidUntil: number; wsUrl: string };
      if (opened.session !== built.session) throw new StintError("The gate reported another session", 201, body);
      return sessionFrom(gateUrl, opened, check.amount);
    },
  };
}
```

A `202` (settlement pending) or a `5xx` after paying is reported as an error here, with the
payment still counted against the budget. Polling for the session (spec §9.3) is added with
settlement records.

- [ ] **Step 4: Implement the tools**

Create `packages/client/src/tools.ts`:

```ts
import type { WebSocket } from "ws";
import type { StintClient, StintSession } from "./client.js";

export class ToolError extends Error {
  override name = "ToolError";
}

export interface Tool<I, O> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  run(input: I): Promise<O>;
}

export interface OpenInput {
  readonly url: string;
  readonly seconds?: number;
  readonly reason: string;
}
export interface OpenOutput {
  readonly sessionId: string;
  readonly paidUntil: number;
  readonly cost: string;
  readonly remainingBudget: string;
}
export interface SendInput {
  readonly sessionId: string;
  readonly message: unknown;
}
export interface ReceiveInput {
  readonly sessionId: string;
  readonly max?: number;
  readonly timeoutSeconds: number;
  readonly match?: Record<string, unknown>;
}
export interface ReceiveOutput {
  readonly messages: unknown[];
  readonly timedOut: boolean;
}
export interface CloseInput {
  readonly sessionId: string;
}
export interface CloseOutput {
  readonly paid: string;
  readonly refunded: string;
  readonly transaction: string;
}

export interface SessionTools {
  readonly tools: {
    readonly stint_open_session: Tool<OpenInput, OpenOutput>;
    readonly stint_send: Tool<SendInput, { ok: true }>;
    readonly stint_receive: Tool<ReceiveInput, ReceiveOutput>;
    readonly stint_close_session: Tool<CloseInput, CloseOutput>;
  };
  /** The close code of the session's connection, once it has closed. */
  closeCode(sessionId: string): number | undefined;
}

interface Live {
  readonly session: StintSession;
  socket?: WebSocket;
  readonly inbox: unknown[];
  readonly waiters: Set<() => void>;
  closeCode?: number;
  closed: boolean;
}

const strict = (properties: Record<string, unknown>, required: string[]) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const sessionIdSchema = { type: "string", description: "The session's address, from stint_open_session" };
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/** The session tools of spec §9.5, sharing one runtime. */
export function createSessionTools(client: StintClient): SessionTools {
  const live = new Map<string, Live>();

  const get = (sessionId: unknown): Live => {
    const state = typeof sessionId === "string" ? live.get(sessionId) : undefined;
    if (!state) throw new ToolError(`Unknown session ${String(sessionId)}: open one with stint_open_session`);
    return state;
  };
  const wake = (state: Live) => {
    for (const waiter of state.waiters) waiter();
    state.waiters.clear();
  };

  async function connected(state: Live): Promise<WebSocket> {
    if (state.socket && state.socket.readyState === state.socket.OPEN) return state.socket;
    if (state.closed) throw new ToolError("The session is closed");
    const socket = await state.session.connect();
    socket.on("message", (data) => {
      const text = String(data);
      let message: unknown;
      try {
        message = JSON.parse(text);
      } catch {
        message = text;
      }
      state.inbox.push(message);
      wake(state);
    });
    socket.on("close", (code) => {
      state.closeCode = code;
      wake(state);
    });
    state.socket = socket;
    return socket;
  }

  const matches = (message: unknown, match: Record<string, unknown> | undefined) =>
    !match || (isRecord(message) && Object.entries(match).every(([key, value]) => message[key] === value));

  return {
    closeCode: (sessionId) => live.get(sessionId)?.closeCode,
    tools: {
      stint_open_session: {
        name: "stint_open_session",
        description:
          "Opens a paid, time-boxed session on a seller's resource. The deposit is held in escrow; only the time used is paid. Close it with stint_close_session as soon as your task is done.",
        inputSchema: strict(
          {
            url: { type: "string", description: "The seller's gate URL" },
            seconds: { type: "integer", minimum: 1, description: "How long to buy; omit to take the seller's default" },
            reason: { type: "string", description: "Why the session is needed" },
          },
          ["url", "reason"],
        ),
        async run(input) {
          const session = await client.open(input.url, input.seconds === undefined ? {} : { seconds: input.seconds });
          live.set(session.id, { session, inbox: [], waiters: new Set(), closed: false });
          return {
            sessionId: session.id,
            paidUntil: session.paidUntil,
            cost: session.cost.toString(),
            remainingBudget: client.remainingBudget().toString(),
          };
        },
      },
      stint_send: {
        name: "stint_send",
        description: "Sends one message to the session's resource over its connection, connecting first if needed.",
        inputSchema: strict(
          { sessionId: sessionIdSchema, message: { description: "A JSON value, or a string sent as is" } },
          ["sessionId", "message"],
        ),
        async run(input) {
          const socket = await connected(get(input.sessionId));
          socket.send(typeof input.message === "string" ? input.message : JSON.stringify(input.message));
          return { ok: true };
        },
      },
      stint_receive: {
        name: "stint_receive",
        description:
          "Waits for messages from the session's resource and returns up to `max` of them. With `match`, returns only messages whose top-level fields equal it; others stay queued.",
        inputSchema: strict(
          {
            sessionId: sessionIdSchema,
            max: { type: "integer", minimum: 1, description: "Default 10" },
            timeoutSeconds: { type: "number", minimum: 0 },
            match: { type: "object", description: "Top-level fields a message must equal" },
          },
          ["sessionId", "timeoutSeconds"],
        ),
        async run(input) {
          const state = get(input.sessionId);
          const max = input.max ?? 10;
          const deadline = Date.now() + input.timeoutSeconds * 1000;
          for (;;) {
            const taken: unknown[] = [];
            for (let index = 0; index < state.inbox.length && taken.length < max; ) {
              if (matches(state.inbox[index], input.match)) taken.push(state.inbox.splice(index, 1)[0]);
              else index++;
            }
            if (taken.length > 0) return { messages: taken, timedOut: false };
            const left = deadline - Date.now();
            if (left <= 0) return { messages: [], timedOut: true };
            await new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, left);
              state.waiters.add(() => {
                clearTimeout(timer);
                resolve();
              });
            });
          }
        },
      },
      stint_close_session: {
        name: "stint_close_session",
        description:
          "Closes the session as soon as your task is done: the seller is paid for the time used and the rest of the deposit is refunded.",
        inputSchema: strict({ sessionId: sessionIdSchema }, ["sessionId"]),
        async run(input) {
          const state = get(input.sessionId);
          const receipt = await state.session.close();
          state.closed = true;
          return { paid: receipt.paid.toString(), refunded: receipt.refunded.toString(), transaction: receipt.transaction };
        },
      },
    },
  };
}
```

Create `packages/client/src/index.ts`:

```ts
export { checkOffer, type Asset, type Policy, type PolicyCheck } from "./policy.js";
export { StintError, createStintClient, type ClientOptions, type CloseReceipt, type StintClient, type StintSession } from "./client.js";
export {
  ToolError,
  createSessionTools,
  type CloseInput,
  type CloseOutput,
  type OpenInput,
  type OpenOutput,
  type ReceiveInput,
  type ReceiveOutput,
  type SendInput,
  type SessionTools,
  type Tool,
} from "./tools.js";
```

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter @lxfoundry/stint-client test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/client pnpm-lock.yaml
git commit -m "Add the session client: policy checks, open, connect, close, and the first four tools"
```

---

### Task 10: Scenario 1 on the local target

**Files:**
- Modify: `conformance/package.json`, `conformance/src/types.ts`, `conformance/src/catalogue.ts`,
  `conformance/src/index.ts`
- Create: `conformance/src/assert.ts`, `conformance/src/scenarios/01-open-connect-close.ts`
- Modify: `conformance/test/catalogue.test.ts`, `conformance/test/runner.test.ts`
- Modify: `e2e/package.json`, `e2e/src/targets/local.ts`, `e2e/src/fixtures/buyers.ts`,
  `e2e/src/cli.ts`, `e2e/test/local-target.test.ts`
- Modify: `docs/plans/README.md`

**Interfaces:**
- Consumes: every earlier task.
- Produces:
  - `ScenarioContext = { target; gateUrl: string; rpc: Rpc<SolanaRpcApi>; newBuyer(usdc: bigint): Promise<Buyer> }`;
  - `Buyer = { signer: KeyPairSigner; usdcAccount: Address }` (moved to `@lxfoundry/stint-conformance`);
  - `LocalStack` gains `stream: RunningStream` and `context(): ScenarioContext`;
  - `LOCAL_TERMS = { rate: 1_000n, minSeconds: 5, maxSeconds: 120 }`, `LOCAL_DURATIONS = [30]`,
    `LOCAL_IDLE_CLOSE_SECONDS = 10` (spec §12.6: a test offer with `minSeconds` of 5 s or less and a
    short `idleCloseSeconds`).

- [ ] **Step 1: Widen the scenario context**

Add to `conformance/package.json`:

```json
  "dependencies": {
    "@lxfoundry/stint-client": "workspace:*",
    "@lxfoundry/stint-program-client": "workspace:*",
    "@lxfoundry/stint-x402": "workspace:*",
    "@solana/kit": "8.5.0"
  }
```

and to `e2e/package.json`'s dependencies: `"@lxfoundry/stint-example-stream": "workspace:*"` and
`"@lxfoundry/stint-gate": "workspace:*"`. Run `pnpm install`.

In `conformance/src/types.ts`, add the import and replace `ScenarioContext`:

```ts
import type { Address, KeyPairSigner, Rpc, SolanaRpcApi } from "@solana/kit";

/** A fresh buyer key: USDC in its associated token account, and no SOL (spec §9.1, §12.2). */
export interface Buyer {
  readonly signer: KeyPairSigner;
  readonly usdcAccount: Address;
}

/** What a scenario receives when it runs. */
export interface ScenarioContext {
  readonly target: Target;
  /** The gate's URL, which the session client opens sessions on. */
  readonly gateUrl: string;
  /** The network's RPC, for reading what the scenario's own transactions did (spec §12.2). */
  readonly rpc: Rpc<SolanaRpcApi>;
  newBuyer(usdc: bigint): Promise<Buyer>;
}
```

In `e2e/src/fixtures/buyers.ts`, delete the `Buyer` interface and import it instead:
`import type { Buyer } from "@lxfoundry/stint-conformance";`. Keep exporting it from
`e2e/src/index.ts` (`export type { Buyer } from "@lxfoundry/stint-conformance";`).

In `conformance/test/runner.test.ts`, replace the `context` helper so it builds a whole context:

```ts
import { createSolanaRpc } from "@solana/kit";

const context = (target: Target) => (): ScenarioContext => ({
  target,
  gateUrl: "http://127.0.0.1:9",
  rpc: createSolanaRpc("http://127.0.0.1:9"),
  newBuyer: async () => {
    throw new Error("no buyers in unit tests");
  },
});
```

Run: `pnpm typecheck`
Expected: FAIL in `e2e/src/cli.ts` and `e2e/test/local-target.test.ts`, which still pass
`{ target }`. The next steps fix them.

- [ ] **Step 2: Add the stream to the local target**

In `e2e/src/targets/local.ts`, add the imports:

```ts
import type { ScenarioContext } from "@lxfoundry/stint-conformance";
import { startStream, type RunningStream } from "@lxfoundry/stint-example-stream";
import { createFacilitatorClient, createRpcChain } from "@lxfoundry/stint-gate";
import { SOLANA_DEVNET, USDC_DEVNET, type Terms } from "@lxfoundry/stint-x402";
import { newBuyer } from "../fixtures/buyers.js";
```

the test offer:

```ts
/** The test offer of spec §12.6: a minimum of 5 s or less, and a short idle close. */
export const LOCAL_TERMS: Terms = { rate: 1_000n, minSeconds: 5, maxSeconds: 120 };
export const LOCAL_DURATIONS = [30] as const;
export const LOCAL_IDLE_CLOSE_SECONDS = 10;
```

`stream: RunningStream` and `context(): ScenarioContext` in `LocalStack`, and, after the
facilitator starts:

```ts
    const stream = await startStream({
      rpcWsUrl: chain.network.wsUrl,
      gate: {
        network: SOLANA_DEVNET,
        asset: USDC_DEVNET,
        payTo: chain.keys.seller.signer.address,
        receiverAuthorizer: chain.keys.receiverAuthorizer.signer,
        terms: LOCAL_TERMS,
        durations: LOCAL_DURATIONS,
        idleCloseSeconds: LOCAL_IDLE_CLOSE_SECONDS,
        facilitator: createFacilitatorClient(facilitator.url, facilitatorApiKey),
        chain: createRpcChain(chain.network.rpc),
      },
    });
    stops.unshift(() => stream.stop());
```

and in the returned object:

```ts
      stream,
      context: () => ({
        target,
        gateUrl: stream.url,
        rpc: chain.network.rpc,
        newBuyer: (usdc) => newBuyer(chain.network.rpc, chain.keys.mintAuthority.signer, usdc),
      }),
```

Update the doc comment of `startLocalStack`: "the local chain, Kora, the facilitator, and the
example stream with its gate".

In `e2e/src/cli.ts`, replace `() => ({ target: stack.target })` with `() => stack.context()`. In
`e2e/test/local-target.test.ts`, do the same in the last test.

Run: `pnpm typecheck && pnpm --filter @lxfoundry/stint-e2e test`
Expected: PASS, still 34 pending scenarios and one not applicable.

- [ ] **Step 3: Write scenario 1, as pending**

Create `conformance/src/assert.ts`:

```ts
/** Assertions for scenarios: each failure names what was checked (spec §12.2, "Report"). */
export function expectTrue(condition: unknown, what: string): asserts condition {
  if (!condition) throw new Error(`${what}: not so`);
}

export function expectEqual<T>(actual: T, expected: T, what: string): void {
  if (actual !== expected) throw new Error(`${what}: expected ${String(expected)}, got ${String(actual)}`);
}

export async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${what}: not within ${timeoutMs} ms`);
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
```

Create `conformance/src/scenarios/01-open-connect-close.ts`:

```ts
import { address } from "@solana/kit";
import { fetchMaybeSession } from "@lxfoundry/stint-program-client";
import { createSessionTools, createStintClient } from "@lxfoundry/stint-client";
import { associatedTokenAddress, fetchClosedEvent, tokenBalanceChanges } from "@lxfoundry/stint-x402";
import { expectEqual, expectTrue, sleep, waitFor } from "../assert.js";
import type { ScenarioContext } from "../types.js";

/**
 * Scenario 1 (spec §12.7): open, connect, close early. Refund = deposit − due; the receiver
 * receives due, across claims and the close. Amounts are read from the session's own
 * transactions (spec §12.2, "Measuring money").
 */
export async function openConnectCloseEarly(context: ScenarioContext): Promise<void> {
  const buyer = await context.newBuyer(1_000_000n);
  const client = createStintClient({
    signer: buyer.signer,
    policy: { maxRate: 10_000n, maxPerSession: 1_000_000n, budget: { amount: 1_000_000n, periodSeconds: 3_600 } },
  });
  const { tools, closeCode } = createSessionTools(client);

  const opened = await tools.stint_open_session.run({ url: context.gateUrl, seconds: 30, reason: "conformance scenario 1" });
  const session = address(opened.sessionId);
  const account = await fetchMaybeSession(context.rpc, session, { commitment: "confirmed" });
  expectTrue(account.exists, "the session exists on-chain after the open");
  const stored = account.data;
  const deposit = BigInt(opened.cost);
  expectEqual(stored.deposited, deposit, "the deposit credited at open");

  await tools.stint_send.run({ sessionId: opened.sessionId, message: { op: "subscribe", accounts: [buyer.usdcAccount] } });
  // Past the minimum, so the charge is normally the elapsed time rather than minSeconds
  // (scenario 2's case). The chain's clock can lag the wall clock, so `due` is computed, not assumed.
  await sleep((stored.minSeconds + 2) * 1000);
  const receipt = await tools.stint_close_session.run({ sessionId: opened.sessionId });

  const closed = await fetchClosedEvent(context.rpc, receipt.transaction);
  expectTrue(closed, "the close emitted Closed");
  // Spec §4.2: elapsed stops at paid_until, and a close charges at least minSeconds.
  const covered = stored.deposited / stored.rate;
  const elapsed = closed.at - stored.startedAt;
  const used = elapsed < 0n ? 0n : elapsed > covered ? covered : elapsed;
  const charged = used > BigInt(stored.minSeconds) ? used : BigInt(stored.minSeconds);
  const due = stored.rate * charged;
  expectEqual(BigInt(receipt.paid), due, "paid = due");
  expectEqual(BigInt(receipt.refunded), deposit - due, "refunded = deposit − due");

  const changes = await tokenBalanceChanges(context.rpc, receipt.transaction);
  const receiverToken = await associatedTokenAddress(stored.receiver, stored.mint);
  expectEqual(changes.get(receiverToken), due, "the receiver's gain in the close");
  expectEqual(changes.get(buyer.usdcAccount), deposit - due, "the buyer's refund in the close");

  expectTrue(!(await fetchMaybeSession(context.rpc, session, { commitment: "confirmed" })).exists, "the session account is closed");
  await waitFor(() => closeCode(opened.sessionId) === 4410, 5_000, "the connection is dropped with 4410");
}
```

The scenario computes `due` from the chain's own times (`started_at` and the `Closed` event's
`at`), never from the wall clock (spec §4.2). `claimed` is zero: nothing claims before the close at
this stage, so "across claims and the close" is the close alone.

In `conformance/src/catalogue.ts`, import `openConnectCloseEarly` and give the first entry its
implementation, still pending:

```ts
  { ...pending(1, "Open, connect, close early"), run: openConnectCloseEarly },
```

Export the assertions for later scenarios: add
`export { expectEqual, expectTrue, sleep, waitFor } from "./assert.js";` to `conformance/src/index.ts`.

- [ ] **Step 4: Run it, and see the report flag it**

Run: `pnpm e2e:local`
Expected: exit code 0, and the report row
`| 1. Open, connect, close early | local | pending | pass (make required) | … |`, with
`Make required: 1`. If the row shows `pending` with an error, the error line under "Errors:" names
the check that failed. Fix the component it points to and rerun.

- [ ] **Step 5: Make it required, in the same change**

In `conformance/src/catalogue.ts`, add next to `pending`:

```ts
function required(
  id: number,
  title: string,
  run: Scenario["run"],
  needs: readonly Capability[] = [],
  group: IsolationGroup = "shared",
): Scenario {
  return { id, title, needs, group, status: "required", run };
}
```

and replace the first entry with `required(1, "Open, connect, close early", openConnectCloseEarly),`.

In `conformance/test/catalogue.test.ts`, replace the test
`"starts every scenario as pending, with no implementation"`:

```ts
  it("has scenario 1 required with its implementation, and every other scenario pending without one", () => {
    for (const scenario of catalogue) {
      if (scenario.id === 1) {
        expect(scenario.status).toBe("required");
        expect(scenario.run).toBeDefined();
      } else {
        expect(scenario.status).toBe("pending");
        expect(scenario.run).toBeUndefined();
      }
    }
  });
```

In `e2e/test/local-target.test.ts`, replace the last test:

```ts
  it("passes scenario 1, now required, and reports every other scenario", async () => {
    const outcomes = await runScenarios(catalogue, stack.target, () => stack.context());
    expect(outcomes).toHaveLength(35);
    expect(outcomes.find((outcome) => outcome.id === 1)).toMatchObject({ status: "required", result: "pass" });
    expect(outcomes.find((outcome) => outcome.id === 12)?.result).toBe("not applicable");
    expect(outcomes.filter((outcome) => outcome.result === "pending")).toHaveLength(33);
    expect(exitCodeFor(outcomes)).toBe(0);
  });
```

- [ ] **Step 6: Run everything**

Run: `pnpm typecheck && pnpm test && pnpm e2e:local`
Expected: PASS. The report reads `Status: required 1, pending 34 · Result: pass 1, fail 0, pending
33, not applicable 1`, with no "Make required" line.

- [ ] **Step 7: Link this plan from the stage index**

In `docs/plans/README.md`, in the stages table, set stage 1's "Plan" cell to
`[01-walking-skeleton.md](01-walking-skeleton.md)` and stage 2's to "After stage 1" (unchanged if
already so).

- [ ] **Step 8: Commit and push**

```bash
git add conformance e2e docs/plans/README.md pnpm-lock.yaml
git commit -m "Run scenario 1 on the local target and make it required"
git push -u origin HEAD
```

Expected: the `CI` workflow passes on the branch, and its job summary shows scenario 1 as `pass`.

---

## Done when

- `scripts/check-toolchain.sh` passes, and so do `pnpm typecheck`, `pnpm test` and
  `pnpm e2e:local`, locally in WSL and in continuous integration.
- The report lists all 35 scenarios: scenario 1 `required` and passing, 33 `pending`, and scenario
  12 `not applicable`.
- The program tests cover `open` and the `Standard` close (spec §12.1, "Program", for the paths
  this stage adds).
- The pull request records the answers below.

## Spec §14 answers

| # | Answer | Evidence |
|---|---|---|
| 1 | **Yes, and not used beyond types and headers.** `@x402/core` 2.28.0 registers custom schemes on its client, resource server and facilitator, and declares payment flows, `escrow` included. This repository uses its types and its v2 header helpers only. Its resource server drives the second settlement within one request; the gate settles a close on a later request (spec §5.5, "Payment flow"). `@x402/svm` would install a second copy of `@solana/kit` | The published `.d.ts` and built files of `@x402/core` 2.28.0 |
| 2 | **To be confirmed by Task 6, Step 7.** Kora 2.0.5's source applies the program allowlist and the fee-payer policy to inner instructions, and its policy only constrains instructions where the fee payer is the funder or authority | Kora v2.0.5 source; the integration test's run |
| 4 | **Yes for Kora:** it accepts version 0 transactions (stage 0's Kora test; v2.0.5 source). The x402 SDK never handles the transaction: only this repository's scheme code does | Kora's test in `e2e/test/kora.test.ts`; Kora v2.0.5 source |
| 5 | **No** (stage 0): Kora's TypeScript client declares older Kit versions; Kora is called over JSON-RPC | Stage 0's plan |
| 7 | **No.** Neither `@x402/core`, `@x402/svm` nor Kora 2.0.5 compares the node's genesis hash with the network identifier, so the local target keeps devnet's | Source search for `genesis` in all three |
