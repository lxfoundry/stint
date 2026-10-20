# Stage 0: Toolchain and Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or
> executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for
> tracking.

**Goal:** A pinned toolchain, a pnpm workspace with the program skeleton and its generated client,
and an end-to-end harness that boots the `local` target (embedded Surfpool with its fixtures, and
Kora) and reports all 35 scenarios, in continuous integration.

**Architecture:** An Anchor workspace and a pnpm workspace share the repository root. The harness
(`e2e/`) starts Surfpool in-process through `@solana/surfpool`, writes the fixtures of spec §12.3
with cheatcodes and ordinary transactions, and runs Kora as a child process. The scenario library
and its runner (`conformance/`) know nothing about Surfpool. They see only a `Target` and its
capabilities. Every scenario is `pending` at this stage.

**Tech Stack:** Rust 1.99.1, Agave 4.3.2, Anchor 1.2.1, Node.js 24.22.0, pnpm 12.14.0,
TypeScript 7.0.2, Vitest 5.0.5, tsx 4.23.15, `@solana/kit` 8.5.0, `@solana/surfpool` 1.6.1,
Codama (`@codama/renderers-js` 2.8.0), Kora 2.0.5.

**Spec:** [`docs/specs/stint-system.md`](../specs/stint-system.md): §3 (architecture and
toolchain), §4.1, §4.4 and §4.5 (the program's account, events and errors), §12 (testing and
conformance), §14 question 6. Read §2.3 (tooling facts T1–T8) before Tasks 5 and 6.

## Global Constraints

- Platform: Linux x86-64 or macOS. On Windows, everything runs inside WSL 2 (T1, T2). Run every
  command in this plan from the repository root, inside WSL.
- Transactions are version 0, without address lookup tables (spec §3.5).
- Only classic SPL Token mints. The payment token is devnet USDC,
  `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`, 6 decimals (spec §3.4).
- The local network is Surfpool, offline, embedded in the harness's process. It produces blocks on
  a clock, with a 400 ms slot time, set explicitly (spec §12.3, T3).
- Kora runs with free pricing and its `Mock` price source, and Lighthouse assertions off (spec §6.2,
  §12.3, T7, T8).
- The harness waits for a new slot after its setup, and after every cheatcode, before the next
  step (spec §12.3, T5).
- No secrets in any commit. Keys are generated for each run; Kora's key reaches it through its
  environment. The program keypair `target/deploy/stint-keypair.json` is never committed. Keep a
  copy outside the repository: it fixes the program ID.
- Scenario statuses follow the ratchet of spec §12.2: a pending scenario that passes is made
  required in the same change, and a required scenario never goes back to pending.
- Commit messages are neutral, technical and in the present tense.

## Version pins

| Tool | Version | Installed by |
|---|---|---|
| Rust | 1.99.1 | rustup, pinned in `rust-toolchain.toml` |
| Agave (Solana CLI) | 4.3.2 | Anza's installer |
| Anchor CLI and `anchor-lang` | 1.2.1 | AVM, built from tag `v1.2.1` |
| Node.js | 24.22.0 | nvm 0.40.8, pinned in `.nvmrc` |
| pnpm | 12.14.0 | pnpm's installer, pinned in `packageManager` |
| Surfpool CLI and `@solana/surfpool` | 1.6.1 | Surfpool's installer, and npm |
| Kora (`kora-cli`) | 2.0.5 | `cargo install` |
| TypeScript | 7.0.2 | npm |
| Vitest | 5.0.5 | npm |
| tsx | 4.23.15 | npm |
| `@types/node` | 24.19.2 | npm |
| `@solana/kit` | 8.5.0 | npm |
| `@solana-program/token` | 0.18.0 | npm |
| `codama`, `@codama/nodes-from-anchor`, `@codama/renderers-js` | 1.11.0, 1.5.6, 2.8.0 | npm |

## File structure

| Path | Responsibility |
|---|---|
| `rust-toolchain.toml`, `.nvmrc` | Pin Rust and Node.js |
| `scripts/check-toolchain.sh` | Fails when an installed tool differs from the pins |
| `Anchor.toml`, `Cargo.toml` | Anchor and Cargo workspaces |
| `programs/stint/src/lib.rs` | Program entry: its ID and an empty instruction set |
| `programs/stint/src/state.rs` | `Session` account (spec §4.1) |
| `programs/stint/src/events.rs` | Events (spec §4.4) |
| `programs/stint/src/errors.rs` | Errors (spec §4.5) |
| `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json` | pnpm workspace and shared TypeScript settings |
| `packages/program-client/` | Codama-generated client (`src/generated/`, never edited by hand) and its generation script |
| `conformance/src/types.ts` | Targets, capabilities, scenarios, outcomes |
| `conformance/src/catalogue.ts` | The 35 scenarios of spec §12.7 |
| `conformance/src/runner.ts` | Runs scenarios against a target and decides the run's result |
| `conformance/src/report.ts` | Renders and writes the run report |
| `e2e/src/paths.ts` | Repository paths the harness reads and writes |
| `e2e/src/network/surfnet.ts` | Starts and stops the embedded Surfpool; waits for a new slot |
| `e2e/src/network/transactions.ts` | Builds, signs, sends and confirms version 0 transactions |
| `e2e/src/fixtures/keys.ts` | Harness keys, with their secret bytes |
| `e2e/src/fixtures/usdc.ts` | The USDC mint at its devnet address; token accounts; minting |
| `e2e/src/fixtures/programs.ts` | Deploys the Stint program and the Subscriptions program copy |
| `e2e/src/kora/config.ts` | Renders `kora.toml` and `signers.toml` |
| `e2e/src/kora/process.ts` | Runs Kora as a child process |
| `e2e/src/kora/client.ts` | Kora's JSON-RPC interface |
| `e2e/src/targets/local.ts` | Assembles the `local` target |
| `e2e/src/cli.ts` | `pnpm e2e:local`: runs the catalogue and writes the report |
| `scripts/fetch-subscriptions-program.sh` | Fetches and checks the Subscriptions program copy |
| `e2e/fixtures/subscriptions.sha256` | The copy's pinned hash |
| `.github/workflows/ci.yml` | Continuous integration |

---

### Task 1: Toolchain

**Files:**
- Create: `rust-toolchain.toml`, `.nvmrc`, `scripts/check-toolchain.sh`
- Modify: `CLAUDE.md` (section "Toolchain")

**Interfaces:**
- Produces: the tools of the version pins on `PATH`; `scripts/check-toolchain.sh`, exit code 0 when
  every pin matches.

- [ ] **Step 1: Write the check that will fail**

Create `scripts/check-toolchain.sh`:

```bash
#!/usr/bin/env bash
# Checks that the installed tools match the pinned versions. Exits non-zero on any mismatch.
set -uo pipefail

failed=0

check() {
  local name="$1" command="$2" want="$3" got
  if ! got="$(bash -c "$command" 2>/dev/null | head -n 1)" || [[ -z "$got" ]]; then
    echo "MISSING  $name (want $want)"
    failed=1
  elif [[ "$got" == *"$want"* ]]; then
    echo "OK       $name: $got"
  else
    echo "MISMATCH $name: want $want, got $got"
    failed=1
  fi
}

check rustc    "rustc --version"    "1.99.1"
check solana   "solana --version"   "4.3.2"
check anchor   "anchor --version"   "1.2.1"
check node     "node --version"     "v24.22.0"
check pnpm     "pnpm --version"     "12.14.0"
check surfpool "surfpool --version" "1.6.1"
check kora     "kora --version"     "2.0.5"

exit "$failed"
```

Create `rust-toolchain.toml`:

```toml
[toolchain]
channel = "1.99.1"
components = ["rustfmt", "clippy"]
```

Create `.nvmrc`:

```
24.22.0
```

- [ ] **Step 2: Run the check to see it fail**

Run: `chmod +x scripts/check-toolchain.sh && scripts/check-toolchain.sh`
Expected: `MISSING` lines, exit code 1.

- [ ] **Step 3: Install the system packages (needs `sudo`; the developer runs this one)**

```bash
sudo apt-get update
sudo apt-get install -y build-essential pkg-config libudev-dev llvm libclang-dev protobuf-compiler libssl-dev
```

Every later step installs into the user's home and needs no `sudo`.

- [ ] **Step 4: Install Rust, Agave and Anchor**

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain 1.99.1
source "$HOME/.cargo/env"

sh -c "$(curl -sSfL https://release.anza.xyz/v4.3.2/install)"
echo 'export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"' >> ~/.bashrc
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"

cargo install --git https://github.com/otter-sec/anchor --tag v1.2.1 avm --locked --force
avm install 1.2.1
avm use 1.2.1
```

- [ ] **Step 5: Install Node.js, pnpm, Surfpool and Kora**

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.8/install.sh | bash
source ~/.nvm/nvm.sh
nvm install 24.22.0

curl -fsSL https://get.pnpm.io/install.sh | env PNPM_VERSION=12.14.0 sh -
source ~/.bashrc

curl -sL https://run.surfpool.run/ | VERSION=v1.6.1 bash

cargo install kora-cli --version 2.0.5 --locked
```

- [ ] **Step 6: Run the check to see it pass**

Run: `scripts/check-toolchain.sh`
Expected: seven `OK` lines, exit code 0.

- [ ] **Step 7: Record the pins in `CLAUDE.md`**

In `CLAUDE.md`, replace the body of the section `## Toolchain` with:

```markdown
Named in section 3.5 of `docs/specs/stint-system.md` and pinned by
`docs/plans/00-toolchain-and-harness.md`:

| Tool | Version |
|---|---|
| Rust | 1.99.1 (`rust-toolchain.toml`) |
| Agave (Solana CLI) | 4.3.2 |
| Anchor | 1.2.1 |
| Node.js | 24.22.0 (`.nvmrc`) |
| pnpm | 12.14.0 (`packageManager`) |
| Surfpool | 1.6.1 |
| Kora | 2.0.5 |

`scripts/check-toolchain.sh` checks them. Commands: `anchor build` builds the program;
`pnpm generate:client` regenerates its client; `pnpm test` runs the unit tests; `pnpm e2e:local`
runs the end-to-end scenarios on the `local` target. On Windows, everything runs inside WSL 2 (the
Solana and Anchor toolchains require it).
```

- [ ] **Step 8: Commit**

```bash
git add rust-toolchain.toml .nvmrc scripts/check-toolchain.sh CLAUDE.md
git commit -m "Pin the toolchain and add a check for it"
```

---

### Task 2: Program skeleton

**Files:**
- Create: `Anchor.toml`, `Cargo.toml`, `programs/stint/Cargo.toml`, `programs/stint/src/lib.rs`,
  `programs/stint/src/state.rs`, `programs/stint/src/events.rs`, `programs/stint/src/errors.rs`

