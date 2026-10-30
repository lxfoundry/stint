# Stage 4: End of Session Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or
> executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for
> tracking.

**Goal:** A session ends by itself when its paid time runs out: the seller is paid without anyone asking, the
gate stops forwarding and drops the connection with close code 4402, and a session that no one is using is
closed after the grace period. Scenarios 2, 3, 9, 16 and 26 pass on `local` and become `required`, the program
on devnet is upgraded, and the required scenarios pass there.

**Architecture:** Stage 2's stack, extended in four places. The program gains `claim` and `close(AtExpiry)`
and the complete maths of spec section 4.2 with property tests. The facilitator gains the sweeper of section
6.4, which closes expired sessions that name its rent payer. The gate gains the idle timer and the end timer of
section 7.3: at the end of the paid time it stops forwarding, closes with `AtExpiry` through the facilitator,
and drops the connections with 4402. The client treats a session the gate has ended as ended. The harness
learns to stop and restart the gate and to open sessions directly on the program, which scenarios 26 and 16
need.

**Tech Stack:** Rust 1.99.1 with Anchor 1.2.1 (and `proptest` as a dev-dependency), TypeScript 7.0.2, vitest
5.0.5, LiteSVM 1.6.1, Surfpool 1.6.1, Kora 2.0.5, `ws`.

**Spec:** `docs/specs/stint-system.md`, sections 4.2 and 4.3 (`claim`, `close`), 6.4 (the sweeper), 7.3 and
7.4 (the gate's lifecycle and close codes), 9.5 (the tools), 11 (failure handling), 12.1, 12.2, 12.4 and 12.7
(testing and the scenarios).

## Global Constraints

- Platform: Linux x86-64; on Windows, everything runs inside WSL 2 (T1, T2). Run every command from the
  repository root, inside WSL. Do not rely on `/tmp` staying intact while a command runs: keep scratch files
  under the home directory or a git-ignored folder of the repository.
- **Devnet only.** No transaction from this repository's code or scripts reaches another network. The Solana
  CLI's own default RPC is mainnet, so every command names its `--url`, and every script and the harness check
  devnet's genesis hash before they send anything.
- Transactions are version 0, without address lookup tables (spec section 3.5). Only classic SPL Token mints;
  the payment token is devnet USDC, `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`, 6 decimals (spec section
  3.4).
- The program is built for SBPF v3 (Anchor 1.2.1's default). `e2e/test/artifact.test.ts` checks it.
- `u64` values on the wire are decimal strings; `u32` values are JSON numbers (spec section 5.1). Amounts are
  `bigint` in TypeScript, never `number`. Every amount in the program is computed with checked integers and
  128-bit intermediates (spec section 4.2).
- **No secrets, ever, in any commit.** Keypair files are named by path in `.env`, and the devnet harness's seed
  is in `.env.devnet` (both git-ignored); `.env.example` carries names and empty values. Never print a key's
  contents or the seed; an RPC URL may carry an API key, so it appears in `.env` or `.env.devnet` only.
- The chain's clock decides every amount; the gate's and the facilitator's clocks only decide when they act
  (spec section 4.2, 7.3). `AtExpiry` makes a component whose clock runs ahead harmless: it fails with
  `NotExpired` and tries again.
- A client never signs a transaction supplied by a seller, and every spending limit is enforced by the client's
  policy in code (spec section 9.3).
- Scenario statuses follow the ratchet of spec section 12.2: a scenario is made `required` in the commit where
  it first passes on `local`, and never goes back to `pending`.
- Test first: write the failing test, run it, implement, run it again, commit.
- Commit messages are neutral, technical and in the present tense.
- `GateChain` and `GateConfig` gain no required member in this stage: `packages/client/test/gate.ts` builds a
  gate from literals of both.

## What this stage builds, and what it leaves for later

Built: `claim`; `close(AtExpiry)`; the sweeper in its basic form; the gate's idle timer and end timer, the
`AtExpiry` close and close code 4402; the client's handling of an ended session; stack control and direct
on-chain sessions in the harness; scenarios 2, 3, 9, 16 and 26.

Not built, and not to be built here:
- **Top-up**, and any chain subscription in the gate: the end timer re-reads the session when it fires, which is
  enough to notice a later `paidUntil`.
- **The lookup of the `Closed` event** after another party closed the account before the paid time ran out
  (spec section 7.3, the "account closed by another party" row): this stage only handles an account that is
  gone, or that holds another session opened at the address after a close, when the end timer fires, which is
  always at or after `paid_until`. Either way the session the gate tracks has ended: `4402`, and no close.
- Adoption of sessions opened directly on the program, one live connection per session (`4429`), the outage and
  admin closes (`WaiveMinimum`, `4503`), restart recovery.
- Recreating a closed `receiver_token` in a sweeper close, and the sweeper's back-off on a frozen account: a
  close that fails is reported and tried again at the next sweep.
- `WaiveMinimum` in the program: it stays refused with `InvalidTerms`.
- The sponsored close route and the client's fallback chain.
- **The isolation groups of spec section 12.2, and concurrency in the runner.** This is a known deviation from that
  section: scenario 26 belongs to the own-stack group, but runs on the run's common stack. It stops the common gate
  and starts it again at the same address, and the scenarios after it use that gate. That is safe only because the
  runner runs scenarios one after another (`conformance/src/runner.ts`), so no other scenario is using the gate while
  it is down. A scenario that times out is not cancelled (`withTimeout` in the runner; the limit is 180 s, in
  `e2e/src/cli.ts`), so a scenario 26 that timed out could leave the gate stopped while the scenarios after it run.
  No scenario numbered after 26 has a run in this stage, so none can meet it. The catalogue keeps 26's `ownStack`
  group, which the runner does not act on yet, and Task 6 says so in the runner's doc comment. When the runner gains
  concurrency, scenario 26 moves to a stack of its own, with its own keys on devnet, as section 12.2 says.

## Before you start: what a person must prepare

Start from a clean tree on a branch of its own, with this plan already merged: the steps that say `git status
--short` prints nothing, or lists only what a step changed, rely on it.

Tasks 1 to 6 need nothing but the repository. Task 7 uses the person's keys:

1. The deploying key and the upgrade authority of the first deployment: `~/.config/stint/devnet.json` (the
   payer, holding SOL) and `~/.config/stint/upgrade-authority.json`, and the program keypair
   `target/deploy/stint-keypair.json`.
2. `.env.devnet` with `STINT_DEVNET_RPC_URL`, `STINT_DEVNET_SEED` and, if the provider's free tier refuses
   `getProgramAccounts`, `STINT_DEVNET_SCAN_RPC_URL`; the harness's funding key funded as `pnpm e2e:devnet
   funds` says. The sweeper lists sessions through the scan endpoint too.
3. Docker, for `anchor build --verifiable`. If `docker pull` fails in WSL with an error from a credential
   helper, run the build with `DOCKER_CONFIG` pointing at a directory that holds a file `config.json` containing
   `{}`.

---

### Task 1: The program: earned, claim and close(AtExpiry)

Nothing in the program ends a session by itself yet: `close` accepts only the `Standard` kind, and the receiver is paid
only when somebody closes. This task adds what spec §4.2 and §4.3 describe for that: the maths of `earned` with its
property tests (spec §12.1), the `claim` instruction (anyone may call it; it pays what has been earned and not yet
paid, and leaves the session open), and the `AtExpiry` kind of `close` (anyone may sign it, once `paid_until` has
passed). `claim` has no automatic caller in this stage. `WaiveMinimum` stays refused. Every step runs from the
repository root, inside WSL. The program tests load `target/deploy/stint.so`, so `anchor build` comes before any
LiteSVM run that must see a Rust change.

**Files:**
- Create: `programs/stint/src/instructions/claim.rs`, `packages/program-client/test/program/claim.test.ts`
- Create (generated, committed): `packages/program-client/src/generated/instructions/claim.ts`
- Modify: `programs/stint/Cargo.toml` and `Cargo.lock` (the `proptest` dev-dependency), `programs/stint/src/maths.rs`,
  `programs/stint/src/instructions/mod.rs`, `programs/stint/src/lib.rs`, `programs/stint/src/instructions/close.rs`,
  `packages/program-client/src/helpers.ts`
- Modify (generated, committed): `packages/program-client/src/generated/instructions/index.ts`,
  `packages/program-client/src/generated/programs/stint.ts`
- Test: `packages/program-client/test/helpers.test.ts`, `packages/program-client/test/program/fixture.ts`,
  `packages/program-client/test/program/claim.test.ts`, `packages/program-client/test/program/close.test.ts`

**Interfaces:**
- Consumes: stage 2's program (`open`, `close` with `Standard`, `maths::{paid_until, elapsed, charged, due, owed,
  redirects}`, the events `Claimed` and `Closed`, the error `NotExpired`); the generated client (`getCloseInstruction`,
  `CloseKind`, `STINT_ERROR__NOT_EXPIRED` = 6004, `CLAIMED_EVENT_DISCRIMINATOR`, `parseClaimedEvent`,
  `getClaimedEventEncoder`); `eventAccounts`, `eventPayloads` and `EVENT_IX_TAG` from `helpers.ts`; the program tests'
  `Fixture`.
- Produces:
  - `maths::earned(deposited: u64, rate: u64, elapsed: u64) -> u64`: `min(deposited, rate × elapsed)` through `u128`.
  - `maths::claim_amounts(session: &Session, now: i64) -> Result<ClaimAmounts>` with `ClaimAmounts { amount, claimed }`,
    and `maths::close_amounts(session: &Session, vault: u64, now: i64, waive_minimum: bool, refund_account_gone: bool)
    -> Result<CloseAmounts>` with `CloseAmounts { owed, refunded, redirected }`: every amount a claim or a close moves.
    `claim` and `close` take their amounts from these two functions, so the property tests, which run on these
    functions, check what the program moves. The one sum left in a handler is `close`'s transfer to the receiver,
    `owed + redirected`; the LiteSVM tests of `close` check it through the receiver's balance.
  - The instruction `claim()`, without signer or arguments. Accounts, in order: `session` (mutable), `vault` (mutable;
    the canonical associated token account of the session, else `AccountMismatch`), `receiver_token` (mutable; the
    associated token account of the stored `receiver`, else `AccountMismatch`), `token_program`, then the two
    `#[event_cpi]` accounts. When `earned(now) > claimed` it transfers `earned(now) - claimed` from the vault to
    `receiver_token`, sets `claimed = earned(now)` and emits `Claimed { session, amount, claimed }`; otherwise it
    succeeds, moves nothing and emits nothing. `earned` uses the elapsed time of spec §4.2, so it stops at `paid_until`.
  - `close` accepts `CloseKind.AtExpiry`: any signer; `now >= paid_until`, else `NotExpired`; the minimum
    waived (`close_amounts` with `waive_minimum: true`); everything else as `Standard`. `CloseKind.WaiveMinimum` is still
    refused with `InvalidTerms`. The authorisation rule of `Standard` is unchanged.
  - `@lxfoundry/stint-program-client`: the generated `getClaimInstruction(input)` with
    `input = { session, vault, receiverToken, tokenProgram?, eventAuthority, program }` (the last two from
    `await eventAccounts()`), `parseClaimInstruction`, `CLAIM_DISCRIMINATOR`, `StintInstruction.Claim`; and
    `findClaimedEvent(instructions: Iterable<ProgramInstruction>): ClaimedEvent | undefined`.
  - The fixture: `Fixture.claim(options: ClaimOptions): Promise<Sent>` with
    `ClaimOptions = { session: Address; vault?: Address; receiverToken?: Address }`.
  - The program deployed on devnet has neither `claim` nor `AtExpiry` until it is upgraded (a later task).

- [ ] **Step 1: Add the property-testing dependency**

Run: `cargo add --dev proptest@1 -p stint`
Expected: `programs/stint/Cargo.toml` gains a `[dev-dependencies]` section with `proptest = "1.x.y"` (the newest 1.x
release) and `Cargo.lock` gains `proptest` and its dependencies; `git status --short` lists exactly those two files. The
SBF build is unaffected; the IDL step builds the test profile, so `mod properties` must compile for `anchor build` to
pass.

- [ ] **Step 2: Write the failing unit tests of `earned`, `claim_amounts` and `close_amounts`**

In `programs/stint/src/maths.rs`, replace

```rust
#[cfg(test)]
mod tests {
```

with

```rust
/// The session `open` stores, for the tests: the keys play no part in the amounts.
#[cfg(test)]
fn opened(rate: u64, min_seconds: u32, started_at: i64, deposited: u64) -> Session {
    Session {
        version: crate::state::SESSION_VERSION,
        bump: 0,
        authority: Pubkey::default(),
        seed: 0,
        mint: Pubkey::default(),
        receiver: Pubkey::default(),
        receiver_authorizer: Pubkey::default(),
        refund_owner: Pubkey::default(),
        rent_payer: Pubkey::default(),
        rate,
        min_seconds,
        max_seconds: u32::MAX,
        started_at,
        deposited,
        claimed: 0,
    }
}

#[cfg(test)]
mod tests {
```

Then, in the same file, replace

```rust
        assert!(!redirects(1, 1_030, 1_030, false));
    }
}
```

with

```rust
        assert!(!redirects(1, 1_030, 1_030, false));
    }

    #[test]
    fn earned_is_zero_before_any_time_has_elapsed() {
        assert_eq!(earned(30_000, 1_000, 0), 0);
        // A clock behind `started_at` gives zero elapsed time, so nothing is earned.
        assert_eq!(earned(30_000, 1_000, elapsed(1_000, 1_030, 900)), 0);
        assert_eq!(earned(30_000, 1_000, elapsed(1_000, 1_030, 1_000)), 0);
    }

    #[test]
    fn earned_grows_with_the_elapsed_time() {
        assert_eq!(earned(30_000, 1_000, elapsed(1_000, 1_030, 1_008)), 8_000);
        assert_eq!(earned(30_000, 1_000, elapsed(1_000, 1_030, 1_029)), 29_000);
    }

    #[test]
    fn earned_stops_at_the_deposit_from_paid_until_on() {
        assert_eq!(earned(30_000, 1_000, elapsed(1_000, 1_030, 1_030)), 30_000);
        assert_eq!(earned(30_000, 1_000, elapsed(1_000, 1_030, 9_000)), 30_000);
        // The rounding remainder is never earned: 30,500 buys 30 s, and the elapsed time stops at 30 s.
        assert_eq!(earned(30_500, 1_000, elapsed(1_000, 1_030, 9_000)), 30_000);
        // Given more seconds than the deposit buys, the deposit itself is the cap.
        assert_eq!(earned(30_500, 1_000, 31), 30_500);
    }

    #[test]
    fn earned_does_not_overflow() {
        assert_eq!(earned(u64::MAX, u64::MAX, u64::MAX), u64::MAX);
        assert_eq!(earned(u64::MAX, 1, u64::MAX), u64::MAX);
        assert_eq!(earned(u64::MAX, u64::MAX, 0), 0);
        assert_eq!(earned(0, u64::MAX, u64::MAX), 0);
    }

    #[test]
    fn a_claim_pays_what_is_earned_and_not_yet_claimed() {
        let mut session = opened(1_000, 5, 1_000, 30_000);
        assert_eq!(claim_amounts(&session, 1_008).unwrap(), ClaimAmounts { amount: 8_000, claimed: 8_000 });
        session.claimed = 8_000;
        assert_eq!(claim_amounts(&session, 1_012).unwrap(), ClaimAmounts { amount: 4_000, claimed: 12_000 });
        // A clock that stepped back pays nothing and leaves `claimed` as it is.
        assert_eq!(claim_amounts(&session, 1_003).unwrap(), ClaimAmounts { amount: 0, claimed: 8_000 });
        // From `paid_until` on, a claim pays up to the covered time, never the rounding remainder.
        let session = opened(1_000, 5, 1_000, 30_500);
        assert_eq!(claim_amounts(&session, 9_000).unwrap(), ClaimAmounts { amount: 30_000, claimed: 30_000 });
    }

    #[test]
    fn a_close_pays_what_is_owed_then_refunds_or_redirects_the_residual() {
        let mut session = opened(1_000, 5, 1_000, 30_000);
        session.claimed = 8_000;
        // Before `paid_until`, with the minimum: 12 s charged, 8,000 already claimed; the vault holds the rest.
        let before = close_amounts(&session, 22_000, 1_012, false, true).unwrap();
        assert_eq!(before, CloseAmounts { owed: 4_000, refunded: 18_000, redirected: 0 });
        // 2 s in, the minimum of 5 s is charged unless it is waived.
        let fresh = opened(1_000, 5, 1_000, 30_000);
        assert_eq!(close_amounts(&fresh, 30_000, 1_002, false, false).unwrap().owed, 5_000);
        assert_eq!(close_amounts(&fresh, 30_000, 1_002, true, false).unwrap().owed, 2_000);
        // From `paid_until` on, a residual owed to a missing refund account goes to the receiver.
        let after = close_amounts(&session, 22_100, 1_030, true, true).unwrap();
        assert_eq!(after, CloseAmounts { owed: 22_000, refunded: 0, redirected: 100 });
        // A vault holding less than is owed is an error, not a partial payment.
        assert!(close_amounts(&session, 3_999, 1_012, false, false).is_err());
    }
}
```

- [ ] **Step 3: Write the failing property tests**

The properties of spec §12.1 are checked on the two functions `claim` and `close` take their amounts from: a random
sequence of claims, each applied as `claim` applies it, then one close on what the vault still holds. `earned` and `due`
at the close come from the formulas of spec §4.2 and serve as the reference. In `programs/stint/src/maths.rs`, replace

```rust
        assert!(close_amounts(&session, 3_999, 1_012, false, false).is_err());
    }
}
```

with

```rust
        assert!(close_amounts(&session, 3_999, 1_012, false, false).is_err());
    }
}

/// Property tests of spec section 12.1, run on the functions `claim` and `close` call: a claim at
/// each of a sequence of moments, then a close.
#[cfg(test)]
mod properties {
    use super::{charged, claim_amounts, close_amounts, due, earned, elapsed, opened, paid_until, CloseAmounts};
    use proptest::prelude::*;

    /// A session's terms as `open` stores them, and the tokens that reached the vault uncredited.
    #[derive(Clone, Copy, Debug)]
    struct Terms {
        rate: u64,
        min_seconds: u32,
        started_at: i64,
        deposited: u64,
        uncredited: u64,
    }

    /// Claims at `claim_times`, in that order, then one close at `close_time`.
    #[derive(Clone, Debug)]
    struct Scenario {
        terms: Terms,
        claim_times: Vec<i64>,
        close_time: i64,
        waive_minimum: bool,
        refund_account_gone: bool,
    }

    impl Scenario {
        /// The same scenario on a clock that never steps back: moments in order, the close last.
        fn monotone(mut self) -> Self {
            self.claim_times.sort_unstable();
            if let Some(&last) = self.claim_times.last() {
                self.close_time = self.close_time.max(last);
            }
            self
        }
    }

    /// A moment between a little before the start and about twice the paid time after it.
    fn moment(terms: &Terms, raw: u64) -> i64 {
        let covered = terms.deposited / terms.rate;
        let offset = i64::try_from(raw % (2 * covered + 11)).unwrap();
        terms.started_at + offset - 5
    }

    prop_compose! {
        fn any_terms()(
            rate in 1u64..=1_000_000_000,
            covered in prop_oneof![1u64..=120, 1u64..=u64::from(u32::MAX)],
            remainder in any::<u64>(),
            min in any::<u64>(),
            started_at in 0i64..=4_000_000_000,
            uncredited in prop_oneof![Just(0u64), 1u64..=1_000_000],
        ) -> Terms {
            Terms {
                rate,
                // `open` requires `min_seconds <= covered`.
                min_seconds: u32::try_from(min % covered).unwrap() + 1,
                started_at,
                deposited: rate * covered + remainder % rate,
                uncredited,
            }
        }
    }

    prop_compose! {
        fn any_scenario()(
            terms in any_terms(),
            raw_claims in proptest::collection::vec(any::<u64>(), 0..24),
            raw_close in any::<u64>(),
            waive_minimum in any::<bool>(),
            refund_account_gone in any::<bool>(),
        ) -> Scenario {
            Scenario {
                terms,
                claim_times: raw_claims.iter().map(|&raw| moment(&terms, raw)).collect(),
                close_time: moment(&terms, raw_close),
                waive_minimum,
                refund_account_gone,
            }
        }
    }

    struct Outcome {
        /// The session's `claimed` after each claim, with what was earned at that claim's moment.
        claims: Vec<(u64, u64)>,
        /// What the claims moved out of the vault, in total.
        paid_by_claims: u64,
        claimed: u64,
        close: CloseAmounts,
        /// `earned` and `due` at the close, by the formulas of spec section 4.2: the reference the
        /// amounts are checked against.
        earned_at_close: u64,
        due: u64,
    }

    /// The program's sequence: each claim applied as `claim` applies it (the vault pays `amount`, the
    /// session stores `claimed`), then the close on what the vault still holds, as `close` computes it.
    fn run(scenario: &Scenario) -> Outcome {
        let terms = scenario.terms;
        let mut session = opened(terms.rate, terms.min_seconds, terms.started_at, terms.deposited);
        let paid_until = paid_until(terms.started_at, terms.deposited, terms.rate).unwrap();
        let elapsed_at = |now: i64| elapsed(terms.started_at, paid_until, now);

        // The vault holds the credited deposit and whatever reached it without being credited.
        let mut vault = terms.deposited + terms.uncredited;
        let mut paid_by_claims = 0;
        let mut claims = Vec::new();
        for &now in &scenario.claim_times {
            let claim = claim_amounts(&session, now).unwrap();
            vault = vault.checked_sub(claim.amount).expect("a claim pays no more than the vault holds");
            paid_by_claims += claim.amount;
            session.claimed = claim.claimed;
            claims.push((session.claimed, earned(terms.deposited, terms.rate, elapsed_at(now))));
        }

        let now = scenario.close_time;
        let close = close_amounts(&session, vault, now, scenario.waive_minimum, scenario.refund_account_gone)
            .expect("a close owes no more than the vault holds");
        let charged_now = charged(terms.min_seconds, elapsed_at(now), scenario.waive_minimum);
        Outcome {
            claims,
            paid_by_claims,
            claimed: session.claimed,
            close,
            earned_at_close: earned(terms.deposited, terms.rate, elapsed_at(now)),
            due: due(terms.deposited, terms.rate, charged_now),
        }
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(512))]

        // `claimed + owed <= deposited`, on any clock and in any order of moments.
        #[test]
        fn claimed_plus_owed_never_exceeds_the_deposit(scenario in any_scenario()) {
            let outcome = run(&scenario);
            prop_assert!(
                u128::from(outcome.claimed) + u128::from(outcome.close.owed) <= u128::from(scenario.terms.deposited)
            );
        }

        // `earned <= due` at every close, whether or not the minimum is waived.
        #[test]
        fn earned_never_exceeds_due_at_a_close(scenario in any_scenario()) {
            let outcome = run(&scenario);
            prop_assert!(outcome.earned_at_close <= outcome.due);
        }

        // While the clock never steps back no claim pays beyond what is earned, so `claimed <= earned <= due`
        // at the close, and the close pays exactly the rest of `due`.
        #[test]
        fn claimed_never_exceeds_earned_while_the_clock_never_steps_back(
            scenario in any_scenario().prop_map(Scenario::monotone)
        ) {
            let outcome = run(&scenario);
            for &(claimed, earned_then) in &outcome.claims {
                prop_assert!(claimed <= earned_then);
            }
            prop_assert!(outcome.claimed <= outcome.earned_at_close);
            prop_assert_eq!(outcome.claimed + outcome.close.owed, outcome.due);
        }

        // Every token that entered the vault leaves it exactly once, on any clock: what the claims moved is
        // what the session records as claimed, and the close moves the rest.
        #[test]
        fn every_token_that_entered_the_vault_leaves_it_once(scenario in any_scenario()) {
            let outcome = run(&scenario);
            let terms = scenario.terms;
            prop_assert_eq!(outcome.paid_by_claims, outcome.claimed);
            prop_assert_eq!(
                u128::from(outcome.claimed)
                    + u128::from(outcome.close.owed)
                    + u128::from(outcome.close.refunded)
                    + u128::from(outcome.close.redirected),
                u128::from(terms.deposited) + u128::from(terms.uncredited)
            );
        }
    }
}
```

If a property ever fails on correct code, proptest records the failing case in
`programs/stint/proptest-regressions/maths.txt`. Commit that file with the fix: it replays the case first on every later
run. Only a genuine failure is worth keeping: the failures of Step 8's deliberate mutation are not (see there).

- [ ] **Step 4: Run the tests to see them fail**

Run: `cargo test -p stint`
Expected: FAIL, the tests do not compile: the errors name `earned`, `claim_amounts`, `close_amounts`, `ClaimAmounts`,
`CloseAmounts` and `Session` (`cannot find function`, `cannot find type` or `unresolved import`), in `mod tests`, in
`mod properties` and in `opened`.

- [ ] **Step 5: Implement `earned` and the amounts of a claim and a close, and take `close`'s amounts from them**

In `programs/stint/src/maths.rs`, replace

```rust
use crate::errors::StintError;
```

with

```rust
use crate::errors::StintError;
use crate::state::Session;
```

Then, in the same file, replace

```rust
/// The seconds a close charges: the elapsed time, raised to the minimum unless it is waived.
```

with

```rust
/// `min(deposited, rate × elapsed)`: everything the receiver has earned so far, and the most that claims have paid in
/// total. It never includes the minimum charge, and it stops at the deposit.
pub fn earned(deposited: u64, rate: u64, elapsed: u64) -> u64 {
    capped(deposited, rate, elapsed)
}

/// The seconds a close charges: the elapsed time, raised to the minimum unless it is waived.
```

Then, in the same file, replace

```rust
pub fn due(deposited: u64, rate: u64, charged: u64) -> u64 {
    let due = u128::from(rate) * u128::from(charged);
    // The minimum with a u64 always fits in a u64.
    u64::try_from(due.min(u128::from(deposited))).unwrap_or(deposited)
}
```

with

```rust
pub fn due(deposited: u64, rate: u64, charged: u64) -> u64 {
    capped(deposited, rate, charged)
}

/// `min(deposited, rate × seconds)` through `u128`: the shape of both `earned` and `due`.
fn capped(deposited: u64, rate: u64, seconds: u64) -> u64 {
    let amount = u128::from(rate) * u128::from(seconds);
    // The minimum with a u64 always fits in a u64.
    u64::try_from(amount.min(u128::from(deposited))).unwrap_or(deposited)
}
```

Then, in the same file, replace

```rust
/// `rate × seconds`, for the deposit bounds of `open`.
```

with

```rust
/// What a claim moves: `amount` from the vault to the receiver, after which the session's
/// `claimed` is `claimed`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ClaimAmounts {
    pub amount: u64,
    pub claimed: u64,
}

/// A claim at `now` (spec section 4.3): what is earned and not yet paid. It is zero when the clock
/// has not moved since the last claim, and when it has stepped back (S15): `claimed` then stays as
/// it is, and otherwise becomes exactly `earned`.
pub fn claim_amounts(session: &Session, now: i64) -> Result<ClaimAmounts> {
    let paid_until = paid_until(session.started_at, session.deposited, session.rate)?;
    let earned = earned(session.deposited, session.rate, elapsed(session.started_at, paid_until, now));
    Ok(ClaimAmounts { amount: owed(session.claimed, earned), claimed: session.claimed.max(earned) })
}

/// What a close moves: `owed` to the receiver for the time charged, then the residual, either
/// `refunded` or `redirected` to the receiver. Together they are the vault's whole balance.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CloseAmounts {
    pub owed: u64,
    pub refunded: u64,
    pub redirected: u64,
}

/// A close at `now` of a vault holding `vault` (spec section 4.3): the time charged, with the
/// minimum waived or not, what that still owes the receiver, and where the residual goes.
pub fn close_amounts(
    session: &Session,
    vault: u64,
    now: i64,
    waive_minimum: bool,
    refund_account_gone: bool,
) -> Result<CloseAmounts> {
    let paid_until = paid_until(session.started_at, session.deposited, session.rate)?;
    let elapsed = elapsed(session.started_at, paid_until, now);
    let due = due(session.deposited, session.rate, charged(session.min_seconds, elapsed, waive_minimum));
    let owed = owed(session.claimed, due);
    let residual = vault.checked_sub(owed).ok_or_else(|| error!(StintError::MathOverflow))?;
    Ok(if redirects(residual, now, paid_until, refund_account_gone) {
        CloseAmounts { owed, refunded: 0, redirected: residual }
    } else {
        CloseAmounts { owed, refunded: residual, redirected: 0 }
    })
}

/// `rate × seconds`, for the deposit bounds of `open`.
```

Last, make `close` take its amounts from `close_amounts`, with no change in behaviour. In
`programs/stint/src/instructions/close.rs`, replace

```rust
    let elapsed = maths::elapsed(session.started_at, paid_until, now);
    let charged = maths::charged(session.min_seconds, elapsed, false);
    let due = maths::due(session.deposited, session.rate, charged);
    let owed = maths::owed(session.claimed, due);
    let residual = ctx
        .accounts
        .vault
        .amount
        .checked_sub(owed)
        .ok_or_else(|| error!(StintError::MathOverflow))?;

    // From `paid_until` on, a residual owed to a refund account that no longer exists goes to the
    // receiver (spec section 4.3), so the account's owner cannot keep a session open by closing it
    // and sending the vault one base unit. "No longer exists" means owned by the System program,
    // whatever its lamports (S12): anyone can send lamports to a closed address, so a balance check
    // would let them block the redirect.
    let refund_account_gone = *ctx.accounts.refund_to.owner == System::id();
    let (to_receiver, refunded, redirected) =
        if maths::redirects(residual, now, paid_until, refund_account_gone) {
            let to_receiver = owed
                .checked_add(residual)
                .ok_or_else(|| error!(StintError::MathOverflow))?;
            (to_receiver, 0, residual)
        } else {
            (owed, residual, 0)
        };
```

with

```rust
    // From `paid_until` on, a residual owed to a refund account that no longer exists goes to the
    // receiver (spec section 4.3), so the account's owner cannot keep a session open by closing it
    // and sending the vault one base unit. "No longer exists" means owned by the System program,
    // whatever its lamports (S12): anyone can send lamports to a closed address, so a balance check
    // would let them block the redirect.
    let refund_account_gone = *ctx.accounts.refund_to.owner == System::id();
    let maths::CloseAmounts { owed, refunded, redirected } =
        maths::close_amounts(session, ctx.accounts.vault.amount, now, false, refund_account_gone)?;
    let to_receiver = owed
        .checked_add(redirected)
        .ok_or_else(|| error!(StintError::MathOverflow))?;
```

`paid_until` is still computed in the handler: the authorisation check and the `Closed` event use it.

- [ ] **Step 6: Run the tests to see them pass**

Run: `cargo test -p stint`
Expected: PASS: `test result: ok. 21 passed; 0 failed` (the 11 earlier tests, the 6 new unit tests and the 4
properties). The two `unexpected cfg condition value: solana` warnings were there before and stay.

Run: `anchor build && pnpm generate:client && pnpm --filter @lxfoundry/stint-program-client test close.test.ts && git status --short`
Expected: PASS. Every test of `close.test.ts` passes unchanged: `close` behaves as before. `pnpm generate:client` changes
nothing, because no instruction, account or event changed. `git status --short` lists exactly `Cargo.lock`,
`programs/stint/Cargo.toml`, `programs/stint/src/maths.rs` and `programs/stint/src/instructions/close.rs`.

- [ ] **Step 7: Commit the maths**

```bash
git add Cargo.lock programs/stint/Cargo.toml programs/stint/src/maths.rs programs/stint/src/instructions/close.rs
git commit -m "Add earned and the amounts of a claim and a close to the maths, with property tests, and use them in close"
```

- [ ] **Step 8: Check that the properties can fail**

A property that cannot fail guards nothing. The tree is clean after Step 7, so a mutation can be undone with `git
checkout`. In `programs/stint/src/maths.rs`, replace

```rust
pub fn owed(claimed: u64, due: u64) -> u64 {
    claimed.max(due) - claimed
}
```

with

```rust
pub fn owed(_claimed: u64, due: u64) -> u64 {
    due
}
```

Run: `cargo test -p stint`
Expected: FAIL. `owed_excludes_what_claims_paid`, `a_claim_pays_what_is_earned_and_not_yet_claimed`,
`a_close_pays_what_is_owed_then_refunds_or_redirects_the_residual`, `claimed_plus_owed_never_exceeds_the_deposit` and
`every_token_that_entered_the_vault_leaves_it_once` fail, the properties with a shrunk counter-example (the other
properties may fail too). The mutation run's failures are recorded in `programs/stint/proptest-regressions/maths.txt`;
delete it, it must not be committed.

Run: `git checkout -- programs/stint/src/maths.rs && rm -rf programs/stint/proptest-regressions && cargo test -p stint`
Expected: PASS, `21 passed`; `git status --short` prints nothing.

A second mutation breaks how a close splits the vault rather than what it owes: the residual is paid twice, redirected
to the receiver and refunded as well. Checking `owed` alone cannot see it; the property that every token leaves once
can. In `programs/stint/src/maths.rs`, replace

```rust
        CloseAmounts { owed, refunded: 0, redirected: residual }
```

with

```rust
        CloseAmounts { owed, refunded: residual, redirected: residual }
```

Run: `cargo test -p stint`
Expected: FAIL: `19 passed; 2 failed`, the two being `a_close_pays_what_is_owed_then_refunds_or_redirects_the_residual`
and `every_token_that_entered_the_vault_leaves_it_once` (with a shrunk counter-example). Delete
`programs/stint/proptest-regressions` again: it must not be committed.

Run: `git checkout -- programs/stint/src/maths.rs && rm -rf programs/stint/proptest-regressions && cargo test -p stint`
Expected: PASS, `21 passed`; `git status --short` prints nothing.

- [ ] **Step 9: Write the failing tests of `findClaimedEvent`**

In `packages/program-client/test/helpers.test.ts`, replace

```ts
import { describe, expect, it } from "vitest";
import { dueAt, earnedAt, elapsedAt } from "../src/index.js";
```

with

```ts
import { address, type Address, type ReadonlyUint8Array } from "@solana/kit";
import { describe, expect, it } from "vitest";
import {
  CloseKind,
  EVENT_IX_TAG,
  STINT_PROGRAM_ADDRESS,
  dueAt,
  earnedAt,
  elapsedAt,
  findClaimedEvent,
  getClaimedEventEncoder,
  getClosedEventEncoder,
  type ProgramInstruction,
} from "../src/index.js";
```

Then replace

```ts
    expect(dueAt(odd, 9_000n)).toBe(30_000n);
  });
});
```

with

```ts
    expect(dueAt(odd, 9_000n)).toBe(30_000n);
  });
});

describe("findClaimedEvent", () => {
  const key = address("11111111111111111111111111111111");
  const claimed = getClaimedEventEncoder().encode({ session: key, amount: 8_000n, claimed: 8_000n });
  const closed = getClosedEventEncoder().encode({
    session: key,
    kind: CloseKind.Standard,
    claimed: 0n,
    owed: 0n,
    refunded: 0n,
    redirected: 0n,
    closedBy: key,
    paidUntil: 0n,
    at: 0n,
  });

  /** An `emit_cpi!` instruction as it appears among a transaction's inner instructions. */
  function emitted(payload: ReadonlyUint8Array, programAddress: Address = STINT_PROGRAM_ADDRESS): ProgramInstruction {
    const data = new Uint8Array(EVENT_IX_TAG.length + payload.length);
    data.set(EVENT_IX_TAG, 0);
    data.set(payload, EVENT_IX_TAG.length);
    return { programAddress, data };
  }

  it("decodes the Claimed event that the program emitted, among other events", () => {
    const expected = { session: key, amount: 8_000n, claimed: 8_000n };
    expect(findClaimedEvent([emitted(claimed)])).toEqual(expected);
    expect(findClaimedEvent([emitted(closed), emitted(claimed)])).toEqual(expected);
  });

  it("is undefined when the program emitted no Claimed event", () => {
    expect(findClaimedEvent([])).toBeUndefined();
    expect(findClaimedEvent([emitted(closed)])).toBeUndefined();
  });

  it("ignores an event emitted by another program", () => {
    const tokenProgram = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
    expect(findClaimedEvent([emitted(claimed, tokenProgram)])).toBeUndefined();
  });
});
```

- [ ] **Step 10: Run the tests to see them fail**

Run: `pnpm --filter @lxfoundry/stint-program-client test helpers.test.ts`
Expected: FAIL. The three new tests fail because `findClaimedEvent` does not exist yet (a `TypeError` that names it); the
earlier tests of the file pass.

- [ ] **Step 11: Implement `findClaimedEvent`**

In `packages/program-client/src/helpers.ts`, replace

```ts
import { CLOSED_EVENT_DISCRIMINATOR, parseClosedEvent, type ClosedEvent } from "./generated/events/closed.js";
```

with

```ts
import { CLAIMED_EVENT_DISCRIMINATOR, parseClaimedEvent, type ClaimedEvent } from "./generated/events/claimed.js";
import { CLOSED_EVENT_DISCRIMINATOR, parseClosedEvent, type ClosedEvent } from "./generated/events/closed.js";
```

Then replace

```ts
export function findClosedEvent(instructions: Iterable<ProgramInstruction>): ClosedEvent | undefined {
  const payload = eventPayloads(instructions).find((data) => containsBytes(data, CLOSED_EVENT_DISCRIMINATOR, 0));
  return payload && parseClosedEvent(payload);
}
```

with

```ts
export function findClosedEvent(instructions: Iterable<ProgramInstruction>): ClosedEvent | undefined {
  const payload = eventPayloads(instructions).find((data) => containsBytes(data, CLOSED_EVENT_DISCRIMINATOR, 0));
  return payload && parseClosedEvent(payload);
}

export function findClaimedEvent(instructions: Iterable<ProgramInstruction>): ClaimedEvent | undefined {
  const payload = eventPayloads(instructions).find((data) => containsBytes(data, CLAIMED_EVENT_DISCRIMINATOR, 0));
  return payload && parseClaimedEvent(payload);
}
```

- [ ] **Step 12: Run the tests to see them pass, then commit**

Run: `pnpm --filter @lxfoundry/stint-program-client test helpers.test.ts`
Expected: PASS, every test of the file.

```bash
git add packages/program-client/src/helpers.ts packages/program-client/test/helpers.test.ts
git commit -m "Add findClaimedEvent to the program client helpers"
```

- [ ] **Step 13: Add `claim` to the test fixture**

In `packages/program-client/test/program/fixture.ts`, make three edits. First, replace

```ts
  getCloseInstruction,
  getOpenInstruction,
  getSessionDecoder,
  type ProgramInstruction,
} from "../../src/index.js";
```

with

```ts
  getClaimInstruction,
  getCloseInstruction,
  getOpenInstruction,
  getSessionDecoder,
  type ProgramInstruction,
} from "../../src/index.js";
```

Second, replace

```ts
export interface Opened {
```

with

```ts
export interface ClaimOptions {
  readonly session: Address;
  readonly vault?: Address;
  readonly receiverToken?: Address;
}

export interface Opened {
```

Third, replace

```ts
  /** `close`, with each account derived from the stored session unless overridden. */
```

with

```ts
  /**
   * `claim`, with each account derived from the stored session unless overridden. The instruction has no signer: the
   * fixture's payer signs as the fee payer and nothing else.
   */
  async claim(options: ClaimOptions): Promise<Sent> {
    const account = this.svm.getAccount(options.session);
    if (!account.exists) throw new Error(`no session at ${options.session}`);
    const stored = getSessionDecoder().decode(account.data);
    const instruction = getClaimInstruction({
      session: options.session,
      vault: options.vault ?? (await this.ata(options.session)),
      receiverToken: options.receiverToken ?? (await this.ata(stored.receiver)),
      ...(await eventAccounts()),
    });
    return this.send([instruction]);
  }

  /** `close`, with each account derived from the stored session unless overridden. */
```

- [ ] **Step 14: Write the failing tests of `claim`**

Create `packages/program-client/test/program/claim.test.ts`:

```ts
import { generateKeyPairSigner, isSignerRole, type Address } from "@solana/kit";
import { beforeEach, describe, expect, it } from "vitest";
import {
  CloseKind,
  STINT_ERROR__ACCOUNT_MISMATCH,
  eventAccounts,
  findClaimedEvent,
  findClosedEvent,
  getClaimInstruction,
  getSessionDecoder,
} from "../../src/index.js";
import { Fixture, type Wallet } from "./fixture.js";

describe("claim", () => {
  let fixture: Fixture;
  let buyer: Wallet;
  let startedAt: bigint;

  beforeEach(async () => {
    fixture = await Fixture.create();
    buyer = await fixture.wallet(1_000_000n);
    startedAt = fixture.now();
  });

  /** Opens `deposit` at 1,000 per second (minimum 5 s), then moves the clock `seconds` forward. */
  async function openAndWait(seconds: bigint, deposit = 30_000n) {
    const opened = await fixture.open({ authority: buyer, deposit });
    expect(opened.sent.ok, opened.sent.logs.join("\n")).toBe(true);
    fixture.setNow(startedAt + seconds);
    return opened;
  }

  /** The session as the account stores it. */
  function stored(session: Address) {
    const account = fixture.svm.getAccount(session);
    if (!account.exists) throw new Error(`no session at ${session}`);
    return getSessionDecoder().decode(account.data);
  }

  it("pays what has been earned to the receiver, and records it", async () => {
    const { session, vault } = await openAndWait(8n);
    const sent = await fixture.claim({ session });

    expect(sent.ok, sent.logs.join("\n")).toBe(true);
    expect(fixture.tokenAmount(fixture.seller.token)).toBe(8_000n);
    expect(fixture.tokenAmount(vault)).toBe(22_000n);
    expect(stored(session).claimed).toBe(8_000n);
    expect(findClaimedEvent(sent.inner)).toMatchObject({ session, amount: 8_000n, claimed: 8_000n });
  });

  it("declares no signer, so anyone may call it: the fee payer is the only key that signs", async () => {
    const { session, vault } = await openAndWait(8n);
    const accounts = { session, vault, receiverToken: fixture.seller.token, ...(await eventAccounts()) };
    const instruction = getClaimInstruction(accounts);

    expect(instruction.accounts.some((meta) => isSignerRole(meta.role))).toBe(false);
    const sent = await fixture.send([instruction]);
    expect(sent.ok, sent.logs.join("\n")).toBe(true);
    expect(fixture.tokenAmount(fixture.seller.token)).toBe(8_000n);
  });

  it("pays nothing, and emits nothing, when claimed again in the same second", async () => {
    const { session, vault } = await openAndWait(8n);
    expect((await fixture.claim({ session })).ok).toBe(true);

    const again = await fixture.claim({ session });

    expect(again.ok, again.logs.join("\n")).toBe(true);
    expect(findClaimedEvent(again.inner)).toBeUndefined();
    expect(again.inner).toEqual([]);
    expect(fixture.tokenAmount(fixture.seller.token)).toBe(8_000n);
    expect(fixture.tokenAmount(vault)).toBe(22_000n);
    expect(stored(session).claimed).toBe(8_000n);
  });

  it.each([0n, -100n])("pays nothing when nothing is earned yet: the clock is %s s from the start", async (seconds) => {
    const { session, vault } = await openAndWait(seconds);
    const sent = await fixture.claim({ session });

    expect(sent.ok, sent.logs.join("\n")).toBe(true);
    expect(findClaimedEvent(sent.inner)).toBeUndefined();
    expect(fixture.tokenAmount(vault)).toBe(30_000n);
    expect(stored(session).claimed).toBe(0n);
  });

  it("adds up, over time, to what has been earned", async () => {
    const { session } = await openAndWait(0n);
    const steps = [
      { seconds: 3n, amount: 3_000n, claimed: 3_000n },
      { seconds: 10n, amount: 7_000n, claimed: 10_000n },
      { seconds: 29n, amount: 19_000n, claimed: 29_000n },
    ];

    for (const step of steps) {
      fixture.setNow(startedAt + step.seconds);
      const sent = await fixture.claim({ session });
      expect(sent.ok, sent.logs.join("\n")).toBe(true);
      expect(findClaimedEvent(sent.inner)).toMatchObject({ session, amount: step.amount, claimed: step.claimed });
      expect(fixture.tokenAmount(fixture.seller.token)).toBe(step.claimed);
      expect(stored(session).claimed).toBe(step.claimed);
    }
  });

  it.each([30n, 60n])("pays the covered time and no more, %s s after the start", async (seconds) => {
    // 30,500 buys 30 s: the 500 left over is never earned.
    const { session, vault } = await openAndWait(seconds, 30_500n);
    const first = await fixture.claim({ session });

    expect(first.ok, first.logs.join("\n")).toBe(true);
    expect(findClaimedEvent(first.inner)).toMatchObject({ amount: 30_000n, claimed: 30_000n });
    expect(fixture.tokenAmount(fixture.seller.token)).toBe(30_000n);
    expect(fixture.tokenAmount(vault)).toBe(500n);

    fixture.setNow(startedAt + 90n);
    const later = await fixture.claim({ session });
    expect(later.ok, later.logs.join("\n")).toBe(true);
    expect(findClaimedEvent(later.inner)).toBeUndefined();
    expect(fixture.tokenAmount(fixture.seller.token)).toBe(30_000n);
  });

  it("pays nothing, and keeps what was claimed, when the clock has stepped back", async () => {
    const { session } = await openAndWait(20n);
    expect((await fixture.claim({ session })).ok).toBe(true);
    fixture.setNow(startedAt + 10n);

    const sent = await fixture.claim({ session });

    expect(sent.ok, sent.logs.join("\n")).toBe(true);
    expect(findClaimedEvent(sent.inner)).toBeUndefined();
    expect(fixture.tokenAmount(fixture.seller.token)).toBe(20_000n);
    expect(stored(session).claimed).toBe(20_000n);

    // The running total carries on from where it was, not from the earlier clock.
    fixture.setNow(startedAt + 25n);
    const resumed = await fixture.claim({ session });
    expect(findClaimedEvent(resumed.inner)).toMatchObject({ amount: 5_000n, claimed: 25_000n });
  });

  it("leaves the session open and the vault funded for the rest", async () => {
    const { session, vault } = await openAndWait(8n);
    await fixture.claim({ session });

    expect(fixture.exists(session)).toBe(true);
    expect(fixture.exists(vault)).toBe(true);
    expect(fixture.tokenAmount(vault)).toBe(22_000n);
    expect(stored(session)).toMatchObject({ deposited: 30_000n, claimed: 8_000n });
  });

  it("skips a transfer of zero: a closed receiver account does not matter when nothing is earned", async () => {
    const { session } = await openAndWait(0n);
    fixture.removeAccount(fixture.seller.token);
    const sent = await fixture.claim({ session });

    expect(sent.ok, sent.logs.join("\n")).toBe(true);
    expect(stored(session).claimed).toBe(0n);
  });

  it("fails, and changes nothing, when something is earned and the receiver's account is closed", async () => {
    const { session, vault } = await openAndWait(8n);
    fixture.removeAccount(fixture.seller.token);
    const sent = await fixture.claim({ session });

    expect(sent.ok).toBe(false);
    expect(fixture.tokenAmount(vault)).toBe(30_000n);
    expect(stored(session).claimed).toBe(0n);
  });

  it.each(["vault", "receiverToken"] as const)("refuses a substituted %s with AccountMismatch (S2)", async (field) => {
    const { session } = await openAndWait(8n);
    const other = await fixture.wallet(0n);
    const sent = await fixture.claim({ session, [field]: other.token });

    expect(sent.errorCode).toBe(STINT_ERROR__ACCOUNT_MISMATCH);
    expect(fixture.tokenAmount(fixture.seller.token)).toBe(0n);
  });

  it("refuses a vault that the session owns but that is not its associated token account (S6)", async () => {
    const { session } = await openAndWait(8n);
    const decoy = (await generateKeyPairSigner()).address;
    fixture.writeTokenAccount(decoy, session, 30_000n);
    const sent = await fixture.claim({ session, vault: decoy });

    expect(sent.errorCode).toBe(STINT_ERROR__ACCOUNT_MISMATCH);
    expect(fixture.tokenAmount(decoy)).toBe(30_000n);
    expect(fixture.tokenAmount(fixture.seller.token)).toBe(0n);
  });

  describe("a close after a claim", () => {
    it("Standard pays only what is still owed: claimed + owed + refunded is the deposit", async () => {
      const { session, vault } = await openAndWait(8n);
      await fixture.claim({ session });
      fixture.setNow(startedAt + 12n);
      const buyerBefore = fixture.tokenAmount(buyer.token)!;

      const sent = await fixture.close({ session, closer: buyer.signer });

      expect(sent.ok, sent.logs.join("\n")).toBe(true);
      const closed = findClosedEvent(sent.inner)!;
      expect(closed).toMatchObject({ kind: CloseKind.Standard, claimed: 8_000n, owed: 4_000n, refunded: 18_000n });
      expect(closed.claimed + closed.owed + closed.refunded + closed.redirected).toBe(30_000n);
      expect(fixture.tokenAmount(fixture.seller.token)).toBe(12_000n);
      expect(fixture.tokenAmount(buyer.token)! - buyerBefore).toBe(18_000n);
      expect(fixture.exists(session)).toBe(false);
      expect(fixture.exists(vault)).toBe(false);
    });

    it("Standard still charges the minimum: the close adds what the claims did not reach", async () => {
      const { session } = await openAndWait(2n);
      await fixture.claim({ session });

      const sent = await fixture.close({ session, closer: buyer.signer });

      const closed = findClosedEvent(sent.inner)!;
      expect(closed).toMatchObject({ claimed: 2_000n, owed: 3_000n, refunded: 25_000n });
      expect(closed.claimed + closed.owed + closed.refunded + closed.redirected).toBe(30_000n);
      expect(fixture.tokenAmount(fixture.seller.token)).toBe(5_000n);
    });
  });
});
```

- [ ] **Step 15: Run the tests to see them fail**

Run: `pnpm --filter @lxfoundry/stint-program-client test claim.test.ts`
Expected: FAIL. Every one of the 17 tests of the file fails, naming `getClaimInstruction` (a `TypeError`): the generated
client does not export it yet, because the program has no `claim`. (`target/deploy/stint.so` must exist; run `anchor build` first if it
does not.)

- [ ] **Step 16: Write the instruction**

Create `programs/stint/src/instructions/claim.rs`:

```rust
use anchor_lang::prelude::*;
use anchor_spl::associated_token::get_associated_token_address;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::errors::StintError;
use crate::events::Claimed;
use crate::maths;
use crate::state::{Session, SESSION_SEED};

/// Pays the receiver what the session has earned and not yet paid (spec section 4.3). It needs no
/// signer: whoever calls it, it only moves tokens from the vault to the receiver, by the session's
/// own terms, and leaves the session open.
#[event_cpi]
#[derive(Accounts)]
pub struct Claim<'info> {
    #[account(mut)]
    pub session: Account<'info, Session>,

    #[account(
        mut,
        address = get_associated_token_address(&session.key(), &session.mint) @ StintError::AccountMismatch,
    )]
    pub vault: Account<'info, TokenAccount>,

    /// CHECK: the receiver's associated token account; unchecked so that a closed one arrives System-owned (S12), as in `close`.
    #[account(
        mut,
        address = get_associated_token_address(&session.receiver, &session.mint) @ StintError::AccountMismatch,
    )]
    pub receiver_token: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
}

pub fn claim_handler(ctx: Context<Claim>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let session = &ctx.accounts.session;

    // What is earned and not yet paid: the same difference as a close's `owed`. It is zero when the
    // clock has not moved since the last claim, and when it has stepped back (S15): then `claimed`
    // stays as it is, and the claim succeeds without moving anything or emitting an event. A transfer
    // of zero is skipped, so the receiver's account need not exist then (spec section 4.3).
    let maths::ClaimAmounts { amount, claimed } = maths::claim_amounts(session, now)?;
    if amount == 0 {
        return Ok(());
    }

    let session_key = session.key();
    let authority = session.authority;
    let seed = session.seed.to_le_bytes();
    let bump = [session.bump];
    let signer_seeds: &[&[&[u8]]] = &[&[SESSION_SEED, authority.as_ref(), &seed, &bump]];

    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.receiver_token.to_account_info(),
                authority: ctx.accounts.session.to_account_info(),
            },
            signer_seeds,
        ),
        amount,
    )?;

    ctx.accounts.session.claimed = claimed;
    emit_cpi!(Claimed { session: session_key, amount, claimed });
    Ok(())
}
```

- [ ] **Step 17: Register the instruction**

In `programs/stint/src/instructions/mod.rs`, replace

```rust
pub mod close;
pub mod open;

pub use close::*;
pub use open::*;
```

with

```rust
pub mod claim;
pub mod close;
pub mod open;

pub use claim::*;
pub use close::*;
pub use open::*;
```

In `programs/stint/src/lib.rs`, replace

```rust
    pub fn close(ctx: Context<Close>, kind: CloseKind) -> Result<()> {
        instructions::close::close_handler(ctx, kind)
    }
```

with

```rust
    pub fn claim(ctx: Context<Claim>) -> Result<()> {
        instructions::claim::claim_handler(ctx)
    }

    pub fn close(ctx: Context<Close>, kind: CloseKind) -> Result<()> {
        instructions::close::close_handler(ctx, kind)
    }
```

- [ ] **Step 18: Build the program and regenerate the client**

Run: `anchor build && pnpm generate:client && git status --short`
Expected: the build finishes and updates `target/deploy/stint.so` and `target/idl/stint.json`. The generator creates
`packages/program-client/src/generated/instructions/claim.ts` and modifies
`packages/program-client/src/generated/instructions/index.ts` and `packages/program-client/src/generated/programs/stint.ts`
(a `StintInstruction.Claim` member and a `claim` entry in the plugin). `git status --short` lists those three files and
the files edited in Steps 13 to 17, and nothing else under `packages/program-client`. If any other generated file
changed, stop and report it. The error constants do not change: no error was added.

- [ ] **Step 19: Check the names the tests rely on**

Run: `grep -n -e "export const CLAIM_DISCRIMINATOR" -e "export function getClaimInstruction<" -e "^  session: " -e "^  vault: " -e "^  receiverToken: " -e "^  tokenProgram?: " -e "^  eventAuthority: " -e "^  program: " packages/program-client/src/generated/instructions/claim.ts`
Expected: eight lines: the declarations of `CLAIM_DISCRIMINATOR` and `getClaimInstruction`, and the six members of
`ClaimInput` (`session`, `vault`, `receiverToken`, `tokenProgram?`, `eventAuthority`, `program`). The input has no
instruction argument. If a name differs, correct the fixture's `claim` and the test to match the generated code, not the
generated code.

- [ ] **Step 20: Run the tests to see them pass**

Run: `cargo test -p stint && pnpm --filter @lxfoundry/stint-program-client test && pnpm --filter @lxfoundry/stint-program-client typecheck`
Expected: PASS. `21 passed` in the Rust run; every test of the program-client suite, including all 17 of `claim.test.ts`;
no type error.

- [ ] **Step 21: Run the Solana program analyser on `claim.rs`**

The `program_autofixer` tool of the Solana docs MCP server (`.mcp.json`) takes Rust program code and returns issues.
`CLAUDE.md` allows it on program code from this repository. Run it on `programs/stint/src/instructions/claim.rs` with
`framework: "anchor"`, apply every Critical and High finding, and run it again until it reports none. Medium and Low
findings and suggestions are advisory: note them in the commit message body only if one changes behaviour. If the tool is
unavailable, say so in the task report. If a finding changed the file, run Step 18's build and Step 20's tests again.

- [ ] **Step 22: Commit the instruction and the regenerated client**

```bash
git add programs/stint/src/instructions/claim.rs programs/stint/src/instructions/mod.rs programs/stint/src/lib.rs \
  packages/program-client/src/generated packages/program-client/test/program/fixture.ts \
  packages/program-client/test/program/claim.test.ts
git commit -m "Add the claim instruction and its generated client"
```

- [ ] **Step 23: Write the failing tests of `close(AtExpiry)`**

In `packages/program-client/test/program/close.test.ts`, make two edits. First, replace

```ts
  STINT_ERROR__INVALID_TERMS,
  STINT_ERROR__UNAUTHORIZED,
  findClosedEvent,
} from "../../src/index.js";
```

with

```ts
  STINT_ERROR__INVALID_TERMS,
  STINT_ERROR__NOT_EXPIRED,
  STINT_ERROR__UNAUTHORIZED,
  findClosedEvent,
} from "../../src/index.js";
```

Second, split the test "does not support kind %s yet": `AtExpiry` is supported now and `WaiveMinimum` stays refused.
Replace

```ts
  it.each([CloseKind.AtExpiry, CloseKind.WaiveMinimum])("does not support kind %s yet", async (kind) => {
    const { session } = await openAndWait(30n);
    const sent = await fixture.close({ session, closer: fixture.receiverAuthorizer, kind });
    expect(sent.errorCode).toBe(STINT_ERROR__INVALID_TERMS);
  });
});
```

with

```ts
  it.each([8n, 30n])("refuses kind WaiveMinimum with InvalidTerms, %s s after the start", async (seconds) => {
    const { session } = await openAndWait(seconds);
    const sent = await fixture.close({ session, closer: fixture.receiverAuthorizer, kind: CloseKind.WaiveMinimum });
    expect(sent.errorCode).toBe(STINT_ERROR__INVALID_TERMS);
  });
});

describe("close (AtExpiry)", () => {
  let fixture: Fixture;
  let buyer: Wallet;
  let startedAt: bigint;

  beforeEach(async () => {
    fixture = await Fixture.create();
    buyer = await fixture.wallet(1_000_000n);
    startedAt = fixture.now();
  });

  /** Opens `deposit` at 1,000 per second (minimum 5 s), then moves the clock `seconds` forward. */
  async function openAndWait(seconds: bigint, deposit = 30_000n) {
    const opened = await fixture.open({ authority: buyer, deposit });
    expect(opened.sent.ok, opened.sent.logs.join("\n")).toBe(true);
    fixture.setNow(startedAt + seconds);
    return opened;
  }

  it.each([29n, -100n])("fails with NotExpired %s s after the start, for any signer, and changes nothing", async (seconds) => {
    const { session, vault } = await openAndWait(seconds);
    const stranger = await generateKeyPairSigner();

    for (const closer of [buyer.signer, fixture.receiverAuthorizer, stranger]) {
      const sent = await fixture.close({ session, closer, kind: CloseKind.AtExpiry });
      expect(sent.errorCode).toBe(STINT_ERROR__NOT_EXPIRED);
    }

    expect(fixture.exists(session)).toBe(true);
    expect(fixture.tokenAmount(vault)).toBe(30_000n);
    expect(fixture.tokenAmount(fixture.seller.token)).toBe(0n);
  });

  it.each(["stranger", "authority", "receiverAuthorizer"] as const)(
    "accepts the %s at paid_until, charges the whole covered time and returns the rent",
    async (who) => {
      const { session, vault } = await openAndWait(30n);
      const closer =
        who === "authority" ? buyer.signer : who === "receiverAuthorizer" ? fixture.receiverAuthorizer : await generateKeyPairSigner();
      const rentBefore = fixture.lamportsOf(fixture.rentPayer.address);
      const deposits = fixture.lamportsOf(session) + fixture.lamportsOf(vault);

      const sent = await fixture.close({ session, closer, kind: CloseKind.AtExpiry });

      expect(sent.ok, sent.logs.join("\n")).toBe(true);
      expect(findClosedEvent(sent.inner)).toMatchObject({
        session,
        kind: CloseKind.AtExpiry,
        claimed: 0n,
        owed: 30_000n,
        refunded: 0n,
        redirected: 0n,
        closedBy: closer.address,
        paidUntil: startedAt + 30n,
        at: startedAt + 30n,
      });
      expect(fixture.tokenAmount(fixture.seller.token)).toBe(30_000n);
      expect(fixture.exists(session)).toBe(false);
      expect(fixture.exists(vault)).toBe(false);
      expect(fixture.lamportsOf(fixture.rentPayer.address) - rentBefore).toBe(deposits);
    },
  );

  it("charges the whole covered time after paid_until, and refunds the rounding remainder", async () => {
    const { session } = await openAndWait(60n, 30_500n);
    const buyerBefore = fixture.tokenAmount(buyer.token)!;

    const sent = await fixture.close({ session, closer: await generateKeyPairSigner(), kind: CloseKind.AtExpiry });

    expect(sent.ok, sent.logs.join("\n")).toBe(true);
    expect(findClosedEvent(sent.inner)).toMatchObject({
      kind: CloseKind.AtExpiry,
      owed: 30_000n,
      refunded: 500n,
      redirected: 0n,
      paidUntil: startedAt + 30n,
      at: startedAt + 60n,
    });
    expect(fixture.tokenAmount(fixture.seller.token)).toBe(30_000n);
    expect(fixture.tokenAmount(buyer.token)! - buyerBefore).toBe(500n);
  });

  it("pays only the rest after earlier claims: claimed + owed + refunded is the deposit", async () => {
    const { session } = await openAndWait(0n, 30_500n);
    for (const seconds of [4n, 11n]) {
      fixture.setNow(startedAt + seconds);
      const claimed = await fixture.claim({ session });
      expect(claimed.ok, claimed.logs.join("\n")).toBe(true);
    }
    fixture.setNow(startedAt + 30n);

    const sent = await fixture.close({ session, closer: await generateKeyPairSigner(), kind: CloseKind.AtExpiry });

    expect(sent.ok, sent.logs.join("\n")).toBe(true);
    const closed = findClosedEvent(sent.inner)!;
    expect(closed).toMatchObject({ claimed: 11_000n, owed: 19_000n, refunded: 500n, redirected: 0n });
    expect(closed.claimed + closed.owed + closed.refunded + closed.redirected).toBe(30_500n);
    expect(fixture.tokenAmount(fixture.seller.token)).toBe(30_000n);
  });

  it("still redirects a residual to the receiver when the refund account is closed", async () => {
    const { session } = await openAndWait(30n, 30_500n);
    fixture.removeAccount(buyer.token);

    const sent = await fixture.close({ session, closer: await generateKeyPairSigner(), kind: CloseKind.AtExpiry });

    expect(sent.ok, sent.logs.join("\n")).toBe(true);
    expect(findClosedEvent(sent.inner)).toMatchObject({ owed: 30_000n, refunded: 0n, redirected: 500n });
    expect(fixture.tokenAmount(fixture.seller.token)).toBe(30_500n);
  });

  it("accepts the rent payer itself as the closer, and the rent still returns to it", async () => {
    const { session, vault } = await openAndWait(30n);
    const rentBefore = fixture.lamportsOf(fixture.rentPayer.address);
    const deposits = fixture.lamportsOf(session) + fixture.lamportsOf(vault);

    const sent = await fixture.close({ session, closer: fixture.rentPayer, kind: CloseKind.AtExpiry });

    expect(sent.ok, sent.logs.join("\n")).toBe(true);
    expect(findClosedEvent(sent.inner)).toMatchObject({ closedBy: fixture.rentPayer.address, owed: 30_000n });
    expect(fixture.tokenAmount(fixture.seller.token)).toBe(30_000n);
    expect(fixture.exists(session)).toBe(false);
    expect(fixture.lamportsOf(fixture.rentPayer.address) - rentBefore).toBe(deposits);
  });
});
```

The last test, `accepts the rent payer itself as the closer`, proves the case in which the closer and the rent payer are one
key. A transaction that closes a session on behalf of the rent payer does exactly this: the key is the signer
(account 0, `closer`) and also the writable `rent_payer` (account 5) of the same instruction. `fixture.rentPayer` is a
`KeyPairSigner` (see the `Fixture` constructor in `fixture.ts`), and `fixture.close` passes the stored `rent_payer` address
as account 5 while the fixture's payer, a different key, pays the fee. The test shows that the duplicated account is
accepted, that the seller is paid the whole deposit, that the rent returns to that same key (its balance rises by exactly
the lamports of the session and the vault), and that `Closed.closedBy` is the rent payer's address.

- [ ] **Step 24: Run the tests to see them fail**

Run: `pnpm --filter @lxfoundry/stint-program-client test close.test.ts`
Expected: FAIL. The nine tests of `close (AtExpiry)` fail: the program still refuses the kind with `InvalidTerms` (6000),
so the `NotExpired` tests see the wrong code and every other test sees a failed transaction. The two `WaiveMinimum` tests
and every earlier test of the file pass.

- [ ] **Step 25: Implement `AtExpiry` in `close`**

In `programs/stint/src/instructions/close.rs`, make two edits. First, replace

```rust
pub fn close_handler(ctx: Context<Close>, kind: CloseKind) -> Result<()> {
    // Only `Standard` is supported so far; the other kinds are refused rather than guessed at.
    require!(kind == CloseKind::Standard, StintError::InvalidTerms);

    let now = Clock::get()?.unix_timestamp;
    let session = &ctx.accounts.session;
    let paid_until = maths::paid_until(session.started_at, session.deposited, session.rate)?;
    let closer = ctx.accounts.closer.key();
    if now < paid_until {
```

with

```rust
pub fn close_handler(ctx: Context<Close>, kind: CloseKind) -> Result<()> {
    // `WaiveMinimum` is not supported yet: it is refused rather than guessed at.
    require!(kind != CloseKind::WaiveMinimum, StintError::InvalidTerms);

    let now = Clock::get()?.unix_timestamp;
    let session = &ctx.accounts.session;
    let paid_until = maths::paid_until(session.started_at, session.deposited, session.rate)?;
    let closer = ctx.accounts.closer.key();
    // An `AtExpiry` close is for a session whose paid time has run out, and anyone may sign it (spec
    // section 4.3). A top-up that lands first moves `paid_until`, so this close then fails instead of
    // ending an extended session.
    if kind == CloseKind::AtExpiry {
        require!(now >= paid_until, StintError::NotExpired);
    }
    if now < paid_until {
```

Second, replace

```rust
    let maths::CloseAmounts { owed, refunded, redirected } =
        maths::close_amounts(session, ctx.accounts.vault.amount, now, false, refund_account_gone)?;
```

with

```rust
    // `AtExpiry` charges the elapsed time alone: from `paid_until` on, that is the whole covered time.
    let waive_minimum = kind == CloseKind::AtExpiry;
    let maths::CloseAmounts { owed, refunded, redirected } =
        maths::close_amounts(session, ctx.accounts.vault.amount, now, waive_minimum, refund_account_gone)?;
```

- [ ] **Step 26: Rebuild and run every program check**

Run: `anchor build && pnpm generate:client && cargo test -p stint && pnpm --filter @lxfoundry/stint-program-client test && pnpm --filter @lxfoundry/stint-program-client typecheck && git status --short`
Expected: PASS everywhere, with all nine `close (AtExpiry)` tests passing. `pnpm generate:client` produces no change: the
instruction's interface and the doc comments the IDL carries are untouched. `git status --short` lists only
`programs/stint/src/instructions/close.rs` and `packages/program-client/test/program/close.test.ts`. If the generated
client changed, stop and report it.

- [ ] **Step 27: Run the Solana program analyser on `close.rs`**

The `program_autofixer` tool of the Solana docs MCP server (`.mcp.json`) takes Rust program code and returns issues.
`CLAUDE.md` allows it on program code from this repository. Run it on `programs/stint/src/instructions/close.rs` with
`framework: "anchor"`, apply every Critical and High finding, and run it again until it reports none. Medium and Low
findings and suggestions are advisory: note them in the commit message body only if one changes behaviour. If the tool is
unavailable, say so in the task report. If a finding changed the file, run Step 26's command again.

- [ ] **Step 28: Commit the close kind**

```bash
git add programs/stint/src/instructions/close.rs packages/program-client/test/program/close.test.ts
git commit -m "Accept the AtExpiry kind in close from paid_until on"
```

- [ ] **Step 29: Check the whole workspace against the new client**

Run: `pnpm typecheck && pnpm --filter @lxfoundry/stint-x402 test && git status --short`
Expected: PASS. The generated `StintInstruction` enum gained a member and the instruction parser a case, which no other
package branches on. `git status --short` prints nothing: everything is committed.

---

### Task 2: The facilitator's sweeper

A session whose paid time has passed, and that nobody closes, keeps its deposit and its rent locked. The
facilitator's sweeper finds such sessions and closes them with `AtExpiry`, signing as the rent payer (spec §6.4).
It is the second way a session ends by itself: the gate's end timer (Task 3) is the first, and the sweeper
covers a gate that is stopped or gone.

Decisions this task makes, from the code:
- **The sweeper builds and signs its own transactions.** `verifyPayment` refuses a close whose `closer` is the
  rent payer (`checkCloseTransaction` requires the session's receiver authorizer, and the rent payer may sit
  only at the sixth account), so the sweeper does not go through it. It builds the transaction with
  `buildCloseTransaction` and `closer: ctx.rentPayer` (a `KeyPairSigner`, so its signature is applied while
  the transaction is built), has Kora add the fee payer's signature (`ctx.kora.signTransaction`), and reads
  the transaction's ID with `getSignatureFromTransaction`, exactly as `settlePayment` does. The blockhash is
  the one it built the transaction with.
- **It reuses `submitSettlement`** for sending and confirming. That function reports its result as a
  `SettleResponse`: `success: false` with an `errorReason` (`simulation_failed`, `blockhash_expired`,
  `settlement_pending`) is a failure the sweeper reports and retries at the next sweep. A retry cannot pay
  twice: the next sweep reads the session first, and the program closes an account once.
- **Which session is closed is decided by a fresh read.** The listing may be seconds old and may come from
  another node than the one that sends, and the gate or another instance may have closed the session since.
  The sweeper reads each listed session on the main RPC at `confirmed` before it builds anything, skips it if
  it is gone or no longer expired (a top-up moves `paid_until`), and builds from what it read. A skipped
  session is not a failure and is not in the report.
- **Two callers of `sweepOnce` share one sweep.** A call made while a sweep is in flight returns that sweep's
  report instead of starting another, so a close is never sent twice at once, with no lock per session. The
  interval's ticks join a sweep in flight the same way.
- **Closes are sent one after the other.** Each waits for `confirmed`; this avoids contention on the fee
  payer's and the rent payer's accounts and keeps the report in the listing's order.
- **The first periodic sweep runs one interval after `start`, not at once.** A facilitator that restarts
  therefore leaves expired sessions for up to one interval (30 s by default) before it closes them; a
  caller that wants a sweep now calls `sweepOnce()`.
- **A throwing logger never escapes.** The sweeper writes its log entries through a wrapper that swallows
  what `config.log` throws: a logger that fails must not lose a sweep's report or become an unhandled
  rejection in the timer. A sweep that itself fails (the listing) rejects `sweepOnce()` with an error whose
  URLs are reduced to their host.
- **Not built here:** back-off on a failing session, recreating a closed `receiver_token` (spec §6.4's last
  paragraphs), and an elected instance. A failing session is tried at every sweep.

**Files:**
- Create: `apps/facilitator/src/sweeper.ts`
- Modify: `apps/facilitator/src/server.ts` (the configuration, `RunningFacilitator`, the sweeper's creation, start and stop)
- Modify: `apps/facilitator/src/index.ts`
- Test: `apps/facilitator/test/sweeper.test.ts` (the sweep and its timer, against fake nodes)
- Test: `apps/facilitator/test/sweeper-server.test.ts` (the same through `startFacilitator`, against fake HTTP nodes)

**Interfaces:**
- Consumes:
  - `@lxfoundry/stint-x402`: `buildCloseTransaction(input: BuildCloseInput): Promise<string>` (a base64 wire
    transaction, fee payer's slot empty), `redactUrls(text: string): string`, `type SettleResponse`.
  - `@lxfoundry/stint-program-client`: `CloseKind.AtExpiry`, `SESSION_DISCRIMINATOR`, `STINT_PROGRAM_ADDRESS`,
    `fetchMaybeSession`, `getSessionDecoder`, `getSessionSize()` (250), `paidUntil(session): bigint`.
  - `./settle.js`: `submitSettlement(ctx, signed: SignedSettlement): Promise<SettleResponse>`.
  - `./verify.js`: `FacilitatorContext` (`rpc`, `network`, `keys`, `rentPayer`, `kora`, `confirmTimeoutMs`, `readRetry`).
  - `./kora.js`: `KoraClient.signTransaction(transaction: Base64EncodedWireTransaction): Promise<Base64EncodedWireTransaction>`.
  - The program accepts `close` with `kind: AtExpiry` from any signer once `now >= paid_until` (Task 1). The tests
    of this task use fake nodes and do not need the built program.
- Produces:
  - `SweeperConfig { intervalMs?: number; scanRpcUrl?: string; clock?: () => number }` (defaults 30_000 ms, `rpcUrl`, `Date.now`).
  - `SweepReport { closed: readonly Address[]; failed: readonly { session: Address; error: string }[] }`.
  - `FacilitatorConfig.sweeper?: SweeperConfig` (absent: no periodic sweep);
    `RunningFacilitator.sweepOnce(): Promise<SweepReport>` (with or without `sweeper`); `stop()` ends the interval and
    waits for a sweep in flight.
  - `createSweeper(deps: SweeperDeps): Sweeper` with `sweepOnce()`, `start(intervalMs)`, `stop()`, and
    `DEFAULT_SWEEP_INTERVAL_MS` (all in `src/sweeper.ts`).
  - Log entries through `config.log`: `{ event: "sweep", closed, failed }` when a sweep closed or failed something,
    and `{ event: "sweep_error", error }` when a periodic sweep failed (the listing, for example; a direct `sweepOnce()` rejects and logs nothing). URLs in `error`, and
    in the message of the error that `sweepOnce()` rejects with, are reduced to their host. A logger that throws is
    ignored.

- [ ] **Step 1: Write the failing tests of one sweep**

Create `apps/facilitator/test/sweeper.test.ts`. The fake node holds real encoded session accounts and applies the
listing's `dataSize` and `memcmp` filters to their bytes, so a wrong offset excludes the session and fails the test.
The fake Kora signs as the fee payer with a real key, so the transactions the sweeper sends are real and are
decoded and inspected.

```ts
import {
  generateKeyPairSigner,
  getBase58Decoder,
  getBase58Encoder,
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
import {
  CloseKind,
  SESSION_DISCRIMINATOR,
  STINT_PROGRAM_ADDRESS,
  getCloseInstructionDataDecoder,
  getSessionEncoder,
} from "@lxfoundry/stint-program-client";
import { inspectTransaction, type InspectedTransaction } from "@lxfoundry/stint-x402";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { KoraClient } from "../src/kora.js";
import { createSweeper } from "../src/sweeper.js";
import type { FacilitatorContext } from "../src/verify.js";

const NETWORK = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const BLOCKHASH = "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N";
const MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU" as Address;

/** Sessions of 30 s at 1,000 per second, started at this second. The sweeper closes when `paid_until <= clock`. */
const STARTED_AT = 1_800_000_000n;
const PAID_UNTIL_MS = Number(STARTED_AT + 30n) * 1_000;
const JUST_BEFORE_MS = PAID_UNTIL_MS - 1;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function until(condition: () => boolean, what: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await sleep(5);
  }
}

type Filter =
  | { readonly dataSize: bigint }
  | { readonly memcmp: { readonly offset: bigint; readonly bytes: string; readonly encoding: string } };
interface Listing {
  readonly program: Address;
  readonly config: { readonly commitment: string; readonly encoding: string; readonly filters: readonly Filter[] };
}

/** What the fake node holds and what it was asked; the unset parts are the happy path. */
interface Node {
  /** The session accounts, by address. A close that lands removes its account, as the program does. */
  accounts: Map<Address, Uint8Array>;
  /** Sessions whose close the node refuses at submission. */
  refuse: Set<Address>;
  /** Makes every listing fail with this message. */
  listingError?: string;
  /** Holds every submission until it settles. */
  hold?: Promise<void>;
  /** Runs after a listing has been answered. */
  onListed?: () => void;
  listings: Listing[];
  /** The accounts read one by one. */
  reads: Address[];
  /** Submissions that reached the node, held or not. */
  submitting: number;
  sent: { readonly session: Address; readonly tx: InspectedTransaction }[];
}

/**
 * Two views of one node: the main RPC, which refuses to list a program's accounts as a free tier does, and the
 * scan RPC, which does nothing else.
 */
function createChain(): { node: Node; rpc: Rpc<SolanaRpcApi>; scanRpc: Rpc<SolanaRpcApi> } {
  const node: Node = { accounts: new Map(), refuse: new Set(), listings: [], reads: [], submitting: 0, sent: [] };
  const call = (answer: () => unknown) => ({ send: async () => answer() });
  const rpcAccount = (data: Uint8Array) => ({
    data: [getBase64Decoder().decode(data), "base64"],
    executable: false,
    lamports: 1_000_000n,
    owner: STINT_PROGRAM_ADDRESS,
    space: BigInt(data.length),
  });
  const matches = (data: Uint8Array, filter: Filter): boolean => {
    if ("dataSize" in filter) return BigInt(data.length) === filter.dataSize;
    const expected = getBase58Encoder().encode(filter.memcmp.bytes);
    return expected.every((byte, index) => data[Number(filter.memcmp.offset) + index] === byte);
  };
  const scanRpc = {
    getProgramAccounts: (program: Address, config: Listing["config"]) =>
      call(() => {
        node.listings.push({ program, config });
        if (node.listingError) throw new Error(node.listingError);
        const listed = [...node.accounts]
          .filter(([, data]) => config.filters.every((filter) => matches(data, filter)))
          .map(([pubkey, data]) => ({ pubkey, account: rpcAccount(data) }));
        node.onListed?.();
        return listed;
      }),
  };
  const rpc = {
    getProgramAccounts: () =>
      call(() => {
        throw new Error("HTTP error (400): Bad Request");
      }),
    getAccountInfo: (target: Address) =>
      call(() => {
        node.reads.push(target);
        const data = node.accounts.get(target);
        return { value: data ? rpcAccount(data) : null };
      }),
    getLatestBlockhash: () => call(() => ({ value: { blockhash: BLOCKHASH, lastValidBlockHeight: 1_234n } })),
    sendTransaction: (wire: string) =>
      call(async () => {
        node.submitting++;
        await node.hold;
        const tx = inspectTransaction(wire)!;
        // `close`'s accounts: closer, session, vault, receiver token, refund account, rent payer.
        const session = tx.instructions[0]!.accounts![1]!.address;
        if (node.refuse.has(session)) throw new Error("Transaction simulation failed: custom program error 0x1774");
        node.sent.push({ session, tx });
        node.accounts.delete(session);
        return "accepted";
      }),
    getSignatureStatuses: () => call(() => ({ value: [{ confirmationStatus: "confirmed", err: null }] })),
    isBlockhashValid: () => call(() => ({ value: true })),
    getTransaction: () => call(() => null),
  };
  return { node, rpc: rpc as unknown as Rpc<SolanaRpcApi>, scanRpc: scanRpc as unknown as Rpc<SolanaRpcApi> };
}

interface FakeKora extends KoraClient {
  /** While set, Kora refuses to sign. */
  failing: boolean;
}

/** Signs as the fee payer, as Kora does: it adds its signature to a transaction that already carries the others. */
function createKora(feePayer: KeyPairSigner): FakeKora {
  const kora: FakeKora = {
    failing: false,
    getPayerSigner: async () => ({ signer_address: feePayer.address, payment_address: feePayer.address }),
    signTransaction: async (wire) => {
      if (kora.failing) throw new Error("Kora signTransaction: the policy refuses this transaction (-32000)");
      const transaction = getTransactionDecoder().decode(getBase64Encoder().encode(wire));
      return getBase64EncodedWireTransaction(await partiallySignTransaction([feePayer.keyPair], transaction));
    },
  };
  return kora;
}

describe("the sweeper (spec §6.4)", () => {
  let buyer: Address;
  let seller: Address;
  let authorizer: Address;
  let feePayer: KeyPairSigner;
  let rentPayer: KeyPairSigner;
  let stranger: KeyPairSigner;
  let fake: ReturnType<typeof createChain>;
  let kora: FakeKora;
  let logs: Record<string, unknown>[];
  let ctx: FacilitatorContext;

  beforeAll(async () => {
    buyer = (await generateKeyPairSigner()).address;
    seller = (await generateKeyPairSigner()).address;
    authorizer = (await generateKeyPairSigner()).address;
    feePayer = await generateKeyPairSigner();
    rentPayer = await generateKeyPairSigner();
    stranger = await generateKeyPairSigner();
  });

  beforeEach(() => {
    fake = createChain();
    kora = createKora(feePayer);
    logs = [];
    ctx = {
      rpc: fake.rpc,
      network: NETWORK,
      keys: { feePayer: feePayer.address, rentPayer: rentPayer.address },
      rentPayer,
      kora,
      confirmTimeoutMs: 1_000,
      readRetry: { attempts: 1, delayMs: 0 },
    };
  });

  const sweeper = (clock: () => number = () => PAID_UNTIL_MS) =>
    createSweeper({ ctx, scanRpc: fake.scanRpc, clock, log: (entry) => logs.push(entry) });

  const sessionData = (options: { rentPayer?: Address; deposited?: bigint }): Uint8Array =>
    Uint8Array.from(
      getSessionEncoder().encode({
        version: 1,
        bump: 255,
        authority: buyer,
        seed: 1n,
        mint: MINT,
        receiver: seller,
        receiverAuthorizer: authorizer,
        refundOwner: buyer,
        rentPayer: options.rentPayer ?? rentPayer.address,
        rate: 1_000n,
        minSeconds: 5,
        maxSeconds: 120,
        startedAt: STARTED_AT,
        deposited: options.deposited ?? 30_000n,
        claimed: 0n,
      }),
    );

  /** A session on the node, naming the facilitator's rent payer unless told otherwise. */
  const addSession = async (options: { rentPayer?: Address } = {}): Promise<Address> => {
    const address = (await generateKeyPairSigner()).address;
    fake.node.accounts.set(address, sessionData(options));
    return address;
  };

  it("lists the sessions that name its rent payer, on the scan RPC and never on the main one", async () => {
    const ours = await addSession();
    await addSession({ rentPayer: stranger.address });

    await sweeper().sweepOnce();

    // The main RPC refuses to list (see `createChain`): reaching it would have failed the sweep.
    expect(fake.node.listings).toEqual([
      {
        program: STINT_PROGRAM_ADDRESS,
        config: {
          commitment: "confirmed",
          encoding: "base64",
          filters: [
            { dataSize: 250n },
            { memcmp: { offset: 0n, bytes: getBase58Decoder().decode(SESSION_DISCRIMINATOR), encoding: "base58" } },
            { memcmp: { offset: 178n, bytes: rentPayer.address, encoding: "base58" } },
          ],
        },
      },
    ]);
    // The fake applied those filters to the real layout: the other rent payer's session was never listed, so never read.
    expect(fake.node.reads).toEqual([ours]);
  });

  it("closes an expired session with AtExpiry, signed by the rent payer and by Kora's fee payer", async () => {
    const session = await addSession();

    expect(await sweeper().sweepOnce()).toEqual({ closed: [session], failed: [] });

    expect(fake.node.sent).toHaveLength(1);
    const { tx } = fake.node.sent[0]!;
    const close = tx.instructions[0]!;
    expect(tx.instructions).toHaveLength(1);
    expect(getCloseInstructionDataDecoder().decode(close.data!).kind).toBe(CloseKind.AtExpiry);
    expect(close.accounts![0]!.address).toBe(rentPayer.address); // the closer
    expect(tx.feePayer).toBe(feePayer.address);
    expect(tx.blockhash).toBe(BLOCKHASH);
    expect(new Set(tx.signers)).toEqual(new Set([feePayer.address, rentPayer.address]));
    expect(tx.signed).toEqual(new Set([feePayer.address, rentPayer.address]));
  });

  it("leaves a session that has not expired alone", async () => {
    await addSession();

    expect(await sweeper(() => JUST_BEFORE_MS).sweepOnce()).toEqual({ closed: [], failed: [] });

    expect(fake.node.reads).toEqual([]);
    expect(fake.node.sent).toEqual([]);
  });

  it("skips a session that is gone when it reads it, without reporting it as failed", async () => {
    const session = await addSession();
    fake.node.onListed = () => fake.node.accounts.delete(session);

    expect(await sweeper().sweepOnce()).toEqual({ closed: [], failed: [] });

    expect(fake.node.reads).toEqual([session]);
    expect(fake.node.sent).toEqual([]);
    expect(logs).toEqual([]);
  });

  it("decides on what it reads, not on the listing: a session whose paid time moved later is left alone", async () => {
    const session = await addSession();
    fake.node.onListed = () => fake.node.accounts.set(session, sessionData({ deposited: 60_000n }));

    expect(await sweeper().sweepOnce()).toEqual({ closed: [], failed: [] });

    expect(fake.node.reads).toEqual([session]);
    expect(fake.node.sent).toEqual([]);
  });

  it("does not stop at a failing close: it closes the others, reports the failure, and tries it again at the next sweep", async () => {
    const first = await addSession();
    const second = await addSession();
    const third = await addSession();
    fake.node.refuse.add(second);
    const sweep = sweeper();

    expect(await sweep.sweepOnce()).toEqual({
      closed: [first, third],
      failed: [{ session: second, error: expect.stringContaining("simulation_failed") }],
    });
    expect(fake.node.sent.map(({ session }) => session)).toEqual([first, third]);

    fake.node.refuse.delete(second);
    expect(await sweep.sweepOnce()).toEqual({ closed: [second], failed: [] });
  });

  it("reports a close that Kora refuses to sign, and sends nothing", async () => {
    const session = await addSession();
    kora.failing = true;

    expect(await sweeper().sweepOnce()).toEqual({
      closed: [],
      failed: [{ session, error: expect.stringContaining("Kora") }],
    });
    expect(fake.node.sent).toEqual([]);
  });

  it("shares one sweep between callers that overlap, so a close is never sent twice", async () => {
    const session = await addSession();
    let release!: () => void;
    fake.node.hold = new Promise<void>((resolve) => (release = resolve));
    const sweep = sweeper();

    const first = sweep.sweepOnce();
    const second = sweep.sweepOnce();
    await until(() => fake.node.submitting === 1, "the close to reach the node");
    release();

    const [one, other] = await Promise.all([first, second]);
    expect(other).toBe(one);
    expect(one).toEqual({ closed: [session], failed: [] });
    expect(fake.node.sent).toHaveLength(1);
    expect(fake.node.listings).toHaveLength(1);

    // Once it has finished, the next call is a sweep of its own.
    expect(await sweep.sweepOnce()).toEqual({ closed: [], failed: [] });
    expect(fake.node.listings).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @lxfoundry/stint-facilitator test sweeper.test.ts`
Expected: FAIL: the file cannot be loaded, because `../src/sweeper.js` does not exist.

- [ ] **Step 3: Implement the sweep**

Create `apps/facilitator/src/sweeper.ts`:

```ts
import {
  getBase58Decoder,
  getBase64Encoder,
  getSignatureFromTransaction,
  getTransactionDecoder,
  type Address,
  type Base58EncodedBytes,
  type Base64EncodedWireTransaction,
  type Rpc,
  type SolanaRpcApi,
} from "@solana/kit";
import {
  CloseKind,
  SESSION_DISCRIMINATOR,
  STINT_PROGRAM_ADDRESS,
  fetchMaybeSession,
  getSessionDecoder,
  getSessionSize,
  paidUntil,
} from "@lxfoundry/stint-program-client";
import { buildCloseTransaction, redactUrls, type SettleResponse } from "@lxfoundry/stint-x402";
import { submitSettlement } from "./settle.js";
import type { FacilitatorContext } from "./verify.js";

export interface SweeperConfig {
  /** Milliseconds between sweeps. Default 30_000. */
  readonly intervalMs?: number;
  /** An endpoint that lists the program's accounts, if `rpcUrl` refuses that (a provider's free tier may). Default `rpcUrl`. */
  readonly scanRpcUrl?: string;
  /** Milliseconds since the epoch; default `Date.now`. Decides which sessions have expired. */
  readonly clock?: () => number;
}

export interface SweepReport {
  readonly closed: readonly Address[];
  readonly failed: readonly { readonly session: Address; readonly error: string }[];
}

export interface SweeperDeps {
  readonly ctx: FacilitatorContext;
  /** Lists the program's accounts: the main RPC, unless its provider refuses that. */
  readonly scanRpc: Rpc<SolanaRpcApi>;
  /** Milliseconds since the epoch. */
  readonly clock: () => number;
  readonly log: (entry: Record<string, unknown>) => void;
}

export interface Sweeper {
  /** Runs one sweep now and resolves to its report. A sweep already in flight is joined, not repeated. */
  sweepOnce(): Promise<SweepReport>;
}

export const DEFAULT_SWEEP_INTERVAL_MS = 30_000;

/**
 * Where a session account stores `rent_payer`: discriminator 8, version 1, bump 1, authority 32, seed 8, mint 32,
 * receiver 32, receiver authorizer 32 and refund owner 32 come first (`programs/stint/src/state.rs`).
 */
const RENT_PAYER_OFFSET = 178n;

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

function describeFailure(settled: SettleResponse): string {
  const detail = [settled.errorReason, settled.errorMessage].filter((part) => part).join(": ");
  return redactUrls(settled.transaction ? `${detail} (transaction ${settled.transaction})` : detail);
}

/** Spec §6.4: closes the sessions that name the facilitator's rent payer and whose paid time has passed. */
export function createSweeper(deps: SweeperDeps): Sweeper {
  const { ctx, scanRpc, clock, log } = deps;

  // A logger that throws must not escape: it would lose a sweep's report, or become an unhandled rejection in the timer.
  const record = (entry: Record<string, unknown>): void => {
    try {
      log(entry);
    } catch {
      // Nothing else can be done with a logger that fails.
    }
  };

  /** The listed sessions that have expired at `now` (seconds), in the order the node lists them. */
  async function listExpired(now: bigint): Promise<Address[]> {
    const accounts = await scanRpc
      .getProgramAccounts(STINT_PROGRAM_ADDRESS, {
        commitment: "confirmed",
        encoding: "base64",
        filters: [
          { dataSize: BigInt(getSessionSize()) },
          { memcmp: { offset: 0n, bytes: getBase58Decoder().decode(SESSION_DISCRIMINATOR) as Base58EncodedBytes, encoding: "base58" } },
          { memcmp: { offset: RENT_PAYER_OFFSET, bytes: ctx.keys.rentPayer as string as Base58EncodedBytes, encoding: "base58" } },
        ],
      })
      .send();
    const decoder = getSessionDecoder();
    const base64 = getBase64Encoder();
    return accounts
      .filter(({ account }) => paidUntil(decoder.decode(base64.encode(account.data[0]))) <= now)
      .map(({ pubkey }) => pubkey);
  }

  /** Closes one session; throws when the close fails. "skipped": it is gone, or no longer expired. */
  async function closeOne(session: Address, now: bigint): Promise<"closed" | "skipped"> {
    // The listing may be old, or from another node: the gate or another instance may have closed the session since.
    const current = await fetchMaybeSession(ctx.rpc, session, { commitment: "confirmed" });
    if (!current.exists || paidUntil(current.data) > now) return "skipped";
    const stored = current.data;

    const { value: lifetime } = await ctx.rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
    const transaction = await buildCloseTransaction({
      session,
      stored,
      closer: ctx.rentPayer,
      feePayer: ctx.keys.feePayer,
      lifetime,
      kind: CloseKind.AtExpiry,
    });
    let wire: Base64EncodedWireTransaction;
    try {
      wire = await ctx.kora.signTransaction(transaction as Base64EncodedWireTransaction);
    } catch (error) {
      throw new Error(`Kora: ${message(error)}`);
    }
    const signature = getSignatureFromTransaction(getTransactionDecoder().decode(getBase64Encoder().encode(wire)));
    const settled = await submitSettlement(ctx, {
      type: "close",
      wire,
      signature,
      blockhash: lifetime.blockhash,
      payer: stored.authority,
      amount: "0",
    });
    if (!settled.success) throw new Error(describeFailure(settled));
    return "closed";
  }

  async function sweep(): Promise<SweepReport> {
    const now = BigInt(Math.floor(clock() / 1000));
    const closed: Address[] = [];
    const failed: { session: Address; error: string }[] = [];
    let expired: Address[];
    try {
      expired = await listExpired(now);
    } catch (error) {
      // The caller may log this: an RPC URL can carry an API key.
      throw new Error(redactUrls(message(error)));
    }
    for (const session of expired) {
      try {
        if ((await closeOne(session, now)) === "closed") closed.push(session);
      } catch (error) {
        failed.push({ session, error: redactUrls(message(error)) });
      }
    }
    if (closed.length > 0 || failed.length > 0) record({ event: "sweep", closed, failed });
    return { closed, failed };
  }

  // A call that arrives while a sweep is in flight gets that sweep: no close is sent twice, with no lock per session.
  let inFlight: Promise<SweepReport> | undefined;
  const sweepOnce = (): Promise<SweepReport> =>
    (inFlight ??= sweep().finally(() => {
      inFlight = undefined;
    }));

  return { sweepOnce };
}
```

- [ ] **Step 4: Run them to see them pass**

Run: `pnpm --filter @lxfoundry/stint-facilitator test sweeper.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Write the failing tests of the timer**

In `apps/facilitator/test/sweeper.test.ts`, add inside the `describe`, after the test `shares one sweep between callers that overlap, so a close is never sent twice`.

Old text (the end of the file):

```ts
    expect(await sweep.sweepOnce()).toEqual({ closed: [], failed: [] });
    expect(fake.node.listings).toHaveLength(2);
  });
});
```

New text:

```ts
    expect(await sweep.sweepOnce()).toEqual({ closed: [], failed: [] });
    expect(fake.node.listings).toHaveLength(2);
  });

  it("sweeps on every interval with the clock it is given, until it is stopped", async () => {
    const session = await addSession();
    let now = JUST_BEFORE_MS;
    const sweep = sweeper(() => now);

    sweep.start(10);
    await until(() => fake.node.listings.length >= 3, "three sweeps");
    expect(fake.node.sent).toEqual([]);

    now = PAID_UNTIL_MS;
    await until(() => fake.node.sent.length === 1, "the close");
    await sweep.stop();
    expect(fake.node.sent[0]!.session).toBe(session);

    const sweeps = fake.node.listings.length;
    await sleep(50);
    expect(fake.node.listings).toHaveLength(sweeps);
  });

  it("never throws out of the interval: a failed sweep is logged, without the URL's secret, and the next one runs", async () => {
    fake.node.listingError = "HTTP error (429) from https://rpc.example/v2/secret-key: rate limited";
    const sweep = sweeper();
    // A caller that logs what `sweepOnce` rejects with must not leak the secret either.
    const rejection = (await sweep.sweepOnce().catch((error: unknown) => error)) as Error;
    expect(rejection.message).toBe("HTTP error (429) from https://rpc.example rate limited");

    sweep.start(10);
    await until(() => logs.length >= 2, "two failed sweeps");
    await sweep.stop();

    expect(logs[0]).toMatchObject({ event: "sweep_error" });
    expect(JSON.stringify(logs)).toContain("https://rpc.example");
    expect(JSON.stringify(logs)).not.toContain("secret-key");
  });

  it("does not let a logger that throws escape: the report is still returned, and the timer raises no unhandled rejection", async () => {
    const session = await addSession();
    let logged = 0;
    const sweep = createSweeper({
      ctx,
      scanRpc: fake.scanRpc,
      clock: () => PAID_UNTIL_MS,
      log: () => {
        logged++;
        throw new Error("the log is down");
      },
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      expect(await sweep.sweepOnce()).toEqual({ closed: [session], failed: [] });

      fake.node.listingError = "listing failed";
      sweep.start(10);
      await until(() => logged >= 3, "the logger to be called for two failed sweeps");
      await sweep.stop();
      await sleep(20);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }

    expect(unhandled).toEqual([]);
  });

  it("waits, when it stops, for a sweep in flight", async () => {
    await addSession();
    let release!: () => void;
    fake.node.hold = new Promise<void>((resolve) => (release = resolve));
    const sweep = sweeper();
    try {
      sweep.start(10);
      await until(() => fake.node.submitting === 1, "a close in flight");

      let stopped = false;
      const stopping = sweep.stop().then(() => (stopped = true));
      await sleep(50);
      expect(stopped).toBe(false);

      release();
      await stopping;
      expect(fake.node.sent).toHaveLength(1);
    } finally {
      release();
    }
    const sweeps = fake.node.listings.length;
    await sleep(50);
    expect(fake.node.listings).toHaveLength(sweeps);
  });
});
```

- [ ] **Step 6: Run them to see them fail**

Run: `pnpm --filter @lxfoundry/stint-facilitator test sweeper.test.ts`
Expected: FAIL: the four new tests fail with `sweep.start is not a function`; the first eight still pass.

- [ ] **Step 7: Implement the timer**

In `apps/facilitator/src/sweeper.ts`, two edits.

1. The interface. Old text:

```ts
export interface Sweeper {
  /** Runs one sweep now and resolves to its report. A sweep already in flight is joined, not repeated. */
  sweepOnce(): Promise<SweepReport>;
}
```

New text:

```ts
export interface Sweeper {
  /** Runs one sweep now and resolves to its report. A sweep already in flight is joined, not repeated. */
  sweepOnce(): Promise<SweepReport>;
  /** Sweeps every `intervalMs` from now on, the first sweep one interval from now. The timer does not keep the process alive, and no tick throws: a failed sweep is logged. */
  start(intervalMs: number): void;
  /** Ends the interval and waits for a sweep in flight. `sweepOnce` still works afterwards. */
  stop(): Promise<void>;
}
```

2. The end of `createSweeper`. Old text:

```ts
  return { sweepOnce };
}
```

New text:

```ts
  let timer: NodeJS.Timeout | undefined;
  function start(intervalMs: number): void {
    if (timer) return;
    timer = setInterval(() => {
      sweepOnce().catch((error: unknown) => record({ event: "sweep_error", error: redactUrls(message(error)) }));
    }, intervalMs);
    timer.unref();
  }

  async function stop(): Promise<void> {
    clearInterval(timer);
    timer = undefined;
    await inFlight?.catch(() => undefined);
  }

  return { sweepOnce, start, stop };
}
```

- [ ] **Step 8: Run them to see them pass**

Run: `pnpm --filter @lxfoundry/stint-facilitator test sweeper.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 9: Write the failing tests through `startFacilitator`**

These start the real facilitator against fake JSON-RPC nodes over HTTP, so the wiring is tested: that the configuration starts
the interval, that the clock and `scanRpcUrl` reach the sweeper, and that `stop()` ends it. Create
`apps/facilitator/test/sweeper-server.test.ts`:

```ts
import { generateKeyPairSync } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { generateKeyPairSigner, getBase64Decoder, type Address } from "@solana/kit";
import { STINT_PROGRAM_ADDRESS, getSessionEncoder, getSessionSize } from "@lxfoundry/stint-program-client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { startFacilitator, type RunningFacilitator, type SweeperConfig } from "../src/index.js";

const NETWORK = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU" as Address;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function until(condition: () => boolean, what: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await sleep(5);
  }
}

/** A fresh 64-byte Solana secret key: the 32-byte seed, then the public key. */
function newSecretKey(): Uint8Array {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const seed = privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
  const pub = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  return Uint8Array.from([...seed, ...pub]);
}

interface Endpoint {
  readonly url: string;
  count(method: string): number;
  stop(): Promise<void>;
}

/** A JSON-RPC node over HTTP: it answers every call from `answer`, and counts the calls by method. */
async function startEndpoint(answer: (method: string) => unknown): Promise<Endpoint> {
  const calls: string[] = [];
  const server: Server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const { id, method } = JSON.parse(body) as { id: unknown; method: string };
      calls.push(method);
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ jsonrpc: "2.0", id, result: answer(method) }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    count: (method) => calls.filter((called) => called === method).length,
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

describe("the sweeper inside startFacilitator (spec §6.4, §12.4)", () => {
  let kora: { url: string; stop: () => Promise<void> };
  // A session account that started in 1970 and ran for 30 s: every real clock says it has expired.
  let expired: { pubkey: string; account: unknown };
  const endpoints: Endpoint[] = [];
  const running: RunningFacilitator[] = [];

  beforeAll(async () => {
    const feePayer = (await generateKeyPairSigner()).address;
    const koraEndpoint = await startEndpoint(() => ({ signer_address: feePayer, payment_address: feePayer }));
    kora = koraEndpoint;
    const key = (await generateKeyPairSigner()).address;
    const data = getSessionEncoder().encode({
      version: 1,
      bump: 255,
      authority: key,
      seed: 1n,
      mint: MINT,
      receiver: key,
      receiverAuthorizer: key,
      refundOwner: key,
      rentPayer: key,
      rate: 1_000n,
      minSeconds: 5,
      maxSeconds: 120,
      startedAt: 1_000_000n,
      deposited: 30_000n,
      claimed: 0n,
    });
    expired = {
      pubkey: (await generateKeyPairSigner()).address,
      account: {
        data: [getBase64Decoder().decode(data), "base64"],
        executable: false,
        lamports: 1_000_000,
        owner: STINT_PROGRAM_ADDRESS,
        rentEpoch: 0,
        space: getSessionSize(),
      },
    };
  });

  afterAll(() => kora.stop());

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(running.splice(0).map((facilitator) => facilitator.stop()));
    await Promise.all(endpoints.splice(0).map((endpoint) => endpoint.stop()));
  });

  /** A node that lists `accounts` and holds none: reading one account finds nothing. */
  const node = async (accounts: unknown[]): Promise<Endpoint> => {
    const endpoint = await startEndpoint((method) => (method === "getAccountInfo" ? { context: { slot: 1 }, value: null } : accounts));
    endpoints.push(endpoint);
    return endpoint;
  };

  const launch = async (rpcUrl: string, sweeper?: SweeperConfig): Promise<RunningFacilitator> => {
    const facilitator = await startFacilitator({
      rpcUrl,
      network: NETWORK,
      kora: { url: kora.url, apiKey: "kora-key" },
      rentPayerSecretKey: newSecretKey(),
      apiKeys: ["seller-key"],
      sweeper,
    });
    running.push(facilitator);
    return facilitator;
  };

  it("sweeps on its interval, decides expiry on the clock it is given, and stops sweeping when it stops", async () => {
    const endpoint = await node([expired]);
    // Only the injected clock, set at the epoch, says that this session has not expired: the real one would not.
    const facilitator = await launch(endpoint.url, { intervalMs: 20, clock: () => 0 });

    await until(() => endpoint.count("getProgramAccounts") >= 3, "three sweeps");
    expect(endpoint.count("getAccountInfo")).toBe(0);

    await facilitator.stop();
    const sweeps = endpoint.count("getProgramAccounts");
    await sleep(100);
    expect(endpoint.count("getProgramAccounts")).toBe(sweeps);
  });

  it("starts no interval without a sweeper configuration, and still sweeps on demand", async () => {
    const timers = vi.spyOn(globalThis, "setInterval");
    // The default interval is 30 s: no short wait could show that a timer was started by mistake, a spy can.
    const atDefault = () => timers.mock.calls.filter((call) => call[1] === 30_000);
    const endpoint = await node([]);

    const facilitator = await launch(endpoint.url);
    expect(atDefault()).toHaveLength(0);
    // The control: a sweeper configuration without an interval starts exactly one timer, at the default.
    await launch(endpoint.url, {});
    expect(atDefault()).toHaveLength(1);

    expect(endpoint.count("getProgramAccounts")).toBe(0);
    expect(await facilitator.sweepOnce()).toEqual({ closed: [], failed: [] });
    expect(endpoint.count("getProgramAccounts")).toBe(1);
  });

  it("lists on scanRpcUrl when it is set, and reads on rpcUrl", async () => {
    const main = await node([]);
    const scan = await node([expired]);
    const facilitator = await launch(main.url, { scanRpcUrl: scan.url });

    // The real clock: the session expired in 1970, so it is read, and the main node holds nothing, so it is skipped.
    expect(await facilitator.sweepOnce()).toEqual({ closed: [], failed: [] });

    expect(scan.count("getProgramAccounts")).toBe(1);
    expect(scan.count("getAccountInfo")).toBe(0);
    expect(main.count("getProgramAccounts")).toBe(0);
    expect(main.count("getAccountInfo")).toBe(1);
  });
});
```

- [ ] **Step 10: Run them to see them fail**

Run: `pnpm --filter @lxfoundry/stint-facilitator test sweeper-server.test.ts`
Expected: FAIL: the first test times out waiting for three sweeps (the configuration is ignored); the second fails at the
control, `expected [] to have a length of 1` (no timer is started for the configuration); and the third fails with
`facilitator.sweepOnce is not a function`.

- [ ] **Step 11: Wire the sweeper into `startFacilitator`**

In `apps/facilitator/src/server.ts`, five edits.

1. The import. Old text:

```ts
import { settlePayment } from "./settle.js";
import { verifyPayment, type FacilitatorContext } from "./verify.js";
```

New text:

```ts
import { settlePayment } from "./settle.js";
import { DEFAULT_SWEEP_INTERVAL_MS, createSweeper, type SweepReport, type SweeperConfig } from "./sweeper.js";
import { verifyPayment, type FacilitatorContext } from "./verify.js";
```

2. The configuration. Old text:

```ts
  readonly readRetry?: RetryOptions;
  readonly log?: (entry: Record<string, unknown>) => void;
}
```

New text:

```ts
  readonly readRetry?: RetryOptions;
  /** Absent: no periodic sweep (spec §6.4). `sweepOnce()` works either way. */
  readonly sweeper?: SweeperConfig;
  readonly log?: (entry: Record<string, unknown>) => void;
}
```

3. The running facilitator. Old text:

```ts
  readonly rentPayer: Address;
  stop(): Promise<void>;
}
```

New text:

```ts
  readonly rentPayer: Address;
  /** Runs one sweep of expired sessions now (spec §12.4); a sweep already in flight is joined. */
  sweepOnce(): Promise<SweepReport>;
  /** Ends the sweeper's interval and waits for a sweep in flight, then stops the server. */
  stop(): Promise<void>;
}
```

4. The sweeper, built from the same context as `/settle`. Old text:

```ts
    confirmTimeoutMs: config.confirmTimeoutMs ?? 30_000,
    readRetry: config.readRetry,
  };
  const host = config.host ?? "127.0.0.1";
```

New text:

```ts
    confirmTimeoutMs: config.confirmTimeoutMs ?? 30_000,
    readRetry: config.readRetry,
  };
  // The sweeper builds and signs its own closes with `ctx`: they do not pass `verifyPayment`, which refuses the rent payer as a closer.
  const sweeper = createSweeper({
    ctx,
    scanRpc: config.sweeper?.scanRpcUrl ? createSolanaRpc(config.sweeper.scanRpcUrl) : ctx.rpc,
    clock: config.sweeper?.clock ?? Date.now,
    log,
  });
  const host = config.host ?? "127.0.0.1";
```

5. The start and the stop. Old text:

```ts
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

New text:

```ts
  url = `http://${host}:${(server.address() as AddressInfo).port}`;
  // Started only once the server listens, so that a start that fails leaves no timer behind.
  if (config.sweeper) sweeper.start(config.sweeper.intervalMs ?? DEFAULT_SWEEP_INTERVAL_MS);

  return {
    url,
    closeUrl: `${url}/close`,
    feePayer,
    rentPayer: rentPayer.address,
    sweepOnce: () => sweeper.sweepOnce(),
    stop: async () => {
      // The sweeper first: a close it has sent is waited for before the server goes.
      await sweeper.stop();
      await new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
    },
  };
}
```

- [ ] **Step 12: Export the types**

In `apps/facilitator/src/index.ts`. Old text:

```ts
export { settlePayment, submitSettlement, type SignedSettlement } from "./settle.js";
```

New text:

```ts
export { settlePayment, submitSettlement, type SignedSettlement } from "./settle.js";
export type { SweepReport, SweeperConfig } from "./sweeper.js";
```

- [ ] **Step 13: Run the facilitator's tests and its type check**

Run: `pnpm --filter @lxfoundry/stint-facilitator test`
Expected: PASS: every file, the 15 new tests included (12 in `sweeper.test.ts`, 3 in `sweeper-server.test.ts`).

Run: `pnpm --filter @lxfoundry/stint-facilitator typecheck`
Expected: no output, exit code 0.

Run: `pnpm typecheck`
Expected: exit code 0 (the harness starts the facilitator and is checked with it).

- [ ] **Step 14: Commit**

```bash
git add apps/facilitator
git commit -m "Add the facilitator's sweeper: it closes expired sessions with AtExpiry, signing as the rent payer"
```

---

### Task 3: The gate's end of session: idle timer, end timer and close code 4402

Until now nothing in the gate ends a session: a connection stays open past `paidUntil`, and a session nobody
uses keeps its deposit until someone closes it. This task gives the gate two timers per session (spec §7.3,
§7.5). The **idle timer** closes a session that has no connection for `idleCloseSeconds`. The **end timer**
stops forwarding at `paidUntil`, settles an `AtExpiry` close, and drops the connections with `4402`. Every
timer is injectable (spec §12.4), so the tests fire them on demand.

Run every command from the repository root, inside WSL.

**One close, three triggers.** `performClose` today builds a `Standard` close and ends the session with
`closed` and `4410`; `Tracked.closing` makes concurrent closes share one settlement. The buyer's HTTP close,
the idle timer and the end timer all go through that same slot. `startClose` and `performClose` take a
`ClosePlan` (the close's kind, the reason the session ends with, and the code its connections get); whichever
trigger arrives first sets the plan, and the others join its promise. `CloseOutcome` stays HTTP-shaped: the
timers read only its `ended` flag. A second `closeAtExpiry` function was rejected: it would duplicate the
settlement and the `end` call, and it could run beside the buyer's close.

**How the clock and the timers combine.** A timer is armed for a target on the session clock, with
`delayMs = max(0, targetMs - sessionClock())`: the idle target is `sessionClock() + idleCloseSeconds * 1000`,
the end target is `Number(paidUntil) * 1000`. `setTimeout` takes at most 2,147,483,647 ms (a longer delay fires
at once) and can fire a moment early, so the delay is capped and a timer that fires before its target sets
itself again for what is left. The tests' fake timers record `{ callback, delayMs, dueMs, cleared, fired }`;
`fire` moves the fake session clock to `dueMs`, as a real timer's wait would, and runs the callback.

**Stopping forwarding.** The `ResourceAdapter` interface does not change (only its doc comment, Step 16). At the
end timer the gate replaces each connection's `send` with a function that drops the frame (it still calls a send
callback, so an adapter waiting on one is not stuck), keeping the original in a map; `resume` puts it back. A close
frame does not go through `send`, so the later `4402` is unaffected. Forwarding stops only for sends made through
`socket.send` at send time: an adapter that captured the method earlier is not muted.

**What this task leaves out** (each is built later, or is outside the system; do not half-build it): the
top-up route and any subscription to the session account, so `paid_until` moves only through the re-read at the
end timer; the lookup of the `Closed` event after another party closed the account (a missing account, or one
that holds another session opened at the address after a close, is ended as `expired` with `4402`); adoption of
a session opened on chain; one live connection per session (`4429`);
outage and admin closes (`4503`, `WaiveMinimum`); the sponsored close; restart recovery; a pending settlement
(`202`) of an idle or end close, which counts as a failed attempt. A close request to the facilitator has no
timeout of its own, so a hung close blocks the other triggers until the HTTP library gives up; that is out of
scope here.

**Files:**
- Modify: `packages/gate/src/types.ts` (`Timers`, `CLOSE_CODES`, `"idle"`, the two config fields, the comments, including the `ResourceAdapter` one)
- Modify: `packages/gate/src/index.ts`
- Modify: `packages/gate/src/gate.ts`
- Create: `packages/gate/test/harness.ts` (the harness of `gate.test.ts`, moved, with fake timers and a movable clock)
- Modify: `packages/gate/test/gate.test.ts` (uses the moved harness; no test changes)
- Test: `packages/gate/test/lifecycle.test.ts` (create)
- Checked, not changed: `packages/client/test/gate.ts` (Step 18)

**Interfaces:**
- Consumes: `createGate`, `GateChain.readSession`, `FacilitatorClient.settle`, `buildCloseTransaction({ kind })`,
  `readUntilFound`, `paidUntil`, `sessionMatches` and `CloseKind` (`CloseKind.AtExpiry` is in the generated client). The facilitator's
  `/settle` passes a close of any kind: `checkCloseTransaction` reads the kind and `verifyPayment` does not restrict
  it. The program accepts `AtExpiry` once the program task has landed; the unit tests here use a fake facilitator.
- Produces (from `@lxfoundry/stint-gate`):

```ts
export interface Timers {
  /** Runs `callback` once, after `delayMs`; the handle goes to `clear`. */
  set(callback: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
}
// GateConfig gains:
//   readonly timers?: Timers;             // default: setTimeout / clearTimeout, unreferenced
//   readonly endRetrySeconds?: number;    // default 2, at least 1: the wait before the end close is tried again
// idleCloseSeconds is enforced (default 60).
export const CLOSE_CODES = { PAID_TIME_ENDED: 4402, SESSION_CLOSED: 4410 } as const;
export type EndReason = "closed" | "expired" | "idle" | "outage" | "admin" | "closedElsewhere";
```

  - Behaviour: an open that settles for a new session arms both timers; an accepted connection clears the idle
    timer and the drop of the last one arms it (not while forwarding is stopped: `resume` arms it then); the idle
    timer settles a `Standard` close (`teardown("idle")`,
    `4410`); the end timer mutes forwarding, re-reads the session, and ends it (`4402`, `teardown("expired")`,
    no close) if the account is gone or holds another session (another `startedAt`, or terms that
    `sessionMatches` refuses), resumes if `paid_until` moved later on the same session, or settles an `AtExpiry`
    close, re-reading the same way and retrying after `endRetrySeconds` when that fails. `end()` clears both
    timers and logs a `teardown` that throws; `Gate.close()` clears every timer and still ends no session.
  - Test support: `packages/gate/test/harness.ts` exports `NOW_MS`, `Harness`, `startHarness(timings?)`,
    `helpers(get)`, `FakeTimers` and `FakeClock`.

- [ ] **Step 1: Declare the timers, the close codes and the idle reason**

In `packages/gate/src/types.ts`, replace:

```ts
export type EndReason = "closed" | "expired" | "outage" | "admin" | "closedElsewhere";
```

with:

```ts
/** Why a session ended, as `teardown` receives it. `idle`: no connection came back within `idleCloseSeconds`. */
export type EndReason = "closed" | "expired" | "idle" | "outage" | "admin" | "closedElsewhere";

/** The close codes the gate sends on a connection it drops (spec §7.4). */
export const CLOSE_CODES = { PAID_TIME_ENDED: 4402, SESSION_CLOSED: 4410 } as const;

/** The timers the gate arms (spec §12.4). A test replaces them to fire one on demand. */
export interface Timers {
  /** Runs `callback` once, after `delayMs`; the handle goes to `clear`. */
  set(callback: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
}
```

In the same file, replace:

```ts
  /** Milliseconds. Runs the margin (spec §7.3). Default `Date.now`. */
  readonly sessionClock?: () => number;
```

with:

```ts
  /** Milliseconds. Runs the idle and end timers and the margin (spec §7.3). Default `Date.now`. */
  readonly sessionClock?: () => number;
  /** The idle and end timers. Default: `setTimeout` and `clearTimeout`, without keeping the process alive. */
  readonly timers?: Timers;
  /** Seconds to wait before the close at the end of the paid time is tried again, after it failed and the session was unchanged. Default 2; a value below 1 is raised to 1, and one that is not a finite number gives 2. */
  readonly endRetrySeconds?: number;
```

In `packages/gate/src/index.ts`, replace:

```ts
export type { EndReason, GateConfig, ResourceAdapter, SessionInfo } from "./types.js";
```

with:

```ts
export { CLOSE_CODES } from "./types.js";
export type { EndReason, GateConfig, ResourceAdapter, SessionInfo, Timers } from "./types.js";
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @lxfoundry/stint-gate typecheck`
Expected: no output, exit code 0 (nothing uses the new names yet).

- [ ] **Step 3: Commit**

```bash
git add packages/gate/src/types.ts packages/gate/src/index.ts
git commit -m "Declare the gate's timers, its close codes and the idle end reason"
```

- [ ] **Step 4: Move the test harness into its own file, with fake timers and a movable clock**

`gate.test.ts` builds its harness inline, and the lifecycle tests need the same fakes. The harness moves to
`packages/gate/test/harness.ts` unchanged, except for what lifecycle tests need: the session clock and the
timers are fakes the tests move, the gate's side of each connection is recorded in `attached`, the gate's log
is recorded in `logs`, and two knobs exist (`onSettleClose`, `fail.teardown`). Nothing in the existing tests
reads any of these. Create `packages/gate/test/harness.ts`:

```ts
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { generateKeyPairSigner, type Address, type KeyPairSigner } from "@solana/kit";
import { CloseKind, type ClosedEvent, type Session } from "@lxfoundry/stint-program-client";
import {
  USDC_DEVNET,
  buildOpenTransaction,
  createSessionToken,
  encodePaymentSignatureHeader,
  readElapsedPayload,
  type PaymentPayload,
  type PaymentRequired,
  type SettleResponse,
  type VerifyResponse,
} from "@lxfoundry/stint-x402";
import { WebSocket } from "ws";
import { createGate, type EndReason, type Gate, type GateChain, type GateConfig, type SessionInfo, type Timers } from "../src/index.js";

export const NOW_MS = 1_800_000_000_000;

/** The gate's session clock, in milliseconds. Tests move it. */
export interface FakeClock {
  now: number;
}

export interface FakeTimer {
  readonly callback: () => void;
  readonly delayMs: number;
  /** On the session clock: when the timer was set, plus its delay. */
  readonly dueMs: number;
  cleared: boolean;
  fired: boolean;
}

/** Timers that run only when a test fires them. */
export class FakeTimers implements Timers {
  readonly all: FakeTimer[] = [];
  readonly clock: FakeClock;

  constructor(clock: FakeClock) {
    this.clock = clock;
  }

  set(callback: () => void, delayMs: number): FakeTimer {
    const timer: FakeTimer = { callback, delayMs, dueMs: this.clock.now + delayMs, cleared: false, fired: false };
    this.all.push(timer);
    return timer;
  }

  clear(handle: unknown): void {
    (handle as FakeTimer).cleared = true;
  }

  /** The timers that have neither been cleared nor fired. */
  get pending(): FakeTimer[] {
    return this.all.filter((timer) => !timer.cleared && !timer.fired);
  }

  /** Runs a pending timer as a real one would run: by then the clock has reached the time it was due, unless `advance` is false. */
  fire(timer: FakeTimer, options: { advance?: boolean } = {}): void {
    if (timer.cleared || timer.fired) throw new Error("The timer is not pending");
    timer.fired = true;
    if (options.advance !== false) this.clock.now = Math.max(this.clock.now, timer.dueMs);
    timer.callback();
  }
}

export interface Harness {
  readonly url: string;
  readonly gate: Gate;
  readonly server: Server;
  readonly buyer: KeyPairSigner;
  readonly authorizer: KeyPairSigner;
  readonly calls: { verify: PaymentPayload[]; settle: PaymentPayload[]; provision: SessionInfo[]; attach: SessionInfo[]; teardown: EndReason[] };
  verifyAnswer: VerifyResponse;
  settleAnswer: (payload: PaymentPayload) => SettleResponse;
  sessions: Map<Address, Session>;
  /** Faults and pauses a test switches on. */
  fail: { supported: boolean; settleClose: boolean; closedEvent: boolean; provision: boolean; teardown: boolean };
  hold: { provision?: Promise<void>; settleClose?: Promise<void> };
  /** Runs inside the fake facilitator's close, after `hold` and before `fail`: a test changes the chain here. */
  onSettleClose?: () => void;
  /** How many reads the fake chain answers with nothing before the real answer, and the reads made. */
  missing: { session: number; closedEvent: number };
  reads: { session: number; closedEvent: number };
  /** Rejections that escaped `handleRequest`: the gate must contain its own errors. */
  escaped: unknown[];
  /** The gate's session clock and its timers: the timers run only when a test fires them. */
  readonly clock: FakeClock;
  readonly timers: FakeTimers;
  /** The gate's side of each accepted connection, in order, as the adapter received it. */
  readonly attached: WebSocket[];
  /** What the gate logged. */
  readonly logs: Record<string, unknown>[];
}

export async function startHarness(timings: Pick<GateConfig, "idleCloseSeconds" | "endRetrySeconds"> = {}): Promise<Harness> {
  const buyer = await generateKeyPairSigner();
  const authorizer = await generateKeyPairSigner();
  const seller = await generateKeyPairSigner();
  const feePayer = (await generateKeyPairSigner()).address;
  const rentPayer = (await generateKeyPairSigner()).address;
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const clock: FakeClock = { now: NOW_MS };

  const harness = {
    url,
    server,
    buyer,
    authorizer,
    calls: { verify: [], settle: [], provision: [], attach: [], teardown: [] },
    verifyAnswer: { isValid: true },
    settleAnswer: () => ({ success: true, transaction: "sig", network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" }),
    sessions: new Map<Address, Session>(),
    fail: { supported: false, settleClose: false, closedEvent: false, provision: false, teardown: false },
    hold: {},
    missing: { session: 0, closedEvent: 0 },
    reads: { session: 0, closedEvent: 0 },
    escaped: [],
    clock,
    timers: new FakeTimers(clock),
    attached: [],
    logs: [],
  } as unknown as Harness;

  const chain: GateChain = {
    latestBlockhash: async () => ({ blockhash: "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N", lastValidBlockHeight: 100n }),
    readSession: async (session) => (harness.reads.session++ < harness.missing.session ? undefined : harness.sessions.get(session)),
    closedEvent: async () => {
      if (harness.fail.closedEvent) throw new Error("rpc down");
      if (harness.reads.closedEvent++ < harness.missing.closedEvent) return undefined;
      return { claimed: 0n, owed: 8_000n, refunded: 22_000n, redirected: 0n, kind: CloseKind.Standard } as ClosedEvent;
    },
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
    endRetrySeconds: 3,
    ...timings,
    facilitator: {
      supported: async () => {
        if (harness.fail.supported) throw new Error("facilitator down");
        return {
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
        };
      },
      verify: async (payload) => (harness.calls.verify.push(payload), harness.verifyAnswer),
      settle: async (payload) => {
        harness.calls.settle.push(payload);
        if (readElapsedPayload(payload)?.type === "close") {
          await harness.hold.settleClose;
          harness.onSettleClose?.();
          if (harness.fail.settleClose) throw new Error("facilitator down");
        }
        return harness.settleAnswer(payload);
      },
    },
    chain,
    adapter: {
      provision: async (info) => {
        harness.calls.provision.push(info);
        await harness.hold.provision;
        if (harness.fail.provision) throw new Error("adapter broke");
      },
      attach: (info, socket) => {
        harness.calls.attach.push(info);
        harness.attached.push(socket);
        socket.send(JSON.stringify({ type: "hello" }));
      },
      teardown: async (_, reason) => {
        harness.calls.teardown.push(reason);
        if (harness.fail.teardown) throw new Error("teardown broke");
      },
    },
    tokenClock: () => NOW_MS,
    sessionClock: () => clock.now,
    timers: harness.timers,
    readRetry: { attempts: 3, delayMs: 5 },
    log: (entry) => void harness.logs.push(entry),
  });
  server.on("request", (req, res) => {
    gate.handleRequest(req, res).then(
      (handled) => {
        if (!handled) res.writeHead(404).end();
      },
      (error: unknown) => {
        harness.escaped.push(error);
        res.writeHead(500).end();
      },
    );
  });
  server.on("upgrade", (req, socket, head) => {
    if (!gate.handleUpgrade(req, socket, head)) socket.destroy();
  });
  return Object.assign(harness, { gate });
}

/** The requests and connections the tests make, against whichever harness `get` returns. */
export function helpers(get: () => Harness) {
  async function offers(seconds?: number): Promise<{ status: number; body: PaymentRequired; header: string | null }> {
    const response = await fetch(`${get().url}/sessions${seconds === undefined ? "" : `?seconds=${seconds}`}`, { method: "POST" });
    return { status: response.status, body: (await response.json()) as PaymentRequired, header: response.headers.get("payment-required") };
  }

  /** Pays for the first offer and records the session on the fake chain as the program would. */
  async function open(): Promise<{ session: Address; status: number; body: Record<string, unknown> }> {
    const { session, payload } = await prepareOpen();
    return { session, ...(await send(payload)) };
  }

  async function send(payload: PaymentPayload): Promise<{ status: number; body: Record<string, unknown> }> {
    const response = await fetch(`${get().url}/sessions?seconds=30`, {
      method: "POST",
      headers: { "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(payload) },
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  async function prepareOpen(): Promise<{ session: Address; payload: PaymentPayload }> {
    const h = get();
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
    return { session: built.session, payload };
  }

  const closeWith = async (session: Address) =>
    fetch(`${get().url}/sessions/${session}/close`, {
      method: "POST",
      headers: { authorization: `Bearer ${await token(session, "close")}` },
    });

  /** Lets requests already in flight reach the gate's guards. */
  const settleDown = () => new Promise((resolve) => setTimeout(resolve, 100));

  const token = (session: Address, purpose: "connect" | "close", audience = get().url) =>
    createSessionToken(get().buyer, { session, audience, purpose }, { nowMs: NOW_MS });

  function connect(session: Address, bearer?: string, query?: string): Promise<{ status?: number; socket?: WebSocket }> {
    const url = `${get().url.replace("http", "ws")}/sessions/${session}/ws${query ? `?token=${query}` : ""}`;
    const socket = new WebSocket(url, bearer ? { headers: { authorization: `Bearer ${bearer}` } } : {});
    return new Promise((resolve) => {
      socket.once("open", () => resolve({ socket }));
      socket.once("unexpected-response", (_, response) => resolve({ status: response.statusCode }));
    });
  }

  return { offers, open, send, prepareOpen, closeWith, settleDown, token, connect };
}
```

- [ ] **Step 5: Make `gate.test.ts` use the moved harness**

In `packages/gate/test/gate.test.ts`:

1. In the `describe("gate", ...)` block, replace the helpers, from the line
`  async function offers(seconds?: number): Promise<{ status: number; body: PaymentRequired; header: string | null }> {`
(line 162 of the original file) through the closing `}` of `function connect(` (line 227), with this one line. Do this
first: the next edit shifts every line number.

```ts
  const { offers, open, send, prepareOpen, closeWith, settleDown, token, connect } = helpers(() => h);
```

2. Replace the top of the file, from line 1 (the first import) through the closing `}` of `startHarness` (line 146: the
imports, `NOW_MS`, the `Harness` interface and `startHarness`), with:

```ts
import { connect as netConnect, type AddressInfo, type Socket } from "node:net";
import type { Address } from "@solana/kit";
import { decodePaymentRequiredHeader, inspectTransaction, readElapsedPayload } from "@lxfoundry/stint-x402";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NOW_MS, helpers, startHarness, type Harness } from "./harness.js";
```

Nothing else in the file changes: `beforeEach`, `afterEach`, every test and `connectRaw` stay as they are.

- [ ] **Step 6: Run the moved tests and the typecheck**

Run: `pnpm --filter @lxfoundry/stint-gate test`
Expected: PASS: 34 tests (27 in `gate.test.ts`, 7 in `chain.test.ts`), the same as before the move.

Run: `pnpm --filter @lxfoundry/stint-gate typecheck`
Expected: no output, exit code 0.

- [ ] **Step 7: Commit**

```bash
git add packages/gate/test/harness.ts packages/gate/test/gate.test.ts
git commit -m "Move the gate's test harness to its own file and give it fake timers and a movable session clock"
```

- [ ] **Step 8: Write the failing tests of the idle timer**

Create `packages/gate/test/lifecycle.test.ts`:

```ts
import { once } from "node:events";
import { CloseKind, STINT_PROGRAM_ADDRESS, parseCloseInstruction } from "@lxfoundry/stint-program-client";
import { inspectTransaction, readElapsedPayload, type PaymentPayload } from "@lxfoundry/stint-x402";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WebSocket } from "ws";
import { NOW_MS, helpers, startHarness, type FakeTimer, type Harness } from "./harness.js";

/** The harness's `idleCloseSeconds`. */
const IDLE_MS = 10_000;
const IDLE_DUE = NOW_MS + IDLE_MS;

/** The `CloseKind` of the `stint.close` in a close payload, read from the transaction's instruction data. */
function closeKindOf(payload: PaymentPayload): CloseKind {
  const tx = inspectTransaction(readElapsedPayload(payload)!.transaction)!;
  const close = tx.instructions.find((instruction) => instruction.programAddress === STINT_PROGRAM_ADDRESS)!;
  return parseCloseInstruction(close as Parameters<typeof parseCloseInstruction>[0]).data.kind;
}

/** Closes the buyer's socket and waits until the gate's side of it has closed too. */
async function drop(client: WebSocket, server: WebSocket): Promise<void> {
  const closed = once(server, "close");
  client.close();
  await closed;
}

describe("the gate's lifecycle", () => {
  let h: Harness;
  const { open, prepareOpen, send, closeWith, settleDown, token, connect } = helpers(() => h);

  beforeEach(async () => {
    h = await startHarness();
  });

  afterEach(async () => {
    expect(h.escaped).toEqual([]);
    await h.gate.close();
    h.server.closeAllConnections();
    await new Promise((resolve) => h.server.close(resolve));
  });

  /** The close transactions the gate sent to the facilitator. */
  const closes = () => h.calls.settle.filter((payload) => readElapsedPayload(payload)?.type === "close");
  /** The timers waiting for the idle period. */
  const idleTimers = () => h.timers.pending.filter((timer) => timer.delayMs === IDLE_MS);
  /** The one timer still waiting that is due at `dueMs` on the session clock. */
  function pendingDue(dueMs: number): FakeTimer {
    const found = h.timers.pending.filter((timer) => timer.dueMs === dueMs);
    expect(found).toHaveLength(1);
    return found[0]!;
  }
  /** Makes the fake facilitator's close wait until the returned function is called. */
  function holdClose(): () => void {
    let release!: () => void;
    h.hold.settleClose = new Promise<void>((resolve) => (release = resolve));
    return release;
  }

  describe("the idle timer", () => {
    it("is armed for idleCloseSeconds when an open settles, and a repeated open arms nothing", async () => {
      const { payload } = await prepareOpen();
      expect(h.timers.all).toHaveLength(0);

      expect((await send(payload)).status).toBe(201);
      expect(h.timers.pending.map((timer) => timer.delayMs)).toContain(IDLE_MS);
      const armed = h.timers.all.length;

      expect((await send(payload)).status).toBe(201);
      expect(h.timers.all).toHaveLength(armed);
    });

    it("is cleared when a connection is accepted, and armed again when the last connection drops", async () => {
      const { session } = await open();
      const idle = pendingDue(IDLE_DUE);
      const first = await connect(session, await token(session, "connect"));
      const second = await connect(session, await token(session, "connect"));
      expect(idle.cleared).toBe(true);
      expect(idleTimers()).toEqual([]);

      h.clock.now = NOW_MS + 4_000;
      await drop(first.socket!, h.attached[0]!);
      expect(idleTimers()).toEqual([]); // one connection is left
      await drop(second.socket!, h.attached[1]!);

      expect(idleTimers().map((timer) => timer.dueMs)).toEqual([NOW_MS + 4_000 + IDLE_MS]);
    });

    it("closes an idle session with a Standard close and ends it with the reason idle", async () => {
      const { session } = await open();

      h.timers.fire(pendingDue(IDLE_DUE));

      await expect.poll(() => h.calls.teardown).toEqual(["idle"]);
      const [close, ...others] = closes();
      expect(others).toEqual([]);
      expect(closeKindOf(close!)).toBe(CloseKind.Standard);
      expect(close!.accepted.extra).toMatchObject({ action: "close", session });
      expect([...inspectTransaction(readElapsedPayload(close!)!.transaction)!.signed]).toEqual([h.authorizer.address]);
      expect(h.timers.pending).toEqual([]);
      expect((await connect(session, await token(session, "connect"))).status).toBe(404);
    });

    it("leaves the session as it is when the idle close fails", async () => {
      const { session } = await open();
      h.fail.settleClose = true;

      h.timers.fire(pendingDue(IDLE_DUE));

      await expect.poll(() => h.logs.some((entry) => entry.event === "error")).toBe(true);
      expect(h.calls.teardown).toEqual([]);
      expect(idleTimers()).toEqual([]);
      h.fail.settleClose = false;
      expect((await closeWith(session)).status).toBe(200); // the session is still tracked, and the failed close left nothing stuck
      expect(h.calls.teardown).toEqual(["closed"]);
    });

    it("shares one close with the buyer's request", async () => {
      const { session } = await open();
      const release = holdClose();

      h.timers.fire(pendingDue(IDLE_DUE));
      await expect.poll(() => closes()).toHaveLength(1);
      const buyer = closeWith(session);
      await settleDown();
      release();

      expect((await buyer).status).toBe(200);
      expect(closes()).toHaveLength(1);
      expect(h.calls.teardown).toEqual(["idle"]);
    });

    it("is cleared when the gate stops, and no connection that drops afterwards arms it again", async () => {
      await open(); // never connected: its idle timer is waiting
      expect(idleTimers()).toHaveLength(1);
      const { session } = await open();
      await connect(session, await token(session, "connect")); // connected: its idle timer is cleared

      await h.gate.close();

      expect(h.timers.pending).toEqual([]);
    });
  });
});

describe("a gate with no timings configured", () => {
  let d: Harness;
  const { open } = helpers(() => d);

  beforeEach(async () => {
    d = await startHarness({ idleCloseSeconds: undefined, endRetrySeconds: undefined });
  });

  afterEach(async () => {
    await d.gate.close();
    d.server.closeAllConnections();
    await new Promise((resolve) => d.server.close(resolve));
  });

  it("gives a session 60 seconds to connect", async () => {
    await open();
    expect(d.timers.pending.map((timer) => timer.delayMs)).toContain(60_000);
  });
});
```

- [ ] **Step 9: Run them to see them fail**

Run: `pnpm exec vitest run packages/gate/test/lifecycle.test.ts`
Expected: FAIL: all 7 tests. The gate arms no timer yet, so the checks on `h.timers` fail, for example
`expected [] to include 10000` and `expected [] to have a length of 1`.

- [ ] **Step 10: Update the comments of `idleCloseSeconds` and `closeOnOutage`**

In `packages/gate/src/types.ts`, replace:

```ts
  /** Default 60 (spec §7.5). Announced in offers; not yet enforced by the gate. */
  readonly idleCloseSeconds?: number;
  /** Default true (spec §7.5). Announced in offers; not yet enforced by the gate. */
  readonly closeOnOutage?: boolean;
```

with:

```ts
  /**
   * Seconds a session may go without a connection, from its open or from the drop of its last connection,
   * before the gate closes it. Default 60 (spec §7.5); a value that is not a finite number gives 60, and a negative
   * one gives 0. Announced in offers.
   */
  readonly idleCloseSeconds?: number;
  /** Default true (spec §7.5). Announced in offers. The gate does not act on it: no close follows a failure of the resource. */
  readonly closeOnOutage?: boolean;
```

- [ ] **Step 11: Implement the idle timer and the shared close in `gate.ts`**

In `packages/gate/src/gate.ts`, make these edits, each replacing the old text (copied from the file as it is
now) with the new text.

1. The imports. Replace the two lines that open the import from `@lxfoundry/stint-program-client`:

```ts
import {
  STINT_PROGRAM_ADDRESS,
```

with:

```ts
import {
  CloseKind,
  STINT_PROGRAM_ADDRESS,
```

and replace the line `import type { EndReason, GateConfig, SessionInfo } from "./types.js";` with:

```ts
import { CLOSE_CODES, type EndReason, type GateConfig, type SessionInfo, type Timers } from "./types.js";
```

2. The `Gate` interface. Replace the comment `/** Drops every connection. */` above `close(): Promise<void>;` with:

```ts
  /** Stops the gate's timers and drops every connection. It does not end the sessions: nothing is closed on chain. */
```

3. The tracked session, and what a close is for. Replace:

```ts
interface Tracked<U> {
  readonly info: SessionInfo;
  readonly stored: Session;
  readonly upstream: U;
  readonly connections: Set<WebSocket>;
  /** The close in flight, or finished with the session ended: concurrent closes share it. */
  closing?: Promise<CloseOutcome>;
  ended: boolean;
}

interface CloseOutcome {
  readonly status: number;
  readonly body: unknown;
  /** True once the session is over; false when the buyer may retry. */
  readonly ended: boolean;
}
```

with:

```ts
/** The two timers of a session: no connection within the grace period, and the end of the paid time. */
type TimerSlot = "idle" | "end";

interface Tracked<U> {
  readonly info: SessionInfo;
  readonly stored: Session;
  readonly upstream: U;
  readonly connections: Set<WebSocket>;
  /** The close in flight, or finished with the session ended: every close of the session shares it. */
  closing?: Promise<CloseOutcome>;
  ended: boolean;
  /** Cancels each pending timer. */
  readonly pending: Partial<Record<TimerSlot, () => void>>;
}

interface CloseOutcome {
  readonly status: number;
  readonly body: unknown;
  /** True once the session is over; false when the buyer, or a timer, may retry. */
  readonly ended: boolean;
}

/** What a close is for: its kind on chain, why the session ends once it is confirmed, and the code its connections get. */
interface ClosePlan {
  readonly kind: CloseKind;
  readonly reason: EndReason;
  readonly code: number;
}

/** The buyer's request. */
const BUYER_CLOSE: ClosePlan = { kind: CloseKind.Standard, reason: "closed", code: CLOSE_CODES.SESSION_CLOSED };
/** No connection came back within `idleCloseSeconds`. */
const IDLE_CLOSE: ClosePlan = { kind: CloseKind.Standard, reason: "idle", code: CLOSE_CODES.SESSION_CLOSED };
```

4. The default timers. After the line `const TOKEN_SKEW_MS = 30_000;` add:

```ts
/** The longest delay `setTimeout` takes: a longer one fires at once. */
const MAX_TIMER_MS = 2_147_483_647;

const systemTimers: Timers = {
  // Unreferenced, so a session that is still waiting does not keep a stopped host alive.
  set: (callback, delayMs) => setTimeout(callback, delayMs).unref(),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
```

5. The configuration the timers read. After the line `  const log = config.log ?? (() => {});` add:

```ts
  const logError = (error: unknown) => log({ event: "error", error: error instanceof Error ? error.message : String(error) });
```

After the line `  const readRetry = config.readRetry ?? { attempts: 5, delayMs: 200 };` add:

```ts
  const timers = config.timers ?? systemTimers;
  const idleCloseSeconds = Math.max(0, Number.isFinite(config.idleCloseSeconds) ? (config.idleCloseSeconds as number) : 60);
  /** Set when the gate stops: from then on no timer is armed. */
  let stopped = false;
```

In `offerBase`, replace the line `      idleCloseSeconds: config.idleCloseSeconds ?? 60,` with `      idleCloseSeconds,`.

6. The timers, and `provision`. Replace the whole function:

```ts
  async function provision(session: Address, stored: Session): Promise<Tracked<U>> {
    const info: SessionInfo = { session, authority: stored.authority, paidUntil: paidUntil(stored) };
    const resource = await config.adapter.provision(info);
    const tracked: Tracked<U> = { info, stored, upstream: resource, connections: new Set(), ended: false };
    sessions.set(session, tracked);
    return tracked;
  }
```

with:

```ts
  /**
   * Runs `run` once the session clock reaches `targetMs`: the timer is set for `max(0, targetMs - sessionClock())`.
   * A slot holds one timer, and arming it again replaces the old one. A timer that fires before its target (the
   * delay is capped, and a timer can fire a moment early) sets itself again for what is left.
   */
  function arm(tracked: Tracked<U>, slot: TimerSlot, targetMs: number, run: (tracked: Tracked<U>) => Promise<void>): void {
    disarm(tracked, slot);
    if (stopped || tracked.ended) return;
    const delayMs = Math.min(Math.max(0, targetMs - sessionClock()), MAX_TIMER_MS);
    const handle = timers.set(() => {
      tracked.pending[slot] = undefined;
      if (stopped || tracked.ended) return;
      if (sessionClock() < targetMs) return arm(tracked, slot, targetMs, run);
      run(tracked).catch(logError);
    }, delayMs);
    tracked.pending[slot] = () => timers.clear(handle);
  }

  function disarm(tracked: Tracked<U>, slot: TimerSlot): void {
    tracked.pending[slot]?.();
    tracked.pending[slot] = undefined;
  }

  /** The session has `idleCloseSeconds`, from now, to get a connection. */
  function armIdle(tracked: Tracked<U>): void {
    arm(tracked, "idle", sessionClock() + idleCloseSeconds * 1000, idleClose);
  }

  /** The idle timer fired (spec §7.3): close the session. A close that fails leaves it to run to the end of its paid time. */
  async function idleClose(tracked: Tracked<U>): Promise<void> {
    try {
      await (tracked.closing ??= startClose(tracked, IDLE_CLOSE));
    } catch (error) {
      logError(error);
    }
  }

  async function provision(session: Address, stored: Session): Promise<Tracked<U>> {
    const info: SessionInfo = { session, authority: stored.authority, paidUntil: paidUntil(stored) };
    const resource = await config.adapter.provision(info);
    const tracked: Tracked<U> = { info, stored, upstream: resource, connections: new Set(), ended: false, pending: {} };
    sessions.set(session, tracked);
    armIdle(tracked);
    return tracked;
  }
```

7. `end` clears both timers. In `end`, after the line `    tracked.ended = true;` add:

```ts
    disarm(tracked, "idle");
    disarm(tracked, "end");
```

8. The close path takes a plan. Make these replacements:
   - In `closeSession`, `startClose(tracked)` becomes `startClose(tracked, BUYER_CLOSE)`.
   - `function startClose(tracked: Tracked<U>): Promise<CloseOutcome> {` becomes `function startClose(tracked: Tracked<U>, plan: ClosePlan): Promise<CloseOutcome> {`.
   - `const run = performClose(tracked);` becomes `const run = performClose(tracked, plan);`, and the comment under it becomes
     `// A failed close leaves the session open, and the buyer, or a timer, may try again.`
   - `async function performClose(tracked: Tracked<U>): Promise<CloseOutcome> {` becomes
     `async function performClose(tracked: Tracked<U>, plan: ClosePlan): Promise<CloseOutcome> {`.
   - `await end(tracked, "closed", 4410);` becomes `await end(tracked, plan.reason, plan.code);`.
   - In `performClose`, the call that builds the close transaction gains one line. Replace:

```ts
    const transaction = await buildCloseTransaction({
      session,
      stored: tracked.stored,
      closer: config.receiverAuthorizer,
      feePayer: address(base.facilitator.feePayer),
      lifetime: base.lifetime,
    });
```

with:

```ts
    const transaction = await buildCloseTransaction({
      session,
      stored: tracked.stored,
      closer: config.receiverAuthorizer,
      feePayer: address(base.facilitator.feePayer),
      lifetime: base.lifetime,
      kind: plan.kind,
    });
```

The rest of `performClose` is untouched, and `CloseOutcome` stays HTTP-shaped.

9. Connections clear and arm the idle timer. Replace:

```ts
    wss.handleUpgrade(request, socket, head, (ws) => {
      tracked.connections.add(ws);
      ws.once("close", () => tracked.connections.delete(ws));
```

with:

```ts
    wss.handleUpgrade(request, socket, head, (ws) => {
      tracked.connections.add(ws);
      disarm(tracked, "idle");
      ws.once("close", () => {
        tracked.connections.delete(ws);
        if (tracked.connections.size === 0) armIdle(tracked);
      });
```

10. Stopping the gate clears the timers, and arms no more. Replace:

```ts
    async close() {
      for (const tracked of sessions.values()) for (const socket of tracked.connections) socket.close(1001, "gate stopping");
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
```

with:

```ts
    async close() {
      stopped = true;
      for (const tracked of sessions.values()) {
        disarm(tracked, "idle");
        disarm(tracked, "end");
        for (const socket of tracked.connections) socket.close(1001, "gate stopping");
      }
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
```

- [ ] **Step 12: Run the tests**

Run: `pnpm exec vitest run packages/gate/test/lifecycle.test.ts`
Expected: PASS: 7 tests.

Run: `pnpm --filter @lxfoundry/stint-gate test`
Expected: PASS: 41 tests (7 lifecycle, 27 `gate.test.ts`, 7 `chain.test.ts`). The buyer's close test still
expects `["closed"]` and 4410: the buyer's plan keeps both.

Run: `pnpm --filter @lxfoundry/stint-gate typecheck`
Expected: no output, exit code 0.

- [ ] **Step 13: Commit**

```bash
git add packages/gate/src packages/gate/test/lifecycle.test.ts
git commit -m "Close a session in the gate when no connection comes back within idleCloseSeconds"
```

- [ ] **Step 14: Write the failing tests of the end timer**

In `packages/gate/test/lifecycle.test.ts`:

1. Below `const IDLE_DUE = NOW_MS + IDLE_MS;`, add:

```ts
/** What a deposit of 30,000 at 1,000 per second lasts, in the harness's sessions. */
const PAID_MS = 30_000;
const END_DUE = NOW_MS + PAID_MS;
```

2. Inside `describe("the gate's lifecycle", ...)`, after the helper `holdClose` and before `describe("the idle timer", ...)`, add the fixture:

```ts
  /** An open session with one connection: `frames` collects what the buyer's socket receives, `closed` resolves with its close code. */
  async function openConnected() {
    const { session, payload } = await prepareOpen();
    await send(payload);
    const { socket } = await connect(session, await token(session, "connect"));
    const frames: string[] = [];
    socket!.on("message", (data) => frames.push(String(data)));
    const closed = new Promise<number>((resolve) => socket!.once("close", (code) => resolve(code)));
    return { session, payload, socket: socket!, server: h.attached.at(-1)!, frames, closed };
  }
```

3. Inside the same `describe`, after the `describe("the idle timer", ...)` block, add:

```ts
  describe("the end timer", () => {
    it.each([
      { offset: 0, delays: [10_000, 30_000] },
      { offset: 5_000, delays: [10_000, 25_000] },
      { offset: 40_000, delays: [0, 10_000] },
    ])("is set for the time left on the session clock when the open settles $offset ms into the session", async ({ offset, delays }) => {
      h.clock.now = NOW_MS + offset;

      await open();

      expect(h.timers.pending.map((timer) => timer.delayMs).sort((a, b) => a - b)).toEqual(delays);
    });

    it("stops forwarding when it fires: a frame the adapter sends afterwards does not reach the buyer", async () => {
      const { server, frames, closed } = await openConnected();
      server.send("tick:before");
      await expect.poll(() => frames).toContain("tick:before");
      const release = holdClose();

      h.timers.fire(pendingDue(END_DUE));
      await expect.poll(() => closes()).toHaveLength(1); // the close is waiting at the facilitator: forwarding has stopped
      server.send("tick:after");
      release();

      expect(await closed).toBe(4402);
      expect(frames.filter((frame) => frame.startsWith("tick:"))).toEqual(["tick:before"]);
    });

    it("settles an AtExpiry close, then drops the connection with 4402 and tears down once with the reason expired", async () => {
      const { session, closed } = await openConnected();

      h.timers.fire(pendingDue(END_DUE));

      expect(await closed).toBe(4402);
      expect(h.calls.teardown).toEqual(["expired"]);
      const [close, ...others] = closes();
      expect(others).toEqual([]);
      expect(closeKindOf(close!)).toBe(CloseKind.AtExpiry);
      expect(close!.accepted.extra).toMatchObject({ action: "close", session });
      expect([...inspectTransaction(readElapsedPayload(close!)!.transaction)!.signed]).toEqual([h.authorizer.address]);
      expect(h.timers.pending).toEqual([]);
    });

    it("refuses a connection once it has fired: 402 while the close is in flight, 404 when the session is gone", async () => {
      const { session, closed } = await openConnected();
      const release = holdClose();

      h.timers.fire(pendingDue(END_DUE));
      await expect.poll(() => closes()).toHaveLength(1);
      expect((await connect(session, await token(session, "connect"))).status).toBe(402);
      release();

      expect(await closed).toBe(4402);
      expect((await connect(session, await token(session, "connect"))).status).toBe(404);
    });

    it("shares one close with a buyer's request that arrives while it is in flight", async () => {
      const { session, closed } = await openConnected();
      const release = holdClose();

      h.timers.fire(pendingDue(END_DUE));
      await expect.poll(() => closes()).toHaveLength(1);
      const buyer = closeWith(session);
      await settleDown();
      release();

      expect((await buyer).status).toBe(200);
      expect(await closed).toBe(4402);
      expect(closes()).toHaveLength(1);
      expect(h.calls.teardown).toEqual(["expired"]);
    });

    it("joins a close already in flight instead of re-reading the session first", async () => {
      const { session, closed } = await openConnected();
      const release = holdClose();
      const buyer = closeWith(session);
      await expect.poll(() => closes()).toHaveLength(1);
      const reads = h.reads.session;

      h.timers.fire(pendingDue(END_DUE));
      await settleDown();
      expect(h.reads.session).toBe(reads);
      release();

      expect((await buyer).status).toBe(200);
      expect(await closed).toBe(4410); // the buyer's close came first, so it decides how the session ends
      expect(closes()).toHaveLength(1);
      expect(h.calls.teardown).toEqual(["closed"]);
    });

    it("does not arm the idle timer when the last connection drops while forwarding is stopped", async () => {
      const { socket } = await openConnected();
      const release = holdClose();

      h.timers.fire(pendingDue(END_DUE));
      await expect.poll(() => closes()).toHaveLength(1);
      await drop(socket, h.attached[0]!);
      expect(idleTimers()).toEqual([]);
      release();

      await expect.poll(() => h.calls.teardown).toEqual(["expired"]);
    });

    it("ends the session with 4402, with no close, when the account is already gone, after a single read", async () => {
      const { session, closed } = await openConnected();
      h.sessions.delete(session);
      const reads = h.reads.session;

      h.timers.fire(pendingDue(END_DUE));

      expect(await closed).toBe(4402);
      expect(h.reads.session - reads).toBe(1); // the harness's readRetry allows 3 reads: a gone account is not read again
      expect(h.calls.teardown).toEqual(["expired"]);
      expect(closes()).toEqual([]);
    });

    it("ends the session with 4402 when the close fails and a re-read shows the account gone", async () => {
      const { session, closed } = await openConnected();
      h.fail.settleClose = true;
      h.onSettleClose = () => void h.sessions.delete(session);

      h.timers.fire(pendingDue(END_DUE));

      expect(await closed).toBe(4402);
      expect(h.calls.teardown).toEqual(["expired"]);
      expect(closes()).toHaveLength(1);
      expect(h.timers.pending).toEqual([]);
    });

    it("resumes forwarding, answers with the new end and sets the timer again when a re-read shows a later paid_until", async () => {
      const { session, payload, server, frames } = await openConnected();
      h.sessions.set(session, { ...h.sessions.get(session)!, deposited: 60_000n }); // paid for 60 s in all

      h.timers.fire(pendingDue(END_DUE));

      await expect.poll(() => h.timers.pending.map((timer) => timer.dueMs)).toEqual([NOW_MS + 60_000]);
      expect(closes()).toEqual([]);
      server.send("tick:resumed");
      await expect.poll(() => frames).toContain("tick:resumed");
      expect((await send(payload)).body.paidUntil).toBe(NOW_MS / 1000 + 60);
      expect((await connect(session, await token(session, "connect"))).socket).toBeDefined(); // 30 s from the new end: no longer refused
    });

    it("resumes forwarding and sets the timer again when the close fails and a re-read shows a later paid_until", async () => {
      const { session, server, frames } = await openConnected();
      h.fail.settleClose = true;
      h.onSettleClose = () => void h.sessions.set(session, { ...h.sessions.get(session)!, deposited: 60_000n });

      h.timers.fire(pendingDue(END_DUE));

      await expect.poll(() => h.timers.pending.map((timer) => timer.dueMs)).toEqual([NOW_MS + 60_000]);
      expect(closes()).toHaveLength(1);
      server.send("tick:resumed");
      await expect.poll(() => frames).toContain("tick:resumed");
      expect(h.calls.teardown).toEqual([]);
    });

    it.each([
      { what: "a later start", startedAfter: 20n, rate: 1_000n, deposited: 60_000n },
      { what: "other terms", startedAfter: 0n, rate: 2_000n, deposited: 120_000n },
    ])("ends the session with 4402, and does not resume, when the re-read finds another session at the address: $what", async ({ startedAfter, rate, deposited }) => {
      const { session, closed } = await openConnected();
      const stored = h.sessions.get(session)!;
      // Closed, then opened again at the same address, and paid until later than the session the gate tracks.
      h.sessions.set(session, { ...stored, startedAt: stored.startedAt + startedAfter, rate, deposited });

      h.timers.fire(pendingDue(END_DUE));

      await expect.poll(() => h.calls.teardown).toEqual(["expired"]);
      expect(await closed).toBe(4402);
      expect(closes()).toEqual([]);
      expect(h.timers.pending).toEqual([]);
    });

    it("tries the close again after endRetrySeconds when it fails and nothing changed, and stays muted meanwhile", async () => {
      const { server, frames, closed } = await openConnected();
      h.fail.settleClose = true;

      h.timers.fire(pendingDue(END_DUE));

      await expect.poll(() => h.timers.pending.map((timer) => timer.delayMs)).toEqual([3_000]);
      expect(closes()).toHaveLength(1);
      expect(h.calls.teardown).toEqual([]);
      server.send("tick:waiting");
      h.fail.settleClose = false;
      h.timers.fire(h.timers.pending[0]!);

      expect(await closed).toBe(4402);
      expect(closes().map(closeKindOf)).toEqual([CloseKind.AtExpiry, CloseKind.AtExpiry]);
      expect(h.calls.teardown).toEqual(["expired"]);
      expect(frames.filter((frame) => frame.startsWith("tick:"))).toEqual([]);
    });

    it("sets itself again, without stopping forwarding, when it fires before paid_until on the session clock", async () => {
      const { server, frames } = await openConnected();
      const early = pendingDue(END_DUE);

      h.timers.fire(early, { advance: false });

      expect(closes()).toEqual([]);
      server.send("tick:early");
      await expect.poll(() => frames).toContain("tick:early");
      const again = pendingDue(END_DUE);
      expect(again).not.toBe(early);
      expect(again.delayMs).toBe(PAID_MS);
    });

    it("caps a long wait at the longest delay setTimeout takes, and waits out the rest", async () => {
      const longest = 2_147_483_647;
      const { session, payload } = await prepareOpen();
      h.sessions.set(session, { ...h.sessions.get(session)!, deposited: 3_000_000_000_000n }); // paid for about 95 years
      await send(payload);
      const end = h.timers.pending.find((timer) => timer.delayMs === longest)!;
      expect(end).toBeDefined();

      h.timers.fire(end);

      expect(closes()).toEqual([]);
      expect(h.timers.pending.some((timer) => timer.delayMs === longest)).toBe(true);
    });

    it("is kept when an idle close fails", async () => {
      await open();
      h.fail.settleClose = true;

      h.timers.fire(pendingDue(IDLE_DUE));

      await expect.poll(() => h.logs.some((entry) => entry.event === "error")).toBe(true);
      expect(h.timers.pending.map((timer) => timer.dueMs)).toEqual([END_DUE]);
    });

    it("is cleared with the idle timer when the buyer closes the session", async () => {
      const { session } = await open();
      expect(h.timers.pending).toHaveLength(2);

      expect((await closeWith(session)).status).toBe(200);

      expect(h.timers.pending).toEqual([]);
    });

    it("is cleared with the idle timer when the gate stops", async () => {
      await open();
      expect(h.timers.pending).toHaveLength(2);

      await h.gate.close();

      expect(h.timers.pending).toEqual([]);
    });
  });
```

4. In `describe("a gate with no timings configured", ...)`, after its one test, add:

```ts
  it("tries a failed close at the end of the paid time again after 2 seconds", async () => {
    await open();
    d.fail.settleClose = true;

    d.timers.fire(d.timers.pending.find((timer) => timer.delayMs === 30_000)!);

    await expect.poll(() => d.timers.pending.map((timer) => timer.delayMs).sort((a, b) => a - b)).toEqual([2_000, 60_000]);
  });
```

- [ ] **Step 15: Run them to see them fail**

Run: `pnpm exec vitest run packages/gate/test/lifecycle.test.ts`
Expected: FAIL: the 22 new tests (the 3 cases of the first `it.each` and the 2 of the second, 16 more in the end-timer block, and 1 in the defaults
block). The gate arms no end timer, so `pendingDue(END_DUE)` fails with `expected [] to have a length of 1`, and the
checks on two pending timers fail. The 7 idle tests still pass.

- [ ] **Step 16: Implement the end timer in `gate.ts`**

In `packages/gate/src/gate.ts`, make these edits (the old text is the file as Step 11 left it).

1. The tracked session gets the end of its paid time, and the sockets' own `send`. Replace:

```ts
  ended: boolean;
  /** Cancels each pending timer. */
  readonly pending: Partial<Record<TimerSlot, () => void>>;
}
```

with:

```ts
  ended: boolean;
  /** Unix seconds. Starts as `info.paidUntil`; a re-read at the end of the paid time can move it later. */
  paidUntil: bigint;
  /** Cancels each pending timer. */
  readonly pending: Partial<Record<TimerSlot, () => void>>;
  /** While forwarding is stopped: each socket's own `send`, which `resume` puts back. */
  muted?: Map<WebSocket, WebSocket["send"]>;
}
```

2. The close at the end of the paid time. After the line:

```ts
const IDLE_CLOSE: ClosePlan = { kind: CloseKind.Standard, reason: "idle", code: CLOSE_CODES.SESSION_CLOSED };
```

add:

```ts
/** The paid time ran out. */
const END_CLOSE: ClosePlan = { kind: CloseKind.AtExpiry, reason: "expired", code: CLOSE_CODES.PAID_TIME_ENDED };
```

3. What a muted socket's `send` does. After the last two lines of `systemTimers`:

```ts
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
```

add:

```ts

/** Stands in for a muted socket's `send`: the frame is dropped, and a send callback still runs, so an adapter waiting on it is not stuck. */
function discard(...args: unknown[]): void {
  const done = args.at(-1);
  if (typeof done === "function") done();
}
```

4. The retry wait. After the line `  const idleCloseSeconds = Math.max(0, Number.isFinite(config.idleCloseSeconds) ? (config.idleCloseSeconds as number) : 60);` add:

```ts
  // At least a second, and the default for a value that is not a number: each retry is a round trip to the
  // facilitator, so a wait of 0 (or NaN, which `Math.max` passes through) would loop hot.
  const endRetrySeconds = config.endRetrySeconds ?? 2;
  const endRetryMs = (Number.isFinite(endRetrySeconds) ? Math.max(1, endRetrySeconds) : 2) * 1000;
```

5. `provision` arms the end timer. In `provision`, replace these four lines:

```ts
    const tracked: Tracked<U> = { info, stored, upstream: resource, connections: new Set(), ended: false, pending: {} };
    sessions.set(session, tracked);
    armIdle(tracked);
    return tracked;
```

with:

```ts
    const tracked: Tracked<U> = { info, stored, upstream: resource, connections: new Set(), ended: false, paidUntil: info.paidUntil, pending: {} };
    sessions.set(session, tracked);
    armIdle(tracked);
    armEnd(tracked);
    return tracked;
```

6. The end of the paid time. After the function `idleClose` (and before `provision`) add:

```ts
  /** The session ends when its paid time does. */
  function armEnd(tracked: Tracked<U>): void {
    arm(tracked, "end", Number(tracked.paidUntil) * 1000, expire);
  }

  /** Stops forwarding: each socket's `send` drops what the adapter sends. The adapter is not asked to do anything. */
  function mute(tracked: Tracked<U>): void {
    if (tracked.muted) return;
    tracked.muted = new Map();
    for (const socket of tracked.connections) {
      tracked.muted.set(socket, socket.send);
      socket.send = discard as WebSocket["send"];
    }
  }

  /** The session was paid for longer: forwarding resumes, and the end timer is set for the new end of the paid time. */
  function resume(tracked: Tracked<U>, until: bigint): void {
    if (tracked.muted) for (const [socket, send] of tracked.muted) socket.send = send;
    tracked.muted = undefined;
    tracked.paidUntil = until;
    armEnd(tracked);
    // The last connection may have dropped while forwarding was stopped, and a drop then does not arm the idle timer.
    if (tracked.connections.size === 0 && !tracked.pending.idle) armIdle(tracked);
  }

  /**
   * The end timer fired (spec §7.3): forwarding stops, and the session is closed at the end of its paid time. A session
   * that is gone, whose account now holds another session, or that was paid for longer, needs no close. A close that
   * fails while the session is unchanged is tried again after `endRetrySeconds`, until the session ends or the gate
   * stops.
   */
  async function expire(tracked: Tracked<U>): Promise<void> {
    mute(tracked);
    if (await attempt(tracked)) return;
    arm(tracked, "end", sessionClock() + endRetryMs, expire);
  }

  /**
   * One pass at the end of the paid time. True when nothing is left to do: the session has ended, or it runs on. A close
   * already in flight (the buyer's, or the idle timer's) is joined without a re-read first: the re-read could race it,
   * find the account gone because that very close landed, and end the session with the wrong reason and code.
   */
  async function attempt(tracked: Tracked<U>): Promise<boolean> {
    if (!tracked.closing && (await settledByChain(tracked))) return true;
    try {
      const outcome = await (tracked.closing ??= startClose(tracked, END_CLOSE));
      if (outcome.ended) return true;
    } catch (error) {
      logError(error);
    }
    // The close failed. The chain may have changed under it: a top-up landed, or another party closed the session.
    return settledByChain(tracked);
  }

  /**
   * Re-reads the session at `confirmed`, once. True when that settles the matter: the session ended meanwhile; or its
   * account is gone or holds another session, so it ends here with 4402; or `paid_until` moved later on the same
   * session, so it runs on. A read that fails settles nothing.
   *
   * One read, not `readRetry`'s several: the account was read when the open settled, so finding nothing now means it has
   * closed, not that the RPC has yet to see it. An account at the address that started at another moment, or on other
   * terms, is another session opened there after a close (spec §4.1): the one tracked here is gone, and its connections
   * are not served on the newcomer's account.
   */
  async function settledByChain(tracked: Tracked<U>): Promise<boolean> {
    try {
      const stored = await upstream(() => config.chain.readSession(tracked.info.session));
      if (tracked.ended) return true;
      if (!stored || stored.startedAt !== tracked.stored.startedAt || !sessionMatches(stored, seller)) {
        await end(tracked, "expired", CLOSE_CODES.PAID_TIME_ENDED);
        return true;
      }
      const until = paidUntil(stored);
      if (until <= tracked.paidUntil) return false;
      resume(tracked, until);
      return true;
    } catch (error) {
      logError(error);
      return false;
    }
  }
```

7. The answer to an open, and the margin of a connect, use the moving end. In `open`, replace
`paidUntil: Number(tracked.info.paidUntil)` with `paidUntil: Number(tracked.paidUntil)`. In `connect`, replace
`Number(tracked.info.paidUntil) * 1000 - sessionClock() <= marginMs` with
`Number(tracked.paidUntil) * 1000 - sessionClock() <= marginMs`.

8. No idle timer is armed while forwarding is stopped. In the connection's close handler in `connect` (added in
Step 11), replace the line:

```ts
        if (tracked.connections.size === 0) armIdle(tracked);
```

with:

```ts
        if (tracked.connections.size === 0 && !tracked.muted) armIdle(tracked);
```

The session is about to be closed or to resume; `resume` arms the idle timer then, if no connection is left.

9. The adapter is told what muting covers. In `packages/gate/src/types.ts`, replace the comment above
`ResourceAdapter`:

```ts
/** Spec §7.6. `provision` once when the open settles, `attach` per connection, `teardown` once. */
```

with:

```ts
/**
 * Spec §7.6. `provision` once when the open settles, `attach` per connection, `teardown` once. At the end of the paid
 * time the gate stops forwarding by replacing each socket's `send`: only sends made through `socket.send` at send
 * time are dropped, so an adapter that captured the method earlier is not muted.
 */
```

`end()`, `closeSession`, `performClose` and `Gate.close()` need no further change: `end` and `Gate.close()` already
clear the `"end"` slot, and the buyer's close and the end close share `tracked.closing`.

- [ ] **Step 17: Run the tests**

Run: `pnpm exec vitest run packages/gate/test/lifecycle.test.ts`
Expected: PASS: 29 tests (7 of Step 8, 22 new).

Run: `pnpm --filter @lxfoundry/stint-gate test`
Expected: PASS: 63 tests (29 lifecycle, 27 `gate.test.ts`, 7 `chain.test.ts`).

Run: `pnpm --filter @lxfoundry/stint-gate typecheck`
Expected: no output, exit code 0.

- [ ] **Step 18: Check that the client's tests need no change**

`packages/client/test/gate.ts` builds a real gate with real clocks and default timers, and its chain holds
sessions that started when the gate did. Its two timers are an idle timer of 60 s and an end timer 30 s out;
every test stops its gate (`stop()` calls `gate.close()`, which clears both); vitest's default test timeout
(5 s) is shorter than either timer; and the default timers are unreferenced. No stray close can fire, so the
file stays as it is.

Run: `pnpm --filter @lxfoundry/stint-client test`
Expected: PASS: 32 tests (13 in `tools.test.ts`, 13 in `policy.test.ts`, 6 in `client.test.ts`), the same as before
this task.

- [ ] **Step 19: Commit**

```bash
git add packages/gate/src packages/gate/test/lifecycle.test.ts
git commit -m "End a session in the gate when its paid time runs out: stop forwarding, settle an AtExpiry close, drop connections with 4402"
```

- [ ] **Step 20: Write the failing test of a `teardown` that throws**

In `packages/gate/test/lifecycle.test.ts`, inside `describe("the gate's lifecycle", ...)`, after the
`describe("the end timer", ...)` block, add:

```ts
  describe("a teardown that throws", () => {
    it("is logged, and the buyer's confirmed close is still answered 200 with its amounts", async () => {
      const { session } = await open();
      const { socket } = await connect(session, await token(session, "connect"));
      const closed = new Promise<number>((resolve) => socket!.once("close", (code) => resolve(code)));
      h.fail.teardown = true;

      const response = await closeWith(session);

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ paid: "8000", refunded: "22000", transaction: "sig" });
      expect(await closed).toBe(4410);
      expect(h.calls.teardown).toEqual(["closed"]);
      expect(h.logs).toContainEqual({ event: "error", error: "teardown broke" });
    });
  });
```

- [ ] **Step 21: Run it to see it fail**

Run: `pnpm exec vitest run packages/gate/test/lifecycle.test.ts -t "a teardown that throws"`
Expected: FAIL: `expected 500 to be 200`. A throwing `teardown` rejects `end`, which rejects `performClose`.

- [ ] **Step 22: Log a `teardown` that throws**

In `packages/gate/src/gate.ts`, replace:

```ts
    await config.adapter.teardown(tracked.info, reason);
```

with:

```ts
    try {
      await config.adapter.teardown(tracked.info, reason);
    } catch (error) {
      // The session is over on chain whatever the resource does: a confirmed close must not become a failure.
      logError(error);
    }
```

- [ ] **Step 23: Run the tests**

Run: `pnpm --filter @lxfoundry/stint-gate test`
Expected: PASS: 64 tests (30 lifecycle, 27 `gate.test.ts`, 7 `chain.test.ts`).

- [ ] **Step 24: Commit**

```bash
git add packages/gate/src/gate.ts packages/gate/test/lifecycle.test.ts
git commit -m "Log a teardown that throws instead of failing the close that ended the session"
```

- [ ] **Step 25: Check the whole workspace**

Run: `pnpm typecheck`
Expected: every package passes with no errors (`e2e`, `conformance` and `examples/solana-stream` build against
the new optional `GateConfig` fields without change).

Run: `pnpm --filter @lxfoundry/stint-gate test && pnpm --filter @lxfoundry/stint-client test`
Expected: PASS (64 gate tests and 32 client tests; the client's tests unchanged).

Run: `git status --short`
Expected: no output (everything is committed).

The suites of `e2e` and `conformance` need the local stack and run in the tasks that depend on this one.

---

### Task 4: The client treats a session that the gate ended

When the gate ends a session by itself (its paid time ran out, or it was closed for another reason), it drops the
session's WebSocket with close code 4402 or 4410 (spec §7.4). Nothing is left to close: a close request would
reach a gate that no longer tracks the session and fail with `404`. The session tools already record the close code
of each connection (`closeCode`), but nothing branches on it. This task makes the tools read it: a session whose
connection the gate closed with 4402 or 4410 is **ended**. The tools can only see the code of a connection they
opened themselves, through `stint_send`: a session that was never connected through the tools has no code and is
treated as open, as it is today, and closing it after the gate ended it still fails with `404` and is reported in
`failed`.

What changes, in `packages/client/src/tools.ts`:
- `closeAll` leaves an ended session alone: it does not send a close and does not count the session as a failure
  (it is in neither `closed` nor `failed`).
- `stint_close_session` on an ended session fails with a readable tool error that names the code:
  `The session has ended: the paid time ran out (4402)` or `The session was closed (4410)`.
- `stint_session_status` is unchanged: it keeps asking the gate, which answers from the chain.
- A connection that dropped with any other code (1001 "going away", 1006 or any other) says nothing about the
  session: it is still treated as open.
- A session whose connection was never opened through the tools has no close code and is treated as open;
  closing it after the gate ended it still fails with 404 and is reported in `failed`.
- A second `stint_close_session` after the buyer's own close has finished now fails with
  `The session was closed (4410)` instead of posting a second close and getting `Close failed (HTTP 404)`; no
  other package depends on the old behaviour. (This holds for a session the tools had connected, which is the
  only kind that has recorded the code.)
- No schema or tool description changes.

How a refusal becomes a readable tool error in this file: a tool throws a `ToolError` (the class at the top of
`tools.ts`), as it does for an unknown session or a closed one, and the host turns any thrown error into an error
result carrying its message (the MCP server does this for every tool; a policy refusal reaches it as the
`StintError` that `client.open` throws). The new refusal uses the same mechanism: it throws a `ToolError`.

Two details the code requires:
- **The buyer's own close is not a gate-ended session.** When the buyer closes a session, the gate confirms the
  close, drops the socket with 4410, and only then answers the request, so the code can arrive before the close's
  receipt. A close of the buyer's own that is in flight (`state.closing`) is therefore never refused, and
  `closeAll` still waits for it before it looks at the code.
- **`client.ts` does not change.** The session object does not see the socket the tools open through
  `session.connect()`; the close code is read where the socket is handled, in `tools.ts`.

**Files:**
- Modify: `packages/client/src/tools.ts`
- Test: `packages/client/test/tools.test.ts`

**Interfaces:**
- Consumes:
  - `createSessionTools(client: StintClient): SessionTools` and its per-session state `Live`, whose `closeCode?: number`
    is set from the socket's `close` event (existing).
  - `ToolError` (existing, exported from `src/index.ts`).
  - The test gate of `packages/client/test/gate.ts`: `startTestGate(buyer: Address, onAttach?: (socket: WebSocket) => void): Promise<TestGate>`,
    whose `payments` lists every settlement the gate sent to its facilitator (the open, and each close). The test closes the
    gate's side of the connection with `socket.close(code, reason)`, which stands for the gate ending the session.
  - Close codes 4402 (the paid time ended) and 4410 (the session was closed), as the gate sends them (Task 3 sends 4402;
    4410 is sent today). This task does not depend on Task 3's code: the tests close the connection themselves.
- Produces:
  - No new export and no signature change. `SessionTools.closeAll()` and `tools.stint_close_session.run()` behave as above.

- [ ] **Step 1: Import `ToolError` in the test file**

In `packages/client/test/tools.test.ts`. Old text:

```ts
import { createSessionTools, createStintClient, type CloseReceipt, type StintClient } from "../src/index.js";
```

New text:

```ts
import { ToolError, createSessionTools, createStintClient, type CloseReceipt, type StintClient } from "../src/index.js";
```

- [ ] **Step 2: Write the failing tests**

In `packages/client/test/tools.test.ts`, add the tests inside the `describe`, before `answers an unknown session with a readable error`.
`connected()` opens a session through the real test gate and connects it; `dropWith(code)` closes the gate's side of the
connection, as the gate does when it ends a session, and waits until the tools have seen the code.

Old text:

```ts
  it("answers an unknown session with a readable error", async () => {
```

New text:

```ts
  const ENDED: [number, string][] = [
    [4402, "The session has ended: the paid time ran out (4402)"],
    [4410, "The session was closed (4410)"],
  ];

  /** Opens a session and connects it. `dropWith` closes the connection from the gate's side, as the gate does when it ends a session. */
  async function connected() {
    const buyer = await generateKeyPairSigner();
    const attached: WebSocket[] = [];
    gate = await startTestGate(buyer.address, (socket) => {
      attached.push(socket);
    });
    const client = createStintClient({
      signer: buyer,
      policy: { maxRate: 1_000n, maxPerSession: 100_000n, budget: { amount: 100_000n, periodSeconds: 3_600 } },
    });
    const runtime = createSessionTools(client);
    const { sessionId } = await runtime.tools.stint_open_session.run({ url: gate.url, seconds: 30, reason: "test" });
    await runtime.tools.stint_send.run({ sessionId, message: "hello" });
    await expect.poll(() => attached.length).toBe(1);
    return {
      ...runtime,
      sessionId,
      /** The settlements the gate has sent to its facilitator: the open, then every close. */
      settlements: () => gate?.payments.length ?? 0,
      async dropWith(code: number) {
        attached[0]?.close(code, "test");
        await expect.poll(() => runtime.closeCode(sessionId)).toBe(code);
      },
    };
  }

  it.each(ENDED)("leaves a session the gate ended with %s alone: closeAll sends no close, and reports no failure", async (code) => {
    const session = await connected();
    const before = session.settlements();
    await session.dropWith(code);

    expect(await session.closeAll()).toEqual({ closed: [], failed: [] });

    expect(session.settlements()).toBe(before);
  });

  it.each(ENDED)("answers a close of a session the gate ended with %s by naming the code, and sends no close", async (code, text) => {
    const session = await connected();
    const before = session.settlements();
    await session.dropWith(code);

    const refused = session.tools.stint_close_session.run({ sessionId: session.sessionId });

    await expect(refused).rejects.toBeInstanceOf(ToolError);
    await expect(refused).rejects.toThrow(text);
    expect(session.settlements()).toBe(before);
  });

  it("still treats a session whose connection dropped with another code as open: closeAll closes it", async () => {
    const session = await connected();
    const before = session.settlements();
    await session.dropWith(1001);

    expect(await session.closeAll()).toEqual({ closed: [session.sessionId], failed: [] });

    expect(session.settlements()).toBe(before + 1);
  });

  it("still treats a session whose connection dropped with another code as open: stint_close_session closes it", async () => {
    const session = await connected();
    const before = session.settlements();
    await session.dropWith(1001);

    expect(await session.tools.stint_close_session.run({ sessionId: session.sessionId })).toEqual({
      paid: "8000",
      refunded: "22000",
      transaction: "sig",
    });

    expect(session.settlements()).toBe(before + 1);
  });

  it("keeps asking the gate for the status of a session it ended", async () => {
    const session = await connected();
    await session.dropWith(4402);

    const status = await session.tools.stint_session_status.run({ sessionId: session.sessionId });

    expect(status.timeLeftSeconds).toBeGreaterThan(0);
  });

  it("answers an unknown session with a readable error", async () => {
```

- [ ] **Step 3: Run them to see them fail**

Run: `pnpm --filter @lxfoundry/stint-client test tools.test.ts`
Expected: FAIL, four tests:
- the two `leaves a session the gate ended with ... alone` cases: `closeAll` closes the session (`closed` holds its address, and a settlement was sent);
- the two `answers a close of a session the gate ended with ...` cases: the close succeeds instead of being refused.

The two `another code` tests and `keeps asking the gate for the status` already pass: they pin what must not change. Every earlier test still passes.

- [ ] **Step 4: Implement it**

In `packages/client/src/tools.ts`, five edits.

1. The codes and their messages. Old text:

```ts
/** The session tools of spec §9.5, sharing one runtime. */
export function createSessionTools(client: StintClient): SessionTools {
```

New text:

```ts
/** The close codes with which a gate ends a session by itself (spec §7.4), and what a tool says about each. */
const ENDED_BY_GATE: ReadonlyMap<number, string> = new Map([
  [4402, "The session has ended: the paid time ran out (4402)"],
  [4410, "The session was closed (4410)"],
]);

/** The session tools of spec §9.5, sharing one runtime. */
export function createSessionTools(client: StintClient): SessionTools {
```

2. The reading of a session's code. Old text:

```ts
  const wake = (state: Live) => {
    for (const waiter of state.waiters) waiter();
    state.waiters.clear();
  };
```

New text:

```ts
  const wake = (state: Live) => {
    for (const waiter of state.waiters) waiter();
    state.waiters.clear();
  };
  /** What to tell about a session the gate ended, read from its connection's close code; any other code says nothing. */
  const endedByGate = (state: Live): string | undefined =>
    state.closeCode === undefined ? undefined : ENDED_BY_GATE.get(state.closeCode);
```

3. `closeAll`. Old text:

```ts
          if (state.closing) {
            await state.closing.catch(() => undefined);
            if (state.closed) return;
          }
          try {
            await closeSession(state);
```

New text:

```ts
          if (state.closing) {
            await state.closing.catch(() => undefined);
            if (state.closed) return;
          }
          // The gate ended it by itself: nothing is left to close, and the gate would answer 404. Not a failure.
          if (endedByGate(state)) return;
          try {
            await closeSession(state);
```

4. `stint_close_session`. Old text:

```ts
        async run(input) {
          const receipt = await closeSession(get(input.sessionId));
```

New text:

```ts
        async run(input) {
          const state = get(input.sessionId);
          // A close of the buyer's own in flight is answered with its receipt, even when the gate's 4410 arrives before it.
          const ended = state.closing ? undefined : endedByGate(state);
          if (ended) throw new ToolError(ended);
          const receipt = await closeSession(state);
```

5. The documentation of `closeAll` in `SessionTools`. Old text:

```ts
  /** Closes every session still open, for a runtime that is shutting down; none can be opened afterwards. A failure is reported, never thrown. */
```

New text:

```ts
  /**
   * Closes every session still open, for a runtime that is shutting down; none can be opened afterwards. A failure is reported, never thrown.
   * A session the gate has ended (its connection closed with 4402 or 4410) is left alone: it is neither closed nor failed.
   */
```

- [ ] **Step 5: Run them to see them pass**

Run: `pnpm --filter @lxfoundry/stint-client test tools.test.ts`
Expected: PASS: the existing tests and the seven new ones (two `it.each` tables of two cases each, the two `another code` tests, and the status test).

- [ ] **Step 6: Run the client's tests, the tests of the packages that use it, and the type check**

Run: `pnpm --filter @lxfoundry/stint-client test`
Expected: PASS, every file.

Run: `pnpm --filter @lxfoundry/stint-mcp test && pnpm --filter @lxfoundry/stint-example-agent test`
Expected: PASS (they use the tools through a fake and a real client; neither sees a gate-ended session).

Run: `pnpm typecheck`
Expected: exit code 0.

- [ ] **Step 7: Commit**

```bash
git add packages/client
git commit -m "Treat a session the gate ended as ended in the session tools: closeAll leaves it, and a close names the code"
```

---

### Task 5: The harness: stack control, direct on-chain sessions and the stack's timers

The scenarios that follow need three things the harness does not give them: a way to stop the gate and bring it
back on the same URL, a way to open and close a session straight on the program (no gate, no facilitator, nobody of
the stack's holding it), and a facilitator whose sweeper runs at a short interval in a test stack. This task adds
them to the conformance context (`stack`, `direct`, both optional) and to the `local` and `devnet` targets. No scenario
uses them yet.

What the code does today, as read:
- `startStream` (`examples/solana-stream/src/server.ts`) already takes `port` (0 picks a free port), and the `url` it
  returns carries the port it bound. Its `stop()` stops the gate, closes the connections, then closes the server. The
  gate can therefore come back on its old port with `startStream({ ...config, port })`; the example needs no change.
- `startServices` (`e2e/src/targets/services.ts`) starts Kora, the facilitator and the stream, and returns a constant
  `stream`. Nothing stops the gate alone, and the facilitator is started without a sweeper.
- The program's `open` stores `rent_payer` and `close` returns the session account's and the vault's rent to it. The
  scenario assertion on rent (`assertRentReturned`) reads the rent payer's balance change in the close, so the
  rent payer must not also pay the close's fee: a direct session uses a separate fee payer.
- On `devnet`, every key that holds anything derives from the seed and is in `holders`, which the clean-up empties and
  signs closes with. The funding key is not in `holders` and pays the fee of the harness's own transactions. The
  clean-up finds a session if its `authority` or its `rent_payer` is a holder.

Decisions:
- **One rent payer per run.** A direct chain has one rent payer key for all its sessions, and `createDirectChain` asks for it
  once, when the first session opens. On `local` the stack has already made it, with the fee payer, when it started (the
  chain hands out SOL at no cost). Only `devnet` draws it lazily: it takes the next key of the buyer pool, so the clean-up
  returns what it holds, and sends it SOL from the funding key. Drawing it at start-up would take a key from a pool that a
  test sizes to one buyer, and spend SOL on a run that opens no direct session.
- **The receiver authorizer is a throwaway key** (generated, its secret dropped): nothing can sign as it, so only the
  buyer, or anyone from the paid time on, can close a direct session. **The unrelated closer** (`newKey()`) is also
  generated and holds nothing; it signs a close and needs no SOL.
- **The fee payer is separate from the rent payer.** `local`: a fresh funded key. `devnet`: the funding key.
- **A remainder is optional.** `open({ buyer, seconds, remainder })` adds `remainder` base units, fewer than the rate, to the
  buyer's transfer to the vault. The program pays for `floor(deposited / rate)` seconds, so the session is paid for `seconds`
  whatever the remainder is, and a close from the paid time on pays `rate x seconds` and refunds the remainder.
- **The sweeper's interval is the target's to set.** The local stack keeps the 2 s default; the devnet target runs it every 5 s,
  to keep the sweeper's listing of the program's accounts within the public endpoint's rate limits.

**Files:**
- Modify: `conformance/src/types.ts`
- Test: `conformance/test/types.test.ts` (create)
- Modify: `e2e/src/targets/services.ts`, `e2e/src/targets/local.ts`, `e2e/src/targets/devnet.ts`
- Create: `e2e/src/targets/direct.ts`
- Test: `e2e/test/services.test.ts` (create), `e2e/test/direct-chain.test.ts` (create), `e2e/test/local-target.test.ts`,
  `e2e/test/devnet-target.test.ts`
- `conformance/test/runner.test.ts` needs no change: the new context members are optional (Step 4 shows it).

**Interfaces:**
- Consumes:
  - Task 2: `FacilitatorConfig.sweeper?: SweeperConfig` with `SweeperConfig { intervalMs?: number; scanRpcUrl?: string;
    clock?: () => number }`, on `startFacilitator` (`@lxfoundry/stint-facilitator`).
  - Task 3: nothing it changes is called here; `Gate.close()` clears the gate's timers, which a stop relies on.
  - Existing: `startStream(config: StreamConfig): Promise<RunningStream>` and `StreamConfig.port?: number`;
    `RunningFacilitator.rentPayer: Address`; `sendInstructions(rpc, feePayer, instructions, options?)`,
    `SendOptions`; `sendSol(rpc, from, to, lamports, options)` (`devnet/funds.ts`); `fundSol(network, address, sol)`,
    `newHarnessKey()`; `readUntil(options, read, done)` (`@lxfoundry/stint-conformance`); `findSessionPda`,
    `eventAccounts`, `getOpenInstruction`, `getCloseInstruction`, `fetchMaybeSession`, `paidUntil`, `CloseKind`
    (`@lxfoundry/stint-program-client`); `associatedTokenAddress`, `randomSeed`, `Terms`, `RetryOptions`
    (`@lxfoundry/stint-x402`).
- Produces:
  - `@lxfoundry/stint-conformance`, in `conformance/src/types.ts` (the index already re-exports the file):
    ```ts
    export interface StackControl {
      readonly rentPayer: Address;
      stopGate(): Promise<void>;
      startGate(): Promise<void>;
    }
    export interface DirectSession {
      readonly session: Address;
      readonly vault: Address;
      readonly rentPayer: Address;
      readonly receiverToken: Address;
      readonly refundTo: Address;
      readonly deposit: bigint;
      readonly startedAt: bigint;
      readonly paidUntil: bigint;
    }
    export interface DirectChain {
      open(options: { readonly buyer: Buyer; readonly seconds: number; readonly remainder?: bigint }): Promise<DirectSession>;
      close(session: DirectSession, closer: KeyPairSigner): Promise<string>;
      newKey(): Promise<KeyPairSigner>;
    }
    // DirectSession.deposit is the whole deposit: rate x seconds + remainder (the session account's `deposited`).
    // ScenarioContext gains: readonly stack?: StackControl; readonly direct?: DirectChain;
    ```
  - `e2e/src/targets/services.ts`: `ServicesOptions.sweeperIntervalMs?: number` (default `TEST_SWEEPER_INTERVAL_MS` =
    2_000) and `ServicesOptions.scanRpcUrl?: string`; `Services.stopGate(): Promise<void>` and
    `Services.startGate(): Promise<void>` (both safe to repeat; `startGate` does nothing once `stop()` has been called);
    `Services.stream` is a getter for the current stream;
    `Services.stop()` stops whatever is current and may be called twice.
  - `e2e/src/targets/direct.ts`: `createDirectChain(options: DirectChainOptions): DirectChain`.
  - `local` and `devnet` contexts set `stack` and `direct` (one of each per stack, shared by every context it makes).

---

#### Commit 1: the context's types, and the services' control of the gate and the sweeper

- [ ] **Step 1: Write the failing type test**

Create `conformance/test/types.test.ts`:

```ts
import type { Address, KeyPairSigner } from "@solana/kit";
import { describe, expectTypeOf, it } from "vitest";
import type { DirectChain, DirectSession, ScenarioContext, StackControl } from "../src/index.js";

describe("the scenario context's members for stack control and direct sessions", () => {
  it("are optional, and exported with the other types", () => {
    expectTypeOf<ScenarioContext["stack"]>().toEqualTypeOf<StackControl | undefined>();
    expectTypeOf<ScenarioContext["direct"]>().toEqualTypeOf<DirectChain | undefined>();
  });

  it("describe the gate's control and a session opened straight on the program", () => {
    expectTypeOf<StackControl["rentPayer"]>().toEqualTypeOf<Address>();
    expectTypeOf<ReturnType<StackControl["stopGate"]>>().toEqualTypeOf<Promise<void>>();
    expectTypeOf<ReturnType<StackControl["startGate"]>>().toEqualTypeOf<Promise<void>>();
    expectTypeOf<Awaited<ReturnType<DirectChain["open"]>>>().toEqualTypeOf<DirectSession>();
    expectTypeOf<Parameters<DirectChain["close"]>>().toEqualTypeOf<[session: DirectSession, closer: KeyPairSigner]>();
    expectTypeOf<ReturnType<DirectChain["close"]>>().toEqualTypeOf<Promise<string>>();
    expectTypeOf<Awaited<ReturnType<DirectChain["newKey"]>>>().toEqualTypeOf<KeyPairSigner>();
    expectTypeOf<DirectSession["deposit"]>().toEqualTypeOf<bigint>();
    expectTypeOf<Parameters<DirectChain["open"]>[0]["remainder"]>().toEqualTypeOf<bigint | undefined>();
    expectTypeOf<Parameters<DirectChain["open"]>[0]["seconds"]>().toEqualTypeOf<number>();
  });
});
```

- [ ] **Step 2: Run the typecheck to verify it fails**

Run: `pnpm --filter @lxfoundry/stint-conformance typecheck`
Expected: FAIL with `has no exported member 'DirectChain'` (and the same for `DirectSession` and `StackControl`).
The test itself passes at run time: its assertions are about types, so the typecheck is the check.

- [ ] **Step 3: Add the interfaces to the context's types**

In `conformance/src/types.ts`, replace

```ts
/** What a scenario receives when it runs. */
export interface ScenarioContext {
```

with

```ts
/** What a scenario may do to the services that the target runs (spec §12.2). */
export interface StackControl {
  /** The facilitator's rent payer: its sweeper signs closes as this key, and a session that names it as rent payer is the sweeper's. */
  readonly rentPayer: Address;
  /** Stops the gate and its connections. The facilitator, its sweeper and Kora keep running. */
  stopGate(): Promise<void>;
  /** Starts the gate again on the port it had, so that `gateUrl` stays valid. The new gate has no memory of earlier sessions. */
  startGate(): Promise<void>;
}

/** A session opened straight on the program, with no gate and no facilitator: nothing of the stack holds it. */
export interface DirectSession {
  readonly session: Address;
  readonly vault: Address;
  /** A harness key that is not the facilitator's: the rent of the session account and its vault returns to it at the close. */
  readonly rentPayer: Address;
  /** The seller's token account, which a close pays. */
  readonly receiverToken: Address;
  /** The buyer's USDC account, which a close refunds. */
  readonly refundTo: Address;
  /** The whole deposit, the remainder included: the session account's `deposited`. */
  readonly deposit: bigint;
  /** The chain's clock when the session opened, in seconds. */
  readonly startedAt: bigint;
  /** On the chain's clock, in seconds. */
  readonly paidUntil: bigint;
}

/** Opens and closes sessions straight on the program (spec §12.2). */
export interface DirectChain {
  /**
   * Opens a session: the buyer funds the vault, and the rent payer and the receiver authorizer are harness keys, not the
   * stack's. `seconds` is a whole number between the offer's minimum and maximum. `remainder` (default 0) is a number of base
   * units, below the rate, that the buyer adds to the vault: the deposit is `rate x seconds + remainder`, the session is paid
   * for `seconds`, and a close from the paid time on pays `rate x seconds` and refunds the remainder.
   */
  open(options: { readonly buyer: Buyer; readonly seconds: number; readonly remainder?: bigint }): Promise<DirectSession>;
  /**
   * A `Standard` close signed by `closer`, which may be any key and needs no SOL: a harness key pays the fee. Returns the
   * transaction's signature, and rejects if the program refuses the close.
   */
  close(session: DirectSession, closer: KeyPairSigner): Promise<string>;
  /** A new key that holds nothing. */
  newKey(): Promise<KeyPairSigner>;
}

/** What a scenario receives when it runs. */
export interface ScenarioContext {
```

and replace

```ts
  readonly readRetry: RetryOptions;
}

export interface Scenario {
```

with

```ts
  readonly readRetry: RetryOptions;
  /** Control of the gate that the target runs. Absent on a target whose services the harness does not run. */
  readonly stack?: StackControl;
  /** Sessions opened and closed straight on the program. Absent where the harness holds none of the keys to do it with. */
  readonly direct?: DirectChain;
}

export interface Scenario {
```

- [ ] **Step 4: Run the conformance checks**

Run: `pnpm --filter @lxfoundry/stint-conformance typecheck && pnpm --filter @lxfoundry/stint-conformance test`
Expected: PASS. `conformance/test/runner.test.ts` builds its `ScenarioContext` literal without the two new members and still
typechecks, so it is not edited.

- [ ] **Step 5: Write the failing test of the services' control of the gate**

Create `e2e/test/services.test.ts`:

```ts
import { createServer } from "node:net";
import { createSessionTools, createStintClient } from "@lxfoundry/stint-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newBuyer } from "../src/fixtures/buyers.js";
import { startLocalChain, type LocalChain } from "../src/targets/chain.js";
import { startServices, type Services } from "../src/targets/services.js";

describe("the services of a stack, run against the local chain", () => {
  let chain: LocalChain;
  let services: Services;
  const started: Services[] = [];

  /** The services as the targets start them, with a sweeper that runs every second. */
  async function start(): Promise<Services> {
    const running = await startServices({
      rpc: chain.network.rpc,
      rpcUrl: chain.network.rpcUrl,
      rpcWsUrl: chain.network.wsUrl,
      keys: chain.keys,
      sweeperIntervalMs: 1_000,
    });
    started.push(running);
    return running;
  }

  beforeAll(async () => {
    chain = await startLocalChain();
    services = await start();
  });

  afterAll(async () => {
    for (const running of started) await running.stop();
    chain?.stop();
  });

  const healthy = async (url: string) => (await fetch(`${url}/health`)).status === 200;
  const unreachable = (url: string) => fetch(`${url}/health`).then(() => false, () => true);

  /**
   * A whole session through the gate at `url`: the open, which the facilitator and Kora settle, and the close.
   * Returns what the close paid and refunded, together.
   */
  async function openAndClose(url: string): Promise<bigint> {
    const buyer = await newBuyer(chain.network.rpc, chain.keys.mintAuthority.signer, 1_000_000n);
    const { tools } = createSessionTools(
      createStintClient({
        signer: buyer.signer,
        policy: { maxRate: 10_000n, maxPerSession: 1_000_000n, budget: { amount: 1_000_000n, periodSeconds: 3_600 } },
      }),
    );
    const opened = await tools.stint_open_session.run({ url, seconds: 30, reason: "stack control test" });
    const { paid, refunded } = await tools.stint_close_session.run({ sessionId: opened.sessionId });
    return BigInt(paid ?? 0) + BigInt(refunded ?? 0);
  }

  it("stops the gate and starts it again on the same URL, with the facilitator and Kora as they were", async () => {
    const { kora, facilitator } = services;
    const url = services.stream.url;
    expect(await openAndClose(url)).toBe(30_000n);

    await services.stopGate();

    expect(await unreachable(url)).toBe(true);
    expect(await healthy(facilitator.url)).toBe(true);

    await services.startGate();

    expect(services.stream.url).toBe(url);
    expect(await healthy(url)).toBe(true);
    expect(services.facilitator).toBe(facilitator);
    expect(services.kora).toBe(kora);
    // The new gate settles through the same facilitator and Kora: a session opens and closes on it.
    expect(await openAndClose(url)).toBe(30_000n);
  }, 90_000);

  it("takes a second stop or a second start of the gate as it comes", async () => {
    const url = services.stream.url;

    await services.stopGate();
    await services.stopGate();
    expect(await unreachable(url)).toBe(true);

    await services.startGate();
    await services.startGate();
    expect(await healthy(url)).toBe(true);
  });

  it("starts the gate again once whatever held its port lets go of it", async () => {
    const url = services.stream.url;
    await services.stopGate();
    const holder = createServer();
    await new Promise<void>((resolve) => holder.listen(Number(new URL(url).port), "127.0.0.1", resolve));

    const starting = services.startGate();
    await new Promise((resolve) => setTimeout(resolve, 500));
    await new Promise<void>((resolve) => holder.close(() => resolve()));
    await starting;

    expect(await healthy(url)).toBe(true);
  });

  it("stops the restarted gate with the rest", async () => {
    const own = await start();
    const url = own.stream.url;
    await own.stopGate();
    await own.startGate();
    expect(await healthy(url)).toBe(true);

    await own.stop();

    expect(await unreachable(url)).toBe(true);
    expect(await unreachable(own.facilitator.url)).toBe(true);
  }, 60_000);

  it("stops with a gate that is already stopped, takes a second stop, and starts no gate after it", async () => {
    const url = services.stream.url;
    await services.stopGate();

    await services.stop();
    await services.stop();

    expect(await unreachable(url)).toBe(true);
    expect(await unreachable(services.facilitator.url)).toBe(true);
    // A scenario's clean-up can ask for the gate after the stack has stopped: a gate started now is one that nothing stops.
    await services.startGate();
    expect(await unreachable(url)).toBe(true);
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `pnpm --filter @lxfoundry/stint-e2e test services.test.ts`
Expected: FAIL in every test with `services.stopGate is not a function` (the first test has already opened a session by
then, which shows that the stack itself starts).

- [ ] **Step 7: Let the services stop and start the gate, and run the sweeper**

Requires Task 2: before it, `FacilitatorConfig` has no `sweeper` member and the typecheck fails there (the start-up
itself works, since the extra member is ignored at run time).

In `e2e/src/targets/services.ts`, make these edits.

Replace

```ts
import { startStream, type RunningStream } from "@lxfoundry/stint-example-stream";
```

with

```ts
import { startStream, type RunningStream, type StreamConfig } from "@lxfoundry/stint-example-stream";
```

Replace

```ts
export const TEST_IDLE_CLOSE_SECONDS = 10;
```

with

```ts
export const TEST_IDLE_CLOSE_SECONDS = 10;
/** How often the facilitator's sweeper runs in a test stack (spec §12.4): often enough that a session nobody closed ends within a scenario's patience. */
export const TEST_SWEEPER_INTERVAL_MS = 2_000;
/** How many times a restart of the gate tries a port that something still holds, and how long it waits between tries. */
const GATE_RESTART_ATTEMPTS = 10;
const GATE_RESTART_DELAY_MS = 200;
```

Replace

```ts
  /** How the gate and the facilitator re-read what a node does not return yet. */
  readonly readRetry?: RetryOptions;
}

export interface Services {
  readonly kora: KoraProcess;
  readonly facilitator: RunningFacilitator;
  readonly facilitatorApiKey: string;
  readonly stream: RunningStream;
  stop(): Promise<void>;
}
```

with

```ts
  /** How the gate and the facilitator re-read what a node does not return yet. */
  readonly readRetry?: RetryOptions;
  /** Milliseconds between the facilitator's sweeps. Default `TEST_SWEEPER_INTERVAL_MS`. */
  readonly sweeperIntervalMs?: number;
  /** An endpoint that lists the program's accounts for the sweeper, if `rpcUrl` refuses that (a provider's free tier may). Default `rpcUrl`. */
  readonly scanRpcUrl?: string;
}

export interface Services {
  readonly kora: KoraProcess;
  readonly facilitator: RunningFacilitator;
  readonly facilitatorApiKey: string;
  /** The gate and the example stream that are current: after `stopGate()` and `startGate()`, the new ones, at the same URL. */
  readonly stream: RunningStream;
  /** Stops the gate and its connections; the facilitator, its sweeper and Kora keep running. Safe to repeat. */
  stopGate(): Promise<void>;
  /**
   * Starts the gate again on the port it had. The new gate has no memory of earlier sessions. Safe to repeat. It does nothing
   * once `stop()` has been called: a gate started then would be one that nothing stops.
   */
  startGate(): Promise<void>;
  /** Stops everything that is running, a stopped gate included. Safe to repeat. */
  stop(): Promise<void>;
}
```

Replace

```ts
/** Kora, the facilitator, and the example stream with its gate, against the network at `rpcUrl`. */
```

with

```ts
/**
 * Starts the example stream on `port`. A gate that has just stopped may still hold its port for a moment, so a port that is
 * in use is tried again a few times.
 */
async function startStreamOn(config: StreamConfig, port: number): Promise<RunningStream> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await startStream({ ...config, port });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE" || attempt >= GATE_RESTART_ATTEMPTS) throw error;
      await new Promise((resolve) => setTimeout(resolve, GATE_RESTART_DELAY_MS));
    }
  }
}

/** Kora, the facilitator with its sweeper, and the example stream with its gate, against the network at `rpcUrl`. */
```

Replace

```ts
      apiKeys: [facilitatorApiKey],
      readRetry: options.readRetry,
    });
```

with

```ts
      apiKeys: [facilitatorApiKey],
      readRetry: options.readRetry,
      sweeper: { intervalMs: options.sweeperIntervalMs ?? TEST_SWEEPER_INTERVAL_MS, scanRpcUrl: options.scanRpcUrl },
    });
```

Replace

```ts
    const stream = await startStream({
      rpcWsUrl: options.rpcWsUrl,
      gate: {
```

with

```ts
    const streamConfig: StreamConfig = {
      rpcWsUrl: options.rpcWsUrl,
      gate: {
```

Replace

```ts
        chain: createRpcChain(options.rpc),
      },
    });
    stops.unshift(() => stream.stop());
    return { kora, facilitator, facilitatorApiKey, stream, stop: () => stopAll(stops) };
```

with

```ts
        chain: createRpcChain(options.rpc),
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
    };
    let stopped = false;
    const startGate = async (): Promise<void> => {
      if (running || stopped) return;
      latest = running = await startStreamOn(streamConfig, port);
    };
    stops.unshift(stopGate);
    let stopping: Promise<void> | undefined;
    return {
      kora,
      facilitator,
      facilitatorApiKey,
      get stream() {
        return latest;
      },
      stopGate,
      startGate,
      stop: () => ((stopped = true), (stopping ??= stopAll(stops))),
    };
```

- [ ] **Step 8: Run the services test and the typecheck**

Run: `pnpm --filter @lxfoundry/stint-e2e test services.test.ts && pnpm typecheck`
Expected: PASS (five tests).

- [ ] **Step 9: Run the local target on the changed services**

Run: `pnpm --filter @lxfoundry/stint-e2e test local-target.test.ts`
Expected: PASS: the stack starts with a sweeper and scenarios 1 and 22 pass as before.

- [ ] **Step 10: Commit**

```bash
git add conformance/src/types.ts conformance/test/types.test.ts e2e/src/targets/services.ts e2e/test/services.test.ts
git commit -m "Let the harness stop and restart the gate on its port, and start the facilitator with a sweeper"
```

---

#### Commit 2: sessions opened straight on the program

- [ ] **Step 11: Write the failing tests of the direct chain**

Create `e2e/test/direct-chain.test.ts`:

```ts
import { fetchToken } from "@solana-program/token";
import { sleep, type DirectChain } from "@lxfoundry/stint-conformance";
import { CloseKind, fetchMaybeSession, fetchSession } from "@lxfoundry/stint-program-client";
import { fetchClosedEvent, lamportBalances, tokenBalanceChanges } from "@lxfoundry/stint-x402";
import type { Address, KeyPairSigner } from "@solana/kit";
import { fetchSysvarClock } from "@solana/sysvars";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newBuyer } from "../src/fixtures/buyers.js";
import { fundSol, newHarnessKey } from "../src/fixtures/keys.js";
import { waitForNewSlot } from "../src/network/surfnet.js";
import { createDirectChain } from "../src/targets/direct.js";
import { startLocalStack, type LocalStack } from "../src/targets/local.js";
import { TEST_TERMS } from "../src/targets/services.js";

const ONE_READ = { attempts: 1, delayMs: 0 };

describe("sessions opened straight on the program, on the local stack", () => {
  let stack: LocalStack;
  let rentPayer: KeyPairSigner;
  let direct: DirectChain;

  /** A direct chain on the stack's chain and seller, with `payer` as its rent payer and a fresh funded key as its fee payer. */
  async function directChainWith(payer: KeyPairSigner): Promise<DirectChain> {
    const feePayer = await newHarnessKey();
    fundSol(stack.network, feePayer.signer.address, 5);
    await waitForNewSlot(stack.network.rpc);
    return createDirectChain({
      rpc: stack.network.rpc,
      terms: TEST_TERMS,
      seller: { wallet: stack.keys.seller.signer.address, usdcAccount: stack.keys.sellerUsdcAccount },
      feePayer: feePayer.signer,
      rentPayer: async () => payer,
      readRetry: ONE_READ,
    });
  }

  beforeAll(async () => {
    stack = await startLocalStack();
    const key = await newHarnessKey();
    fundSol(stack.network, key.signer.address, 5);
    await waitForNewSlot(stack.network.rpc);
    rentPayer = key.signer;
    direct = await directChainWith(rentPayer);
  });

  afterAll(async () => {
    await stack?.stop();
  });

  const buyerWith = (usdc: bigint) => newBuyer(stack.network.rpc, stack.keys.mintAuthority.signer, usdc);
  const balanceOf = async (account: Address) => (await stack.network.rpc.getBalance(account, { commitment: "confirmed" }).send()).value;
  const sessionExists = async (session: Address) => (await fetchMaybeSession(stack.network.rpc, session, { commitment: "confirmed" })).exists;
  const chainClockReaches = (seconds: bigint) => async () =>
    (await fetchSysvarClock(stack.network.rpc, { commitment: "confirmed" })).unixTimestamp >= seconds;

  it("opens a session whose rent payer and receiver authorizer are not the stack's, funded by the buyer", async () => {
    const buyer = await buyerWith(1_000_000n);

    const opened = await direct.open({ buyer, seconds: 30 });

    const stored = (await fetchSession(stack.network.rpc, opened.session, { commitment: "confirmed" })).data;
    expect(stored).toMatchObject({
      authority: buyer.signer.address,
      receiver: stack.keys.seller.signer.address,
      refundOwner: buyer.signer.address,
      rentPayer: rentPayer.address,
      deposited: 30_000n,
      rate: 1_000n,
      minSeconds: 5,
      maxSeconds: 120,
    });
    expect(stored.rentPayer).not.toBe(stack.facilitator.rentPayer);
    expect(stored.receiverAuthorizer).not.toBe(stack.keys.receiverAuthorizer.signer.address);
    expect(stored.receiverAuthorizer).not.toBe(stack.facilitator.rentPayer);
    expect(opened).toMatchObject({
      rentPayer: rentPayer.address,
      receiverToken: stack.keys.sellerUsdcAccount,
      refundTo: buyer.usdcAccount,
      deposit: 30_000n,
      startedAt: stored.startedAt,
      paidUntil: stored.startedAt + 30n,
    });
    expect((await fetchToken(stack.network.rpc, opened.vault, { commitment: "confirmed" })).data.amount).toBe(30_000n);
    expect((await fetchToken(stack.network.rpc, buyer.usdcAccount, { commitment: "confirmed" })).data.amount).toBe(970_000n);
  });

  it.each([4, 121, 5.5, Number.NaN])("refuses %s seconds before it sends anything: the offer sells whole seconds from 5 to 120", async (seconds) => {
    const buyer = await buyerWith(1_000_000n);

    await expect(direct.open({ buyer, seconds })).rejects.toThrow(/whole number of seconds between 5 and 120/);

    expect((await fetchToken(stack.network.rpc, buyer.usdcAccount, { commitment: "confirmed" })).data.amount).toBe(1_000_000n);
  });

  it.each([1_000n, 1_001n, -1n])("refuses a remainder of %s before it sends anything: it must be below the rate", async (remainder) => {
    const buyer = await buyerWith(1_000_000n);

    await expect(direct.open({ buyer, seconds: 5, remainder })).rejects.toThrow(/remainder.*below the rate \(1000\)/);

    expect((await fetchToken(stack.network.rpc, buyer.usdcAccount, { commitment: "confirmed" })).data.amount).toBe(1_000_000n);
  });

  it("refuses a remainder on the longest session, whose deposit could not take it", async () => {
    const buyer = await buyerWith(1_000_000n);

    await expect(direct.open({ buyer, seconds: 120, remainder: 1n })).rejects.toThrow(/longest session takes no remainder/);

    expect((await fetchToken(stack.network.rpc, buyer.usdcAccount, { commitment: "confirmed" })).data.amount).toBe(1_000_000n);
  });

  it("leaves the session to whoever closes it: refused before its paid time, and accepted from then on from a key that holds nothing", async () => {
    const buyer = await buyerWith(1_000_000n);
    const remainder = 250n;
    // 8 s and not the minimum: the refusal below must land before the paid time, whatever the machine is doing.
    const opened = await direct.open({ buyer, seconds: 8, remainder });
    // The remainder is in the vault but buys no time: the session is paid for 8 s.
    expect(opened).toMatchObject({ deposit: 8_250n, paidUntil: opened.startedAt + 8n });
    expect((await fetchSession(stack.network.rpc, opened.session, { commitment: "confirmed" })).data.deposited).toBe(8_250n);
    const stranger = await direct.newKey();
    expect(await balanceOf(stranger.address)).toBe(0n);

    await expect(direct.close(opened, stranger)).rejects.toThrow();
    expect(await sessionExists(opened.session)).toBe(true);

    await expect.poll(chainClockReaches(opened.paidUntil), { timeout: 30_000, interval: 250 }).toBe(true);
    // The stack's gate has never heard of this session, and its sweeper serves only sessions that name the facilitator's own
    // rent payer: several sweeps pass at the stack's interval, and nobody closes it.
    await sleep(4_500);
    expect(await sessionExists(opened.session)).toBe(true);

    const signature = await direct.close(opened, stranger);

    expect(await sessionExists(opened.session)).toBe(false);
    expect(await fetchClosedEvent(stack.network.rpc, signature, ONE_READ)).toMatchObject({
      kind: CloseKind.Standard,
      closedBy: stranger.address,
      owed: 8_000n,
      refunded: remainder,
    });
    // The receiver is paid rate x seconds, and the buyer gets the remainder back.
    const changes = await tokenBalanceChanges(stack.network.rpc, signature);
    expect(changes.get(opened.receiverToken)).toBe(8_000n);
    expect(changes.get(opened.refundTo)).toBe(remainder);
    const balances = await lamportBalances(stack.network.rpc, signature);
    const paying = balances.get(opened.rentPayer)!;
    const account = balances.get(opened.session)!;
    const vault = balances.get(opened.vault)!;
    expect(account.pre + vault.pre).toBeGreaterThan(0n);
    expect(account.post + vault.post).toBe(0n);
    expect(paying.post - paying.pre).toBe(account.pre + vault.pre);
    expect(await balanceOf(stranger.address)).toBe(0n);
  }, 60_000);

  it("has the stack's sweeper close a session that names the facilitator's rent payer, once its paid time has passed", async () => {
    // Scenario 26 covers the same through the gate with the gate stopped. This keeps the harness's side of it in one place:
    // the sweeper runs at the stack's interval (2 s), signing as the facilitator's rent payer, which gets the rent back.
    const swept = await directChainWith(stack.keys.rentPayer.signer);
    const buyer = await buyerWith(1_000_000n);
    const rentBefore = await balanceOf(stack.facilitator.rentPayer);

    const opened = await swept.open({ buyer, seconds: 5 });

    expect(opened.rentPayer).toBe(stack.facilitator.rentPayer);
    expect(await sessionExists(opened.session)).toBe(true);
    expect(await balanceOf(stack.facilitator.rentPayer)).toBeLessThan(rentBefore);
    await expect.poll(() => sessionExists(opened.session), { timeout: 30_000, interval: 500 }).toBe(false);
    expect(await balanceOf(stack.facilitator.rentPayer)).toBe(rentBefore);
  }, 60_000);
});
```

- [ ] **Step 12: Run it to verify it fails**

Run: `pnpm --filter @lxfoundry/stint-e2e test direct-chain.test.ts`
Expected: FAIL: `Failed to resolve import "../src/targets/direct.js"`.

- [ ] **Step 13: Write the direct chain**

Create `e2e/src/targets/direct.ts`:

```ts
import { getCreateAssociatedTokenIdempotentInstructionAsync, getTransferCheckedInstruction } from "@solana-program/token";
import { generateKeyPairSigner, type Address, type KeyPairSigner, type Rpc, type SolanaRpcApi } from "@solana/kit";
import { readUntil, type DirectChain } from "@lxfoundry/stint-conformance";
import {
  CloseKind,
  eventAccounts,
  fetchMaybeSession,
  findSessionPda,
  getCloseInstruction,
  getOpenInstruction,
  paidUntil,
} from "@lxfoundry/stint-program-client";
import { associatedTokenAddress, randomSeed, type RetryOptions, type Terms } from "@lxfoundry/stint-x402";
import { USDC_DECIMALS, USDC_DEVNET_MINT } from "../fixtures/usdc.js";
import { sendInstructions, type SendOptions } from "../network/transactions.js";

export interface DirectChainOptions {
  readonly rpc: Rpc<SolanaRpcApi>;
  /** The seller's offer: the rate every session is opened at, and the shortest and longest it may be. */
  readonly terms: Terms;
  /** The session's receiver, and the token account that a close pays. */
  readonly seller: { readonly wallet: Address; readonly usdcAccount: Address };
  /** Pays the fee of every transaction the chain sends, so that no other key's balance changes by it. */
  readonly feePayer: KeyPairSigner;
  /**
   * The key that pays the rent of every session the chain opens, and gets it back at the close. Called once, at the
   * first open: a target that makes keys when it starts returns its key, and one that draws keys as it goes draws one and
   * gives it enough SOL for a session account and its vault. It must not be the facilitator's, and it must not be the fee payer.
   */
  readonly rentPayer: () => Promise<KeyPairSigner>;
  /** How patiently the chain reads a session it has just opened. */
  readonly readRetry: RetryOptions;
  readonly send?: SendOptions;
}

interface Parties {
  readonly rentPayer: KeyPairSigner;
  readonly receiverAuthorizer: Address;
}

/**
 * Sessions opened and closed straight on the program, for the scenarios that need one that no gate, facilitator or
 * sweeper holds (spec §12.2). The open is the layout of spec §5.3 with real signers: the rent payer creates the vault,
 * the buyer funds it, and the program opens the session. The receiver authorizer is a throwaway key whose secret is
 * dropped: only the buyer can close the session before its paid time, and anyone from then on.
 */
export function createDirectChain(options: DirectChainOptions): DirectChain {
  const { rpc, terms, seller, feePayer, readRetry, send } = options;
  let parties: Promise<Parties> | undefined;
  const partiesOnce = (): Promise<Parties> =>
    (parties ??= (async () => ({
      rentPayer: await options.rentPayer(),
      receiverAuthorizer: (await generateKeyPairSigner()).address,
    }))().catch((error: unknown) => {
      parties = undefined;
      throw error;
    }));

  return {
    async open({ buyer, seconds, remainder = 0n }) {
      if (!Number.isInteger(seconds) || seconds < terms.minSeconds || seconds > terms.maxSeconds) {
        throw new Error(`A session lasts a whole number of seconds between ${terms.minSeconds} and ${terms.maxSeconds}: got ${seconds}`);
      }
      if (remainder < 0n || remainder >= terms.rate) {
        throw new Error(`A remainder is a number of base units below the rate (${terms.rate}): got ${remainder}`);
      }
      // The program refuses a deposit above the cost of the longest session.
      if (remainder > 0n && seconds === terms.maxSeconds) {
        throw new Error(`The longest session takes no remainder (${terms.maxSeconds} s is the most the offer sells): got ${remainder}`);
      }
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
    },

    async close(opened, closer) {
      return sendInstructions(
        rpc,
        feePayer,
        [
          getCloseInstruction({
            closer,
            session: opened.session,
            vault: opened.vault,
            receiverToken: opened.receiverToken,
            refundTo: opened.refundTo,
            rentPayer: opened.rentPayer,
            ...(await eventAccounts()),
            kind: CloseKind.Standard,
          }),
        ],
        send,
      );
    },

    newKey: () => generateKeyPairSigner(),
  };
}
```

- [ ] **Step 14: Run the direct chain's tests and the typecheck**

Run: `pnpm --filter @lxfoundry/stint-e2e test direct-chain.test.ts && pnpm typecheck`
Expected: PASS (eleven tests: the open, four refused lengths, three refused remainders, the longest session with a remainder, the close with its
remainder refunded, the sweeper). The close test takes about 16 s and
the sweeper test about 8 s. If the sweeper test fails with the session still open after 30 s, the facilitator's sweeper is
not running or not listing sessions: that is Task 2's behaviour, not this task's; read the facilitator's log first.

- [ ] **Step 15: Commit**

```bash
git add e2e/src/targets/direct.ts e2e/test/direct-chain.test.ts
git commit -m "Add sessions opened and closed straight on the program to the harness"
```

---

#### Commit 3: the targets give their contexts stack control and direct sessions

- [ ] **Step 16: Write the failing test of the local context**

In `e2e/test/local-target.test.ts`, replace

```ts
    expect(exitCodeFor(outcomes)).toBe(0);
  });
});
```

with

```ts
    expect(exitCodeFor(outcomes)).toBe(0);
  });

  it("gives scenarios control of the gate and sessions opened straight on the program", async () => {
    const context = stack.context();
    const url = context.gateUrl;
    expect(context.stack?.rentPayer).toBe(stack.facilitator.rentPayer);
    expect(context.stack?.rentPayer).toBe(stack.keys.rentPayer.signer.address);
    // One of each per stack: every context it makes shares them.
    expect(stack.context().stack).toBe(context.stack);
    expect(stack.context().direct).toBe(context.direct);

    await context.stack!.stopGate();
    await context.stack!.startGate();

    expect(stack.stream.url).toBe(url);
    expect((await fetch(`${url}/health`)).status).toBe(200);

    const buyer = await context.newBuyer(1_000_000n);
    const opened = await context.direct!.open({ buyer, seconds: 30 });
    expect(opened.rentPayer).not.toBe(stack.facilitator.rentPayer);
    expect(opened.receiverToken).toBe(stack.keys.sellerUsdcAccount);
    expect(opened.refundTo).toBe(buyer.usdcAccount);
  });
});
```

- [ ] **Step 17: Write the failing tests of the devnet context**

In `e2e/test/devnet-target.test.ts`, replace

```ts
import { cleanDevnet, devnetFunds, startDevnetStack, type DevnetStack, type DevnetStackOptions } from "../src/targets/devnet.js";
```

with

```ts
import { cleanDevnet, devnetFunds, startDevnetStack, type DevnetStack, type DevnetStackOptions } from "../src/targets/devnet.js";
import { createDirectChain } from "../src/targets/direct.js";
import { TEST_TERMS } from "../src/targets/services.js";
```

Replace

```ts
  it("closes a session left open at the end, returns the funds, and stops", async () => {
```

with

```ts
  it("gives its context stack control and direct sessions, paid for by a key of the buyer pool and by the funding key", async () => {
    const { seed, funding, fundingUsdc } = await fundedSeed();
    const lamportsOfFunding = async () => (await chain.network.rpc.getBalance(funding, { commitment: "confirmed" }).send()).value;
    const fundingBefore = await lamportsOfFunding();
    const running = await start(seed);
    const context = running.context();
    expect(context.stack?.rentPayer).toBe(running.services.facilitator.rentPayer);

    const buyer = await context.newBuyer(1_000_000n);
    const opened = await context.direct!.open({ buyer, seconds: 5 });

    // The rent payer is a key that the clean-up covers, and it is not the stack's.
    expect((await deriveKeys(seed)).buyers.map((key) => key.signer.address)).toContain(opened.rentPayer);
    expect(opened.rentPayer).not.toBe(running.services.facilitator.rentPayer);
    await expect
      .poll(async () => (await fetchSysvarClock(chain.network.rpc)).unixTimestamp >= opened.paidUntil, { timeout: 30_000, interval: 500 })
      .toBe(true);
    await context.direct!.close(opened, await context.direct!.newKey());
    expect(await sessionsOnChain()).toBe(0);

    await running.stop();

    // What the rent payer held went back with the rest: the funding key ends with what it lent, less fees.
    expect(await usdcOf(fundingUsdc)).toBe(FUNDING_USDC);
    expect(fundingBefore - (await lamportsOfFunding())).toBeLessThan(5_000_000n);
  }, 120_000);

  it("closes a session left open at the end, returns the funds, and stops", async () => {
```

Replace

```ts
  it("refuses a scan endpoint that is not devnet's before it cleans up anything", async () => {
```

with

```ts
  it("runs the sweeper against the scan endpoint, which lists the program's accounts where the main endpoint cannot", async () => {
    const { seed } = await fundedSeed();
    const keys = await deriveKeys(seed, 0);
    const provider = await nodeThatCannotListProgramAccounts();
    let running: DevnetStack | undefined;
    try {
      const started = await start(seed, { rpcUrl: provider.url, scanRpcUrl: chain.network.rpcUrl });
      running = started;
      const seller = keys.stack.seller.signer.address;
      // A session that names the facilitator's rent payer is the sweeper's to close. It is opened straight on the program,
      // so that no gate holds it.
      const swept = createDirectChain({
        rpc: chain.network.rpc,
        terms: TEST_TERMS,
        seller: { wallet: seller, usdcAccount: await associatedTokenAddress(seller, USDC_DEVNET_MINT) },
        feePayer: keys.funding.signer,
        rentPayer: async () => started.keys.rentPayer.signer,
        readRetry: { attempts: 1, delayMs: 0 },
        send: { pollMs: 100 },
      });
      const buyer = await started.context().newBuyer(100_000n);
      await swept.open({ buyer, seconds: 5 });
      expect(await sessionsOnChain()).toBe(1);

      // The listing through the main endpoint would fail at every sweep, and the session would stay open.
      await expect.poll(sessionsOnChain, { timeout: 40_000, interval: 1_000 }).toBe(0);
    } finally {
      await running?.stop();
      await provider.close();
    }
  }, 120_000);

  it("refuses a scan endpoint that is not devnet's before it cleans up anything", async () => {
```

- [ ] **Step 18: Bound what a run lends, and check the pool's size**

A run needs two things from the funding key, and both are bounded.

**Keys.** The scenarios of the catalogue that take pool keys on `devnet`, counted from the code (scenarios 1, 22) and bounded
for the rest: buyers: 1, 1, 3, 3, 1, 3, 1 for scenarios 1, 2, 3, 9, 16, 22, 26 (scenario 22 takes three: the agent, the
payer, the watched account; scenarios 3 and 9 are bounded by the same shape), plus one key for the rent payer of direct
sessions, drawn when the first one opens. That is 14 of the pool's 96, so `BUYER_POOL` stays as it is. The pool's size is
enforced where the keys are drawn: `takeKey` throws, naming `BUYER_POOL`, when a run uses them all (an existing test covers it).

**USDC.** The funding key lends each buyer its USDC until the clean-up at the end of the run, and a start-up only requires
`MINIMUM_FUNDS.usdc` (5,000,000 base units, 5 USDC) of it. The minimum stays. Scenario 1 lends 1,000,000 and scenario 22
lends 1,500,000 (1,000,000 to the agent and 500,000 to the payer), so the scenarios built on top of them fund their buyers with
only what a session costs: 100,000 base units each. The sum of one run's allotments must stay within the minimum. A table of
literals in a test would restate numbers that the scenarios own, and would pass whatever they ask for; the check is
instead made where the numbers are produced. The devnet context adds up what its `newBuyer` is asked to lend, and refuses
an allotment that would take the run's total above `MINIMUM_FUNDS.usdc`. A scenario that asks for too much therefore fails
at once, with a message that names the sum, wherever the scenarios run through the devnet target: on devnet, and in
`devnet-target.test.ts`, which runs scenarios through it against the local network.

In `e2e/test/devnet-target.test.ts`, replace

```ts
  it("stops handing out buyers when the pool is used", async () => {
```

with

```ts
  it("refuses a buyer whose allotment would take the run's loans above the funds a start-up requires", async () => {
    const { seed } = await fundedSeed();
    const running = await start(seed);
    const context = running.context();

    await context.newBuyer(3_000_000n);
    await context.newBuyer(2_000_000n); // 5,000,000 in all: the minimum itself is still within what the run may lend

    await expect(context.newBuyer(1n)).rejects.toThrow(/5000000/);
    await running.stop();
  }, 120_000);

  it("stops handing out buyers when the pool is used", async () => {
```

- [ ] **Step 19: Run the tests to verify the target tests fail**

Run: `pnpm --filter @lxfoundry/stint-e2e test local-target.test.ts devnet-target.test.ts`
Expected: FAIL in four tests: the local one (`context.stack` is undefined, so `rentPayer` is read as `undefined`), the
devnet one that checks the context (same cause), the devnet sweeper one (the stack's sweeper lists nothing through the
refusing endpoint, because the target does not pass its `scanRpcUrl` on: the session stays open and the poll times out)
and the allotment one (the third `newBuyer` resolves instead of rejecting).

- [ ] **Step 20: Give the local context stack control and direct sessions**

In `e2e/src/targets/local.ts`, make these edits.

Replace

```ts
import type { ScenarioContext, Target } from "@lxfoundry/stint-conformance";
```

with

```ts
import type { DirectChain, ScenarioContext, StackControl, Target } from "@lxfoundry/stint-conformance";
```

Replace

```ts
import { newBuyer } from "../fixtures/buyers.js";
```

with

```ts
import { newBuyer } from "../fixtures/buyers.js";
import { fundSol, newHarnessKey } from "../fixtures/keys.js";
```

Replace

```ts
import type { LocalNetwork } from "../network/surfnet.js";
import { startLocalChain, type CommonKeys } from "./chain.js";
import { startServices, stopAll } from "./services.js";

export type { CommonKeys } from "./chain.js";
```

with

```ts
import { waitForNewSlot, type LocalNetwork } from "../network/surfnet.js";
import { startLocalChain, type CommonKeys, type LocalChain } from "./chain.js";
import { createDirectChain } from "./direct.js";
import { TEST_TERMS, startServices, stopAll } from "./services.js";

export type { CommonKeys } from "./chain.js";

/** One attempt: the node is ours, so a read right after a write is not answered from behind (spec §12.2). */
const READ_RETRY = { attempts: 1, delayMs: 0 };

/**
 * The chain's side of sessions opened straight on the program: two fresh keys with SOL, one that pays the fees and one that
 * pays the sessions' rent. Neither is one of the stack's, so nothing of the stack touches what they open.
 */
async function directChainOf(chain: LocalChain): Promise<DirectChain> {
  const feePayer = await newHarnessKey();
  const rentPayer = await newHarnessKey();
  fundSol(chain.network, feePayer.signer.address, 10);
  fundSol(chain.network, rentPayer.signer.address, 10);
  await waitForNewSlot(chain.network.rpc);
  return createDirectChain({
    rpc: chain.network.rpc,
    terms: TEST_TERMS,
    seller: { wallet: chain.keys.seller.signer.address, usdcAccount: chain.keys.sellerUsdcAccount },
    feePayer: feePayer.signer,
    rentPayer: async () => rentPayer.signer,
    readRetry: READ_RETRY,
  });
}
```

Replace

```ts
    stops.unshift(() => services.stop());
    const target: Target = { name: "local", capabilities: new Set(["chain", "stack", "facilitatorApi"]) };
```

with

```ts
    stops.unshift(() => services.stop());
    const direct = await directChainOf(chain);
    const control: StackControl = {
      rentPayer: services.facilitator.rentPayer,
      stopGate: () => services.stopGate(),
      startGate: () => services.startGate(),
    };
    const target: Target = { name: "local", capabilities: new Set(["chain", "stack", "facilitatorApi"]) };
```

Replace

```ts
      stream: services.stream,
      context: () => ({
        target,
        gateUrl: services.stream.url,
```

with

```ts
      get stream() {
        return services.stream;
      },
      context: () => ({
        target,
        gateUrl: services.stream.url,
```

Replace

```ts
        subscriptionSettleMs: 1_500,
        readRetry: { attempts: 1, delayMs: 0 },
      }),
```

with

```ts
        subscriptionSettleMs: 1_500,
        readRetry: READ_RETRY,
        stack: control,
        direct,
      }),
```

- [ ] **Step 21: Give the devnet context stack control and direct sessions, and pass the scan endpoint to the sweeper**

In `e2e/src/targets/devnet.ts`, make these edits.

Replace

```ts
import { describeError, type ScenarioContext, type Target } from "@lxfoundry/stint-conformance";
```

with

```ts
import { describeError, type ScenarioContext, type StackControl, type Target } from "@lxfoundry/stint-conformance";
```

Replace

```ts
import { startServices, type ServiceKeys, type Services } from "./services.js";
```

with

```ts
import { createDirectChain } from "./direct.js";
import { TEST_TERMS, startServices, type ServiceKeys, type Services } from "./services.js";
```

Replace

```ts
const READ_RETRY = { attempts: 20, delayMs: 500 };
```

with

```ts
const READ_RETRY = { attempts: 20, delayMs: 500 };
/**
 * What the rent payer of sessions opened straight on the program is given: the rent of a session account and its vault, about
 * 4.7 million lamports, for a few sessions at once, with the rent-exempt minimum left on the key. The clean-up returns what is left.
 */
const DIRECT_RENT_LAMPORTS = 20_000_000n;
```

Replace

```ts
      maxTimeoutSeconds: 30,
      readRetry: READ_RETRY,
    });
```

with

```ts
      maxTimeoutSeconds: 30,
      readRetry: READ_RETRY,
      // The sweeper lists the program's accounts where the clean-up does.
      scanRpcUrl: options.scanRpcUrl,
      // Keeps the sweeper's `getProgramAccounts` within the public endpoint's rate limits.
      sweeperIntervalMs: 5_000,
    });
```

Replace

```ts
  let nextBuyer = 0;
  let stopping: Promise<void> | undefined;
  return {
    target,
    rpc,
    keys: keys.stack,
    services,
    context: () => ({
      target,
      gateUrl: services.stream.url,
      rpc,
      newBuyer: async (usdc) => {
        const key = keys.buyers[nextBuyer++];
        if (!key) throw new Error(`The run used all ${keys.buyers.length} buyer keys: raise BUYER_POOL in e2e/src/devnet/keys.ts`);
        const usdcAccount = await fundUsdcAccount(rpc, funding, key.signer.address, usdc, send);
        return { signer: key.signer, usdcAccount };
      },
      sendUsdc: (from, to, amount) => sendUsdc(rpc, funding.signer, from, to, amount, send),
      subscriptionSettleMs: SUBSCRIPTION_SETTLE_MS,
      readRetry: READ_RETRY,
    }),
```

with

```ts
  let nextBuyer = 0;
  let stopping: Promise<void> | undefined;
  /** What the run has lent its buyers from the funding key. It comes back only at the clean-up, so it must fit in what a start-up requires. */
  let lent = 0n;
  /** The next key of the pool. Buyers and the rent payer of direct sessions draw from it alike, so that the clean-up covers every one. */
  const takeKey = () => {
    const key = keys.buyers[nextBuyer++];
    if (!key) throw new Error(`The run used all ${keys.buyers.length} buyer keys: raise BUYER_POOL in e2e/src/devnet/keys.ts`);
    return key;
  };
  const control: StackControl = {
    rentPayer: services.facilitator.rentPayer,
    stopGate: () => services.stopGate(),
    startGate: () => services.startGate(),
  };
  const sellerWallet = keys.stack.seller.signer.address;
  const direct = createDirectChain({
    rpc,
    terms: TEST_TERMS,
    seller: { wallet: sellerWallet, usdcAccount: await associatedTokenAddress(sellerWallet, USDC_DEVNET_MINT) },
    // The funding key pays the fee of the harness's own transactions (spec §12.6), so the rent payer's balance changes by rent only.
    feePayer: funding.signer,
    rentPayer: async () => {
      const key = takeKey();
      await sendSol(rpc, funding.signer, key.signer.address, DIRECT_RENT_LAMPORTS, send);
      return key.signer;
    },
    readRetry: READ_RETRY,
    send,
  });
  return {
    target,
    rpc,
    keys: keys.stack,
    services,
    context: () => ({
      target,
      gateUrl: services.stream.url,
      rpc,
      newBuyer: async (usdc) => {
        // Checked and counted before anything is awaited, so that buyers made at the same time cannot all pass.
        if (lent + usdc > MINIMUM_FUNDS.usdc) {
          throw new Error(
            `The run has lent ${lent} USDC base units and this buyer asks for ${usdc} more: a run must stay within ${MINIMUM_FUNDS.usdc}, the least that a start-up requires. Fund a buyer with what its session costs.`,
          );
        }
        lent += usdc;
        const key = takeKey();
        const usdcAccount = await fundUsdcAccount(rpc, funding, key.signer.address, usdc, send);
        return { signer: key.signer, usdcAccount };
      },
      sendUsdc: (from, to, amount) => sendUsdc(rpc, funding.signer, from, to, amount, send),
      subscriptionSettleMs: SUBSCRIPTION_SETTLE_MS,
      readRetry: READ_RETRY,
      stack: control,
      direct,
    }),
```

- [ ] **Step 22: Run the target tests and the typecheck**

Run: `pnpm typecheck && pnpm --filter @lxfoundry/stint-e2e test local-target.test.ts devnet-target.test.ts`
Expected: PASS. The earlier devnet tests are unchanged and still pass: the pool test still reports `buyer keys` when
the pool is used (`takeKey` throws the same message), and a pool of one is not touched by the direct chain until a
session is opened. No devnet test pins what `startServices` is given (they run the real services): the sweeper test of
Step 17 runs with the target's 5 s interval, and its 40 s poll leaves room for it (the session expires 5 s after its open,
and the next sweep is at most 5 s later).

- [ ] **Step 23: Run the whole suite**

Run: `pnpm typecheck && pnpm test`
Expected: PASS.

- [ ] **Step 24: Commit**

```bash
git add e2e/src/targets/local.ts e2e/src/targets/devnet.ts e2e/test/local-target.test.ts e2e/test/devnet-target.test.ts
git commit -m "Give the local and devnet contexts control of the gate and sessions opened straight on the program, and bound what a devnet run lends"
```

---

### Task 6: Scenarios 2, 16, 9, 3 and 26, required on local

Tasks 1 to 5 built the end of a session: the program's `AtExpiry` close, the facilitator's sweeper, the gate's idle and
end timers, a client that understands a session the gate ended, and the harness's stack control and direct on-chain
sessions. This task writes the five scenarios that prove it, and makes them `required`, one at a time, by the ratchet of
spec §12.2: each scenario is first added `pending` with its `run` and watched passing, then made `required` in the same
commit. At the end seven of the 35 scenarios are `required` and pass on `local`.

**Files:**
- Create: `conformance/src/closes.ts`, `conformance/src/helpers.ts`; modify `conformance/src/index.ts` (it exports the close lookup)
- Create: `conformance/src/scenarios/02-close-before-min-seconds.ts`, `conformance/src/scenarios/16-close-after-paid-until.ts`,
  `conformance/src/scenarios/09-disconnect-and-grace.ts`, `conformance/src/scenarios/03-expiry.ts`,
  `conformance/src/scenarios/26-expired-session-nobody-closes.ts`
- Modify: `conformance/src/catalogue.ts`, `conformance/src/runner.ts` (its doc comment only)
- Test: `e2e/test/close-lookup.test.ts` (create: the lookup of a close, on the local node), `conformance/test/closes.test.ts`,
  `conformance/test/helpers.test.ts`, `conformance/test/disconnect-and-grace.test.ts`,
  `conformance/test/expired-session-nobody-closes.test.ts`
- Modify: `conformance/test/catalogue.test.ts`, `e2e/test/local-target.test.ts`, `e2e/test/devnet-target.test.ts`
- Modify: `README.md` (Status, and the scan endpoint's item), `.env.example` (the scan endpoint's comment), `docs/specs/stint-system.md` (§4.3, §6.4, §7.3, §12.2), `docs/plans/README.md` (stage 4 row)

**Interfaces:**
- Consumes:
  - `ScenarioContext.stack?: StackControl` (`rentPayer: Address`, `stopGate(): Promise<void>`, `startGate(): Promise<void>`) and
    `ScenarioContext.direct?: DirectChain` (`open({ buyer, seconds, remainder? }): Promise<DirectSession>`, where the optional
    `remainder: bigint` is extra base units in the buyer's transfer, below the rate, so that `deposited = rate × seconds + remainder` and
    `DirectSession.deposit` is that whole deposit;
    `close(session, closer): Promise<string>`, `newKey(): Promise<KeyPairSigner>`), with `DirectSession`
    (`session`, `vault`, `rentPayer`, `receiverToken`, `refundTo`, `deposit`, `startedAt`, `paidUntil`), all from
    `conformance/src/types.ts` (Task 5). Both targets set both members. `stack` is backed by `Services.stopGate()` and
    `Services.startGate()` (`e2e/src/targets/services.ts`), `direct` by `createDirectChain(options)` (`e2e/src/targets/direct.ts`); a
    direct session's rent payer is a harness key, its receiver authorizer a throwaway key, and the fee payer of its transactions is a
    third key, so that `assertRentReturned` holds. Group 0's probe uses `LocalStack.context().direct`.
  - The gate (Task 3): a session with no connection is closed with a `Standard` close `idleCloseSeconds` after its open and after
    each last drop (10 s on the test offer); at `paidUntil` the gate stops forwarding, closes with `AtExpiry` and drops the
    connection with `4402`; a buyer's close drops it with `4410`.
  - The sweeper (Task 2, `createSweeper` in `apps/facilitator/src/sweeper.ts`, started by `startFacilitator` because the stack sets
    `FacilitatorConfig.sweeper`): every `TEST_SWEEPER_INTERVAL_MS` = 2 s on the local target and every 5 s on the devnet target, it closes with `AtExpiry`, signing as the
    facilitator's rent payer, each session whose `rent_payer` is the facilitator's and whose `paid_until` has passed.
  - The program (Task 1): `close(AtExpiry)`; and a `Standard` close by any key from `paid_until` on, refused before it.
  - Existing: `createStintClient`, `createSessionTools`, `StintSession` (`id`, `paidUntil` in seconds, `cost`, `connect()`, `close()`), `fetchClosedEvent`,
    `tokenBalanceChanges`, `lamportBalances`, `associatedTokenAddress`, `dueAt`, `fetchMaybeSession`, `readUntil`, `expectTrue`, `expectEqual`,
    `waitFor`, `sleep`, `assertRentReturned` and `receivedAmount` (scenario 22's file).
- Produces:
  - `conformance/src/closes.ts`, also exported from the package index: `interface FoundClose { signature: string; event: ClosedEvent }`,
    `findClose(rpc, session, retry, notCloses?: Set<string>): Promise<FoundClose | undefined>`,
    `awaitClose(rpc, session, retry, timeoutMs, what, pollMs = 1_000): Promise<FoundClose>` (a transaction that held no close is read once over all the looks).
  - `conformance/src/helpers.ts`: `buyerClient(buyer: Buyer): StintClient`, `sessionSeconds(target: Target, local: number): number`,
    `closePollMs(target: Target): number` (1,000, and 2,000 on `devnet`).
  - `whileGateStopped<T>(stack: StackControl, work: () => Promise<T>): Promise<T>`, exported from scenario 26's file with its own test.
  - `closeBeforeMinSeconds`, `closeAfterPaidUntil`, `disconnectAndGrace` (with `idleCloseSecondsOf`), `expiry`,
    `expiredSessionNobodyCloses`: the five scenarios, and the catalogue entries 2, 3, 9, 16 and 26 `required` (26 keeps
    `["stack"]` and `"ownStack"`, which the sequential runner does not act on yet: 26 runs on the common stack, a known
    deviation from spec §12.2 recorded under "What this stage builds, and what it leaves for later").
  - The local report reads `Status: required 7, pending 28 · Result: pass 7, fail 0, pending 27, not applicable 1`.

**What stage 4 leaves out, and this task does not build:** top-up, adoption of sessions opened on-chain, one live connection per
session, outage and admin closes, recreating a closed `receiver_token`, the sponsored close, restart recovery. Scenarios 4, 7, 10, 21, 23,
34 and the others stay `pending`.

**What the scenarios rely on.** The fact marked "to confirm" was not observed before this plan was written; the step named beside it
checks it, and when it does not hold, stop and report it instead of changing an assertion.
- The test offer is rate 1,000 base units per second, `minSeconds` 5, `maxSeconds` 120, `idleCloseSeconds` 10, and the gate's connect
  margin is 2 s. A gate open takes any `seconds` from 5 to 120 when the client passes it.
- A session's deposit is `rate × seconds`, so the whole deposit is earned at `paid_until`: a 10 s session is 10,000, all paid at expiry, with nothing refunded (scenario 16's session is the one exception, by 250 base units on purpose).
- Each new scenario funds its buyer with 100,000 base units, which covers its deposit (30,000; 10,000; 60,000 each in scenario 9; 10,250; 12,000; up to 10 s more on `devnet`), because on `devnet` the funding key lends every buyer's USDC until the end-of-run clean-up and a run needs only 5 USDC there: with scenarios 1 (1.0 USDC) and 22 (1.5 USDC), the run lends about 3.2 USDC in total, not the 9.5 that 1 USDC a buyer would.
- The `Closed` event carries `claimed` (paid by earlier claims, always 0 in this stage: nothing calls `claim`), `owed`, `refunded`,
  `redirected`, `closedBy`, `paidUntil` and `at` (the chain's clock). The receiver gains `owed + redirected` in the close.
- The gate's close is signed by the receiver authorizer, the sweeper's by the rent payer; both have Kora's key as fee payer, so the
  rent payer's lamport change in a close is exactly what the session and its vault held (`assertRentReturned`).
- To confirm, by Group 0's probe, before any scenario or helper relies on it: the local node lists a closed account's transactions
  through `getSignaturesForAddress`, newest first, the successful close among them (spec §7.3 relies on it for the gate; nothing in this
  repository calls it yet, and the local network was not probed).
- Scenario 3 can be closed by the gate or, if the sweeper's pass comes first, by the sweeper; its assertions do not name the closer.

---

#### Group 0: probe the lookup of a close on the local node

Scenarios 3, 9 and 26 find the close that the gate or the sweeper sent by listing the session address's transactions
(`getSignaturesForAddress`, spec §7.3). Nothing in this repository calls that method yet, and Surfpool's answer for an account that no
longer exists is not known. This group asks the node, with a real session, before the helper or a scenario is built on the answer. The probe
needs Task 5's `LocalStack.context().direct`; the buyer closes its own session (a `Standard` close before `paid_until`, which the authority
may sign), and a harness key pays the fee, so the close is the only successful transaction that names the session after its open.

- [ ] **Step 0.1: Write the probe**

Create `e2e/test/close-lookup.test.ts`:

```ts
import { fetchMaybeSession } from "@lxfoundry/stint-program-client";
import type { Address } from "@solana/kit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sendSol } from "../src/devnet/funds.js";
import { fundSol, newHarnessKey } from "../src/fixtures/keys.js";
import { waitForNewSlot } from "../src/network/surfnet.js";
import { startLocalStack, type LocalStack } from "../src/targets/local.js";

describe("the lookup of a close, on the local node (spec §7.3)", () => {
  let stack: LocalStack;

  beforeAll(async () => {
    stack = await startLocalStack();
  });

  afterAll(async () => {
    await stack?.stop();
  });

  /** A session opened straight on the program and closed by its buyer. */
  async function closedSession() {
    const context = stack.context();
    const buyer = await context.newBuyer(1_000_000n);
    const opened = await context.direct!.open({ buyer, seconds: 30 });
    const signature = await context.direct!.close(opened, buyer.signer);
    return { buyer, opened, signature };
  }

  /** What the node lists for the address, newest first, at `confirmed`. */
  const listed = (address: Address) => stack.network.rpc.getSignaturesForAddress(address, { commitment: "confirmed" }).send();

  /** Anyone may send lamports to a closed address (S12), which lists the transfer after the close. */
  async function sendLamportsTo(address: Address): Promise<void> {
    const sender = await newHarnessKey();
    fundSol(stack.network, sender.signer.address, 1);
    await waitForNewSlot(stack.network.rpc);
    // Above the rent minimum of an empty account (890,880 lamports), or the transfer would be refused.
    await sendSol(stack.network.rpc, sender.signer, address, 1_000_000n, { pollMs: 100 });
  }

  it("lists a closed session's transactions, the successful close first and its open after it", async () => {
    const { opened, signature } = await closedSession();

    const entries = await listed(opened.session);

    expect((await fetchMaybeSession(stack.network.rpc, opened.session, { commitment: "confirmed" })).exists).toBe(false);
    expect(entries.length).toBeGreaterThanOrEqual(2);
    expect(entries[0]?.signature).toBe(signature);
    expect(entries.every((entry) => entry.err === null)).toBe(true);
  });

  it("lists a later transfer of lamports to the closed address above the close", async () => {
    const { opened, signature } = await closedSession();
    await sendLamportsTo(opened.session);

    const entries = await listed(opened.session);

    expect(entries.length).toBeGreaterThanOrEqual(3);
    expect(entries[0]?.signature).not.toBe(signature);
    expect(entries[1]?.signature).toBe(signature);
  });
});
```

- [ ] **Step 0.2: Run it**

Run: `pnpm --filter @lxfoundry/stint-e2e test close-lookup.test.ts`
Expected: PASS (2 tests). It asks the node and tests no code of ours, so there is no failing first run: its passing is the observation. If it
fails, the error shows what the node does instead (an empty list, another order, or the close missing): stop and report it. The helper
of Group A is built on exactly these two facts: the close is listed, newest-first, and a later transfer can sit above it, which is why the
helper reads each successful entry's `Closed` event instead of taking the first entry.

- [ ] **Step 0.3: Commit**

```bash
git add e2e/test/close-lookup.test.ts
git commit -m "Test that the local node lists a closed session's transactions, newest first"
```

---

#### Group A: the shared helpers

- [ ] **Step A1: Write the failing tests of the close lookup**

Create `conformance/test/closes.test.ts`:

```ts
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
 * A node that answers each listing with the next of `listings` (the last repeating), and knows `transactions` by signature: a
 * transaction, or a function that answers each read of it (`null` is a node that cannot return it yet). `fetched` records every read.
 */
function fakeRpc(listings: readonly (readonly ReturnType<typeof listed>[])[], transactions: Record<string, unknown>) {
  const fetched: string[] = [];
  let lists = 0;
  const rpc = {
    getSignaturesForAddress: () => ({ send: async () => listings[Math.min(lists++, listings.length - 1)] }),
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

  it("is waited for no longer than the limit, and the error names what was awaited", async () => {
    await expect(awaitClose(fakeRpc([[]], {}).rpc, session, retry, 30, "the sweeper closes the session", 5)).rejects.toThrow(
      "the sweeper closes the session: not within 30 ms",
    );
  });
});
```

Create `conformance/test/helpers.test.ts`:

```ts
import { generateKeyPairSigner } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { buyerClient, closePollMs, sessionSeconds } from "../src/helpers.js";
import type { Target } from "../src/types.js";

describe("buyerClient", () => {
  it("is a client for the buyer's key whose period budget is 1 USDC", async () => {
    const signer = await generateKeyPairSigner();
    expect(buyerClient({ signer, usdcAccount: signer.address }).remainingBudget()).toBe(1_000_000n);
  });
});

describe("sessionSeconds", () => {
  const target = (name: Target["name"]): Target => ({ name, capabilities: new Set() });

  it("is as long as asked on a network of ours, and ten seconds longer on devnet, where each step takes seconds", () => {
    expect(sessionSeconds(target("local"), 8)).toBe(8);
    expect(sessionSeconds(target("external"), 8)).toBe(8);
    expect(sessionSeconds(target("devnet"), 8)).toBe(18);
  });

  it("is polled for a close every second on a network of ours, and every two seconds on devnet, which rate-limits", () => {
    expect(closePollMs(target("local"))).toBe(1_000);
    expect(closePollMs(target("external"))).toBe(1_000);
    expect(closePollMs(target("devnet"))).toBe(2_000);
  });
});
```

- [ ] **Step A2: Run them to see them fail**

Run: `pnpm --filter @lxfoundry/stint-conformance test closes.test.ts helpers.test.ts`
Expected: FAIL: the modules `../src/closes.js` and `../src/helpers.js` do not exist.

- [ ] **Step A3: Write the helpers**

Create `conformance/src/closes.ts`:

```ts
import type { Address, Rpc, SolanaRpcApi } from "@solana/kit";
import { findClosedEvent, type ClosedEvent } from "@lxfoundry/stint-program-client";
import { fetchProgramInstructions, type RetryOptions } from "@lxfoundry/stint-x402";
import { sleep } from "./assert.js";

/** A close that the scenario did not send: its signature, and the `Closed` event it emitted. */
export interface FoundClose {
  readonly signature: string;
  readonly event: ClosedEvent;
}

/** How many of an address's newest transactions are looked through. */
const LOOKBACK = 20;

/**
 * The close of a session that the gate or the sweeper closed (spec §7.3, "Account closed by another party"): the newest
 * successful transaction that loaded the session's address and emitted a `Closed` event for it. A failed close, and a later
 * transfer of lamports to the closed address (S12), can come after the close, so the newest entry alone is not enough (the probe
 * of Group 0 shows it on the local node). Undefined while there is none.
 *
 * Each entry is a request for its transaction, so a caller that looks again passes the same `notCloses` set: a signature that was
 * read and holds no close of this session is added to it, and is not read again. One that could not be read (the node does not
 * return it yet) is not added, and is tried at the next look.
 */
export async function findClose(
  rpc: Rpc<SolanaRpcApi>,
  session: Address,
  retry: RetryOptions,
  notCloses: Set<string> = new Set(),
): Promise<FoundClose | undefined> {
  const entries = await rpc.getSignaturesForAddress(session, { commitment: "confirmed", limit: LOOKBACK }).send();
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

/**
 * Looks for the close every `pollMs` until it shows up, or throws, naming `what`, after `timeoutMs`. A transaction that held no
 * close is read once over all the looks, not once per look.
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
  for (;;) {
    const found = await findClose(rpc, session, retry, notCloses);
    if (found) return found;
    if (Date.now() >= deadline) throw new Error(`${what}: not within ${timeoutMs} ms`);
    await sleep(pollMs);
  }
}
```

Create `conformance/src/helpers.ts`:

```ts
import { createStintClient, type StintClient } from "@lxfoundry/stint-client";
import type { Buyer, Target } from "./types.js";

/** A client for the buyer's key with the limits the scenarios use: at most 1 USDC a session and an hour, 10,000 base units a second. */
export function buyerClient(buyer: Buyer): StintClient {
  return createStintClient({
    signer: buyer.signer,
    policy: { maxRate: 10_000n, maxPerSession: 1_000_000n, budget: { amount: 1_000_000n, periodSeconds: 3_600 } },
  });
}

/**
 * How long a session lasts when a scenario must act on it while it still has time left. A real network takes seconds to
 * confirm an open and every step after it, so the scenario buys ten seconds more there; the amounts it expects follow from the length it buys.
 */
export function sessionSeconds(target: Target, local: number): number {
  return target.name === "devnet" ? local + 10 : local;
}

/** How often a scenario looks for a close that someone else sent: devnet's public node rate-limits, so it is asked half as often. */
export function closePollMs(target: Target): number {
  return target.name === "devnet" ? 2_000 : 1_000;
}
```

- [ ] **Step A4: Export the close lookup, and run the tests**

In `conformance/src/index.ts`, replace

```ts
export { readUntil } from "./reads.js";
```

with

```ts
export { readUntil } from "./reads.js";
export { awaitClose, findClose, type FoundClose } from "./closes.js";
```

Run: `pnpm --filter @lxfoundry/stint-conformance test closes.test.ts helpers.test.ts && pnpm --filter @lxfoundry/stint-conformance typecheck`
Expected: PASS (7 + 3 tests), no type errors.

- [ ] **Step A5: Confirm the helper against the real node**

In `e2e/test/close-lookup.test.ts`, replace

```ts
import { fetchMaybeSession } from "@lxfoundry/stint-program-client";
```

with

```ts
import { findClose } from "@lxfoundry/stint-conformance";
import { CloseKind, fetchMaybeSession } from "@lxfoundry/stint-program-client";
```

and replace

```ts
    expect(entries[1]?.signature).toBe(signature);
  });
});
```

with

```ts
    expect(entries[1]?.signature).toBe(signature);
  });

  it("finds the close with the helper the scenarios use, below a later transfer", async () => {
    const { buyer, opened, signature } = await closedSession();
    await sendLamportsTo(opened.session);

    const found = await findClose(stack.network.rpc, opened.session, { attempts: 1, delayMs: 0 });

    expect(found?.signature).toBe(signature);
    expect(found?.event).toMatchObject({ session: opened.session, kind: CloseKind.Standard, closedBy: buyer.signer.address });
  });
});
```

Run: `pnpm --filter @lxfoundry/stint-e2e test close-lookup.test.ts && pnpm typecheck`
Expected: PASS (3 tests).

- [ ] **Step A6: Commit**

```bash
git add conformance e2e
git commit -m "Add scenario helpers: a buyer's client, session lengths per network, and the lookup of a close made by another party"
```

---

#### Group B: scenario 2, close before `minSeconds`

What it proves: the buyer closes a 30 s session (30,000) straight away, before the 5 s minimum has passed on the chain's clock, so the
close charges `rate × minSeconds` = 5 × 1,000 = 5,000 and refunds 30,000 − 5,000 = 25,000. The receipt (read from the `Closed` event), the transaction's own token
transfers, and the session's stored terms agree; the account is gone. The scenario is only meaningful if the close
came before the minimum: it asserts that from the event's `at`. Every figure follows from the session's stored terms (`stored.rate`, `stored.minSeconds`),
which the scenario reads from the chain: the 5 s and 1,000 above are the local test offer's, and an offer with a longer minimum (a target
whose close takes longer than 5 s to land would need one) changes no line of the scenario. The buyer is funded with 100,000 base units, not
more than the deposit needs: on `devnet` the funding key lends it until the clean-up.

- [ ] **Step B1: Write the scenario**

Create `conformance/src/scenarios/02-close-before-min-seconds.ts`:

```ts
import { address } from "@solana/kit";
import { CloseKind, fetchMaybeSession } from "@lxfoundry/stint-program-client";
import { createSessionTools } from "@lxfoundry/stint-client";
import { associatedTokenAddress, fetchClosedEvent, tokenBalanceChanges } from "@lxfoundry/stint-x402";
import { expectEqual, expectTrue } from "../assert.js";
import { buyerClient } from "../helpers.js";
import { readUntil } from "../reads.js";
import type { ScenarioContext } from "../types.js";

/**
 * Scenario 2 (spec §12.7): close before `minSeconds`. The buyer closes at once, so what is charged is the minimum,
 * `rate × minSeconds` (spec §4.2), and the rest of the deposit is refunded. Amounts are read from the close's own transaction.
 */
export async function closeBeforeMinSeconds(context: ScenarioContext): Promise<void> {
  const buyer = await context.newBuyer(100_000n); // the session costs 30,000
  const { tools } = createSessionTools(buyerClient(buyer));

  const opened = await tools.stint_open_session.run({ url: context.gateUrl, seconds: 30, reason: "conformance scenario 2" });
  const session = address(opened.sessionId);
  const readSession = () => fetchMaybeSession(context.rpc, session, { commitment: "confirmed" });
  const account = await readUntil(context.readRetry, readSession, (read) => read.exists);
  expectTrue(account.exists, "the session exists on-chain after the open");
  const stored = account.data;
  const deposit = BigInt(opened.cost);
  expectEqual(stored.deposited, deposit, "the deposit credited at open");

  const receipt = await tools.stint_close_session.run({ sessionId: opened.sessionId });
  const closed = await fetchClosedEvent(context.rpc, receipt.transaction, context.readRetry);
  expectTrue(closed, "the close emitted Closed");
  expectEqual(closed.kind, CloseKind.Standard, "the buyer's close is a Standard close");
  // The scenario means what it says only if the minimum had not passed when the close was made, on the chain's clock. The terms are
  // the stored ones, not 5 s and 1,000: a target whose offer has a longer minimum changes nothing here.
  expectTrue(closed.at - stored.startedAt < BigInt(stored.minSeconds), "the close came before minSeconds had passed");

  const minimum = stored.rate * BigInt(stored.minSeconds); // 5 × 1,000 = 5,000 on the local test offer
  const { paid, refunded } = receipt;
  expectTrue(paid !== undefined && refunded !== undefined, "the gate reported the close's amounts");
  expectEqual(BigInt(paid), minimum, "paid = rate × minSeconds");
  expectEqual(BigInt(refunded), deposit - minimum, "refunded = deposit − rate × minSeconds");

  const changes = await tokenBalanceChanges(context.rpc, receipt.transaction, context.readRetry);
  const receiverToken = await associatedTokenAddress(stored.receiver, stored.mint);
  expectEqual(changes.get(receiverToken), minimum, "the receiver's gain in the close");
  expectEqual(changes.get(buyer.usdcAccount), deposit - minimum, "the buyer's refund in the close");
  expectTrue(!(await readUntil(context.readRetry, readSession, (read) => !read.exists)).exists, "the session account is closed");
}
```

- [ ] **Step B2: Add it to the catalogue as pending, with its run, and watch it pass**

In `conformance/src/catalogue.ts`, replace

```ts
import { openConnectCloseEarly } from "./scenarios/01-open-connect-close.js";
```

with

```ts
import { openConnectCloseEarly } from "./scenarios/01-open-connect-close.js";
import { closeBeforeMinSeconds } from "./scenarios/02-close-before-min-seconds.js";
```

Let the `pending` builder take a run, so that a built scenario can run before it is required. Replace

```ts
  group: IsolationGroup = "shared",
): Scenario {
  return { id, title, needs, group, status: "pending" };
}
```

with

```ts
  group: IsolationGroup = "shared",
  run?: Scenario["run"],
): Scenario {
  return { id, title, needs, group, status: "pending", ...(run ? { run } : {}) };
}
```

and replace `  pending(2, "Close before minSeconds"),` with:

```ts
  pending(2, "Close before minSeconds", [], "shared", closeBeforeMinSeconds),
```

Run: `pnpm typecheck && pnpm e2e:local`
Expected: the table row `| 2. Close before minSeconds | local | pending | pass (make required) | ... |`, the summary
`Status: required 2, pending 33 · Result: pass 3, fail 0, pending 31, not applicable 1`, and `Make required: 1`.
(The catalogue test expects a pending scenario to have no run, so `pnpm test` fails until the next step: that is the ratchet, not a fault.)
If scenario 2 fails, its error names the check that failed. Do not weaken an assertion: stop and report which observation did not hold.

- [ ] **Step B3: Make the tests expect scenario 2 required, and watch them fail**

In `conformance/test/catalogue.test.ts`, replace

```ts
const byId = new Map(catalogue.map((scenario) => [scenario.id, scenario]));
```

with

```ts
const byId = new Map(catalogue.map((scenario) => [scenario.id, scenario]));
/** The scenarios the build has made required: each passes on `local`, and none goes back to pending (spec §12.2). */
const REQUIRED = [1, 2, 22];
```

and replace the test

```ts
  it("has scenarios 1 and 22 required with their implementations, and every other scenario pending without one", () => {
    for (const scenario of catalogue) {
      if (scenario.id === 1 || scenario.id === 22) {
```

with

```ts
  it("has the scenarios of REQUIRED required with their implementations, and every other scenario pending without one", () => {
    for (const scenario of catalogue) {
      if (REQUIRED.includes(scenario.id)) {
```

(Its body is unchanged; the test of the needs, and the 24 `shared` scenarios, stay as they are: 2, 3, 9, 16 are `shared` with no needs, and 26 keeps `["stack"]` and `ownStack`.)

In `e2e/test/local-target.test.ts`, replace

```ts
describe("local target", () => {
```

with

```ts
/**
 * The required scenarios, all passing on `local`. Together they take about two minutes: scenario 1 sleeps 7 s, 3 runs about
 * 25 s, 9 about 15 s, 16 about 15 s and 26 about 20 s, so the test's limit is generous.
 */
const REQUIRED = [1, 2, 22];

describe("local target", () => {
```

and replace the test that begins `it("passes scenarios 1 and 22, now required, and reports every other scenario"`, from its `it(` line through
its closing `});`, with the new one below. (Task 5 adds a test after it, `gives scenarios control of the gate and sessions opened straight on the
program`, which stays.) The old test reads:

```ts
  it("passes scenarios 1 and 22, now required, and reports every other scenario", async () => {
    const outcomes = await runScenarios(catalogue, stack.target, () => stack.context());
    expect(outcomes).toHaveLength(35);
    expect(outcomes.find((outcome) => outcome.id === 1)).toMatchObject({ status: "required", result: "pass" });
    expect(outcomes.find((outcome) => outcome.id === 22)).toMatchObject({ status: "required", result: "pass" });
    expect(outcomes.find((outcome) => outcome.id === 12)?.result).toBe("not applicable");
    expect(outcomes.filter((outcome) => outcome.result === "pending")).toHaveLength(32);
    expect(exitCodeFor(outcomes)).toBe(0);
  });
```

and the new one is:

```ts
  it("passes every required scenario, and reports the others", async () => {
    const outcomes = await runScenarios(catalogue, stack.target, () => stack.context());
    expect(outcomes).toHaveLength(35);
    for (const id of REQUIRED) {
      expect(outcomes.find((outcome) => outcome.id === id), `scenario ${id}`).toMatchObject({ status: "required", result: "pass" });
    }
    // Scenario 12 needs allowance funding, which `local` lacks; every other scenario that is not required is pending.
    expect(outcomes.find((outcome) => outcome.id === 12)?.result).toBe("not applicable");
    expect(outcomes.filter((outcome) => outcome.result === "pending")).toHaveLength(35 - 1 - REQUIRED.length);
    expect(exitCodeFor(outcomes)).toBe(0);
  }, 300_000);
```

Run: `pnpm --filter @lxfoundry/stint-conformance test catalogue.test.ts`
Expected: FAIL: scenario 2's status is `pending`, expected `required`.

- [ ] **Step B4: Make scenario 2 required**

In `conformance/src/catalogue.ts`, replace `  pending(2, "Close before minSeconds", [], "shared", closeBeforeMinSeconds),` with:

```ts
  required(2, "Close before minSeconds", closeBeforeMinSeconds),
```

Run: `pnpm typecheck && pnpm --filter @lxfoundry/stint-conformance test && pnpm --filter @lxfoundry/stint-e2e test local-target.test.ts`
Expected: PASS.

Run: `pnpm e2e:local`
Expected: `Status: required 3, pending 32 · Result: pass 3, fail 0, pending 31, not applicable 1`, with no "Make required" line.

- [ ] **Step B5: Commit**

```bash
git add conformance e2e
git commit -m "Run scenario 2, a close before the minimum charge, and make it required"
```

---

#### Group C: scenario 16, a close by an unrelated key after `paid_until`

What it proves, on a session opened straight on the program with harness keys as receiver authorizer and rent payer (so no gate and no sweeper
may close it): before `paid_until` the program refuses an unrelated key's close and the session stays open; from `paid_until` on the same
close, with the same accounts, is accepted. The session is opened with `remainder: 250n`: 250 base units above the rate (below 1,000), so its
deposit is 10 × 1,000 + 250 = 10,250 and its paid time is still 10 s. The close from `paid_until` on pays the receiver exactly 10,000 (`rate × seconds`,
all of the covered time), refunds the buyer exactly 250, redirects nothing, is signed by the unrelated key, and returns the rent to the
harness's rent payer. The early refusal is attributed to the time because the later success uses the same accounts. The session lasts 10 s
and not less because `paid_until` comes from the chain's clock, which in clock mode follows the wall clock but falls behind when blocks are late
(spec §12.3), while the scenario's guards compare it with the wall clock: the slack keeps them from failing on a late block. The buyer is funded with
100,000 base units, which covers the deposit (10,250, or 20,250 on `devnet`).

- [ ] **Step C1: Write the scenario**

Create `conformance/src/scenarios/16-close-after-paid-until.ts`:

```ts
import type { KeyPairSigner } from "@solana/kit";
import { CloseKind, fetchMaybeSession } from "@lxfoundry/stint-program-client";
import { fetchClosedEvent, lamportBalances, tokenBalanceChanges } from "@lxfoundry/stint-x402";
import { expectEqual, expectTrue, sleep } from "../assert.js";
import { sessionSeconds } from "../helpers.js";
import { readUntil } from "../reads.js";
import type { DirectChain, DirectSession, ScenarioContext } from "../types.js";
import { assertRentReturned } from "./22-example-agent-task.js";

/** Whether the attempt is refused: it rejects. */
async function isRefused(attempt: Promise<unknown>): Promise<boolean> {
  try {
    await attempt;
    return false;
  } catch {
    return true;
  }
}

/** Sends the close until the program accepts it: the chain's clock can trail the wall clock, so `paid_until` may not have passed there yet. */
async function closeOnceAllowed(direct: DirectChain, opened: DirectSession, closer: KeyPairSigner): Promise<string> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      return await direct.close(opened, closer);
    } catch (error) {
      if (Date.now() >= deadline) throw new Error("the program refused the close for 30 s after paid_until", { cause: error });
      await sleep(1_000);
    }
  }
}

/**
 * Scenario 16 (spec §12.7): close by an unrelated key after `paid_until`, on a session opened directly on-chain whose receiver
 * authorizer and rent payer are harness keys, so that no gate or sweeper closes it first.
 */
export async function closeAfterPaidUntil(context: ScenarioContext): Promise<void> {
  const direct = context.direct;
  if (!direct) throw new Error("scenario 16 needs a target that provides direct chain access");
  const buyer = await context.newBuyer(100_000n); // the deposit is 10,250 (20,250 on devnet): the funding key lends no more than that
  const seconds = sessionSeconds(context.target, 10);
  // 250 base units above the rate × seconds, which is below the rate (1,000): the paid time stays `seconds`, and the 250 are what a close refunds.
  const remainder = 250n;
  const opened = await direct.open({ buyer, seconds, remainder });
  const readSession = () => fetchMaybeSession(context.rpc, opened.session, { commitment: "confirmed" });
  const account = await readUntil(context.readRetry, readSession, (read) => read.exists);
  expectTrue(account.exists, "the session exists on-chain after the direct open");
  const stored = account.data;
  expectEqual(stored.rentPayer, opened.rentPayer, "the session names the harness's rent payer");
  const earned = stored.rate * BigInt(seconds); // 10 × 1,000 = 10,000 on the test offer
  expectEqual(stored.deposited, earned + remainder, "the deposit credited at open is rate × seconds + 250"); // 10,250
  expectEqual(opened.deposit, stored.deposited, "the direct session reports the whole deposit");
  if (context.stack) {
    expectTrue(stored.rentPayer !== context.stack.rentPayer, "the session is not the facilitator's, so its sweeper leaves it alone");
  }
  const paidUntilMs = Number(opened.paidUntil) * 1_000;

  // Before paid_until only the authority and the receiver authorizer may close (spec §4.3).
  const stranger = await direct.newKey();
  expectTrue(Date.now() < paidUntilMs - 2_000, "the early close is tried at least 2 s before paid_until: the open took too long");
  expectTrue(await isRefused(direct.close(opened, stranger)), "a close by an unrelated key before paid_until is refused");
  expectTrue((await readSession()).exists, "the refused close left the session open");

  await sleep(Math.max(0, paidUntilMs + 1_000 - Date.now()));
  const signature = await closeOnceAllowed(direct, opened, stranger);

  const closed = await fetchClosedEvent(context.rpc, signature, context.readRetry);
  expectTrue(closed, "the close emitted Closed");
  expectEqual(closed.kind, CloseKind.Standard, "the unrelated key's close is a Standard close");
  expectEqual(closed.closedBy, stranger.address, "the close was signed by the unrelated key");
  // From paid_until on, elapsed stops at paid_until: the whole covered time is charged, whenever the close is made. The receiver is paid
  // exactly rate × seconds (10,000), and the buyer is refunded exactly the 250 base units above it; nothing is redirected, since the buyer's account exists.
  expectEqual(closed.claimed + closed.owed, earned, "the receiver is paid rate × seconds");
  expectEqual(closed.refunded, remainder, "the buyer is refunded exactly the 250 base units above rate × seconds");
  expectEqual(closed.redirected, 0n, "nothing is redirected to the receiver");
  const changes = await tokenBalanceChanges(context.rpc, signature, context.readRetry);
  expectEqual(changes.get(opened.receiverToken), earned - closed.claimed, "the receiver's gain in the close");
  expectEqual(changes.get(opened.refundTo), remainder, "the buyer's refund in the close");
  assertRentReturned(await lamportBalances(context.rpc, signature, context.readRetry), {
    rentPayer: opened.rentPayer,
    session: opened.session,
    vault: opened.vault,
  });
  expectTrue(!(await readUntil(context.readRetry, readSession, (read) => !read.exists)).exists, "the session account is closed");
}
```

- [ ] **Step C2: Add it to the catalogue as pending, with its run, and watch it pass**

In `conformance/src/catalogue.ts`, replace

```ts
import { exampleAgentTask } from "./scenarios/22-example-agent-task.js";
```

with

```ts
import { closeAfterPaidUntil } from "./scenarios/16-close-after-paid-until.js";
import { exampleAgentTask } from "./scenarios/22-example-agent-task.js";
```

and replace `  pending(16, "Close by an unrelated key after paid_until"),` with:

```ts
  pending(16, "Close by an unrelated key after paid_until", [], "shared", closeAfterPaidUntil),
```

Run: `pnpm typecheck && pnpm e2e:local`
Expected: row `| 16. Close by an unrelated key after paid_until | local | pending | pass (make required) | ... |`;
`Status: required 3, pending 32 · Result: pass 4, fail 0, pending 30, not applicable 1`; `Make required: 1`.
If it fails, read the error and stop and report, as in Step B2.

- [ ] **Step C3: Make the tests expect scenario 16 required, and watch them fail**

In `conformance/test/catalogue.test.ts` replace `const REQUIRED = [1, 2, 22];` with `const REQUIRED = [1, 2, 16, 22];`, and make the same replacement
in `e2e/test/local-target.test.ts`.

Run: `pnpm --filter @lxfoundry/stint-conformance test catalogue.test.ts`
Expected: FAIL: scenario 16's status is `pending`.

- [ ] **Step C4: Make scenario 16 required, run, and commit**

In `conformance/src/catalogue.ts` replace `  pending(16, "Close by an unrelated key after paid_until", [], "shared", closeAfterPaidUntil),` with:

```ts
  required(16, "Close by an unrelated key after paid_until", closeAfterPaidUntil),
```

Run: `pnpm typecheck && pnpm --filter @lxfoundry/stint-conformance test && pnpm --filter @lxfoundry/stint-e2e test local-target.test.ts && pnpm e2e:local`
Expected: PASS; the report reads `Status: required 4, pending 31 · Result: pass 4, fail 0, pending 30, not applicable 1`.

```bash
git add conformance e2e
git commit -m "Run scenario 16, a close by an unrelated key after the paid time, and make it required"
```

---

#### Group D: scenario 9, disconnect, reconnect, never connect

What it proves, with three sessions of `4 × grace + 20` = 60 s run at the same time (so their grace periods overlap). The grace period is not assumed: it is the
`idleCloseSeconds` that the gate announces in its offer (10 s on the test offer; the scenario accepts 5 to 20 s).
- (a) Connected, then dropped: the session is still open 2 s after the drop, and is closed by the gate no sooner than the grace period after the drop. It is a `Standard`
  close: `paid = rate × max(minSeconds, elapsed)` with `elapsed` counted to the close on the chain's clock (about 12 s,
  so about 12,000, which is why the minimum of 5 s is not what binds), and the buyer is refunded `60,000 − paid`.
- (b) Connected, dropped, reconnected after a third of the grace period: the session is still open, and its second connection still open, 6 s after the
  first grace period would have run out; then the buyer's close pays and refunds as above, and the connection is dropped with `4410`.
- (c) Never connected: the gate closes it no sooner than the grace period after the open, with the same amounts.

Amounts depend on the chain's clock, so they are checked against spec §4.2 (`dueAt`) at the close's own `at`, and against the transaction's token transfers.

- [ ] **Step D1: Write the failing test of the grace period's reading**

Create `conformance/test/disconnect-and-grace.test.ts`:

```ts
import { STINT_PROGRAM_ADDRESS } from "@lxfoundry/stint-program-client";
import { SOLANA_DEVNET, USDC_DEVNET, buildCloseRequirements, buildOpenOffer, type PaymentRequired } from "@lxfoundry/stint-x402";
import { generateKeyPairSigner } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { idleCloseSecondsOf } from "../src/scenarios/09-disconnect-and-grace.js";

async function offers(idleCloseSeconds: number) {
  const [feePayer, rentPayer, payTo, receiverAuthorizer] = await Promise.all(
    Array.from({ length: 4 }, async () => (await generateKeyPairSigner()).address),
  );
  const base = {
    network: SOLANA_DEVNET,
    asset: USDC_DEVNET.mint,
    payTo: payTo!,
    receiverAuthorizer: receiverAuthorizer!,
    terms: { rate: 1_000n, minSeconds: 5, maxSeconds: 120 },
    facilitator: { feePayer: feePayer!, rentPayer: rentPayer!, programId: STINT_PROGRAM_ADDRESS, closeUrl: "http://127.0.0.1:1/close" },
    lifetime: { blockhash: "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N", lastValidBlockHeight: 100n },
    maxTimeoutSeconds: 30,
    idleCloseSeconds,
    closeOnOutage: true,
  };
  return {
    open: buildOpenOffer({ ...base, seconds: 30 }),
    close: buildCloseRequirements({ ...base, idleCloseSeconds: 99, session: payTo! }),
  };
}

const answer = (accepts: unknown[]) => ({ x402Version: 2, resource: { url: "http://127.0.0.1:1/sessions" }, accepts }) as PaymentRequired;

describe("idleCloseSecondsOf", () => {
  it("is the idle close of the first open offer", async () => {
    expect(idleCloseSecondsOf(answer([(await offers(7)).open]))).toBe(7);
  });

  it("skips entries that are not open offers", async () => {
    const { open, close } = await offers(7);
    expect(idleCloseSecondsOf(answer([{ scheme: "exact" }, close, open]))).toBe(7);
  });

  it("is nothing when there is no open offer", async () => {
    expect(idleCloseSecondsOf(answer([]))).toBeUndefined();
  });
});
```

Run: `pnpm --filter @lxfoundry/stint-conformance test disconnect-and-grace.test.ts`
Expected: FAIL: the module `09-disconnect-and-grace.js` does not exist.

- [ ] **Step D2: Write the scenario**

Create `conformance/src/scenarios/09-disconnect-and-grace.ts`:

```ts
import type { StintSession } from "@lxfoundry/stint-client";
import { CloseKind, dueAt, fetchMaybeSession, type ClosedEvent, type Session } from "@lxfoundry/stint-program-client";
import {
  HEADERS,
  associatedTokenAddress,
  decodePaymentRequiredHeader,
  fetchClosedEvent,
  readElapsedRequirements,
  tokenBalanceChanges,
  type PaymentRequired,
} from "@lxfoundry/stint-x402";
import { expectEqual, expectTrue, sleep, waitFor } from "../assert.js";
import { awaitClose } from "../closes.js";
import { buyerClient, closePollMs } from "../helpers.js";
import { readUntil } from "../reads.js";
import { describeError } from "../runner.js";
import type { Buyer, ScenarioContext } from "../types.js";

type Socket = Awaited<ReturnType<StintSession["connect"]>>;

/** What the three sessions share: the gate's announced grace period, and how long each session lasts, both in seconds. */
interface Shared {
  readonly context: ScenarioContext;
  readonly grace: number;
  readonly seconds: number;
}

/** The idle close announced by the first open offer of a 402 answer (spec §5.1), in seconds. */
export function idleCloseSecondsOf(required: PaymentRequired): number | undefined {
  for (const entry of required.accepts) {
    const offer = readElapsedRequirements(entry);
    if (offer?.extra.action === "open") return offer.extra.idleCloseSeconds;
  }
  return undefined;
}

/** The grace period the gate announces: how long a session may go without a connection before the gate closes it. */
async function announcedGrace(gateUrl: string): Promise<number> {
  const response = await fetch(`${gateUrl}/sessions`, { method: "POST" });
  const header = response.headers.get(HEADERS.paymentRequired);
  const required = (header ? decodePaymentRequiredHeader(header) : await response.json()) as PaymentRequired;
  const grace = idleCloseSecondsOf(required);
  expectTrue(grace !== undefined, "the gate's offer announces its idle close");
  return grace;
}

const readAccount = (context: ScenarioContext, session: StintSession) =>
  fetchMaybeSession(context.rpc, session.id, { commitment: "confirmed" });

/** Opens a session of `seconds` for the buyer, and reads what the chain stored. */
async function openSession({ context, seconds }: Shared, buyer: Buyer) {
  const session = await buyerClient(buyer).open(context.gateUrl, { seconds });
  const openedAt = Date.now();
  const account = await readUntil(context.readRetry, () => readAccount(context, session), (read) => read.exists);
  expectTrue(account.exists, "the session exists on-chain after the open");
  expectEqual(account.data.deposited, session.cost, "the deposit credited at open");
  return { session, stored: account.data, openedAt };
}

/** Connects, and records the close code the gate gives the connection. */
async function connection(session: StintSession) {
  const socket = await session.connect();
  const seen: { code?: number } = {};
  socket.on("close", (code) => {
    seen.code = code;
  });
  socket.on("error", () => {});
  return { socket, seen };
}

/** Drops a connection from the client's side, waits until it is closed, and returns when. */
async function drop(socket: Socket): Promise<number> {
  const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
  socket.close();
  await closed;
  return Date.now();
}

/**
 * A `Standard` close against spec §4.2 and the transaction itself: `max(minSeconds, elapsed)` is charged, `elapsed` counted to the
 * close on the chain's clock; the receiver gains `owed`, the buyer gets the rest of the deposit.
 */
async function expectStandardClose({ context }: Shared, buyer: Buyer, stored: Session, signature: string, closed: ClosedEvent): Promise<void> {
  expectEqual(closed.kind, CloseKind.Standard, "the close is a Standard close");
  const due = dueAt(stored, closed.at);
  expectEqual(closed.claimed + closed.owed, due, "paid = rate × max(minSeconds, elapsed)");
  expectEqual(closed.refunded, stored.deposited - due, "refunded = deposit − paid");
  expectTrue(closed.refunded > 0n, "part of the deposit is refunded");
  const changes = await tokenBalanceChanges(context.rpc, signature, context.readRetry);
  const receiverToken = await associatedTokenAddress(stored.receiver, stored.mint);
  expectEqual(changes.get(receiverToken), closed.owed, "the receiver's gain in the close");
  expectEqual(changes.get(buyer.usdcAccount), closed.refunded, "the buyer's refund in the close");
}

/** (a) Connect, drop, stay away past the grace period: the gate closes the session, no sooner than the grace period after the drop. */
async function disconnectedPastGrace(shared: Shared, buyer: Buyer): Promise<void> {
  const { context, grace } = shared;
  const { session, stored } = await openSession(shared, buyer);
  const { socket } = await connection(session);
  const droppedAt = await drop(socket);
  await sleep(2_000);
  expectTrue((await readAccount(context, session)).exists, "the session is still open while the grace period runs");
  const found = await awaitClose(
    context.rpc,
    session.id,
    context.readRetry,
    (grace + 30) * 1_000,
    "the gate closes the session after the grace period",
    closePollMs(context.target),
  );
  expectTrue(Date.now() - droppedAt >= (grace - 1) * 1_000, "the gate waited out the grace period before closing");
  await expectStandardClose(shared, buyer, stored, found.signature, found.event);
}

/** (b) Connect, drop, reconnect within the grace period: the session is kept until the buyer closes it. */
async function reconnectedWithinGrace(shared: Shared, buyer: Buyer): Promise<void> {
  const { context, grace } = shared;
  const { session, stored } = await openSession(shared, buyer);
  const first = await connection(session);
  const droppedAt = await drop(first.socket);
  await sleep(Math.ceil(grace / 3) * 1_000); // well inside the grace period
  const second = await connection(session);
  // Six seconds past the end of the first grace period: a session that the gate wrongly closed then would be gone.
  await sleep(Math.max(0, droppedAt + (grace + 6) * 1_000 - Date.now()));
  expectTrue((await readAccount(context, session)).exists, "the session is kept after the first grace period");
  expectTrue(second.socket.readyState === second.socket.OPEN, "the second connection is still open");

  const receipt = await session.close();
  const closed = await fetchClosedEvent(context.rpc, receipt.transaction, context.readRetry);
  expectTrue(closed, "the close emitted Closed");
  expectEqual(receipt.paid, closed.claimed + closed.owed + closed.redirected, "paid, as the gate reported it");
  expectEqual(receipt.refunded, closed.refunded, "refunded, as the gate reported it");
  await expectStandardClose(shared, buyer, stored, receipt.transaction, closed);
  await waitFor(() => second.seen.code === 4410, 5_000, "the connection is dropped with 4410");
}

/** (c) Never connect: the gate closes the session, no sooner than the grace period after the open. */
async function neverConnected(shared: Shared, buyer: Buyer): Promise<void> {
  const { context, grace } = shared;
  const { session, stored, openedAt } = await openSession(shared, buyer);
  const found = await awaitClose(
    context.rpc,
    session.id,
    context.readRetry,
    (grace + 30) * 1_000,
    "the gate closes a session that was never connected, after the grace period",
    closePollMs(context.target),
  );
  expectTrue(Date.now() - openedAt >= (grace - 1) * 1_000, "the gate waited out the grace period before closing");
  await expectStandardClose(shared, buyer, stored, found.signature, found.event);
}

/**
 * Scenario 9 (spec §12.7): disconnect past the grace period; reconnect within it; never connect. Closed and refunded;
 * kept; closed and refunded. The three sessions run at the same time, each with its own buyer.
 */
export async function disconnectAndGrace(context: ScenarioContext): Promise<void> {
  const grace = await announcedGrace(context.gateUrl);
  expectTrue(grace >= 5 && grace <= 20, `the gate announces an idle close of ${grace} s: the test offer of spec §12.6 needs 5 to 20 s`);
  const shared: Shared = { context, grace, seconds: 4 * grace + 20 };
  const branches: readonly (readonly [string, (shared: Shared, buyer: Buyer) => Promise<void>])[] = [
    ["disconnected past the grace period", disconnectedPastGrace],
    ["reconnected within the grace period", reconnectedWithinGrace],
    ["never connected", neverConnected],
  ];
  const buyers: Buyer[] = [];
  for (let index = 0; index < branches.length; index++) buyers.push(await context.newBuyer(100_000n)); // a session costs 60,000

  const results = await Promise.allSettled(branches.map(([, branch], index) => branch(shared, buyers[index]!)));
  const failures = results.flatMap((result, index) =>
    result.status === "rejected" ? [`${branches[index]![0]}: ${describeError(result.reason)}`] : [],
  );
  if (failures.length > 0) throw new Error(failures.join("; "));
}
```

- [ ] **Step D3: Run the grace period test, add the scenario to the catalogue as pending, and watch it pass**

Run: `pnpm --filter @lxfoundry/stint-conformance test disconnect-and-grace.test.ts && pnpm --filter @lxfoundry/stint-conformance typecheck`
Expected: PASS (3 tests).

In `conformance/src/catalogue.ts`, replace

```ts
import { closeBeforeMinSeconds } from "./scenarios/02-close-before-min-seconds.js";
```

with

```ts
import { closeBeforeMinSeconds } from "./scenarios/02-close-before-min-seconds.js";
import { disconnectAndGrace } from "./scenarios/09-disconnect-and-grace.js";
```

and replace `  pending(9, "Disconnect past the grace period; reconnect within it; never connect"),` with:

```ts
  pending(9, "Disconnect past the grace period; reconnect within it; never connect", [], "shared", disconnectAndGrace),
```

Run: `pnpm typecheck && pnpm e2e:local`
Expected: row `| 9. Disconnect past the grace period; reconnect within it; never connect | local | pending | pass (make required) | ... |`;
`Status: required 4, pending 31 · Result: pass 5, fail 0, pending 29, not applicable 1`; `Make required: 1`.
This is the first scenario that lists a closed session's transactions, which Group 0 probed on the local node. If it fails, the error names the
branch and the check (the three branches are reported together, in one error); do not weaken an assertion: stop and report which observation did not hold.

- [ ] **Step D4: Make the tests expect scenario 9 required, and watch them fail**

In `conformance/test/catalogue.test.ts` and in `e2e/test/local-target.test.ts`, replace `const REQUIRED = [1, 2, 16, 22];` with `const REQUIRED = [1, 2, 9, 16, 22];`.

Run: `pnpm --filter @lxfoundry/stint-conformance test catalogue.test.ts`
Expected: FAIL: scenario 9's status is `pending`.

- [ ] **Step D5: Make scenario 9 required, run, and commit**

In `conformance/src/catalogue.ts` replace `  pending(9, "Disconnect past the grace period; reconnect within it; never connect", [], "shared", disconnectAndGrace),` with:

```ts
  required(9, "Disconnect past the grace period; reconnect within it; never connect", disconnectAndGrace),
```

Run: `pnpm typecheck && pnpm --filter @lxfoundry/stint-conformance test && pnpm --filter @lxfoundry/stint-e2e test local-target.test.ts && pnpm e2e:local`
Expected: PASS; `Status: required 5, pending 30 · Result: pass 5, fail 0, pending 29, not applicable 1`.

```bash
git add conformance e2e
git commit -m "Run scenario 9, disconnect and the grace period, and make it required"
```

---

#### Group E: scenario 3, expiry

What it proves: a 10 s session (10,000) is connected and subscribed to a watched token account that the scenario keeps changing with 1-base-unit payments from a payer
until the connection ends.
- Frames about the account arrive before `paid_until`, and none arrives more than 5 s after it (spec §12.7: forwarding stops within 5 s). The
  second check is as strong as the time the close takes: when the close is fast, the closed connection satisfies it; when the close is slow, the payments
  go on and any frame the gate still forwards shows up.
- The connection is dropped with `4402` within 30 s of `paid_until`.
- The close is on-chain: `AtExpiry`, its `paid_until` is the one the open reported and the chain's clock had reached it, `claimed + owed` = the deposit (10 × 1,000 = 10,000),
  `refunded` and `redirected` 0, the receiver gained exactly `owed`, the buyer gained nothing, the rent returned to the session's rent payer, and the account is gone.

The watched account is a third buyer's, created before the subscription as in scenario 22, so that the buyer's own account (the refund account) is not mixed into the payments.

- [ ] **Step E1: Write the scenario**

Create `conformance/src/scenarios/03-expiry.ts`:

```ts
import { CloseKind, fetchMaybeSession } from "@lxfoundry/stint-program-client";
import { associatedTokenAddress, lamportBalances, tokenBalanceChanges } from "@lxfoundry/stint-x402";
import { expectEqual, expectTrue, sleep, waitFor } from "../assert.js";
import { awaitClose } from "../closes.js";
import { buyerClient, closePollMs, sessionSeconds } from "../helpers.js";
import { readUntil } from "../reads.js";
import type { ScenarioContext } from "../types.js";
import { assertRentReturned, receivedAmount } from "./22-example-agent-task.js";

/**
 * Scenario 3 (spec §12.7): expiry. The paid time runs out while the buyer is connected: forwarding stops within 5 s of `paidUntil`,
 * and the close is confirmed and `4402` sent within 30 s. The session is closed with `AtExpiry`, which pays the receiver all of the deposit.
 */
export async function expiry(context: ScenarioContext): Promise<void> {
  const buyer = await context.newBuyer(100_000n); // the session costs 10,000 (20,000 on devnet)
  const payer = await context.newBuyer(1_000n);
  // The watched account exists before the subscription: the node then sends one message per change (scenario 22).
  const watched = await context.newBuyer(0n);
  const session = await buyerClient(buyer).open(context.gateUrl, { seconds: sessionSeconds(context.target, 10) });
  const readSession = () => fetchMaybeSession(context.rpc, session.id, { commitment: "confirmed" });
  const account = await readUntil(context.readRetry, readSession, (read) => read.exists);
  expectTrue(account.exists, "the session exists on-chain after the open");
  const stored = account.data;
  expectEqual(stored.deposited, session.cost, "the deposit credited at open");
  const vault = await associatedTokenAddress(session.id, stored.mint);
  const paidUntilMs = session.paidUntil * 1_000;

  const seen = { frames: [] as number[], closeCode: undefined as number | undefined, paymentFailure: undefined as unknown };
  const socket = await session.connect();
  socket.on("message", (data) => {
    try {
      if (receivedAmount(JSON.parse(String(data)), watched.usdcAccount) !== undefined) seen.frames.push(Date.now());
    } catch {
      // not JSON, so not a frame about the account
    }
  });
  socket.on("close", (code) => {
    seen.closeCode = code;
  });
  socket.on("error", () => {});
  socket.send(JSON.stringify({ op: "subscribe", accounts: [watched.usdcAccount] }));
  await sleep(context.subscriptionSettleMs); // the subscription is in place before the first payment

  // Keep the watched account changing until the connection ends: whatever the gate forwards after paid_until shows up as a frame.
  let paying = true;
  const payments = (async () => {
    try {
      while (paying) {
        await context.sendUsdc(payer, watched.usdcAccount, 1n);
        await sleep(500);
      }
    } catch (error) {
      seen.paymentFailure = error;
    }
  })();
  try {
    await waitFor(
      () => seen.closeCode !== undefined,
      Math.max(1_000, paidUntilMs + 30_000 - Date.now()),
      "the connection is closed within 30 s of paid_until",
    );
  } finally {
    paying = false;
    await payments;
    socket.terminate();
  }
  expectEqual(seen.closeCode, 4402, "the connection is dropped with 4402");
  expectTrue(seen.paymentFailure === undefined, "every payment that changed the watched account went through");
  expectTrue(
    seen.frames.some((at) => at <= paidUntilMs),
    "frames about the watched account arrived before paid_until",
  );
  expectEqual(seen.frames.filter((at) => at > paidUntilMs + 5_000).length, 0, "no frame arrived more than 5 s after paid_until");

  const found = await awaitClose(context.rpc, session.id, context.readRetry, 15_000, "the expiry close is on-chain", closePollMs(context.target));
  const { event } = found;
  expectEqual(event.kind, CloseKind.AtExpiry, "the session is closed with AtExpiry");
  expectEqual(event.paidUntil, BigInt(session.paidUntil), "the close's paid_until is the one the open reported");
  expectTrue(event.at >= event.paidUntil, "the chain's clock had reached paid_until at the close");
  // 10 s at 1,000 a second is 10,000: all of it is earned at paid_until, so the receiver is paid it all and nothing is refunded.
  expectEqual(event.claimed + event.owed, stored.deposited, "the receiver is paid the whole deposit");
  expectEqual(event.refunded + event.redirected, 0n, "nothing is refunded");
  const changes = await tokenBalanceChanges(context.rpc, found.signature, context.readRetry);
  const receiverToken = await associatedTokenAddress(stored.receiver, stored.mint);
  expectEqual(changes.get(receiverToken), event.owed + event.redirected, "the receiver's gain in the close");
  expectEqual(changes.get(buyer.usdcAccount) ?? 0n, 0n, "the buyer gains nothing in the close");
  assertRentReturned(await lamportBalances(context.rpc, found.signature, context.readRetry), {
    rentPayer: stored.rentPayer,
    session: session.id,
    vault,
  });
  expectTrue(!(await readUntil(context.readRetry, readSession, (read) => !read.exists)).exists, "the session account is closed");
}
```

- [ ] **Step E2: Add it to the catalogue as pending, with its run, and watch it pass**

In `conformance/src/catalogue.ts`, replace

```ts
import { closeBeforeMinSeconds } from "./scenarios/02-close-before-min-seconds.js";
```

with

```ts
import { closeBeforeMinSeconds } from "./scenarios/02-close-before-min-seconds.js";
import { expiry } from "./scenarios/03-expiry.js";
```

and replace `  pending(3, "Expiry"),` with:

```ts
  pending(3, "Expiry", [], "shared", expiry),
```

Run: `pnpm typecheck && pnpm e2e:local`
Expected: row `| 3. Expiry | local | pending | pass (make required) | ... |` (about 15 to 25 s);
`Status: required 5, pending 30 · Result: pass 6, fail 0, pending 28, not applicable 1`; `Make required: 1`.
If it fails, read the error and stop and report, as in Step B2.

- [ ] **Step E3: Make the tests expect scenario 3 required, and watch them fail**

In `conformance/test/catalogue.test.ts` and in `e2e/test/local-target.test.ts`, replace `const REQUIRED = [1, 2, 9, 16, 22];` with `const REQUIRED = [1, 2, 3, 9, 16, 22];`.

Run: `pnpm --filter @lxfoundry/stint-conformance test catalogue.test.ts`
Expected: FAIL: scenario 3's status is `pending`.

- [ ] **Step E4: Make scenario 3 required, run, and commit**

In `conformance/src/catalogue.ts` replace `  pending(3, "Expiry", [], "shared", expiry),` with:

```ts
  required(3, "Expiry", expiry),
```

Run: `pnpm typecheck && pnpm --filter @lxfoundry/stint-conformance test && pnpm --filter @lxfoundry/stint-e2e test local-target.test.ts && pnpm e2e:local`
Expected: PASS; `Status: required 6, pending 29 · Result: pass 6, fail 0, pending 28, not applicable 1`.

```bash
git add conformance e2e
git commit -m "Run scenario 3, expiry, and make it required"
```

---

#### Group F: scenario 26, an expired session that nobody closes

What it proves: a 12 s session (12,000) is opened through the gate, the gate is stopped, and nobody else is told. The session names the facilitator's rent payer, so
the sweeper owns it. The sweeper runs every 2 s on the local target and every 5 s on the devnet target, so a 30 s window after `paid_until`
covers both. Within that window the sweeper closes it: `AtExpiry`, signed by the rent payer (`closedBy` is `context.stack.rentPayer`, which a gate close, signed by the receiver authorizer, could not be),
`claimed + owed` = the deposit (12,000), nothing refunded, the receiver gained exactly `owed`, the rent returned to the rent payer, the account gone. The gate is started again
in a `finally`, whatever happened, so the scenarios after this one still have a gate at the same address.

Spec §12.2 puts scenario 26 in the own-stack group; here it runs on the common stack, which is safe only while the runner runs one
scenario at a time (see "What this stage builds, and what it leaves for later"). The scenario's file says so where it stops the gate.

The session lasts 12 s and not less because its `paid_until` comes from the chain's clock, which in clock mode follows the wall clock but falls
behind when blocks are late (spec §12.3), while the scenario's `paid_until` guard compares it with the wall clock: the slack keeps the guard
from failing on a late block. The idle guard counts from the wall clock before the open, as the gate's idle timer does, and not from the
chain's `startedAt`. The buyer is funded with 100,000 base units, which covers the deposit (12,000, or 22,000 on `devnet`) with room to spare.

- [ ] **Step F1: Write the failing test of the gate's restart**

`whileGateStopped` is what keeps a failed scenario from leaving the gate down for the scenarios after it, so it has its own test. Create
`conformance/test/expired-session-nobody-closes.test.ts`:

```ts
import type { Address } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { whileGateStopped } from "../src/scenarios/26-expired-session-nobody-closes.js";
import type { StackControl } from "../src/types.js";

/** A stack that records what is done to its gate. */
const recording = (calls: string[]): StackControl => ({
  rentPayer: "RENT" as Address,
  stopGate: async () => void calls.push("stop"),
  startGate: async () => void calls.push("start"),
});

describe("whileGateStopped", () => {
  it("stops the gate, runs the work, starts the gate again, and returns what the work returned", async () => {
    const calls: string[] = [];
    expect(await whileGateStopped(recording(calls), async () => calls.push("work"))).toBe(2);
    expect(calls).toEqual(["stop", "work", "start"]);
  });

  it("starts the gate again, and rethrows, when the work throws", async () => {
    const calls: string[] = [];
    const failing = async () => {
      calls.push("work");
      throw new Error("no close");
    };
    await expect(whileGateStopped(recording(calls), failing)).rejects.toThrow("no close");
    expect(calls).toEqual(["stop", "work", "start"]);
  });
});
```

Run: `pnpm --filter @lxfoundry/stint-conformance test expired-session-nobody-closes.test.ts`
Expected: FAIL: the module `26-expired-session-nobody-closes.js` does not exist.

- [ ] **Step F2: Write the scenario**

Create `conformance/src/scenarios/26-expired-session-nobody-closes.ts`:

```ts
import { CloseKind, fetchMaybeSession } from "@lxfoundry/stint-program-client";
import { associatedTokenAddress, lamportBalances, tokenBalanceChanges } from "@lxfoundry/stint-x402";
import { expectEqual, expectTrue } from "../assert.js";
import { awaitClose } from "../closes.js";
import { buyerClient, closePollMs, sessionSeconds } from "../helpers.js";
import { readUntil } from "../reads.js";
import type { ScenarioContext, StackControl } from "../types.js";
import { assertRentReturned } from "./22-example-agent-task.js";

/**
 * Runs `work` with the gate stopped, and starts the gate again afterwards, whatever happened. The gate is the run's common
 * one: spec §12.2 gives scenario 26 a stack of its own, and stopping the common gate is safe only because the runner runs
 * one scenario at a time. When the runner runs scenarios concurrently, scenario 26 needs a stack of its own.
 */
export async function whileGateStopped<T>(stack: StackControl, work: () => Promise<T>): Promise<T> {
  await stack.stopGate();
  try {
    return await work();
  } finally {
    await stack.startGate();
  }
}

/**
 * Scenario 26 (spec §12.7): an expired session that nobody closes, because the gate is stopped. The sweeper closes it with
 * `AtExpiry`: the receiver is paid, and the rent returns to the rent payer.
 */
export async function expiredSessionNobodyCloses(context: ScenarioContext): Promise<void> {
  const stack = context.stack;
  if (!stack) throw new Error("scenario 26 needs a target that provides stack control");
  const buyer = await context.newBuyer(100_000n); // the session costs 12,000 (22,000 on devnet): the funding key lends no more than that
  const openedAt = Date.now();
  const session = await buyerClient(buyer).open(context.gateUrl, { seconds: sessionSeconds(context.target, 12) });
  const readSession = () => fetchMaybeSession(context.rpc, session.id, { commitment: "confirmed" });
  const account = await readUntil(context.readRetry, readSession, (read) => read.exists);
  expectTrue(account.exists, "the session exists on-chain after the open");
  const stored = account.data;
  expectEqual(stored.deposited, session.cost, "the deposit credited at open");
  expectEqual(stored.rentPayer, stack.rentPayer, "the session names the facilitator's rent payer: the sweeper's to close");
  const vault = await associatedTokenAddress(session.id, stored.mint);
  const paidUntilMs = session.paidUntil * 1_000;
  // Were the gate still running at paid_until it would close the session itself, which is not what this scenario is about.
  // The gate's end timer compares paid_until with its own clock, as this check does.
  expectTrue(paidUntilMs - Date.now() > 3_000, "the gate is stopped at least 3 s before paid_until: the open took too long");
  // Nor may the gate close it for want of a connection: the test offer's idleCloseSeconds is 10, counted on the gate's clock
  // from when the open settled, which is after openedAt. The chain's startedAt would not do: the chain's clock can lag.
  expectTrue(Date.now() < openedAt + 7_000, "the gate is stopped at least 3 s before its idle close: the open took too long");

  // The sweeper lists every 2 s on the local target and every 5 s on the devnet target, and a sweep takes a few seconds to close: 30 s after
  // paid_until covers both. The wait starts when the gate is down, so it also counts the time left until paid_until.
  const found = await whileGateStopped(stack, () =>
    awaitClose(
      context.rpc,
      session.id,
      context.readRetry,
      Math.max(0, paidUntilMs - Date.now()) + 30_000,
      "the sweeper closes the session within 30 s of paid_until",
      closePollMs(context.target),
    ),
  );
  const { event } = found;
  expectEqual(event.kind, CloseKind.AtExpiry, "the sweeper closes with AtExpiry");
  expectEqual(event.closedBy, stack.rentPayer, "the close was signed by the facilitator's rent payer, as the sweeper does");
  expectTrue(event.at >= event.paidUntil, "the chain's clock had reached paid_until at the close");
  // 12 s at 1,000 a second is 12,000: all of it is earned at paid_until, so the receiver is paid it all and nothing is refunded.
  expectEqual(event.claimed + event.owed, stored.deposited, "the receiver is paid the whole deposit");
  expectEqual(event.refunded + event.redirected, 0n, "nothing is refunded");
  const changes = await tokenBalanceChanges(context.rpc, found.signature, context.readRetry);
  const receiverToken = await associatedTokenAddress(stored.receiver, stored.mint);
  expectEqual(changes.get(receiverToken), event.owed + event.redirected, "the receiver's gain in the close");
  assertRentReturned(await lamportBalances(context.rpc, found.signature, context.readRetry), {
    rentPayer: stack.rentPayer,
    session: session.id,
    vault,
  });
  expectTrue(!(await readUntil(context.readRetry, readSession, (read) => !read.exists)).exists, "the session account is closed");
}
```

- [ ] **Step F3: Add it to the catalogue as pending, with its run, and watch it pass**

In `conformance/src/catalogue.ts`, replace

```ts
import { exampleAgentTask } from "./scenarios/22-example-agent-task.js";
```

with

```ts
import { exampleAgentTask } from "./scenarios/22-example-agent-task.js";
import { expiredSessionNobodyCloses } from "./scenarios/26-expired-session-nobody-closes.js";
```

and replace `  pending(26, "An expired session that nobody closes", ["stack"], "ownStack"),` with:

```ts
  pending(26, "An expired session that nobody closes", ["stack"], "ownStack", expiredSessionNobodyCloses),
```

The runner's doc comment says the isolation groups arrive with the first scenarios that need them; scenario 26 needs
one and runs without it, so the comment now says what the runner does instead. In `conformance/src/runner.ts`, replace

```ts
/**
 * Runs scenarios one after another, in the order of their numbers. Concurrency and the isolation
 * groups of spec section 12.2 arrive with the first scenarios that need them.
 */
```

with

```ts
/**
 * Runs scenarios one after another, in the order of their numbers. Concurrency and the isolation
 * groups of spec section 12.2 are not built: a scenario's `group` is not acted on. Scenario 26, of
 * the own-stack group, stops and restarts the common gate, which is safe only because no other
 * scenario runs meanwhile. A scenario that times out is not cancelled, so a later scenario may run
 * while its work goes on: after a timed-out scenario 26, it may find the gate stopped.
 */
```

Run: `pnpm --filter @lxfoundry/stint-conformance test expired-session-nobody-closes.test.ts && pnpm typecheck && pnpm e2e:local`
Expected: the restart test passes (2 tests); the row `| 26. An expired session that nobody closes | local | pending | pass (make required) | ... |` (about 15 to 25 s);
`Status: required 6, pending 29 · Result: pass 7, fail 0, pending 27, not applicable 1`; `Make required: 1`.
If it fails, read the error and stop and report, as in Step B2. A failure of `startGate` in the `finally` replaces the scenario's own error, and
the harness keeps no log of the gate or the facilitator, so look at what a failed run does keep: the scenario's error in `e2e/report/report.md`,
Kora's log in `e2e/report/kora.log`, and when the session account closed on-chain (the `at` of its `Closed` event, against its `paid_until`),
which tells a sweeper that never ran from a sweeper that ran late.

- [ ] **Step F4: Make the tests expect scenario 26 required, and watch them fail**

In `conformance/test/catalogue.test.ts` and in `e2e/test/local-target.test.ts`, replace `const REQUIRED = [1, 2, 3, 9, 16, 22];` with `const REQUIRED = [1, 2, 3, 9, 16, 22, 26];`.

Run: `pnpm --filter @lxfoundry/stint-conformance test catalogue.test.ts`
Expected: FAIL: scenario 26's status is `pending`.

- [ ] **Step F5: Make scenario 26 required, run, and commit**

In `conformance/src/catalogue.ts` replace `  pending(26, "An expired session that nobody closes", ["stack"], "ownStack", expiredSessionNobodyCloses),` with:

```ts
  required(26, "An expired session that nobody closes", expiredSessionNobodyCloses, ["stack"], "ownStack"),
```

Run: `pnpm typecheck && pnpm --filter @lxfoundry/stint-conformance test && pnpm --filter @lxfoundry/stint-e2e test local-target.test.ts && pnpm e2e:local`
Expected: PASS; the report reads `Status: required 7, pending 28 · Result: pass 7, fail 0, pending 27, not applicable 1`, with no "Make required" line. Run `pnpm e2e:local` three times
in a row: all seven pass each time.

```bash
git add conformance e2e
git commit -m "Run scenario 26, an expired session that nobody closes, and make it required, with a test of the gate's restart"
```

---

#### Group G: the required scenarios on the devnet target's stack

The devnet target's tests run the stack that the `devnet` target builds, against the local network, under the local name. Scenario 22's check of a message's
slot, and the longer sessions that scenarios 3, 16 and 26 buy on a real network (`sessionSeconds`), apply only to a target named `devnet`, so they stay out of this run; the keys, the sweeper and the gate are the ones the devnet target builds.

- [ ] **Step G1: Run all seven required scenarios there**

In `e2e/test/devnet-target.test.ts`, replace the test that begins `it("passes scenarios 1 and 22 with buyers funded from the funding key"`,
from its `it(` line through its closing `}, 120_000);`, which Task 5 leaves as it is (it adds a test after it, `gives its context stack control and
direct sessions...`, which stays). The old test reads

```ts
  it("passes scenarios 1 and 22 with buyers funded from the funding key", async () => {
    // The local network reports a subscription's slot, not the change's (T6): scenario 22 asserts
    // on the slot only when the target is named devnet, so it runs here under the local name.
    const asLocal: Target = { name: "local", capabilities: stack.target.capabilities };
    const outcomes = await runScenarios(
      catalogue.filter((scenario) => scenario.id === 1 || scenario.id === 22),
      asLocal,
      () => ({ ...stack.context(), target: asLocal }),
    );
    expect(outcomes.map((outcome) => [outcome.id, outcome.result, outcome.error])).toEqual([
      [1, "pass", undefined],
      [22, "pass", undefined],
    ]);
  }, 120_000);
```

and the new one is

```ts
  it("passes the required scenarios with buyers funded from the funding key", async () => {
    // The local network reports a subscription's slot, not the change's (T6): scenario 22 asserts on the slot only when the
    // target is named devnet, so the scenarios run here under the local name. Together they take about two minutes.
    const required = [1, 2, 3, 9, 16, 22, 26];
    const asLocal: Target = { name: "local", capabilities: stack.target.capabilities };
    const outcomes = await runScenarios(
      catalogue.filter((scenario) => required.includes(scenario.id)),
      asLocal,
      () => ({ ...stack.context(), target: asLocal }),
    );
    expect(outcomes.map((outcome) => [outcome.id, outcome.result, outcome.error])).toEqual(required.map((id) => [id, "pass", undefined]));
  }, 300_000);
```

Run: `pnpm --filter @lxfoundry/stint-e2e test devnet-target.test.ts`
Expected: PASS, the whole file. The test after this one still finds exactly one session on-chain after it opens its own: every scenario's session was closed. If the later test
"closes a session left open at the end..." fails with a lamport difference, the scenarios spent more of the funding key's SOL than its 0.005 SOL allowance: read the amounts before raising it.

- [ ] **Step G2: Commit**

```bash
git add e2e/test/devnet-target.test.ts
git commit -m "Run every required scenario on the devnet target's stack"
```

---

#### Group H: documentation

- [ ] **Step H1: The README's Status**

In `README.md`, replace

```
Work in progress. Working today: the Solana program, deployed on devnet (`open`, and `close`, which pays the
seller for the time used and refunds the rest); the x402 `elapsed` scheme; the facilitator, the gate, the
client library, an MCP server and an example agent. Two of the 35 end-to-end scenarios of the
[specification](docs/specs/stint-system.md) (section 12.7) pass, on a local network and on devnet, and the run
report lists the other 33 as pending. Not built yet: sessions that run to their end and the sweeper that closes
them, top-ups, refusals of bad payments and settlement records, fallback closes, and resilience across restarts.
The [plans](docs/plans/README.md) list the stages that remain.
```

with

```
Work in progress. Working today: the Solana program (`open`, `claim`, and `close`, which pays the seller for the
time used, or for the whole paid time once it has run out, and refunds the rest; the devnet deployment is of the
earlier version, with `open` and the standard close only, until it is upgraded); the x402 `elapsed` scheme; the
facilitator with its sweeper, the gate with its timers, the client library, an MCP server and an example agent.
A session ends by itself: the gate drops its connection with `4402` when the paid time runs out, closes a session
that nobody connects to, and the sweeper closes any expired session that nobody closed. Seven of the 35 end-to-end
scenarios of the [specification](docs/specs/stint-system.md) (section 12.7) pass on a local network, two of them
(1 and 22) also on devnet, and the run report lists the other 28 as pending. Not built yet: top-ups, fallback
closes, refusals of bad payments and settlement records, and resilience across restarts.
The [plans](docs/plans/README.md) list the stages that remain.
```

(The line "Scenarios 1 and 22 pass on devnet." in "Running the scenarios on devnet" stays true until the devnet program is upgraded and the seven are run there.)

The facilitator's sweeper now asks the scan endpoint too. In `README.md`, in the item for `STINT_DEVNET_SCAN_RPC_URL` under `## Running the scenarios on devnet`, replace the words `It is asked three times per run (a devnet check, then the listing at the start and at the end), and the rest goes to` with `It is asked for the clean-up's listings (at the start and at the end of a run) and by the facilitator's sweeper, every 5 s while a run lasts, and the rest goes to` (the paragraph wraps: match on the words). In `.env.example`, replace `It is asked three times per run.` with `It is asked for the clean-up's listings and by the facilitator's sweeper, every 5 s while a run lasts.`

- [ ] **Step H2: The specification, four edits**

In `docs/specs/stint-system.md`, §4.3, in the description of `claim()`, replace

```
- Emits `Claimed`.
```

where it follows `claimed = earned(now)` (the line under `claim()`, not the ones under `open()` and `top_up()`),
with

```
- Emits `Claimed` when it transfers something; a claim that finds nothing newly earned succeeds and emits nothing.
```

In §7.3, in the row `End timer fires`, replace

```
Re-read the session at `confirmed`. If `paid_until` moved, reset the timer. Otherwise stop forwarding and close. On `NotExpired`, re-read: if `paid_until` moved (a top-up landed), resume forwarding and reset the timer; if not (the chain's clock is behind), retry. Once the close is confirmed, drop connections (`4402`)
```

(the row's whole second cell, as it reads at present) with

```
Stop forwarding (the gate discards what the resource sends to a connection, and forwards again if the session continues). Re-read the session at `confirmed`. If the account is gone, or holds another session (another `started_at`, or terms the gate does not offer: an account opened again at the address after a close, section 4.1), the session the gate tracks has ended: drop its connections (`4402`), with no close. If `paid_until` moved on the same session, resume forwarding and reset the timer. Otherwise close. On `NotExpired`, re-read the same way: gone or another session, drop the connections (`4402`); `paid_until` moved on the same session (a top-up landed), resume forwarding and reset the timer; neither (the chain's clock is behind), retry. Once the close is confirmed, drop connections (`4402`)
```

The whole cell changes because a session opened again at the address must not reach either branch that resumes or
closes: the gate ends the session it tracks, without a close, both at the first re-read and at the re-read after
`NotExpired`. A top-up keeps `started_at` and the terms, so it is the one way `paid_until` moves on the same session.

In §6.4, after the last paragraph, `It runs on one elected instance, or on all of them tolerating duplicates: a second close finds the` / `account gone and is skipped.`, replace

```
It runs on one elected instance, or on all of them tolerating duplicates: a second close finds the
account gone and is skipped.
```

with

```
It runs on one elected instance, or on all of them tolerating duplicates: a second close finds the
account gone and is skipped.

It lists sessions through an endpoint that may differ from the facilitator's main one (`scanRpcUrl`), because
a provider's free tier can refuse the listing of a program's accounts.
```

In §12.2, in the bullet `Stack control`, replace

```
  restart or add instances of them.
```

with

```
  restart or add instances of them. In particular, it can stop the gate and start it again on the same
  address while the facilitator, its sweeper and Kora keep running (scenario 26).
```

- [ ] **Step H3: The plan index**

In `docs/plans/README.md`, replace

```
| 4 | End of session: `claim`, `AtExpiry`, the gate's timers, the sweeper | 2, 3, 9, 16, 26 | — | |
```

with

```
| 4 | End of session: `claim`, `AtExpiry`, the gate's timers, the sweeper | 2, 3, 9, 16, 26 | — | [04-end-of-session.md](04-end-of-session.md) |
```

- [ ] **Step H4: Run everything and commit**

Run: `pnpm typecheck && pnpm test && pnpm e2e:local`
Expected: PASS; the report reads `Status: required 7, pending 28 · Result: pass 7, fail 0, pending 27, not applicable 1`.

```bash
git add README.md .env.example docs/specs/stint-system.md docs/plans/README.md
git commit -m "Describe the end of a session in the README, the specification and the plan index"
```

---

### Task 7: Upgrade the devnet program and run the required scenarios there

This task is done with the person who holds the keys. It changes no code except the timing and configuration values that its rules allow: it upgrades
the program on devnet to the build of Tasks 1 to 6, checks the bytes, runs the seven required scenarios on
devnet, and records the result.

**Files:**
- Modify: `README.md` (the devnet section: the deployed hash and the scenarios that pass there), and a timing or configuration value, if the run measures one that must change

**Interfaces:**
- Consumes: Task 1's program, Tasks 2 to 6's services and scenarios, `scripts/deploy-devnet.sh`,
  `scripts/verify-deployment.sh`, `pnpm e2e:devnet`, and the keys of "Before you start".
- Produces: the upgraded program on devnet, its verified hash, and a devnet run in which every required
  scenario passes.

**Rules for this task.**
- A change to a **timing or a configuration value** (a retry count, a poll interval, the sweeper interval, a
  time-out, an amount of SOL, the minimum of the devnet offer, how long a scenario waits for something to
  happen) is made here, with a commit that says what it measured. A wait may be lengthened only to what
  devnet was measured to take; what a scenario checks is never changed.
- A change to an **assertion**, a scenario's checks, the gate, the facilitator, the client or the program is not
  made here. If a scenario fails on devnet for a reason that is not timing or configuration, stop and report:
  the failure is a finding about the design. Do not weaken a check to get a green run.
- Never put a key, the seed, or an RPC URL with its API key into a commit, a log that is committed, or a pull
  request.

- [ ] **Step 1: [Operator] Build the program verifiably**

From the repository root, in WSL, on the stage's branch:

```bash
anchor build --verifiable        # needs Docker; writes target/verifiable/stint.so
```

Expected: `target/verifiable/stint.so` exists. It is larger than the previous build (about 176,952 bytes) by the
size of `claim`. The dry run of Step 2 checks its ELF header (SBPF v3).

- [ ] **Step 2: [Operator] Dry-run the upgrade, then upgrade**

```bash
env_value() { grep "^$1=" .env.devnet | cut -d= -f2- | sed 's/[[:space:]]#.*$//' | tr -d "'\"\r"; }
url="$(env_value STINT_DEVNET_RPC_URL)"    # read from the file: typed in, the URL (which may carry an API key) would stay in the shell history
scripts/deploy-devnet.sh --payer ~/.config/stint/devnet.json --upgrade-authority ~/.config/stint/upgrade-authority.json --program target/verifiable/stint.so --url "$url" --dry-run
scripts/deploy-devnet.sh --payer ~/.config/stint/devnet.json --upgrade-authority ~/.config/stint/upgrade-authority.json --program target/verifiable/stint.so --url "$url"
```

The script also reads the program keypair `target/deploy/stint-keypair.json`, the one of the first deployment
(`anchor build --verifiable` does not create it). Expected: the dry run prints the checks and the command it
would run, and sends nothing. The second command
upgrades the program in place and extends its data account, which the larger build needs: it needs the SOL of
the buffer (returned) and of the extension (kept). If it ends with `Max retries exceeded`, the endpoint is too
throttled: close the buffer it names with `solana program close <buffer> --url "$url" --keypair
~/.config/stint/devnet.json --authority ~/.config/stint/upgrade-authority.json` (the buffer's authority is the
upgrade authority) and run it again on a provider URL.

- [ ] **Step 3: Verify the deployed bytes**

```bash
scripts/verify-deployment.sh target/verifiable/stint.so
```

Expected: `devnet program 5iCYPq… is target/verifiable/stint.so (sha256 …, … bytes)`. Keep the line: the
hash goes in the pull request and in the README.

- [ ] **Step 4: [Operator] Run the scenarios on devnet**

```bash
pnpm e2e:devnet
```

Expected: the preflight passes, the report prints, and it reads `Status: required 7, pending 28 · Result: pass
7, fail 0, pending 25, not applicable 3`, the process ends by itself with exit status 0 and no `clean-up
problems` on stderr. The run takes several minutes: scenarios 3, 16 and 26 wait for a paid time to run out, and
scenario 9 for grace periods (its sessions last a minute). It ends with a line `after clean-up, funding key …
holds … USDC base units`: the USDC figure must be the one the run started with, and the lamports must differ by
fees only.

If a scenario fails, the report names it and the check, and `e2e/report/kora.log` holds Kora's log (git-ignored;
every URL in it is cut to its host). The harness does not capture the facilitator's or the gate's own log: what a
failed run keeps is the report, each scenario's error and Kora's log; an explorer shows when a session's account
closed. Diagnose by the symptom:

| Symptom | Likely cause | What to do |
|---|---|---|
| Scenario 26 times out | The sweeper did not close the session: its interval (5 s on devnet) and the confirmation outlasted the scenario's wait | Lengthen the scenario's wait by the measured delay; never shorten the check. If the provider refuses `getProgramAccounts`, the start-up clean-up fails first: set `STINT_DEVNET_SCAN_RPC_URL=https://api.devnet.solana.com` in `.env.devnet` |
| Scenario 3: `4402` not received within 30 s | Confirmations are slow, or the devnet clock lags the gate's, so the gate's `AtExpiry` close fails with `NotExpired` and is retried every `endRetrySeconds` | A `4402` later than the 30 s after `paid_until` that the specification allows is a finding about the design: stop and report it. Only the slack that `awaitClose` adds for the chain to confirm (15 s) may be lengthened, to the observed lag |
| Scenario 2: the check that the close came before `minSeconds` fails | Devnet's latency between the open's block and the close's block exceeded the minimum (5 s on the test offer) | Run once more. If it recurs, raise the minimum of the devnet offer only: give `startServices` an optional `terms` (default `TEST_TERMS`), pass the larger value from `devnet.ts` to it and to `createDirectChain`, and record the measurement. `TEST_TERMS` itself is shared with the local target and the unit tests, so it does not change; scenario 2 reads the minimum from the session |
| Scenario 9: a session still open after the grace period | Confirmations are slow, so the idle close lands late | Lengthen the scenario's wait by the observed delay |
| Scenario 16: a funding transfer fails (`Transaction … failed`, or a preflight error from the node) | The funding key is short | Fund it (`pnpm e2e:devnet funds` shows what it holds) |
| `Cleaning up what earlier runs left failed` at start-up | A session or account was left by a run that ended abnormally, or the provider refuses the listing of the program's accounts (see the first row) | `pnpm e2e:devnet clean`, then run again |

After any change: `pnpm typecheck && pnpm test && pnpm e2e:devnet`.

- [ ] **Step 5: [Operator] Check that nothing is left open, and run once more**

```bash
env_value() { grep "^$1=" .env.devnet | cut -d= -f2- | sed 's/[[:space:]]#.*$//' | tr -d "'\"\r"; }
url="$(env_value STINT_DEVNET_SCAN_RPC_URL)"; url="${url:-$(env_value STINT_DEVNET_RPC_URL)}"
curl -s "$url" -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"getProgramAccounts","params":["5iCYPqLjCWw5KzQTU6NBUhR2hxg5SWGmS1ctUn3qESvr",{"commitment":"confirmed","dataSlice":{"offset":0,"length":0},"filters":[{"dataSize":250}]}]}'
```

Expected: `"result":[]`. If a session is listed, run `pnpm e2e:devnet clean` once and look again. Then run `pnpm
e2e:devnet` a second time: it passes the same way, and the funding key's USDC figure is the same as after the
first run.

- [ ] **Step 6: Record the result**

Three edits in `README.md`; the paragraphs wrap in the file, so match on the words and keep the wrapping:

1. In `## Deploying to devnet`, in the paragraph that begins `On devnet the program is`, replace the size and
   the hash (`176,952 bytes, sha256` and the hexadecimal string after it) with the size and the sha256 that Step
   3 printed. Keep the rest of the paragraph, which already says that an upgrade changes the hash.
2. In `## Status` (written in Task 6), change two clauses. In the description of the program, replace
   `; the devnet deployment is of the earlier version, with `open` and the standard close only, until it is
   upgraded)` by `)` and write `the Solana program, deployed on devnet (` where the sentence began `the Solana
   program (`. Then replace `pass on a local network, two of them (1 and 22) also on devnet, and the run report`
   by `pass on a local network and on devnet, and the run report`.
3. In `## Running the scenarios on devnet`, change the sentence `Scenarios 1 and 22 pass on devnet.` to
   `Scenarios 1, 2, 3, 9, 16, 22 and 26 pass on devnet.`.

In the pull request's description, record the upgrade, the verified hash, the devnet report and the funding
key's before and after lines.

```bash
git add README.md
git commit -m "Record the upgraded devnet program and the scenarios that pass there"
```

---

## Done when

- `scripts/check-toolchain.sh` passes, and so do `cargo test -p stint`, `pnpm typecheck`, `pnpm test` and
  `pnpm e2e:local`, locally in WSL and in continuous integration. The generated client is current (CI's diff
  check passes).
- The local report reads `Status: required 7, pending 28 · Result: pass 7, fail 0, pending 27, not applicable
  1`: scenarios 1, 2, 3, 9, 16, 22 and 26 are `required` and pass.
- The program tests cover `claim` and `close(AtExpiry)` as spec section 12.1 lists them, and the four
  properties of that section hold as property tests.
- A session that runs to its end is closed by the gate with `AtExpiry`, its connections are dropped with 4402
  and its seller is paid; with the gate stopped, the sweeper closes it; an idle session is closed after the
  grace period and refunded.
- The upgraded program is on devnet, `scripts/verify-deployment.sh` confirms its bytes, and `pnpm e2e:devnet`
  passes the seven required scenarios twice in a row and leaves no session open.
- The pull request's description records: the verified executable hash, the devnet report, and any deviation
  from this plan.

## Spec edits made by this stage

Each is made in the task that needs it, and restates a fact the code relies on:
- §4.3 (`claim`): `Claimed` is emitted only when the claim transfers something (Task 6);
- §7.3 (the end-timer row): how forwarding stops and resumes; that an account gone, or holding another session opened again at the address, ends the tracked session with no close; and that only the same session resumes (Task 6);
- §6.4: the listing endpoint of the sweeper (Task 6);
- §12.2 (stack control): the harness can stop the gate and start it again (Task 6).

Not edited, on purpose: §12.2's isolation groups. The spec describes the runner as it is meant to be: every
scenario runs concurrently, and scenario 26 has a stack of its own. This stage's runner runs scenarios one at a
time and runs 26 on the common stack, the deviation recorded under "What this stage builds, and what it leaves for
later". The spec stays as the target; the runner and scenario 26 move to it when concurrency is built.