**Interfaces:**
- Produces: `target/deploy/stint.so` and `target/idl/stint.json` from `anchor build`; the program
  ID in `declare_id!` and in `Anchor.toml` under `[programs.localnet]` and `[programs.devnet]`;
  `stint::state::Session` with `Session::SIZE == 250`; `stint::errors::StintError` with variants in
  the order of spec §4.5, numbered from 6000; the event types of spec §4.4.

- [ ] **Step 1: Write the failing size test**

Create `programs/stint/src/state.rs`:

```rust
use anchor_lang::prelude::*;

/// Seed prefix of the session PDA: `["session", authority, seed]` (spec section 4.1).
pub const SESSION_SEED: &[u8] = b"session";

/// Layout version stored in `Session::version`.
pub const SESSION_VERSION: u8 = 1;

/// One session's terms and running totals (spec section 4.1).
#[account]
#[derive(InitSpace)]
pub struct Session {
    pub version: u8,
    pub bump: u8,
    pub authority: Pubkey,
    pub seed: u64,
    pub mint: Pubkey,
    pub receiver: Pubkey,
    pub receiver_authorizer: Pubkey,
    pub refund_owner: Pubkey,
    pub rent_payer: Pubkey,
    pub rate: u64,
    pub min_seconds: u32,
    pub max_seconds: u32,
    pub started_at: i64,
    pub deposited: u64,
    pub claimed: u64,
}

impl Session {
    /// Account size: Anchor's 8-byte discriminator, then the fields.
    pub const SIZE: usize = 8 + Session::INIT_SPACE;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_account_is_250_bytes() {
        assert_eq!(Session::SIZE, 250);
    }
}
```

Create `programs/stint/src/lib.rs`:

```rust
use anchor_lang::prelude::*;

pub mod errors;
pub mod events;
pub mod state;

declare_id!("11111111111111111111111111111111");

#[program]
pub mod stint {}
```

`anchor keys sync` replaces the ID in Step 5.

Create `programs/stint/Cargo.toml`:

```toml
[package]
name = "stint"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib", "lib"]
name = "stint"

[features]
default = []
cpi = ["no-entrypoint"]
no-entrypoint = []
no-idl = []
no-log-ix-name = []
idl-build = ["anchor-lang/idl-build"]

[dependencies]
anchor-lang = { version = "1.2.1", features = ["event-cpi"] }
```

Create `Cargo.toml`:

```toml
[workspace]
members = ["programs/*"]
resolver = "2"

[profile.release]
overflow-checks = true
lto = "fat"
codegen-units = 1

[profile.release.build-override]
opt-level = 3
incremental = false
codegen-units = 1
```

Create `Anchor.toml`:

```toml
[toolchain]
anchor_version = "1.2.1"
solana_version = "4.3.2"
package_manager = "pnpm"

[features]
resolution = true
skip-lint = false

[programs.localnet]
stint = "11111111111111111111111111111111"

[programs.devnet]
stint = "11111111111111111111111111111111"

[provider]
cluster = "localnet"
wallet = "~/.config/solana/id.json"
```

- [ ] **Step 2: Run it to see it fail**

Run: `cargo test -p stint`
Expected: FAIL to compile, because `errors` and `events` do not exist yet.

- [ ] **Step 3: Write the errors and events**

Create `programs/stint/src/errors.rs`:

```rust
use anchor_lang::prelude::*;

/// Program errors, in the order of spec section 4.5. Anchor numbers them from 6000.
#[error_code]
pub enum StintError {
    #[msg("The terms are invalid")]
    InvalidTerms,
    #[msg("The deposit is below the minimum charge")]
    DepositTooSmall,
    #[msg("The deposit exceeds the maximum paid duration")]
    DepositTooLarge,
    #[msg("The session has expired")]
    SessionExpired,
    #[msg("The session has not expired yet")]
    NotExpired,
    #[msg("No new tokens have reached the vault")]
    NothingToTopUp,
    #[msg("The signer may not perform this action")]
    Unauthorized,
    #[msg("The mint does not match the session's")]
    MintMismatch,
    #[msg("An account does not match the session's")]
    AccountMismatch,
    #[msg("Arithmetic overflow")]
    MathOverflow,
}
```

Create `programs/stint/src/events.rs`:

```rust
use anchor_lang::prelude::*;

/// How a session is closed (spec section 4.3).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum CloseKind {
    Standard,
    AtExpiry,
    WaiveMinimum,
}

/// Events (spec section 4.4).
#[event]
pub struct Opened {
    pub session: Pubkey,
    pub authority: Pubkey,
    pub rate: u64,
    pub min_seconds: u32,
    pub max_seconds: u32,
    pub deposited: u64,
    pub started_at: i64,
    pub paid_until: i64,
}

#[event]
pub struct ToppedUp {
    pub session: Pubkey,
    pub added: u64,
    pub deposited: u64,
    pub paid_until: i64,
}

#[event]
pub struct Claimed {
    pub session: Pubkey,
    pub amount: u64,
    pub claimed: u64,
}

#[event]
pub struct Closed {
    pub session: Pubkey,
    pub kind: CloseKind,
    /// Paid by earlier claims.
    pub claimed: u64,
    /// Paid by this close.
    pub owed: u64,
    pub refunded: u64,
    pub redirected: u64,
    pub closed_by: Pubkey,
    /// As computed at the close.
    pub paid_until: i64,
    /// The chain's clock at the close: `Clock::unix_timestamp`.
    pub at: i64,
}
```

- [ ] **Step 4: Run the test to see it pass**

Run: `cargo test -p stint`
Expected: PASS, `session_account_is_250_bytes`.

- [ ] **Step 5: Build the program and fix its ID**

```bash
anchor build
anchor keys sync
anchor build
```

Expected: `target/deploy/stint.so`, `target/deploy/stint-keypair.json` and `target/idl/stint.json`
exist. `declare_id!` and both `[programs.*]` entries in `Anchor.toml` hold the same new ID. The
IDL lists the ten errors from 6000. Copy `target/deploy/stint-keypair.json` to safe storage outside
the repository: it is the program ID's keypair.

- [ ] **Step 6: Commit**

```bash
git add Anchor.toml Cargo.toml Cargo.lock programs/stint
git commit -m "Add the program skeleton with its account, events and errors"
```

---

### Task 3: Workspace and generated program client

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`,
  `packages/program-client/package.json`, `packages/program-client/tsconfig.json`,
  `packages/program-client/scripts/generate.mjs`, `packages/program-client/src/index.ts`,
  `packages/program-client/test/generated.test.ts`
- Generated: `packages/program-client/src/generated/` (by Codama; committed; never edited by hand)

**Interfaces:**
- Consumes: `target/idl/stint.json` (Task 2).
- Produces: package `@lxfoundry/stint-program-client`, exporting `STINT_PROGRAM_ADDRESS` and the
  error constants `STINT_ERROR__INVALID_TERMS` (6000) to `STINT_ERROR__MATH_OVERFLOW` (6009); root
  scripts `pnpm generate:client`, `pnpm typecheck`, `pnpm test`.

- [ ] **Step 1: Create the workspace**

Create `package.json`:

```json
{
  "name": "stint",
  "private": true,
  "packageManager": "pnpm@12.14.0",
  "engines": { "node": "24.22.0" },
  "scripts": {
    "generate:client": "pnpm --filter @lxfoundry/stint-program-client run generate",
    "typecheck": "pnpm -r run typecheck",
    "test": "pnpm -r run test",
    "e2e:local": "pnpm --filter @lxfoundry/stint-e2e run local"
  },
  "devDependencies": {
    "@types/node": "24.19.2",
    "tsx": "4.23.15",
    "typescript": "7.0.2",
    "vitest": "5.0.5"
  }
}
```

Create `pnpm-workspace.yaml`:

```yaml
packages:
  - packages/*
  - conformance
  - e2e
```

Create `tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "es2023",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "lib": ["es2023"],
    "types": ["node"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "noEmit": true
  }
}
```

Packages export their TypeScript sources directly. Vitest and tsx run them, `tsc --noEmit`
checks them, and nothing is built.

- [ ] **Step 2: Write the failing test**

Create `packages/program-client/package.json`:

```json
{
  "name": "@lxfoundry/stint-program-client",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "generate": "node scripts/generate.mjs",
    "typecheck": "tsc -p tsconfig.json",
    "test": "vitest run"
  },
  "dependencies": {
    "@solana/kit": "8.5.0"
  },
  "devDependencies": {
    "@codama/nodes-from-anchor": "1.5.6",
    "@codama/renderers-js": "2.8.0",
    "codama": "1.11.0"
  }
}
```

Create `packages/program-client/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src", "test"]
}
```

Create `packages/program-client/src/index.ts`:

```ts
export * from "./generated/index.js";
```

Create `packages/program-client/test/generated.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  STINT_ERROR__INVALID_TERMS,
  STINT_ERROR__MATH_OVERFLOW,
  STINT_PROGRAM_ADDRESS,
} from "../src/index.js";

describe("generated program client", () => {
  it("uses the program ID declared in Anchor.toml", () => {
    const anchorToml = readFileSync(new URL("../../../Anchor.toml", import.meta.url), "utf8");
    const declared = /\[programs\.localnet\]\s*\nstint = "([1-9A-HJ-NP-Za-km-z]+)"/.exec(anchorToml)?.[1];
    expect(declared).toBeDefined();
    expect(STINT_PROGRAM_ADDRESS).toBe(declared);
  });

  it("numbers the program errors from 6000, in the order of spec section 4.5", () => {
    expect(STINT_ERROR__INVALID_TERMS).toBe(6000);
    expect(STINT_ERROR__MATH_OVERFLOW).toBe(6009);
  });
});
```

- [ ] **Step 3: Run it to see it fail**

Run: `pnpm install && pnpm --filter @lxfoundry/stint-program-client test`
Expected: FAIL, because `src/generated/index.js` does not exist.

- [ ] **Step 4: Write the generation script and generate**

Create `packages/program-client/scripts/generate.mjs`:

```js
// Generates the program client from the Anchor IDL. Run after every `anchor build` that changes
// the program's interface; the output in src/generated is committed and never edited by hand.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createFromRoot } from "codama";
import { rootNodeFromAnchor } from "@codama/nodes-from-anchor";
import { renderVisitor } from "@codama/renderers-js";

const idlPath = fileURLToPath(new URL("../../../target/idl/stint.json", import.meta.url));
const packageFolder = fileURLToPath(new URL("..", import.meta.url));

const idl = JSON.parse(readFileSync(idlPath, "utf8"));
await createFromRoot(rootNodeFromAnchor(idl)).accept(
  renderVisitor(packageFolder, { importExtension: "js" }),
);
```

Run: `pnpm generate:client && pnpm install`
Expected: `packages/program-client/src/generated/` exists. The renderer may add `@solana/*`
dependencies to `packages/program-client/package.json`. If it does, set each to an exact version
(`8.5.0` for `@solana/*` packages), so every dependency stays pinned.

- [ ] **Step 5: Run the tests and the type check to see them pass**

Run: `pnpm --filter @lxfoundry/stint-program-client test && pnpm typecheck`
Expected: PASS, two tests; no type errors.

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json packages/program-client
git commit -m "Add the pnpm workspace and the generated program client"
```

---

### Task 4: Scenario catalogue, runner and report

**Files:**
- Create: `conformance/package.json`, `conformance/tsconfig.json`, `conformance/src/types.ts`,
  `conformance/src/catalogue.ts`, `conformance/src/runner.ts`, `conformance/src/report.ts`,
  `conformance/src/index.ts`, `conformance/test/catalogue.test.ts`,
  `conformance/test/runner.test.ts`, `conformance/test/report.test.ts`

**Interfaces:**
- Produces, from `@lxfoundry/stint-conformance`:
  - types `Capability`, `IsolationGroup`, `ScenarioStatus`, `ScenarioResult`, `Target`,
    `ScenarioContext`, `Scenario`, `ScenarioOutcome`;
  - `catalogue: readonly Scenario[]` (35 entries);
  - `runScenarios(scenarios, target, makeContext): Promise<ScenarioOutcome[]>`;
  - `exitCodeFor(outcomes): 0 | 1`;
  - `renderReport(outcomes): string` and `writeReport(directory, outcomes): void`, which writes
    `report.md` and `report.json`.

- [ ] **Step 1: Create the package and its types**

Create `conformance/package.json`:

```json
{
  "name": "@lxfoundry/stint-conformance",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "typecheck": "tsc -p tsconfig.json",
    "test": "vitest run"
  }
}
```

Create `conformance/tsconfig.json`:

```json
{
  "extends": "../tsconfig.base.json",
  "include": ["src", "test"]
}
```

Create `conformance/src/types.ts`:

```ts
/**
 * What a target offers a scenario (spec section 12.2). `facilitatorApi` is the ability to call
 * the facilitator's `/verify` with an API key: always on `local` and `devnet`, and on `external`
 * only with `--facilitator` and `--facilitator-key` (scenarios 18 and 19).
 */
export type Capability = "chain" | "stack" | "allowance" | "facilitatorApi";

/** Where a scenario runs (spec section 12.2, "Isolation"). */
export type IsolationGroup = "shared" | "ownStack" | "ownNetwork";

export type ScenarioStatus = "required" | "pending";

export type ScenarioResult = "pass" | "fail" | "pending" | "not applicable";

export interface Target {
  readonly name: "local" | "devnet" | "external";
  readonly capabilities: ReadonlySet<Capability>;
}

/** What a scenario receives when it runs. Later stages add the services it drives. */
export interface ScenarioContext {
  readonly target: Target;
}

export interface Scenario {
  readonly id: number;
  readonly title: string;
  readonly needs: readonly Capability[];
  readonly group: IsolationGroup;
  readonly status: ScenarioStatus;
  /** Absent until the scenario is built. */
  readonly run?: (context: ScenarioContext) => Promise<void>;
}

export interface ScenarioOutcome {
  readonly id: number;
  readonly title: string;
  readonly target: Target["name"];
  readonly status: ScenarioStatus;
  readonly result: ScenarioResult;
  readonly durationMs: number;
  /** A pending scenario that passed: it must be made required in the same change. */
  readonly passesWhilePending: boolean;
  readonly error?: string;
}
```

- [ ] **Step 2: Write the failing catalogue test**

Create `conformance/test/catalogue.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { catalogue } from "../src/catalogue.js";
import type { Capability, IsolationGroup } from "../src/types.js";

const byId = new Map(catalogue.map((scenario) => [scenario.id, scenario]));

function idsWhere(predicate: (needs: readonly Capability[]) => boolean): number[] {
  return catalogue.filter((scenario) => predicate(scenario.needs)).map((scenario) => scenario.id);
}

describe("scenario catalogue", () => {
  it("lists the 35 scenarios of spec section 12.7, numbered 1 to 35", () => {
    expect(catalogue.map((scenario) => scenario.id)).toEqual(
      Array.from({ length: 35 }, (_, index) => index + 1),
    );
  });

  it("starts every scenario as pending, with no implementation", () => {
    for (const scenario of catalogue) {
      expect(scenario.status).toBe("pending");
      expect(scenario.run).toBeUndefined();
    }
  });

  it("states the needs of spec section 12.7", () => {
    const same = (needs: readonly Capability[], expected: Capability[]) =>
      needs.length === expected.length && expected.every((capability) => needs.includes(capability));
    expect(idsWhere((needs) => same(needs, ["stack"]))).toEqual([10, 11, 22, 23, 24, 25, 26, 27, 30, 33, 34]);
    expect(idsWhere((needs) => same(needs, ["chain", "stack"]))).toEqual([28, 31]);
    expect(idsWhere((needs) => same(needs, ["allowance"]))).toEqual([12]);
    expect(idsWhere((needs) => same(needs, ["facilitatorApi"]))).toEqual([18, 19]);
    expect(idsWhere((needs) => needs.length === 0)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 13, 14, 15, 16, 17, 20, 21, 29, 32, 35,
    ]);
  });

  it("places scenarios in the isolation groups of spec section 12.2", () => {
    const group = (id: number): IsolationGroup | undefined => byId.get(id)?.group;
    for (const id of [10, 11, 23, 24, 25, 26, 27, 28, 33, 34]) expect(group(id)).toBe("ownStack");
    expect(group(31)).toBe("ownNetwork");
    const shared = catalogue.filter((scenario) => scenario.group === "shared").map((s) => s.id);
    expect(shared).toHaveLength(24);
  });
});
```

- [ ] **Step 3: Run it to see it fail**

Run: `pnpm install && pnpm --filter @lxfoundry/stint-conformance test`
Expected: FAIL, because `src/catalogue.ts` does not exist.

- [ ] **Step 4: Write the catalogue**

Create `conformance/src/catalogue.ts`:

```ts
import type { Capability, IsolationGroup, Scenario } from "./types.js";

/** The scenarios of spec section 12.7. Each is pending until a stage builds it. */
function pending(
  id: number,
  title: string,
  needs: readonly Capability[] = [],
  group: IsolationGroup = "shared",
): Scenario {
  return { id, title, needs, group, status: "pending" };
}

export const catalogue: readonly Scenario[] = [
  pending(1, "Open, connect, close early"),
  pending(2, "Close before minSeconds"),
  pending(3, "Expiry"),
  pending(4, "Top-up before and after expiry"),
  pending(5, "Payment with wrong terms, a wrong amount, or a Memo instruction"),
  pending(6, "Failed payment"),
  pending(7, "Unilateral on-chain close"),
  pending(8, "Token: expired, wrong aud, wrong purpose, replayed"),
  pending(9, "Disconnect past the grace period; reconnect within it; never connect"),
  pending(10, "Resource outage", ["stack"], "ownStack"),
  pending(11, "Two gate instances, reconnecting elsewhere", ["stack"], "ownStack"),
  pending(12, "Allowance funding", ["allowance"]),
  pending(13, "Payment whose accepted differs by one byte; x402Version 1"),
  pending(14, "The same payment sent twice"),
  pending(15, "Sponsored close through closeUrl"),
  pending(16, "Close by an unrelated key after paid_until"),
  pending(17, "Top-up for an unknown session"),
  pending(18, "Fee payer or rent payer in a forbidden position", ["facilitatorApi"]),
  pending(19, "/verify of a valid open", ["facilitatorApi"]),
  pending(20, "Session opened on-chain with the gate's terms but another mint"),
  pending(21, "Refund account closed, a stray base unit, then expiry"),
  pending(22, "The example agent's task, scripted", ["stack"]),
  pending(23, "The gate restarts with a session open", ["stack"], "ownStack"),
  pending(24, "The gate is unreachable when the buyer closes", ["stack"], "ownStack"),
  pending(25, "The gate and the facilitator are unreachable when the buyer closes", ["stack"], "ownStack"),
  pending(26, "An expired session that nobody closes", ["stack"], "ownStack"),
  pending(27, "The seller has closed its receiver_token before a close that pays it", ["stack"], "ownStack"),
  pending(28, "A payout account, then the vault, frozen", ["chain", "stack"], "ownStack"),
  pending(29, "The buyer's process restarts with a session open"),
  pending(30, "The resource closes a session through the admin port", ["stack"]),
  pending(31, "Network time moved forward to the end of maxSeconds", ["chain", "stack"], "ownNetwork"),
  pending(32, "Durations out of bounds"),
  pending(33, "A settlement reply lost after the transaction lands", ["stack"], "ownStack"),
  pending(34, "A top-up lands while the gate is closing at expiry", ["stack"], "ownStack"),
  pending(35, "A session opened on-chain with the gate's terms is adopted"),
];
```

- [ ] **Step 5: Run it to see it pass**

Run: `pnpm --filter @lxfoundry/stint-conformance test`
Expected: PASS, four tests.

- [ ] **Step 6: Write the failing runner test**

Create `conformance/test/runner.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { exitCodeFor, runScenarios } from "../src/runner.js";
import type { Scenario, Target } from "../src/types.js";

const local: Target = { name: "local", capabilities: new Set(["chain", "stack", "facilitatorApi"]) };
const external: Target = { name: "external", capabilities: new Set() };
const context = (target: Target) => () => ({ target });

function scenario(overrides: Partial<Scenario>): Scenario {
  return { id: 1, title: "A scenario", needs: [], group: "shared", status: "pending", ...overrides };
}

const passes = async () => {};
const fails = async () => {
  throw new Error("boom");
};

describe("runScenarios", () => {
  it("reports a scenario whose needs the target lacks as not applicable", async () => {
    const [outcome] = await runScenarios([scenario({ needs: ["stack"], run: fails })], external, context(external));
    expect(outcome?.result).toBe("not applicable");
  });

  it("reports a pending scenario without an implementation as pending", async () => {
    const [outcome] = await runScenarios([scenario({})], local, context(local));
    expect(outcome?.result).toBe("pending");
  });

  it("fails a required scenario without an implementation", async () => {
    const [outcome] = await runScenarios([scenario({ status: "required" })], local, context(local));
    expect(outcome?.result).toBe("fail");
    expect(outcome?.error).toBe("a required scenario has no implementation");
  });

  it("reports a failing pending scenario as pending, with its error", async () => {
    const [outcome] = await runScenarios([scenario({ run: fails })], local, context(local));
    expect(outcome?.result).toBe("pending");
    expect(outcome?.error).toBe("boom");
  });

  it("flags a pending scenario that passes", async () => {
    const [outcome] = await runScenarios([scenario({ run: passes })], local, context(local));
    expect(outcome?.result).toBe("pass");
    expect(outcome?.passesWhilePending).toBe(true);
  });

  it("fails a required scenario that throws", async () => {
    const [outcome] = await runScenarios([scenario({ status: "required", run: fails })], local, context(local));
    expect(outcome?.result).toBe("fail");
  });

  it("runs scenarios in the order of their numbers", async () => {
    const outcomes = await runScenarios([scenario({ id: 2 }), scenario({ id: 1 })], local, context(local));
    expect(outcomes.map((outcome) => outcome.id)).toEqual([1, 2]);
  });
});

describe("exitCodeFor", () => {
  it("is 1 when any required scenario fails, and 0 otherwise", async () => {
    const failing = await runScenarios([scenario({ status: "required", run: fails })], local, context(local));
    const pendingOnly = await runScenarios([scenario({ run: fails })], local, context(local));
    expect(exitCodeFor(failing)).toBe(1);
    expect(exitCodeFor(pendingOnly)).toBe(0);
  });
});
```

- [ ] **Step 7: Run it to see it fail**

Run: `pnpm --filter @lxfoundry/stint-conformance test`
Expected: FAIL, because `src/runner.ts` does not exist.

- [ ] **Step 8: Write the runner**

Create `conformance/src/runner.ts`:

```ts
import type { Scenario, ScenarioContext, ScenarioOutcome, Target } from "./types.js";

/**
 * Runs scenarios one after another, in the order of their numbers. Concurrency and the isolation
 * groups of spec section 12.2 arrive with the first scenarios that need them.
 */
export async function runScenarios(
  scenarios: readonly Scenario[],
  target: Target,
  makeContext: (scenario: Scenario) => ScenarioContext | Promise<ScenarioContext>,
  now: () => number = () => performance.now(),
): Promise<ScenarioOutcome[]> {
  const outcomes: ScenarioOutcome[] = [];
  for (const scenario of [...scenarios].sort((a, b) => a.id - b.id)) {
    const base = { id: scenario.id, title: scenario.title, target: target.name, status: scenario.status };

    if (!scenario.needs.every((capability) => target.capabilities.has(capability))) {
      outcomes.push({ ...base, result: "not applicable", durationMs: 0, passesWhilePending: false });
      continue;
    }

    if (!scenario.run) {
      const required = scenario.status === "required";
      outcomes.push({
        ...base,
        result: required ? "fail" : "pending",
        durationMs: 0,
        passesWhilePending: false,
        ...(required ? { error: "a required scenario has no implementation" } : {}),
      });
      continue;
    }

    const started = now();
    try {
      await scenario.run(await makeContext(scenario));
      outcomes.push({
        ...base,
        result: "pass",
        durationMs: now() - started,
        passesWhilePending: scenario.status === "pending",
      });
    } catch (error) {
      outcomes.push({
        ...base,
        result: scenario.status === "required" ? "fail" : "pending",
        durationMs: now() - started,
        passesWhilePending: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return outcomes;
}

/** A run fails when any required scenario fails (spec section 12.2, "Status"). */
export function exitCodeFor(outcomes: readonly ScenarioOutcome[]): 0 | 1 {
  return outcomes.some((outcome) => outcome.result === "fail") ? 1 : 0;
}
```

- [ ] **Step 9: Run it to see it pass**

Run: `pnpm --filter @lxfoundry/stint-conformance test`
Expected: PASS, twelve tests.

- [ ] **Step 10: Write the failing report test**

Create `conformance/test/report.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { renderReport } from "../src/report.js";
import type { ScenarioOutcome } from "../src/types.js";

const outcome = (overrides: Partial<ScenarioOutcome>): ScenarioOutcome => ({
  id: 1,
  title: "Open, connect, close early",
  target: "local",
  status: "pending",
  result: "pending",
  durationMs: 0,
  passesWhilePending: false,
  ...overrides,
});

describe("renderReport", () => {
  it("writes one table row per scenario", () => {
    const report = renderReport([outcome({}), outcome({ id: 2, title: "Close before minSeconds" })]);
    expect(report).toContain("| Scenario | Target | Status | Result | Duration |");
    expect(report).toContain("| 1. Open, connect, close early | local | pending | pending | 0.0 s |");
    expect(report).toContain("| 2. Close before minSeconds | local | pending | pending | 0.0 s |");
  });

  it("flags a pending scenario that passes", () => {
    const report = renderReport([outcome({ result: "pass", passesWhilePending: true, durationMs: 1234 })]);
    expect(report).toContain("| pass (make required) | 1.2 s |");
    expect(report).toContain("Make required: 1");
  });

  it("escapes pipes in titles", () => {
    expect(renderReport([outcome({ title: "a | b" })])).toContain("1. a \\| b");
  });

  it("counts each result", () => {
    const report = renderReport([
      outcome({ status: "required", result: "pass" }),
      outcome({ id: 2, result: "not applicable" }),
      outcome({ id: 3, title: "A failure", status: "required", result: "fail", error: "boom" }),
    ]);
    expect(report).toContain("Required: 2 · Pending: 1 · Passed: 1 · Failed: 1 · Not applicable: 1");
    expect(report).toContain("3. A failure: boom");
  });
});
```

- [ ] **Step 11: Run it to see it fail**

Run: `pnpm --filter @lxfoundry/stint-conformance test`
Expected: FAIL, because `src/report.ts` does not exist.

- [ ] **Step 12: Write the report**

Create `conformance/src/report.ts`:

```ts
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ScenarioOutcome } from "./types.js";

const escapeCell = (text: string) => text.replaceAll("|", "\\|");
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

/** The run report of spec section 12.2: one row per scenario, then the counts. */
export function renderReport(outcomes: readonly ScenarioOutcome[]): string {
  const rows = outcomes.map((outcome) => {
    const result = outcome.passesWhilePending ? `${outcome.result} (make required)` : outcome.result;
    return `| ${outcome.id}. ${escapeCell(outcome.title)} | ${outcome.target} | ${outcome.status} | ${result} | ${seconds(outcome.durationMs)} |`;
  });

  const count = (predicate: (outcome: ScenarioOutcome) => boolean) => outcomes.filter(predicate).length;
  const summary = [
    `Required: ${count((o) => o.status === "required")}`,
    `Pending: ${count((o) => o.status === "pending")}`,
    `Passed: ${count((o) => o.result === "pass")}`,
    `Failed: ${count((o) => o.result === "fail")}`,
    `Not applicable: ${count((o) => o.result === "not applicable")}`,
  ].join(" · ");

  const flagged = count((o) => o.passesWhilePending);
  const failures = outcomes
    .filter((o) => o.error !== undefined)
    .map((o) => `- ${o.id}. ${o.title}: ${o.error}`);

  return [
    "| Scenario | Target | Status | Result | Duration |",
    "|---|---|---|---|---|",
    ...rows,
    "",
    summary,
    ...(flagged > 0 ? ["", `Make required: ${flagged}`] : []),
    ...(failures.length > 0 ? ["", "Errors:", ...failures] : []),
    "",
  ].join("\n");
}

/** Writes `report.md` and `report.json` into `directory`. */
export function writeReport(directory: string, outcomes: readonly ScenarioOutcome[]): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "report.md"), renderReport(outcomes));
  writeFileSync(join(directory, "report.json"), `${JSON.stringify(outcomes, null, 2)}\n`);
}
```

Create `conformance/src/index.ts`:

```ts
export * from "./types.js";
export { catalogue } from "./catalogue.js";
export { exitCodeFor, runScenarios } from "./runner.js";
export { renderReport, writeReport } from "./report.js";
```

- [ ] **Step 13: Run the tests and the type check to see them pass**

Run: `pnpm --filter @lxfoundry/stint-conformance test && pnpm typecheck`
Expected: PASS, sixteen tests; no type errors.

- [ ] **Step 14: Commit**

```bash
git add conformance pnpm-lock.yaml
git commit -m "Add the scenario catalogue, its runner and the run report"
```

---

### Task 5: Local network and its fixtures

**Files:**
- Create: `e2e/package.json`, `e2e/tsconfig.json`, `e2e/vitest.config.ts`, `e2e/src/paths.ts`,
  `e2e/src/network/surfnet.ts`, `e2e/src/network/transactions.ts`, `e2e/src/fixtures/keys.ts`,
  `e2e/src/fixtures/usdc.ts`, `e2e/src/fixtures/programs.ts`,
  `scripts/fetch-subscriptions-program.sh`, `e2e/fixtures/subscriptions.sha256`,
  `e2e/test/local-network.test.ts`
- Modify: `.gitignore` (add `e2e/report/`)

**Interfaces:**
- Consumes: `STINT_PROGRAM_ADDRESS` (Task 3); `target/deploy/stint.so` (Task 2).
- Produces:
  - `startLocalNetwork(): LocalNetwork`, where `LocalNetwork` is `{ rpcUrl, wsUrl, rpc, surfnet,
    stop(): void }`;
  - `waitForNewSlot(rpc): Promise<bigint>`;
  - `sendInstructions(rpc, feePayer, instructions): Promise<Signature>`,
    `confirmSignature(rpc, signature): Promise<void>` and
    `simulateInstruction(rpc, feePayer, programAddress): Promise<{ logs: readonly string[] }>`;
  - `HarnessKey` (`{ signer: KeyPairSigner; secretKey: Uint8Array }`) and
    `newHarnessKey(): Promise<HarnessKey>`;
  - `fundSol(network, address, sol)`;
  - `USDC_DEVNET_MINT`, `USDC_DECIMALS`, `writeUsdcMint(network, authorities): Promise<void>`,
    `createUsdcAccount(rpc, payer, owner): Promise<Address>`,
    `mintUsdc(rpc, mintAuthority, owner, amount): Promise<Address>`;
  - `SUBSCRIPTIONS_PROGRAM_ADDRESS`, `deployStintProgram(network)`,
    `deploySubscriptionsProgram(network)`.

- [ ] **Step 1: Fetch and pin the Subscriptions program copy**

Create `scripts/fetch-subscriptions-program.sh`:

```bash
#!/usr/bin/env bash
# Fetches the Subscriptions & Allowances program from devnet into e2e/.cache when the cache is
# empty, then checks it against the pinned hash. It runs before a test run, never during one
# (spec section 12.3). With --pin, it records the hash of the cached copy instead.
set -euo pipefail
cd "$(dirname "$0")/.."

program_id="De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44"
copy="e2e/.cache/subscriptions.so"
pin="e2e/fixtures/subscriptions.sha256"

mkdir -p e2e/.cache e2e/fixtures
if [[ ! -f "$copy" ]]; then
  solana program dump --url devnet "$program_id" "$copy"
fi

actual="$(sha256sum "$copy" | cut -d ' ' -f 1)"
if [[ "${1:-}" == "--pin" ]]; then
  echo "$actual" > "$pin"
  echo "Pinned $actual"
  exit 0
fi

expected="$(cat "$pin")"
if [[ "$actual" != "$expected" ]]; then
  echo "The cached Subscriptions program ($actual) does not match the pinned hash ($expected)." >&2
  exit 1
fi
echo "The cached Subscriptions program matches the pinned hash."
```

Run:

```bash
chmod +x scripts/fetch-subscriptions-program.sh
scripts/fetch-subscriptions-program.sh --pin
scripts/fetch-subscriptions-program.sh
```

Expected: `Pinned <hash>`, then `The cached Subscriptions program matches the pinned hash.`
`e2e/.cache/` is already ignored (`.cache/` in `.gitignore`); `e2e/fixtures/subscriptions.sha256`
is committed.

- [ ] **Step 2: Create the package and the failing tests**

Add this line to `.gitignore`, in the block of build, dependency and test output:

```
e2e/report/
```

Create `e2e/package.json`:

```json
{
  "name": "@lxfoundry/stint-e2e",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "typecheck": "tsc -p tsconfig.json",
    "test": "vitest run",
    "local": "tsx src/cli.ts"
  },
  "dependencies": {
    "@lxfoundry/stint-conformance": "workspace:*",
    "@lxfoundry/stint-program-client": "workspace:*",
    "@solana-program/token": "0.18.0",
    "@solana/kit": "8.5.0",
    "@solana/surfpool": "1.6.1"
  }
}
```

Create `e2e/tsconfig.json`:

```json
{
  "extends": "../tsconfig.base.json",
  "include": ["src", "test", "vitest.config.ts"]
}
```

Create `e2e/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

// Each test file starts its own network. Running files one at a time keeps the machine's load,
// and so the chain's clock, predictable.
export default defineConfig({
  test: {
    testTimeout: 60_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
```

Create `e2e/test/local-network.test.ts`:

```ts
import { fetchMint, fetchToken } from "@solana-program/token";
import { address, fetchSysvarClock, some } from "@solana/kit";
import { STINT_PROGRAM_ADDRESS } from "@lxfoundry/stint-program-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newHarnessKey, fundSol, type HarnessKey } from "../src/fixtures/keys.js";
import {
  SUBSCRIPTIONS_PROGRAM_ADDRESS,
  deployStintProgram,
  deploySubscriptionsProgram,
} from "../src/fixtures/programs.js";
import { USDC_DECIMALS, USDC_DEVNET_MINT, mintUsdc, writeUsdcMint } from "../src/fixtures/usdc.js";
import { startLocalNetwork, waitForNewSlot, type LocalNetwork } from "../src/network/surfnet.js";
import { simulateInstruction } from "../src/network/transactions.js";

describe("local network", () => {
  let network: LocalNetwork;
  let mintAuthority: HarnessKey;
  let freezeAuthority: HarnessKey;

  beforeAll(async () => {
    network = startLocalNetwork();
    mintAuthority = await newHarnessKey();
    freezeAuthority = await newHarnessKey();
    fundSol(network, mintAuthority.signer.address, 10);
    await writeUsdcMint(network, {
      mintAuthority: mintAuthority.signer.address,
      freezeAuthority: freezeAuthority.signer.address,
    });
    deployStintProgram(network);
    deploySubscriptionsProgram(network);
    await waitForNewSlot(network.rpc);
  });

  afterAll(() => network?.stop());

  it("produces blocks on a clock, so the chain's time moves without transactions (T3)", async () => {
    const before = await fetchSysvarClock(network.rpc);
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    const after = await fetchSysvarClock(network.rpc);
    expect(after.unixTimestamp - before.unixTimestamp).toBeGreaterThanOrEqual(2n);
  });

  it("writes USDC at its devnet address, with harness keys as its authorities", async () => {
    const mint = await fetchMint(network.rpc, USDC_DEVNET_MINT);
    expect(mint.data.decimals).toBe(USDC_DECIMALS);
    expect(mint.data.mintAuthority).toEqual(some(mintAuthority.signer.address));
    expect(mint.data.freezeAuthority).toEqual(some(freezeAuthority.signer.address));
  });

  it("mints USDC with an ordinary transaction", async () => {
    const owner = await newHarnessKey();
    const account = await mintUsdc(network.rpc, mintAuthority.signer, owner.signer.address, 1_000_000n);
    const token = await fetchToken(network.rpc, account);
    expect(token.data.amount).toBe(1_000_000n);
    expect(token.data.mint).toBe(USDC_DEVNET_MINT);
  });

  it("runs the Stint program at its program ID", async () => {
    const result = await simulateInstruction(network.rpc, mintAuthority.signer, STINT_PROGRAM_ADDRESS);
    expect(result.logs.some((line) => line.startsWith(`Program ${STINT_PROGRAM_ADDRESS} consumed`))).toBe(true);
  });

  it("runs the Subscriptions program from its devnet copy (spec section 14, question 6)", async () => {
    const result = await simulateInstruction(network.rpc, mintAuthority.signer, SUBSCRIPTIONS_PROGRAM_ADDRESS);
    expect(result.logs.some((line) => line.startsWith(`Program ${SUBSCRIPTIONS_PROGRAM_ADDRESS} consumed`))).toBe(true);
  });

  it("keeps the Subscriptions program at its devnet address", () => {
    expect(SUBSCRIPTIONS_PROGRAM_ADDRESS).toBe(address("De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44"));
  });
});
```

A program that runs logs `Program <id> consumed <n> of <m> compute units`, even when it rejects
the instruction. A program the runtime could not load never logs that line. The two `runs` tests
therefore pass only if the program actually executed.

- [ ] **Step 3: Run them to see them fail**

Run: `pnpm install && anchor build && pnpm --filter @lxfoundry/stint-e2e test`
Expected: FAIL, because the `src/` modules do not exist.

- [ ] **Step 4: Write the paths, the network and the transactions**

Create `e2e/src/paths.ts`:

```ts
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const STINT_SO_PATH = join(REPO_ROOT, "target/deploy/stint.so");
export const SUBSCRIPTIONS_SO_PATH = join(REPO_ROOT, "e2e/.cache/subscriptions.so");
export const SUBSCRIPTIONS_PIN_PATH = join(REPO_ROOT, "e2e/fixtures/subscriptions.sha256");
export const REPORT_DIR = join(REPO_ROOT, "e2e/report");
```

Create `e2e/src/network/surfnet.ts`:

```ts
import { Surfnet } from "@solana/surfpool";
import { createSolanaRpc, type Rpc, type SolanaRpcApi } from "@solana/kit";

/** Slot time of the local network (spec section 12.3). */
export const SLOT_TIME_MS = 400;

/**
 * Feature gate `disable_sbpf_v0_v1_v2_deployment`, disabled so that a program built for an older
 * SBPF version, such as the Subscriptions program copied from devnet, can be deployed.
 */
export const DISABLE_SBPF_V0_V1_V2_DEPLOYMENT = "B8JJXCy5amZyWG9r7EnUYLwzXSXTxG7GZ1qZ1qggo83g";

export interface LocalNetwork {
  readonly rpcUrl: string;
  readonly wsUrl: string;
  readonly rpc: Rpc<SolanaRpcApi>;
  readonly surfnet: Surfnet;
  stop(): void;
}

/**
 * Starts Surfpool offline, in this process, producing blocks on a clock (spec section 12.3, T3).
 * Its ports are picked by binding and releasing them, so a start can lose a race for a port: it is
 * retried, as Kora's own harness does.
 */
export function startLocalNetwork(attempts = 5): LocalNetwork {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const surfnet = Surfnet.startWithConfig({
        offline: true,
        blockProductionMode: "clock",
        slotTimeMs: SLOT_TIME_MS,
        disableFeatures: [DISABLE_SBPF_V0_V1_V2_DEPLOYMENT],
      });
      return {
        rpcUrl: surfnet.rpcUrl,
        wsUrl: surfnet.wsUrl,
        rpc: createSolanaRpc(surfnet.rpcUrl),
        surfnet,
        stop: () => surfnet.stop(),
      };
    } catch (error) {
      lastError = error;
      if (!String(error).includes("Address already in use")) throw error;
    }
  }
  throw lastError;
}

/** Cheatcodes race with transactions (T5): wait for a new slot after any of them. */
export async function waitForNewSlot(rpc: Rpc<SolanaRpcApi>, timeoutMs = 5_000): Promise<bigint> {
  const start = await rpc.getSlot({ commitment: "confirmed" }).send();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, SLOT_TIME_MS / 4));
    const slot = await rpc.getSlot({ commitment: "confirmed" }).send();
    if (slot > start) return slot;
  }
  throw new Error(`No new slot within ${timeoutMs} ms`);
}
```

Create `e2e/src/network/transactions.ts`:

```ts
import {
  appendTransactionMessageInstructions,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type Instruction,
  type Rpc,
  type Signature,
  type SolanaRpcApi,
  type TransactionSigner,
} from "@solana/kit";

const json = (value: unknown) =>
  JSON.stringify(value, (_, inner) => (typeof inner === "bigint" ? inner.toString() : inner));

/** Builds, signs and sends a version 0 transaction (spec section 3.5), then waits for `confirmed`. */
export async function sendInstructions(
  rpc: Rpc<SolanaRpcApi>,
  feePayer: TransactionSigner,
  instructions: readonly Instruction[],
): Promise<Signature> {
  const { value: latestBlockhash } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  const transaction = await signTransactionMessageWithSigners(message);
  const signature = getSignatureFromTransaction(transaction);
  await rpc.sendTransaction(getBase64EncodedWireTransaction(transaction), { encoding: "base64" }).send();
  await confirmSignature(rpc, signature);
  return signature;
}

/** Waits until a transaction is `confirmed`, and throws if it failed. */
export async function confirmSignature(
  rpc: Rpc<SolanaRpcApi>,
  signature: Signature,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { value } = await rpc.getSignatureStatuses([signature]).send();
    const status = value[0];
    if (status?.err) throw new Error(`Transaction ${signature} failed: ${json(status.err)}`);
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Transaction ${signature} was not confirmed within ${timeoutMs} ms`);
}

/**
 * Simulates one instruction with no accounts and eight 0xff bytes of data, which no program
 * accepts, and returns the logs. Used to check that a program runs at all.
 */
export async function simulateInstruction(
  rpc: Rpc<SolanaRpcApi>,
  feePayer: TransactionSigner,
  programAddress: Address,
): Promise<{ logs: readonly string[] }> {
  const { value: latestBlockhash } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
    (m) => appendTransactionMessageInstructions([{ programAddress, data: new Uint8Array(8).fill(0xff) }], m),
  );
  const transaction = await signTransactionMessageWithSigners(message);
  const { value } = await rpc
    .simulateTransaction(getBase64EncodedWireTransaction(transaction), {
      encoding: "base64",
      commitment: "confirmed",
    })
    .send();
  return { logs: value.logs ?? [] };
}
```

- [ ] **Step 5: Write the keys, the USDC fixture and the programs**

Create `e2e/src/fixtures/keys.ts`:

```ts
import { Surfnet } from "@solana/surfpool";
import { createKeyPairSignerFromBytes, type Address, type KeyPairSigner } from "@solana/kit";
import type { LocalNetwork } from "../network/surfnet.js";

/** A key generated for one run, with its secret bytes for services that need them (Kora). */
export interface HarnessKey {
  readonly signer: KeyPairSigner;
  readonly secretKey: Uint8Array;
}

export async function newHarnessKey(): Promise<HarnessKey> {
  const secretKey = Uint8Array.from(Surfnet.newKeypair().secretKey);
  return { signer: await createKeyPairSignerFromBytes(secretKey), secretKey };
}

const LAMPORTS_PER_SOL = 1_000_000_000;

/** Funds an address with SOL through a cheatcode. Wait for a new slot before relying on it. */
export function fundSol(network: LocalNetwork, address: Address, sol: number): void {
  network.surfnet.fundSol(address, sol * LAMPORTS_PER_SOL);
}
```

Create `e2e/src/fixtures/usdc.ts`:

```ts
import {
  TOKEN_PROGRAM_ADDRESS,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getMintEncoder,
  getMintSize,
  getMintToCheckedInstruction,
} from "@solana-program/token";
import { address, some, type Address, type Rpc, type SolanaRpcApi, type TransactionSigner } from "@solana/kit";
import { sendInstructions } from "../network/transactions.js";
import type { LocalNetwork } from "../network/surfnet.js";

/** Devnet USDC (spec section 3.4). */
export const USDC_DEVNET_MINT = address("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
export const USDC_DECIMALS = 6;

/**
 * Writes the USDC mint at its devnet address with harness keys as its mint and freeze authorities
 * (spec section 12.3). Balances are then minted by ordinary transactions.
 */
export async function writeUsdcMint(
  network: LocalNetwork,
  authorities: { mintAuthority: Address; freezeAuthority: Address },
): Promise<void> {
  const data = getMintEncoder().encode({
    mintAuthority: some(authorities.mintAuthority),
    supply: 0n,
    decimals: USDC_DECIMALS,
    isInitialized: true,
    freezeAuthority: some(authorities.freezeAuthority),
  });
  if (data.length !== getMintSize()) throw new Error(`Unexpected mint size ${data.length}`);
  const rent = await network.rpc.getMinimumBalanceForRentExemption(BigInt(getMintSize())).send();
  network.surfnet.setAccount(USDC_DEVNET_MINT, Number(rent), Uint8Array.from(data), TOKEN_PROGRAM_ADDRESS);
}

/** Creates the owner's USDC associated token account, paid for by `payer`, and returns it. */
export async function createUsdcAccount(
  rpc: Rpc<SolanaRpcApi>,
  payer: TransactionSigner,
  owner: Address,
): Promise<Address> {
  const [account] = await findAssociatedTokenPda({ owner, mint: USDC_DEVNET_MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  const create = await getCreateAssociatedTokenIdempotentInstructionAsync({ payer, owner, mint: USDC_DEVNET_MINT });
  await sendInstructions(rpc, payer, [create]);
  return account;
}

/** Mints USDC to the owner's associated token account, creating it first, and returns it. */
export async function mintUsdc(
  rpc: Rpc<SolanaRpcApi>,
  mintAuthority: TransactionSigner,
  owner: Address,
  amount: bigint,
): Promise<Address> {
  const account = await createUsdcAccount(rpc, mintAuthority, owner);
  const mintTo = getMintToCheckedInstruction({
    mint: USDC_DEVNET_MINT,
    token: account,
    mintAuthority,
    amount,
    decimals: USDC_DECIMALS,
  });
  await sendInstructions(rpc, mintAuthority, [mintTo]);
  return account;
}
```

Create `e2e/src/fixtures/programs.ts`:

```ts
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { STINT_PROGRAM_ADDRESS } from "@lxfoundry/stint-program-client";
import { address } from "@solana/kit";
import { STINT_SO_PATH, SUBSCRIPTIONS_PIN_PATH, SUBSCRIPTIONS_SO_PATH } from "../paths.js";
import type { LocalNetwork } from "../network/surfnet.js";

/** The Subscriptions & Allowances program, at its devnet address (spec section 10). */
export const SUBSCRIPTIONS_PROGRAM_ADDRESS = address("De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44");

/** Deploys the Stint program, built by `anchor build`, at its program ID. */
export function deployStintProgram(network: LocalNetwork): void {
  if (!existsSync(STINT_SO_PATH)) throw new Error(`${STINT_SO_PATH} is missing: run anchor build`);
  network.surfnet.deploy({ programId: STINT_PROGRAM_ADDRESS, soPath: STINT_SO_PATH });
}

/** Deploys the cached devnet copy of the Subscriptions program, after checking its pinned hash. */
export function deploySubscriptionsProgram(network: LocalNetwork): void {
  if (!existsSync(SUBSCRIPTIONS_SO_PATH)) {
    throw new Error(`${SUBSCRIPTIONS_SO_PATH} is missing: run scripts/fetch-subscriptions-program.sh`);
  }
  const actual = createHash("sha256").update(readFileSync(SUBSCRIPTIONS_SO_PATH)).digest("hex");
  const expected = readFileSync(SUBSCRIPTIONS_PIN_PATH, "utf8").trim();
  if (actual !== expected) {
    throw new Error(`The Subscriptions program copy (${actual}) does not match the pinned hash (${expected})`);
  }
  network.surfnet.deploy({ programId: SUBSCRIPTIONS_PROGRAM_ADDRESS, soPath: SUBSCRIPTIONS_SO_PATH });
}
```

- [ ] **Step 6: Run the tests to see them pass**

Run: `pnpm --filter @lxfoundry/stint-e2e test`
Expected: PASS, six tests.

If the Subscriptions test fails because the copy cannot be loaded offline, spec §14 question 6 is
answered "no". Apply its fallback before going on: fork devnet with those accounts preloaded from
a snapshot. Tell the reviewer, because the fallback changes spec §12.3.

- [ ] **Step 7: Commit**

```bash
git add .gitignore scripts/fetch-subscriptions-program.sh e2e pnpm-lock.yaml
git commit -m "Start the local network with its USDC and program fixtures"
```

---

### Task 6: Kora as a child process

**Files:**
- Create: `e2e/src/kora/config.ts`, `e2e/src/kora/process.ts`, `e2e/src/kora/client.ts`,
  `e2e/test/kora.test.ts`

**Interfaces:**
- Consumes: Task 5's network, keys, transactions and USDC fixture.
- Produces:
  - `renderKoraConfig(input: KoraConfigInput): string` and `renderSignersConfig(): string`;
  - `startKora(options: KoraOptions): Promise<KoraProcess>`, where `KoraProcess` is
    `{ url: string; apiKey: string; logs(): string; stop(): Promise<void> }`;
  - `createKoraClient(url, apiKey): KoraClient`, with
    `getPayerSigner(): Promise<{ signer_address: string; payment_address: string }>` and
    `signTransaction(transaction: Base64EncodedWireTransaction): Promise<Base64EncodedWireTransaction>`.

- [ ] **Step 1: Write the failing tests**

Create `e2e/test/kora.test.ts`:

```ts
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchToken, getTransferCheckedInstruction } from "@solana-program/token";
import { STINT_PROGRAM_ADDRESS } from "@lxfoundry/stint-program-client";
import {
  appendTransactionMessageInstructions,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getSignatureFromTransaction,
  getTransactionDecoder,
  partiallySignTransactionMessageWithSigners,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fundSol, newHarnessKey, type HarnessKey } from "../src/fixtures/keys.js";
import { SUBSCRIPTIONS_PROGRAM_ADDRESS, deployStintProgram } from "../src/fixtures/programs.js";
import { USDC_DECIMALS, USDC_DEVNET_MINT, createUsdcAccount, mintUsdc, writeUsdcMint } from "../src/fixtures/usdc.js";
import { createKoraClient } from "../src/kora/client.js";
import { KORA_ALLOWED_PROGRAMS, renderKoraConfig, renderSignersConfig } from "../src/kora/config.js";
import { startKora, type KoraProcess } from "../src/kora/process.js";
import { startLocalNetwork, waitForNewSlot, type LocalNetwork } from "../src/network/surfnet.js";
import { confirmSignature } from "../src/network/transactions.js";

const configInput = {
  allowedPrograms: [...KORA_ALLOWED_PROGRAMS, STINT_PROGRAM_ADDRESS, SUBSCRIPTIONS_PROGRAM_ADDRESS],
  allowedTokens: [USDC_DEVNET_MINT],
  maxAllowedLamports: 1_000_000,
};

describe("Kora configuration", () => {
  it("passes Kora's own validation", () => {
    const directory = mkdtempSync(join(tmpdir(), "stint-kora-config-"));
    writeFileSync(join(directory, "kora.toml"), renderKoraConfig(configInput));
    writeFileSync(join(directory, "signers.toml"), renderSignersConfig());
    const result = spawnSync(process.env.KORA_BIN ?? "kora", ["--config", "kora.toml", "config", "validate"], {
      cwd: directory,
      encoding: "utf8",
    });
    expect(result.status, result.stderr + result.stdout).toBe(0);
  });
});

describe("Kora on the local network", () => {
  let network: LocalNetwork;
  let kora: KoraProcess;
  let mintAuthority: HarnessKey;
  let feePayer: HarnessKey;

  beforeAll(async () => {
    network = startLocalNetwork();
    mintAuthority = await newHarnessKey();
    feePayer = await newHarnessKey();
    const freezeAuthority = await newHarnessKey();
    fundSol(network, mintAuthority.signer.address, 10);
    fundSol(network, feePayer.signer.address, 1);
    await writeUsdcMint(network, {
      mintAuthority: mintAuthority.signer.address,
      freezeAuthority: freezeAuthority.signer.address,
    });
    deployStintProgram(network);
    await waitForNewSlot(network.rpc);
    kora = await startKora({
      rpcUrl: network.rpcUrl,
      config: configInput,
      feePayerSecretKey: feePayer.secretKey,
      apiKey: "local-test-key",
    });
  });

  afterAll(async () => {
    await kora?.stop();
    network?.stop();
  });

  it("reports the harness key as its fee payer", async () => {
    const client = createKoraClient(kora.url, kora.apiKey);
    const { signer_address } = await client.getPayerSigner();
    expect(signer_address).toBe(feePayer.signer.address);
  });

  it("pays the fee of a token transfer, and nothing else", async () => {
    const sender = await newHarnessKey();
    const recipient = await newHarnessKey();
    const source = await mintUsdc(network.rpc, mintAuthority.signer, sender.signer.address, 1_000_000n);
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
              authority: sender.signer,
              amount: 250_000n,
              decimals: USDC_DECIMALS,
            }),
          ],
          m,
        ),
    );
    const partiallySigned = await partiallySignTransactionMessageWithSigners(message);

    const client = createKoraClient(kora.url, kora.apiKey);
    const signed = await client.signTransaction(getBase64EncodedWireTransaction(partiallySigned));
    const signature = getSignatureFromTransaction(getTransactionDecoder().decode(getBase64Encoder().encode(signed)));
    await network.rpc.sendTransaction(signed, { encoding: "base64" }).send();
    await confirmSignature(network.rpc, signature);

    expect((await fetchToken(network.rpc, destination)).data.amount).toBe(250_000n);
    const transaction = await network.rpc
      .getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0, encoding: "json" })
      .send();
    const meta = transaction?.meta;
    expect(meta).toBeDefined();
    const paid = meta!.preBalances[0]! - meta!.postBalances[0]!;
    expect(paid).toBe(meta!.fee);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @lxfoundry/stint-e2e test -- kora`
Expected: FAIL, because the `src/kora/` modules do not exist.

- [ ] **Step 3: Write the configuration**

Create `e2e/src/kora/config.ts`:

```ts
/**
 * Kora's configuration for the local target: free pricing and the `Mock` price source, so Kora
 * makes no outside request (T7), and Lighthouse assertions off (spec section 6.2, T8). The
 * fee-payer policy forbids every action other than paying fees: its flags default to false, and
 * they are written out so the policy reads from the file. In Kora 2.0.5, once a section exists,
 * all of its keys are required.
 */
export interface KoraConfigInput {
  readonly allowedPrograms: readonly string[];
  readonly allowedTokens: readonly string[];
  readonly maxAllowedLamports: number;
}

/** Programs every transaction may use: System, SPL Token, Associated Token Account, Compute Budget. */
export const KORA_ALLOWED_PROGRAMS = [
  "11111111111111111111111111111111",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  "ComputeBudget111111111111111111111111111111",
] as const;

const list = (values: readonly string[]) => `[${values.map((value) => `"${value}"`).join(", ")}]`;

const SPL_TOKEN_POLICY_KEYS = [
  "allow_transfer",
  "allow_burn",
  "allow_close_account",
  "allow_approve",
  "allow_revoke",
  "allow_set_authority",
  "allow_mint_to",
  "allow_initialize_mint",
  "allow_initialize_account",
  "allow_initialize_multisig",
  "allow_freeze_account",
  "allow_thaw_account",
];

export function renderKoraConfig(input: KoraConfigInput): string {
  if (input.allowedTokens.length === 0) throw new Error("Kora needs at least one allowed token");
  return [
    "[kora]",
    "rate_limit = 100",
    "",
    "[kora.auth]",
    "",
    "[kora.lighthouse]",
    "enabled = false",
    "",
    "[kora.enabled_methods]",
    "liveness = true",
    "estimate_transaction_fee = true",
    "get_supported_tokens = true",
    "get_payer_signer = true",
    "sign_transaction = true",
    "sign_and_send_transaction = true",
    "transfer_transaction = false",
    "get_blockhash = true",
    "get_config = true",
    "",
    "[validation]",
    `max_allowed_lamports = ${input.maxAllowedLamports}`,
    "max_signatures = 10",
    'price_source = "Mock"',
    "allow_durable_transactions = false",
    `allowed_programs = ${list(input.allowedPrograms)}`,
    `allowed_tokens = ${list(input.allowedTokens)}`,
    "allowed_spl_paid_tokens = []",
    "disallowed_accounts = []",
    "",
    "[validation.price]",
    'type = "free"',
    "",
    "[validation.fee_payer_policy.system]",
    "allow_transfer = false",
    "allow_assign = false",
    "allow_create_account = false",
    "allow_allocate = false",
    "",
    "[validation.fee_payer_policy.spl_token]",
    ...SPL_TOKEN_POLICY_KEYS.map((key) => `${key} = false`),
    "",
    "[validation.fee_payer_policy.token_2022]",
    ...SPL_TOKEN_POLICY_KEYS.map((key) => `${key} = false`),
    "",
  ].join("\n");
}

/** One memory signer whose key comes from `KORA_PRIVATE_KEY`, a JSON array of 64 bytes. */
export function renderSignersConfig(): string {
  return [
    "[signer_pool]",
    'strategy = "round_robin"',
    "",
    "[[signers]]",
    'name = "fee_payer"',
    'type = "memory"',
    'private_key_env = "KORA_PRIVATE_KEY"',
    "",
  ].join("\n");
}
```

`[kora.lighthouse]` is a Kora 2.2 setting. Kora 2.0.5 ignores unknown keys and has no
Lighthouse, so the section is harmless there and protects an upgrade (T8).

- [ ] **Step 4: Write the process and the client**

Create `e2e/src/kora/process.ts`:

```ts
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderKoraConfig, renderSignersConfig, type KoraConfigInput } from "./config.js";

export interface KoraOptions {
  readonly rpcUrl: string;
  readonly config: KoraConfigInput;
  readonly feePayerSecretKey: Uint8Array;
  readonly apiKey: string;
  /** The `kora` binary: `KORA_BIN`, or `kora` on the PATH. */
  readonly binary?: string;
}

export interface KoraProcess {
  readonly url: string;
  readonly apiKey: string;
  logs(): string;
  stop(): Promise<void>;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

/**
 * Runs Kora in a fresh working directory: Kora reads a `.env` file from its working directory, so
 * a clean one keeps the developer's environment out. Its key reaches it only through its
 * environment.
 */
export async function startKora(options: KoraOptions): Promise<KoraProcess> {
  const directory = mkdtempSync(join(tmpdir(), "stint-kora-"));
  writeFileSync(join(directory, "kora.toml"), renderKoraConfig(options.config));
  writeFileSync(join(directory, "signers.toml"), renderSignersConfig());
  const port = await freePort();

  const child = spawn(
    options.binary ?? process.env.KORA_BIN ?? "kora",
    ["--config", "kora.toml", "--rpc-url", options.rpcUrl, "rpc", "start", "--signers-config", "signers.toml", "--port", String(port)],
    {
      cwd: directory,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? directory,
        KORA_PRIVATE_KEY: JSON.stringify(Array.from(options.feePayerSecretKey)),
        KORA_API_KEY: options.apiKey,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  let exited = false;
  const exit = new Promise<void>((resolve) => child.once("exit", () => ((exited = true), resolve())));

  const url = `http://127.0.0.1:${port}`;
  const stop = async () => {
    if (!exited) {
      child.kill("SIGINT"); // Kora 2.0.5 shuts down on Ctrl-C only.
      const timeout = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 5_000));
      if ((await Promise.race([exit, timeout])) === "timeout") child.kill("SIGKILL");
      await exit;
    }
    rmSync(directory, { recursive: true, force: true });
  };

  // Readiness: GET /liveness, backing off from 50 ms to 1 s, for up to 30 s.
  const deadline = Date.now() + 30_000;
  let delay = 50;
  while (Date.now() < deadline) {
    if (exited) throw new Error(`Kora exited during startup:\n${output}`);
    try {
      const response = await fetch(`${url}/liveness`);
      if (response.ok) return { url, apiKey: options.apiKey, logs: () => output, stop };
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(delay * 2, 1_000);
  }
  await stop();
  throw new Error(`Kora was not ready within 30 s:\n${output}`);
}
```

Create `e2e/src/kora/client.ts`:

```ts
import type { Base64EncodedWireTransaction } from "@solana/kit";

/**
 * Kora's JSON-RPC interface, called directly: its TypeScript client does not support the
 * `@solana/kit` major version pinned here (spec section 14, question 5).
 */
export interface KoraClient {
  getPayerSigner(): Promise<{ signer_address: string; payment_address: string }>;
  /** Adds the fee payer's signature to a transaction that already carries the others. */
  signTransaction(transaction: Base64EncodedWireTransaction): Promise<Base64EncodedWireTransaction>;
}

export function createKoraClient(url: string, apiKey: string): KoraClient {
  let id = 0;

  async function call<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
    });
    const body = (await response.json()) as { result?: T; error?: { code: number; message: string } };
    if (body.error) throw new Error(`Kora ${method}: ${body.error.message} (${body.error.code})`);
    if (body.result === undefined) throw new Error(`Kora ${method}: empty response`);
    return body.result;
  }

  return {
    getPayerSigner: () => call("getPayerSigner", {}),
    signTransaction: async (transaction) =>
      (await call<{ signed_transaction: Base64EncodedWireTransaction }>("signTransaction", { transaction }))
        .signed_transaction,
  };
}
```

- [ ] **Step 5: Run the tests to see them pass**

Run: `pnpm --filter @lxfoundry/stint-e2e test`
Expected: PASS, nine tests (six from Task 5, three here).

- [ ] **Step 6: Commit**

```bash
git add e2e/src/kora e2e/test/kora.test.ts
git commit -m "Run Kora as a child process of the harness"
```

---

### Task 7: The local target and the end-to-end command

**Files:**
- Create: `e2e/src/targets/local.ts`, `e2e/src/cli.ts`, `e2e/src/index.ts`,
  `e2e/test/local-target.test.ts`

**Interfaces:**
- Consumes: Tasks 4 to 6.
- Produces:
  - `startLocalStack(): Promise<LocalStack>`, where `LocalStack` is
    `{ target: Target; network: LocalNetwork; keys: CommonKeys; kora: KoraProcess; stop(): Promise<void> }`;
  - `CommonKeys` is `{ mintAuthority, freezeAuthority, koraFeePayer, rentPayer, receiverAuthorizer,
    seller: HarnessKey; sellerUsdcAccount: Address }`;
  - `pnpm e2e:local`, which writes `e2e/report/report.md` and `report.json` and exits 1 when a
    required scenario fails.

- [ ] **Step 1: Write the failing test**

Create `e2e/test/local-target.test.ts`:

```ts
import { fetchToken } from "@solana-program/token";
import { catalogue, exitCodeFor, runScenarios } from "@lxfoundry/stint-conformance";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startLocalStack, type LocalStack } from "../src/targets/local.js";

describe("local target", () => {
  let stack: LocalStack;

  beforeAll(async () => {
    stack = await startLocalStack();
  });

  afterAll(async () => {
    await stack?.stop();
  });

  it("offers chain control, stack control and the facilitator's API, but not allowance funding yet", () => {
    expect([...stack.target.capabilities].sort()).toEqual(["chain", "facilitatorApi", "stack"]);
  });

  it("creates the seller's USDC account", async () => {
    const account = await fetchToken(stack.network.rpc, stack.keys.sellerUsdcAccount);
    expect(account.data.owner).toBe(stack.keys.seller.signer.address);
  });

  it("reports every scenario of the catalogue, and passes while all are pending", async () => {
    const outcomes = await runScenarios(catalogue, stack.target, () => ({ target: stack.target }));
    expect(outcomes).toHaveLength(35);
    expect(outcomes.find((outcome) => outcome.id === 12)?.result).toBe("not applicable");
    expect(outcomes.filter((outcome) => outcome.result === "pending")).toHaveLength(34);
    expect(exitCodeFor(outcomes)).toBe(0);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm --filter @lxfoundry/stint-e2e test -- local-target`
Expected: FAIL, because `src/targets/local.ts` does not exist.

- [ ] **Step 3: Write the local target**

Create `e2e/src/targets/local.ts`:

```ts
import { randomUUID } from "node:crypto";
import { STINT_PROGRAM_ADDRESS } from "@lxfoundry/stint-program-client";
import type { Target } from "@lxfoundry/stint-conformance";
import type { Address } from "@solana/kit";
import { fundSol, newHarnessKey, type HarnessKey } from "../fixtures/keys.js";
import { SUBSCRIPTIONS_PROGRAM_ADDRESS, deployStintProgram, deploySubscriptionsProgram } from "../fixtures/programs.js";
import { USDC_DEVNET_MINT, createUsdcAccount, writeUsdcMint } from "../fixtures/usdc.js";
import { KORA_ALLOWED_PROGRAMS } from "../kora/config.js";
import { startKora, type KoraProcess } from "../kora/process.js";
import { startLocalNetwork, waitForNewSlot, type LocalNetwork } from "../network/surfnet.js";

/** The common stack's keys (spec section 12.3). */
export interface CommonKeys {
  readonly mintAuthority: HarnessKey;
  readonly freezeAuthority: HarnessKey;
  readonly koraFeePayer: HarnessKey;
  readonly rentPayer: HarnessKey;
  readonly receiverAuthorizer: HarnessKey;
  readonly seller: HarnessKey;
  readonly sellerUsdcAccount: Address;
}

export interface LocalStack {
  readonly target: Target;
  readonly network: LocalNetwork;
  readonly keys: CommonKeys;
  readonly kora: KoraProcess;
  stop(): Promise<void>;
}

/**
 * The `local` target (spec section 12.2): Surfpool, offline and embedded, with the fixtures of
 * spec section 12.3, and Kora. Allowance funding joins its capabilities once the facilitator
 * supports it.
 */
export async function startLocalStack(): Promise<LocalStack> {
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
    const kora = await startKora({
      rpcUrl: network.rpcUrl,
      config: {
        allowedPrograms: [...KORA_ALLOWED_PROGRAMS, STINT_PROGRAM_ADDRESS, SUBSCRIPTIONS_PROGRAM_ADDRESS],
        allowedTokens: [USDC_DEVNET_MINT],
        maxAllowedLamports: 1_000_000,
      },
      feePayerSecretKey: koraFeePayer.secretKey,
      apiKey: randomUUID(),
    });

    const keys: CommonKeys = {
      mintAuthority,
      freezeAuthority,
      koraFeePayer,
      rentPayer,
      receiverAuthorizer,
      seller,
      sellerUsdcAccount,
    };
    const target: Target = { name: "local", capabilities: new Set(["chain", "stack", "facilitatorApi"]) };
    return {
      target,
      network,
      keys,
      kora,
      stop: async () => {
        await kora.stop();
        network.stop();
      },
    };
  } catch (error) {
    network.stop();
    throw error;
  }
}
```

Create `e2e/src/index.ts`:

```ts
export { startLocalStack, type CommonKeys, type LocalStack } from "./targets/local.js";
export { startLocalNetwork, waitForNewSlot, type LocalNetwork } from "./network/surfnet.js";
export { startKora, type KoraProcess } from "./kora/process.js";
```

- [ ] **Step 4: Run the test to see it pass**

Run: `pnpm --filter @lxfoundry/stint-e2e test -- local-target`
Expected: PASS, three tests.

- [ ] **Step 5: Write the command**

Create `e2e/src/cli.ts`:

```ts
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { catalogue, exitCodeFor, renderReport, runScenarios, writeReport } from "@lxfoundry/stint-conformance";
import { REPORT_DIR } from "./paths.js";
import { startLocalStack } from "./targets/local.js";

// `pnpm e2e:local`: runs every scenario on the local target, writes the report, and exits 1 when
// a required scenario fails (spec section 12.2). Kora's logs are kept with a failing run's report.
const stack = await startLocalStack();
try {
  const outcomes = await runScenarios(catalogue, stack.target, () => ({ target: stack.target }));
  writeReport(REPORT_DIR, outcomes);
  process.stdout.write(renderReport(outcomes));
  process.exitCode = exitCodeFor(outcomes);
  if (process.exitCode !== 0) writeFileSync(join(REPORT_DIR, "kora.log"), stack.kora.logs());
} finally {
  await stack.stop();
}
```

Run: `pnpm e2e:local`
Expected: a table of 35 rows, 34 `pending` and one `not applicable` (scenario 12); exit code 0;
`e2e/report/report.md` and `e2e/report/report.json` written.

- [ ] **Step 6: Run everything**

Run: `pnpm typecheck && pnpm test`
Expected: no type errors; every test passes.

- [ ] **Step 7: Commit**

```bash
git add e2e/src e2e/test
git commit -m "Assemble the local target and the end-to-end command"
```

---

### Task 8: Continuous integration

**Files:**
- Create: `.github/workflows/ci.yml`
- Modify: `README.md` (add a "Development" section)

**Interfaces:**
- Consumes: every earlier task.
- Produces: a workflow that, on every push and pull request, checks the toolchain, builds the
  program, checks that the generated client is current, type-checks, runs the unit tests, runs
  `pnpm e2e:local`, and publishes the report as the job summary.

- [ ] **Step 1: Write the workflow**

Create `.github/workflows/ci.yml`:

```yaml
name: CI

on:
  push:
  pull_request:

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

permissions:
  contents: read

jobs:
  local:
    runs-on: ubuntu-24.04
    timeout-minutes: 60
    env:
      RUST_VERSION: "1.99.1"
      AGAVE_VERSION: "4.3.2"
      ANCHOR_VERSION: "1.2.1"
      SURFPOOL_VERSION: "1.6.1"
      KORA_VERSION: "2.0.5"
    steps:
      - uses: actions/checkout@v5

      - name: System packages
        run: |
          sudo apt-get update
          sudo apt-get install -y build-essential pkg-config libudev-dev llvm libclang-dev protobuf-compiler libssl-dev

      - name: Rust
        run: |
          curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain "$RUST_VERSION"
          echo "$HOME/.cargo/bin" >> "$GITHUB_PATH"

      - name: Cache cargo binaries
        id: cargo-bin
        uses: actions/cache@v4
        with:
          path: |
            ~/.cargo/bin/avm
            ~/.cargo/bin/anchor
            ~/.cargo/bin/kora
            ~/.avm
          key: cargo-bin-${{ runner.os }}-rust${{ env.RUST_VERSION }}-anchor${{ env.ANCHOR_VERSION }}-kora${{ env.KORA_VERSION }}

      - name: Agave
        run: |
          sh -c "$(curl -sSfL https://release.anza.xyz/v${AGAVE_VERSION}/install)"
          echo "$HOME/.local/share/solana/install/active_release/bin" >> "$GITHUB_PATH"

      - name: Anchor and Kora
        if: steps.cargo-bin.outputs.cache-hit != 'true'
        run: |
          cargo install --git https://github.com/otter-sec/anchor --tag "v${ANCHOR_VERSION}" avm --locked --force
          avm install "$ANCHOR_VERSION"
          cargo install kora-cli --version "$KORA_VERSION" --locked

      - name: Select Anchor
        run: avm use "$ANCHOR_VERSION"

      - name: Surfpool
        run: |
          curl -sL https://run.surfpool.run/ | VERSION="v${SURFPOOL_VERSION}" bash
          echo "$HOME/.local/bin" >> "$GITHUB_PATH"

      - uses: pnpm/action-setup@v4

      - uses: actions/setup-node@v5
        with:
          node-version-file: .nvmrc
          cache: pnpm

      - name: Check the toolchain
        run: scripts/check-toolchain.sh

      - name: Install
        run: pnpm install --frozen-lockfile

      - name: Build the program
        run: anchor build --ignore-keys

      - name: Check the generated client is current
        run: |
          pnpm generate:client
          git diff --exit-code -- packages/program-client

      - name: Cache the Subscriptions program copy
        uses: actions/cache@v4
        with:
          path: e2e/.cache
          key: subscriptions-${{ hashFiles('e2e/fixtures/subscriptions.sha256') }}

      - name: Fetch and check the Subscriptions program copy
        run: scripts/fetch-subscriptions-program.sh

      - name: Type check
        run: pnpm typecheck

      - name: Unit and integration tests
        run: pnpm test

      - name: End-to-end, local target
        run: pnpm e2e:local

      - name: Report
        if: always()
        run: |
          if [ -f e2e/report/report.md ]; then cat e2e/report/report.md >> "$GITHUB_STEP_SUMMARY"; fi

      - name: Keep the report and logs
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: e2e-report
          path: e2e/report
          if-no-files-found: ignore
```

The program keypair is not committed, so CI builds with a fresh one whose ID differs from
`declare_id!`. `--ignore-keys` skips Anchor's check that the two match. Nothing in the run depends
on the keypair: the harness deploys the program at the ID in `declare_id!`, and the generated
client reads the same ID from the IDL. If Anchor 1.2.1 has no `--ignore-keys` flag, run
`anchor keys sync` before `anchor build`, then `git checkout -- programs/stint/src/lib.rs Anchor.toml`
after it. The build then uses the fresh keypair's ID, and the committed files are restored before
the client check.

- [ ] **Step 2: Add the development notes**

Append to `README.md`:

```markdown
## Development

The toolchain is pinned in `CLAUDE.md` (section "Toolchain") and checked by
`scripts/check-toolchain.sh`. On Windows, work inside WSL 2.

    anchor build                              # build the program
    pnpm install
    pnpm generate:client                      # regenerate the program client after an interface change
    scripts/fetch-subscriptions-program.sh    # fetch and check the Subscriptions program copy, once
    pnpm test                                 # unit and integration tests
    pnpm e2e:local                            # end-to-end scenarios on the local target

The end-to-end report is written to `e2e/report/report.md`.
```

- [ ] **Step 3: Push the branch and watch the run**

Run: `git add .github/workflows/ci.yml README.md && git commit -m "Run the local end-to-end target in continuous integration" && git push -u origin HEAD`
Expected: the `CI` workflow passes on the branch, and its job summary shows the report table,
with 34 `pending` scenarios and one `not applicable`.

If a step fails, fix it in a follow-up commit on the same branch. A cache miss on the
Subscriptions program copy reaches devnet before the run; the run itself stays offline.

---

## Done when

- `scripts/check-toolchain.sh` passes locally and in CI.
- `pnpm typecheck`, `pnpm test` and `pnpm e2e:local` pass locally and in CI.
- The report lists all 35 scenarios: 34 `pending`, and scenario 12 `not applicable`.
- Spec §14 question 6 is answered, and the answer is recorded in the pull request.
