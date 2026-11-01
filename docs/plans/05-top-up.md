# Stage 5: Top-up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or
> executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for
> tracking.

**Goal:** A buyer can extend a session while it runs. A top-up through the gate adds paid time and moves the end
of the session. A top-up paid through the gate is accepted until 10 s before the end of the paid time, on the
facilitator's clock; a later one, or one after the end, is refused and costs nothing. The program itself accepts a
top-up until its own `paid_until`, so a top-up sent to the chain directly can land after the gate has started closing
at expiry, when the gate's clock runs ahead of the chain's: the gate's `AtExpiry` close then fails, the gate resumes
forwarding, and the session runs on to its new end ("Timing of a top-up", below). Scenarios 4 and 34 pass on `local`
and become `required`, the devnet program is upgraded, and the nine required scenarios pass there.

**Architecture:** Stage 4's stack, extended through every component. The program gains `top_up`, whose maths join
the property tests of spec section 4.2. The scheme gains top-up offers, durations, payloads, the transaction and its
static checks. The facilitator verifies and settles a top-up: the session's terms, its authority, the funding, the
10 s margin and `maxSeconds`. The gate gains `POST /sessions/:id/top-up`, which moves its end timer once the top-up
settles, and a subscription to each session's account, which moves it for a top-up the gate did not settle; its end
timer's re-read stays as the fallback. The client gains `session.topUp`, and the tools gain `stint_top_up`, which the
MCP server serves. The harness can top up on-chain and start the gate with its session clock ahead.

**Tech Stack:** Rust 1.99.1 with Anchor 1.2.1 (`proptest` as a dev-dependency), TypeScript 7.0.2, vitest 5.0.5,
LiteSVM 1.6.1, Surfpool 1.6.1, Kora 2.0.5, `ws`.

**Spec:** `docs/specs/stint-system.md`, sections 4.2 and 4.3 (`top_up`), 5.1 to 5.5 (top-up offers, durations,
payloads, verification, settlement), 7.1 and 7.3 (the gate's top-up route, its end timer and its subscription to the
session account), 9.2 to 9.5 (the client's policy, its API and the tools), 11 (failure handling), 12.1, 12.2 and 12.7
(testing and the scenarios).

## Global Constraints

- Platform: Linux x86-64; on Windows, everything runs inside WSL 2 (T1, T2). Run every command from the repository
  root, inside WSL. Do not rely on `/tmp` staying intact while a command runs: keep scratch files under the home
  directory or a git-ignored folder of the repository.
- **Devnet only.** No transaction from this repository's code or scripts reaches another network. The Solana CLI's
  own default RPC is mainnet, so every command names its `--url`, and every script and the harness check devnet's
  genesis hash before they send anything.
- Transactions are version 0, without address lookup tables (spec section 3.5). Only classic SPL Token mints; the
  payment token is devnet USDC, `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`, 6 decimals (spec section 3.4).
- The program is built for SBPF v3 (Anchor 1.2.1's default). `e2e/test/artifact.test.ts` checks it.
- `u64` values on the wire are decimal strings; `u32` values are JSON numbers (spec section 5.1). Amounts are `bigint`
  in TypeScript, never `number`. Every amount in the program is computed with checked integers and 128-bit
  intermediates (spec section 4.2).
- **No secrets, ever, in any commit.** Keypair files are named by path in `.env`, and the devnet harness's seed is in
  `.env.devnet` (both git-ignored); `.env.example` carries names and empty values. Never print a key's contents or
  the seed; an RPC URL may carry an API key, so it appears in `.env` or `.env.devnet` only.
- The chain's clock decides every amount. The gate's and the facilitator's clocks only decide when they act (spec
  sections 4.2 and 7.3), and the facilitator's clock decides the 10 s top-up margin (spec section 5.4). `AtExpiry`
  makes a component whose clock runs ahead harmless: it fails with `NotExpired` and tries again.
- A client never signs a transaction supplied by a seller, and every spending limit is enforced by the client's policy
  in code (spec section 9.3). `maxPerSession` counts the opening deposit and every top-up together (spec section 9.2).
- **A refund goes back to the account the money came from.** A top-up's funding must come from the associated token
  account of the session's stored `refund_owner` (spec section 5.4, as Task 3 states it).
- Scenario statuses follow the ratchet of spec section 12.2: a scenario is made `required` in the commit where it
  first passes on `local`, and never goes back to `pending`.
- Test first: write the failing test, run it, implement, run it again, commit.
- Commit messages are neutral, technical and in the present tense.
- `GateChain` and `GateConfig` gain no required member in this stage: `packages/client/test/gate.ts` builds a gate
  from literals of both.

## What this stage builds, and what it leaves for later

Built: `top_up` and its maths, with property tests; the scheme's top-up offers, durations, payload, transaction and
checks; the facilitator's verification and settlement of a top-up; the gate's top-up route; the client's
`session.topUp`; the `stint_top_up` tool, which the MCP server and the example agent pick up; on-chain top-ups and a
gate whose session clock runs ahead in the harness; scenarios 4 and 34; the gate's subscription to each session's
account (spec section 7.3), for the top-ups it did not settle.

Not built, and not to be built here:
- **What the subscription does with anything but a later end.** A notification that the account is gone, or holds
  another session, is left to the end timer, as today: dropping the connections of a session another party closed
  (spec section 7.3, `4402` or `4410` from the `Closed` event) comes with the stage that needs the account-closed
  notification. The subscription after a `202` to an open (spec section 7.1) comes with the settlement records.
- **Replacing a subscription that fails.** One that fails, or cannot start, is logged and not replaced, while spec
  section 7.3 keeps the gate subscribed until the session ends. Until the end timer's re-read at the old end finds a
  later `paid_until`, the gate holds the old end: a connect within its margin of the old end is refused with `402`,
  forwarding stops for the length of that read, and if the read itself fails, the gate tries `AtExpiry` closes (refused
  with `NotExpired`) and re-reads at each retry until one read succeeds. That is how the gate behaves without a
  subscription today.
- **`autoTopUp`** and its policy fields `topUpAheadSeconds` and `topUpSeconds` (spec section 9.2). The client tops
  up when it is asked to: `session.topUp` or `stint_top_up`.
- **Polling after a payment whose outcome is unknown** (spec section 9.3). After a `202`, a `5xx` or a time-out, the
  top-up is reported as not confirmed and its amount stays locked in the budget, as an open's does today.
- **`onTopUp`** for proxy-mode resources (spec section 7.6): there is no proxy mode yet. In middleware mode, a
  connection attached after a top-up receives the new `paidUntil` in its `SessionInfo`.
- **A top-up of a session the gate does not track** (opened directly on the program and not adopted): the route
  answers `404` until adoption is built.
- Scenario 17 (a top-up for an unknown session) and the top-up case of scenario 32 (a top-up past `maxSeconds`) stay
  `pending` with their stage. This stage's route answers both cases (`404 unknown_session`, `400 invalid_duration`)
  and its unit tests cover them; the scenarios are written with the payment refusals.
- **The isolation groups of spec section 12.2.** Scenario 34 belongs to the own-stack group but runs on the run's
  common stack, as scenario 26 does: it stops the common gate, starts one whose session clock runs ahead, and starts
  an ordinary one again at the end. That is safe only because the runner runs scenarios one after another.

## Timing of a top-up

A top-up reaches the chain by one of two paths, and the path, not the moment alone, decides whether it is accepted:

| Path | Who checks | Accepted when | Refused when |
|---|---|---|---|
| **A. Through the gate** (an x402 payment: gate, then facilitator, then chain) | the gate, the facilitator, then the program | at least 10 s before `paid_until`, on the facilitator's clock | (1) less than 10 s left: `402 session_expired` from the facilitator; the gate answers the same once its end timer has fired. (2) After the end: `402 session_expired` while the gate is closing, `404` once it has closed |
| **B. Sent to the chain directly** (signed by the buyer, its fee paid by any key that holds SOL) | the program alone | before `paid_until`, on the chain's clock | (3) from `paid_until` on: `SessionExpired`; the transaction fails with its funding, so nothing moves |

The 10 s margin is the facilitator's rule, not the program's: it makes sure that a payment, which has to go through
verification, Kora and confirmation, lands before the end. The program has no margin.

```
 Time on the chain's clock, relative to the session's paid_until P (2 characters = 1 s)

 P−20                P−10      P−5 P−2.5 P             P+7       P+12
 |-------------------|---------|----|----|-------------|---------|--->

 A. Through the gate
 ├─── accepted ──────┤├── refused (1) ───┤├── refused (2) ─────────────────►

 B. Sent to the chain directly
 ├─────────────── accepted ───────────────┤├── refused (3) ─────────────────►

 Scenario 34: the gate's clock runs 5 s ahead of the chain's
                               ▲     ▲   ▲             ▲         ▲
                               1     2   3             4         5
```

1. **P−5:** the gate's clock reads P, so its end timer fires. It stops forwarding and tries an `AtExpiry` close, which
   the program refuses with `NotExpired` (the chain is at P−5); the gate retries every 2 s.
2. **About P−2:** the authority's 12 s top-up, sent to the chain directly at P−2.5, lands. That is path B, before P,
   so the program accepts it. The gate sees the later end, through its subscription to the account (Task 7) or its
   next re-read; it resumes forwarding and sets its end timer for P+12.
3. **P:** the old end passes on the chain with no effect: `paid_until` is now P+12.
4. **P+7:** the end timer fires again, 5 s early, as in step 1.
5. **P+12:** the chain reaches the new end. The close succeeds, the connection is dropped with `4402`, and the
   receiver is paid both deposits.

"While the gate is closing" (from P−5 here) comes after the start of the margin (P−10) but still before P: the
scenario's top-up is accepted only because it does not go through the facilitator. The same top-up through the gate
would be refused, by the margin and by the gate, whose end timer has fired. The gate starts closing before the
chain's end only when its clock runs ahead of the chain's, a normal skew; the program decides by the chain's clock,
so a direct top-up can still land, and the gate must not end a session that has just been extended.

Scenario 4 uses path A only: a top-up about 19 s before the first end is accepted, and the new end is P' = P + 10;
one at P' − 5 is refused (1); one after the gate has closed the session at P' is refused (2), with `404`.

## Before you start: what a person must prepare

Start from a clean tree on a branch of its own, with this plan already merged: the steps that say `git status
--short` prints nothing, or lists only what a step changed, rely on it.

Tasks 1 to 7 need nothing but the repository. Task 8 uses the person's keys:

1. The deploying key and the upgrade authority of the first deployment: `~/.config/stint/devnet.json` (the payer,
   holding SOL) and `~/.config/stint/upgrade-authority.json`, and the program keypair
   `target/deploy/stint-keypair.json`.
2. `.env.devnet` with `STINT_DEVNET_RPC_URL`, `STINT_DEVNET_SEED` and, if the provider's free tier refuses
   `getProgramAccounts`, `STINT_DEVNET_SCAN_RPC_URL`; the harness's funding key funded as `pnpm e2e:devnet funds`
   says.
3. Docker, for `anchor build --verifiable`. If `docker pull` fails in WSL with an error from a credential helper, run
   the build with `DOCKER_CONFIG` pointing at a directory that holds a file `config.json` containing `{}`.

---

### Task 1: The program: `top_up`

The program has no way to extend a session: a buyer who needs more time must close and open again, paying the
minimum charge twice. This task adds `top_up` as spec section 4.3 describes it. The funding instruction that precedes
it in the same transaction sends tokens to the vault; `top_up` credits what has arrived since the last credit, so
`paid_until` moves. It is refused from `paid_until` on (`SessionExpired`), when nothing has arrived
(`NothingToTopUp`), and when the deposit would buy more than `max_seconds` (`DepositTooLarge`). Only the session's
authority may sign it (`Unauthorized`). The property tests of spec section 12.1 grow to sequences of claims and
top-ups. Every step runs from the repository root, inside WSL. The program tests load `target/deploy/stint.so`, so
`anchor build` comes before any LiteSVM run that must see a Rust change.

**Files:**
- Create: `programs/stint/src/instructions/top_up.rs`, `packages/program-client/test/program/top-up.test.ts`
- Create (generated, committed): `packages/program-client/src/generated/instructions/topUp.ts`
- Modify: `programs/stint/src/maths.rs`, `programs/stint/src/instructions/mod.rs`, `programs/stint/src/lib.rs`,
  `packages/program-client/src/helpers.ts`
- Modify (generated, committed): `packages/program-client/src/generated/instructions/index.ts`,
  `packages/program-client/src/generated/programs/stint.ts`
- Test: `packages/program-client/test/helpers.test.ts`, `packages/program-client/test/program/fixture.ts`,
  `packages/program-client/test/program/top-up.test.ts`

**Interfaces:**
- Consumes: stage 4's program (`open`, `claim`, `close` with `Standard` and `AtExpiry`, `maths::{paid_until, elapsed,
  earned, charged, due, owed, cost, claim_amounts, close_amounts}`, the event `ToppedUp`, the errors `SessionExpired`,
  `NothingToTopUp`, `DepositTooLarge`, `Unauthorized`, `AccountMismatch`, `MathOverflow`); the generated client
  (`TOPPED_UP_EVENT_DISCRIMINATOR`, `parseToppedUpEvent`, `getToppedUpEventEncoder`, `STINT_ERROR__SESSION_EXPIRED` =
  6003, `STINT_ERROR__NOTHING_TO_TOP_UP` = 6005, `STINT_ERROR__DEPOSIT_TOO_LARGE` = 6002, `STINT_ERROR__UNAUTHORIZED` =
  6006, `STINT_ERROR__ACCOUNT_MISMATCH` = 6008, `STINT_ERROR__NOT_EXPIRED` = 6004); `eventAccounts`, `eventPayloads`
  and `EVENT_IX_TAG` from `helpers.ts`; the program tests' `Fixture`.
- Produces:
  - `maths::top_up_amounts(session: &Session, vault: u64, now: i64) -> Result<TopUpAmounts>` with
    `TopUpAmounts { added: u64, deposited: u64, paid_until: i64 }`: every check and every amount of a top-up. `top_up`
    takes its effect from this function, so the property tests, which run on it, check what the program does.
  - The instruction `top_up()`, without arguments. Accounts, in order: `authority` (signer; the session's stored
    `authority`, else `Unauthorized`), `session` (mutable), `vault` (the canonical associated token account of the
    session for its mint, else `AccountMismatch`), then the two `#[event_cpi]` accounts. It sets `deposited` to
    `vault.amount + claimed` and emits `ToppedUp { session, added, deposited, paid_until }`. `started_at` and
    `claimed` are untouched.
  - `@lxfoundry/stint-program-client`: the generated `getTopUpInstruction(input)` with
    `input = { authority, session, vault, eventAuthority, program }` (the last two from `await eventAccounts()`),
    `parseTopUpInstruction`, `TOP_UP_DISCRIMINATOR`, `StintInstruction.TopUp`; and
    `findToppedUpEvent(instructions: Iterable<ProgramInstruction>): ToppedUpEvent | undefined`.
  - The fixture: `Fixture.topUp(options: TopUpOptions): Promise<Sent>` with
    `TopUpOptions = { session: Address; authority: Wallet; amount: bigint; signer?: KeyPairSigner; vault?: Address }`.
  - The program deployed on devnet has no `top_up` until it is upgraded (Task 8).

- [ ] **Step 1: Write the failing unit tests of `top_up_amounts`**

In `programs/stint/src/maths.rs`, inside `mod tests`, replace

```rust
        // A vault holding less than is owed is an error, not a partial payment.
        assert!(close_amounts(&session, 3_999, 1_012, false, false).is_err());
    }
}
```

with

```rust
        // A vault holding less than is owed is an error, not a partial payment.
        assert!(close_amounts(&session, 3_999, 1_012, false, false).is_err());
    }

    /// The code of a program error: Anchor numbers the errors of spec section 4.5 from 6000.
    fn code(error: StintError) -> u32 {
        6000 + error as u32
    }

    /// Whether `result` failed with the program error numbered `code`.
    fn fails_with<T>(result: Result<T>, code: u32) -> bool {
        matches!(result, Err(anchor_lang::error::Error::AnchorError(error)) if error.error_code_number == code)
    }

    #[test]
    fn a_top_up_credits_what_reached_the_vault_since_the_last_credit() {
        let session = opened(1_000, 5, 1_000, 30_000);
        // 10,000 more in the vault: 10 s more, counted from the same start.
        let topped_up = TopUpAmounts { added: 10_000, deposited: 40_000, paid_until: 1_040 };
        assert_eq!(top_up_amounts(&session, 40_000, 1_010).unwrap(), topped_up);
        // After claims of 8,000 the vault holds 22,000 of the deposit: the same 10,000 is what is new.
        let mut claimed = opened(1_000, 5, 1_000, 30_000);
        claimed.claimed = 8_000;
        assert_eq!(top_up_amounts(&claimed, 32_000, 1_010).unwrap(), topped_up);
        // Tokens that reached the vault uncredited earlier are credited with the top-up; the remainder buys no time.
        let with_stray = top_up_amounts(&session, 40_500, 1_010).unwrap();
        assert_eq!(with_stray, TopUpAmounts { added: 10_500, deposited: 40_500, paid_until: 1_040 });
    }

    #[test]
    fn a_top_up_is_refused_from_paid_until_on() {
        let session = opened(1_000, 5, 1_000, 30_000);
        assert!(top_up_amounts(&session, 40_000, 1_029).is_ok());
        for now in [1_030, 1_031, 9_000] {
            assert!(fails_with(top_up_amounts(&session, 40_000, now), code(StintError::SessionExpired)));
        }
    }

    #[test]
    fn a_top_up_needs_tokens_that_have_not_been_credited() {
        let mut session = opened(1_000, 5, 1_000, 30_000);
        assert!(fails_with(top_up_amounts(&session, 30_000, 1_010), code(StintError::NothingToTopUp)));
        // After a claim of 8,000, a vault of 22,000 holds nothing new, and one base unit more is new.
        session.claimed = 8_000;
        assert!(fails_with(top_up_amounts(&session, 22_000, 1_010), code(StintError::NothingToTopUp)));
        assert_eq!(top_up_amounts(&session, 22_001, 1_010).unwrap().added, 1);
    }

    #[test]
    fn a_top_up_may_not_buy_more_than_max_seconds() {
        let mut session = opened(1_000, 5, 1_000, 30_000);
        session.max_seconds = 120;
        assert_eq!(top_up_amounts(&session, 120_000, 1_010).unwrap().paid_until, 1_120);
        assert!(fails_with(top_up_amounts(&session, 120_001, 1_010), code(StintError::DepositTooLarge)));
        // What claims took out of the vault counts towards the total.
        session.claimed = 10_000;
        assert!(fails_with(top_up_amounts(&session, 110_001, 1_010), code(StintError::DepositTooLarge)));
    }

    #[test]
    fn a_top_up_reports_an_overflow_as_an_error() {
        let mut session = opened(1, 5, 1_000, 30_000);
        session.claimed = 1;
        assert!(fails_with(top_up_amounts(&session, u64::MAX, 1_010), code(StintError::MathOverflow)));
    }
}
```

- [ ] **Step 2: Write the property tests of sequences of claims and top-ups**

In the same file, delete the module `properties`: everything from its doc comment, the line that begins `/// Property
tests of spec section 12.1, run on the functions`, to the end of the file. Put this in its place:

```rust
/// Property tests of spec section 12.1, run on the functions `claim`, `top_up` and `close` call: claims and top-ups at
/// a sequence of moments, then a close.
#[cfg(test)]
mod properties {
    use super::{
        charged, claim_amounts, close_amounts, cost, due, earned, elapsed, opened, paid_until, top_up_amounts, CloseAmounts,
    };
    use crate::state::Session;
    use proptest::prelude::*;

    /// A session's terms as `open` stores them, and the tokens that reached the vault uncredited.
    #[derive(Clone, Copy, Debug)]
    struct Terms {
        rate: u64,
        min_seconds: u32,
        max_seconds: u32,
        started_at: i64,
        deposited: u64,
        uncredited: u64,
    }

    /// One thing that happens to the session: a claim, or a top-up whose funding sends `amount` to the vault in the same
    /// transaction as `top_up`.
    #[derive(Clone, Copy, Debug)]
    enum Step {
        Claim(i64),
        TopUp(i64, u64),
    }

    impl Step {
        fn at(self) -> i64 {
            match self {
                Step::Claim(now) | Step::TopUp(now, _) => now,
            }
        }
    }

    /// `steps`, in that order, then one close at `close_time`.
    #[derive(Clone, Debug)]
    struct Scenario {
        terms: Terms,
        steps: Vec<Step>,
        close_time: i64,
        waive_minimum: bool,
        refund_account_gone: bool,
    }

    impl Scenario {
        /// The same scenario on a clock that never steps back: moments in order, the close last.
        fn monotone(mut self) -> Self {
            self.steps.sort_by_key(|step| step.at());
            if let Some(last) = self.steps.last() {
                self.close_time = self.close_time.max(last.at());
            }
            self
        }
    }

    /// A moment between a little before the start and about twice the opening deposit's paid time after it.
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
            room in prop_oneof![Just(0u32), 1u32..=600],
            started_at in 0i64..=4_000_000_000,
            uncredited in prop_oneof![Just(0u64), 1u64..=1_000_000],
        ) -> Terms {
            let max_seconds = u32::try_from(covered).unwrap().saturating_add(room);
            Terms {
                rate,
                // `open` requires `min_seconds <= covered`, and a deposit of at most `rate x max_seconds`: a session
                // opened for `max_seconds` takes no remainder.
                min_seconds: u32::try_from(min % covered).unwrap() + 1,
                max_seconds,
                started_at,
                deposited: rate * covered + if u64::from(max_seconds) > covered { remainder % rate } else { 0 },
                uncredited,
            }
        }
    }

    // A claim, or a top-up of up to 700 s, now and then with a few base units more than whole seconds.
    prop_compose! {
        fn any_step(terms: Terms)(
            raw in any::<u64>(),
            top_up in any::<bool>(),
            seconds in prop_oneof![Just(0u64), 1u64..=700],
            stray in prop_oneof![Just(0u64), 1u64..=1_000],
        ) -> Step {
            let now = moment(&terms, raw);
            if top_up { Step::TopUp(now, terms.rate * seconds + stray) } else { Step::Claim(now) }
        }
    }

    prop_compose! {
        fn any_scenario()(terms in any_terms())(
            steps in proptest::collection::vec(any_step(terms), 0..24),
            raw_close in any::<u64>(),
            waive_minimum in any::<bool>(),
            refund_account_gone in any::<bool>(),
            terms in Just(terms),
        ) -> Scenario {
            Scenario { terms, steps, close_time: moment(&terms, raw_close), waive_minimum, refund_account_gone }
        }
    }

    struct Outcome {
        /// The session's `claimed` after each claim, with what was earned at that claim's moment.
        claims: Vec<(u64, u64)>,
        /// Each top-up the program accepted: its moment, and `paid_until` before and after it.
        top_ups: Vec<(i64, i64, i64)>,
        /// What the claims moved out of the vault, in total.
        paid_by_claims: u64,
        /// What the funding of the accepted top-ups sent to the vault, in total.
        topped_up: u64,
        /// The session as the close finds it.
        session: Session,
        close: CloseAmounts,
        /// `earned` and `due` at the close, by the formulas of spec section 4.2: the reference the amounts are checked
        /// against.
        earned_at_close: u64,
        due: u64,
    }

    /// `paid_until` of the session as it stands.
    fn end_of(session: &Session) -> i64 {
        paid_until(session.started_at, session.deposited, session.rate).unwrap()
    }

    /// `earned` of the session as it stands, at `now`.
    fn earned_at(session: &Session, now: i64) -> u64 {
        earned(session.deposited, session.rate, elapsed(session.started_at, end_of(session), now))
    }

    /// The program's sequence: each claim applied as `claim` applies it (the vault pays `amount`, the session stores
    /// `claimed`), each top-up as its transaction lands (the funding and `top_up` together, or neither), then the close
    /// on what the vault still holds, as `close` computes it.
    fn run(scenario: &Scenario) -> Outcome {
        let terms = scenario.terms;
        let mut session = opened(terms.rate, terms.min_seconds, terms.started_at, terms.deposited);
        session.max_seconds = terms.max_seconds;

        // The vault holds the credited deposit and whatever reached it without being credited.
        let mut vault = terms.deposited + terms.uncredited;
        let (mut paid_by_claims, mut topped_up) = (0, 0);
        let (mut claims, mut top_ups) = (Vec::new(), Vec::new());
        for &step in &scenario.steps {
            match step {
                Step::Claim(now) => {
                    let claim = claim_amounts(&session, now).unwrap();
                    vault = vault.checked_sub(claim.amount).expect("a claim pays no more than the vault holds");
                    paid_by_claims += claim.amount;
                    session.claimed = claim.claimed;
                    claims.push((session.claimed, earned_at(&session, now)));
                }
                Step::TopUp(now, amount) => {
                    // A refused `top_up` fails its transaction, so its funding never reaches the vault (S13).
                    if let Ok(top_up) = top_up_amounts(&session, vault + amount, now) {
                        let before = end_of(&session);
                        vault += amount;
                        topped_up += amount;
                        session.deposited = top_up.deposited;
                        assert_eq!(top_up.paid_until, end_of(&session), "the paid_until a top-up reports is the session's");
                        top_ups.push((now, before, top_up.paid_until));
                    }
                }
            }
        }

        let now = scenario.close_time;
        let close = close_amounts(&session, vault, now, scenario.waive_minimum, scenario.refund_account_gone)
            .expect("a close owes no more than the vault holds");
        let elapsed_now = elapsed(session.started_at, end_of(&session), now);
        let earned_at_close = earned_at(&session, now);
        let due_at_close = due(session.deposited, session.rate, charged(session.min_seconds, elapsed_now, scenario.waive_minimum));
        Outcome { claims, top_ups, paid_by_claims, topped_up, session, close, earned_at_close, due: due_at_close }
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(512))]

        // `claimed + owed <= deposited`, on any clock and in any order of moments, with the deposit as the top-ups left it.
        #[test]
        fn claimed_plus_owed_never_exceeds_the_deposit(scenario in any_scenario()) {
            let outcome = run(&scenario);
            prop_assert!(
                u128::from(outcome.session.claimed) + u128::from(outcome.close.owed) <= u128::from(outcome.session.deposited)
            );
        }

        // `earned <= due` at every close, whether or not the minimum is waived.
        #[test]
        fn earned_never_exceeds_due_at_a_close(scenario in any_scenario()) {
            let outcome = run(&scenario);
            prop_assert!(outcome.earned_at_close <= outcome.due);
        }

        // While the clock never steps back no claim pays beyond what is earned, so `claimed <= earned <= due` at the
        // close, and the close pays exactly the rest of `due`.
        #[test]
        fn claimed_never_exceeds_earned_while_the_clock_never_steps_back(
            scenario in any_scenario().prop_map(Scenario::monotone)
        ) {
            let outcome = run(&scenario);
            for &(claimed, earned_then) in &outcome.claims {
                prop_assert!(claimed <= earned_then);
            }
            prop_assert!(outcome.session.claimed <= outcome.earned_at_close);
            prop_assert_eq!(outcome.session.claimed + outcome.close.owed, outcome.due);
        }

        // Every token that entered the vault leaves it exactly once, on any clock: what the claims moved is what the
        // session records as claimed, and the close moves the rest, the funding of every top-up included.
        #[test]
        fn every_token_that_entered_the_vault_leaves_it_once(scenario in any_scenario()) {
            let outcome = run(&scenario);
            let terms = scenario.terms;
            prop_assert_eq!(outcome.paid_by_claims, outcome.session.claimed);
            prop_assert_eq!(
                u128::from(outcome.session.claimed)
                    + u128::from(outcome.close.owed)
                    + u128::from(outcome.close.refunded)
                    + u128::from(outcome.close.redirected),
                u128::from(terms.deposited) + u128::from(terms.uncredited) + u128::from(outcome.topped_up)
            );
        }

        // A top-up lands only before `paid_until`, so a buyer never pays for a gap, and it never brings the end closer.
        #[test]
        fn a_top_up_lands_only_before_the_end_and_never_brings_it_closer(scenario in any_scenario()) {
            let outcome = run(&scenario);
            for &(now, before, after) in &outcome.top_ups {
                prop_assert!(now < before);
                prop_assert!(after >= before);
            }
        }

        // However many top-ups land, the deposit never buys more than `max_seconds`.
        #[test]
        fn the_deposit_never_buys_more_than_max_seconds(scenario in any_scenario()) {
            let outcome = run(&scenario);
            prop_assert!(u128::from(outcome.session.deposited) <= cost(outcome.session.rate, outcome.session.max_seconds));
        }
    }
}
```

- [ ] **Step 3: Run the tests to see them fail**

Run: `cargo test -p stint`
Expected: FAIL to compile: `cannot find function top_up_amounts` and `cannot find struct ... TopUpAmounts`.

- [ ] **Step 4: Implement `top_up_amounts`**

In `programs/stint/src/maths.rs`, replace

```rust
/// `rate × seconds`, for the deposit bounds of `open`.
```

with

```rust
/// What a top-up credits: `added` reached the vault since the last credit, after which the session's `deposited` is
/// `deposited` and its paid time runs to `paid_until`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TopUpAmounts {
    pub added: u64,
    pub deposited: u64,
    pub paid_until: i64,
}

/// A top-up at `now` of a vault holding `vault` (spec section 4.3). Only claims take tokens out of an open session's
/// vault, so `vault + claimed` is everything that has reached it, and what exceeds `deposited` arrived since the last
/// credit. Refused from `paid_until` on (`SessionExpired`: a session that has run out cannot be extended, so a buyer
/// never pays for a gap), when nothing has arrived (`NothingToTopUp`), and when the total would buy more than
/// `max_seconds` (`DepositTooLarge`).
pub fn top_up_amounts(session: &Session, vault: u64, now: i64) -> Result<TopUpAmounts> {
    let end = paid_until(session.started_at, session.deposited, session.rate)?;
    require!(now < end, StintError::SessionExpired);
    let total = vault.checked_add(session.claimed).ok_or_else(|| error!(StintError::MathOverflow))?;
    require!(total > session.deposited, StintError::NothingToTopUp);
    require!(u128::from(total) <= cost(session.rate, session.max_seconds), StintError::DepositTooLarge);
    Ok(TopUpAmounts {
        added: total - session.deposited,
        deposited: total,
        paid_until: paid_until(session.started_at, total, session.rate)?,
    })
}

/// `rate × seconds`, for the deposit bounds of `open` and `top_up`.
```

- [ ] **Step 5: Run the tests to see them pass**

Run: `cargo test -p stint`
Expected: PASS, `28 passed`: the 21 tests of stage 4, the 5 new unit tests and the 2 new properties. The four
properties of stage 4 still pass, now on sequences that hold top-ups.

- [ ] **Step 6: Check that a property can fail**

A property that cannot fail proves nothing. In `top_up_amounts`, put `//` in front of the line
`require!(now < end, StintError::SessionExpired);`.

Run: `cargo test -p stint`
Expected: FAIL in two tests: `a_top_up_lands_only_before_the_end_and_never_brings_it_closer`, with proptest's minimal
failing case (a top-up whose moment is at or after its `before`), and `a_top_up_is_refused_from_paid_until_on`.

Remove the `//`, then run `cargo test -p stint` again. Expected: `28 passed`. `git diff programs/stint/src/maths.rs`
shows only the changes of Steps 1, 2 and 4.

- [ ] **Step 7: Commit the maths**

```bash
git add programs/stint/src/maths.rs
git commit -m "Add the maths of a top-up, with property tests over claims and top-ups"
```

- [ ] **Step 8: Write the failing tests of `findToppedUpEvent`**

In `packages/program-client/test/helpers.test.ts`, replace

```ts
  findClaimedEvent,
  getClaimedEventEncoder,
  getClosedEventEncoder,
```

with

```ts
  findClaimedEvent,
  findToppedUpEvent,
  getClaimedEventEncoder,
  getClosedEventEncoder,
  getToppedUpEventEncoder,
```

and add at the end of the file:

```ts

describe("findToppedUpEvent", () => {
  const key = address("11111111111111111111111111111111");
  const toppedUp = getToppedUpEventEncoder().encode({ session: key, added: 10_000n, deposited: 40_000n, paidUntil: 1_040n });
  const claimed = getClaimedEventEncoder().encode({ session: key, amount: 8_000n, claimed: 8_000n });

  function emitted(payload: ReadonlyUint8Array, programAddress: Address = STINT_PROGRAM_ADDRESS): ProgramInstruction {
    const data = new Uint8Array(EVENT_IX_TAG.length + payload.length);
    data.set(EVENT_IX_TAG, 0);
    data.set(payload, EVENT_IX_TAG.length);
    return { programAddress, data };
  }

  it("decodes the ToppedUp event that the program emitted, among other events", () => {
    const expected = { session: key, added: 10_000n, deposited: 40_000n, paidUntil: 1_040n };
    expect(findToppedUpEvent([emitted(toppedUp)])).toEqual(expected);
    expect(findToppedUpEvent([emitted(claimed), emitted(toppedUp)])).toEqual(expected);
  });

  it("is undefined when the program emitted no ToppedUp event, or another program did", () => {
    expect(findToppedUpEvent([])).toBeUndefined();
    expect(findToppedUpEvent([emitted(claimed)])).toBeUndefined();
    expect(findToppedUpEvent([emitted(toppedUp, address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"))])).toBeUndefined();
  });
});
```

- [ ] **Step 9: Run them to see them fail**

Run: `pnpm --filter @lxfoundry/stint-program-client test helpers.test.ts`
Expected: FAIL: `findToppedUpEvent` is not a function (it is not exported).

- [ ] **Step 10: Implement `findToppedUpEvent`**

In `packages/program-client/src/helpers.ts`, replace

```ts
import { STINT_PROGRAM_ADDRESS } from "./generated/programs/stint.js";
```

with

```ts
import { TOPPED_UP_EVENT_DISCRIMINATOR, parseToppedUpEvent, type ToppedUpEvent } from "./generated/events/toppedUp.js";
import { STINT_PROGRAM_ADDRESS } from "./generated/programs/stint.js";
```

and replace

```ts
interface Terms {
  readonly startedAt: bigint;
```

with

```ts
export function findToppedUpEvent(instructions: Iterable<ProgramInstruction>): ToppedUpEvent | undefined {
  const payload = eventPayloads(instructions).find((data) => containsBytes(data, TOPPED_UP_EVENT_DISCRIMINATOR, 0));
  return payload && parseToppedUpEvent(payload);
}

interface Terms {
  readonly startedAt: bigint;
```

- [ ] **Step 11: Run them to see them pass, then commit**

Run: `pnpm --filter @lxfoundry/stint-program-client test helpers.test.ts && pnpm --filter @lxfoundry/stint-program-client typecheck`
Expected: PASS; no type error.

```bash
git add packages/program-client/src/helpers.ts packages/program-client/test/helpers.test.ts
git commit -m "Add findToppedUpEvent to the program client"
```

- [ ] **Step 12: Add `topUp` to the test fixture**

In `packages/program-client/test/program/fixture.ts`, replace

```ts
  getOpenInstruction,
  getSessionDecoder,
  type ProgramInstruction,
} from "../../src/index.js";
```

with

```ts
  getOpenInstruction,
  getSessionDecoder,
  getTopUpInstruction,
  type ProgramInstruction,
} from "../../src/index.js";
```

replace

```ts
export interface Opened {
```

with

```ts
export interface TopUpOptions {
  readonly session: Address;
  /** The buyer: the funding comes from its token account, and it signs `top_up` unless `signer` is set. */
  readonly authority: Wallet;
  /** What the funding transfer sends to the session's canonical vault; 0n sends no transfer. */
  readonly amount: bigint;
  /** Signs `top_up` as its authority. Default: the buyer's key. */
  readonly signer?: KeyPairSigner;
  /** The vault account passed to `top_up`. Default: the session's canonical vault. */
  readonly vault?: Address;
}

export interface Opened {
```

and replace

```ts
  /**
   * `claim`, with each account derived from the stored session unless overridden. The instruction has no signer: the
```

with

```ts
  /** The `topUp` layout of spec §5.3: fund the vault, then `top_up`. */
  async topUp(options: TopUpOptions): Promise<Sent> {
    const canonicalVault = await this.ata(options.session);
    const fund: Instruction[] =
      options.amount === 0n
        ? []
        : [
            getTransferCheckedInstruction({
              source: options.authority.token,
              mint: this.mint,
              destination: canonicalVault,
              authority: options.authority.signer,
              amount: options.amount,
              decimals: DECIMALS,
            }),
          ];
    const topUp = getTopUpInstruction({
      authority: options.signer ?? options.authority.signer,
      session: options.session,
      vault: options.vault ?? canonicalVault,
      ...(await eventAccounts()),
    });
    return this.send([...fund, topUp]);
  }

  /**
   * `claim`, with each account derived from the stored session unless overridden. The instruction has no signer: the
```

- [ ] **Step 13: Write the failing tests of `top_up`**

Create `packages/program-client/test/program/top-up.test.ts`:

```ts
import { generateKeyPairSigner, isSignerRole, type Address } from "@solana/kit";
import { beforeEach, describe, expect, it } from "vitest";
import {
  CloseKind,
  STINT_ERROR__ACCOUNT_MISMATCH,
  STINT_ERROR__DEPOSIT_TOO_LARGE,
  STINT_ERROR__NOTHING_TO_TOP_UP,
  STINT_ERROR__NOT_EXPIRED,
  STINT_ERROR__SESSION_EXPIRED,
  STINT_ERROR__UNAUTHORIZED,
  eventAccounts,
  findClosedEvent,
  findToppedUpEvent,
  getSessionDecoder,
  getTopUpInstruction,
} from "../../src/index.js";
import { Fixture, type Wallet } from "./fixture.js";

describe("top_up", () => {
  let fixture: Fixture;
  let buyer: Wallet;
  let startedAt: bigint;

  beforeEach(async () => {
    fixture = await Fixture.create();
    buyer = await fixture.wallet(1_000_000n);
    startedAt = fixture.now();
  });

  /** Opens 30,000 at 1,000 per second (5 s to 120 s), then moves the clock `seconds` forward. */
  async function openAndWait(seconds: bigint) {
    const opened = await fixture.open({ authority: buyer, deposit: 30_000n });
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

  it("credits what the funding sent, and moves paid_until by the seconds it buys", async () => {
    const { session, vault } = await openAndWait(10n);
    const sent = await fixture.topUp({ session, authority: buyer, amount: 20_000n });

    expect(sent.ok, sent.logs.join("\n")).toBe(true);
    expect(fixture.tokenAmount(vault)).toBe(50_000n);
    expect(stored(session)).toMatchObject({ deposited: 50_000n, claimed: 0n, startedAt });
    expect(findToppedUpEvent(sent.inner)).toEqual({ session, added: 20_000n, deposited: 50_000n, paidUntil: startedAt + 50n });
  });

  it("declares the authority as its one signer", async () => {
    const { session, vault } = await openAndWait(10n);
    const instruction = getTopUpInstruction({ authority: buyer.signer, session, vault, ...(await eventAccounts()) });

    expect(instruction.accounts.filter((meta) => isSignerRole(meta.role)).map((meta) => meta.address)).toEqual([buyer.signer.address]);
  });

  it("credits a top-up after claims: the deposit grows by what arrived, not by what the vault holds", async () => {
    const { session, vault } = await openAndWait(8n);
    expect((await fixture.claim({ session })).ok).toBe(true); // pays 8,000
    const sent = await fixture.topUp({ session, authority: buyer, amount: 10_000n });

    expect(sent.ok, sent.logs.join("\n")).toBe(true);
    expect(fixture.tokenAmount(vault)).toBe(32_000n);
    expect(stored(session)).toMatchObject({ deposited: 40_000n, claimed: 8_000n });
    expect(findToppedUpEvent(sent.inner)).toMatchObject({ added: 10_000n, deposited: 40_000n, paidUntil: startedAt + 40n });
  });

  it("credits tokens that reached the vault uncredited before it", async () => {
    const { session, vault } = await openAndWait(5n);
    fixture.writeTokenAccount(vault, session, 30_500n); // 500 sent to the vault outside any top-up
    const sent = await fixture.topUp({ session, authority: buyer, amount: 10_000n });

    expect(sent.ok, sent.logs.join("\n")).toBe(true);
    expect(findToppedUpEvent(sent.inner)).toMatchObject({ added: 10_500n, deposited: 40_500n, paidUntil: startedAt + 40n });
  });

  it("is accepted one second before paid_until, and refused with SessionExpired at it and after it", async () => {
    const { session } = await openAndWait(29n);
    expect((await fixture.topUp({ session, authority: buyer, amount: 1_000n })).ok).toBe(true); // paid until +31

    fixture.setNow(startedAt + 31n);
    expect(await fixture.topUp({ session, authority: buyer, amount: 1_000n })).toMatchObject({ ok: false, errorCode: STINT_ERROR__SESSION_EXPIRED });
    fixture.setNow(startedAt + 90n);
    expect(await fixture.topUp({ session, authority: buyer, amount: 1_000n })).toMatchObject({ ok: false, errorCode: STINT_ERROR__SESSION_EXPIRED });

    // The refused transactions moved nothing: their funding failed with them (S13).
    expect(stored(session).deposited).toBe(31_000n);
    expect(fixture.tokenAmount(buyer.token)).toBe(969_000n);
  });

  it("is refused with NothingToTopUp when no tokens arrived", async () => {
    const { session } = await openAndWait(5n);

    expect(await fixture.topUp({ session, authority: buyer, amount: 0n })).toMatchObject({ ok: false, errorCode: STINT_ERROR__NOTHING_TO_TOP_UP });
  });

  it("is accepted up to max_seconds, and refused with DepositTooLarge past it", async () => {
    const { session } = await openAndWait(5n);

    expect(await fixture.topUp({ session, authority: buyer, amount: 90_001n })).toMatchObject({ ok: false, errorCode: STINT_ERROR__DEPOSIT_TOO_LARGE });
    const full = await fixture.topUp({ session, authority: buyer, amount: 90_000n });
    expect(full.ok, full.logs.join("\n")).toBe(true);
    expect(findToppedUpEvent(full.inner)).toMatchObject({ deposited: 120_000n, paidUntil: startedAt + 120n });
  });

  it.each(["receiver authorizer", "stranger"])("refuses a top-up signed by the %s with Unauthorized", async (who) => {
    const { session } = await openAndWait(5n);
    const signer = who === "stranger" ? await generateKeyPairSigner() : fixture.receiverAuthorizer;

    expect(await fixture.topUp({ session, authority: buyer, amount: 10_000n, signer })).toMatchObject({ ok: false, errorCode: STINT_ERROR__UNAUTHORIZED });
    expect(stored(session).deposited).toBe(30_000n);
  });

  it("refuses a vault that is not the session's canonical one with AccountMismatch", async () => {
    const { session } = await openAndWait(5n);
    const other = (await generateKeyPairSigner()).address;
    fixture.writeTokenAccount(other, session, 40_000n); // owned by the session, at another address

    expect(await fixture.topUp({ session, authority: buyer, amount: 10_000n, vault: other })).toMatchObject({ ok: false, errorCode: STINT_ERROR__ACCOUNT_MISMATCH });
  });

  it("extends what a close charges for: the close counts the top-up", async () => {
    const { session } = await openAndWait(5n);
    expect((await fixture.topUp({ session, authority: buyer, amount: 30_000n })).ok).toBe(true); // paid for 60 s
    fixture.setNow(startedAt + 40n);
    const closed = await fixture.close({ session, closer: buyer.signer });

    expect(closed.ok, closed.logs.join("\n")).toBe(true);
    expect(findClosedEvent(closed.inner)).toMatchObject({ owed: 40_000n, refunded: 20_000n, paidUntil: startedAt + 60n });
  });

  it("makes an AtExpiry close fail with NotExpired at the old paid_until, and succeed at the new one", async () => {
    const { session } = await openAndWait(20n);
    expect((await fixture.topUp({ session, authority: buyer, amount: 10_000n })).ok).toBe(true); // paid until +40

    fixture.setNow(startedAt + 30n);
    expect(await fixture.close({ session, closer: fixture.receiverAuthorizer, kind: CloseKind.AtExpiry })).toMatchObject({
      ok: false,
      errorCode: STINT_ERROR__NOT_EXPIRED,
    });
    fixture.setNow(startedAt + 40n);
    const closed = await fixture.close({ session, closer: fixture.receiverAuthorizer, kind: CloseKind.AtExpiry });
    expect(closed.ok, closed.logs.join("\n")).toBe(true);
    expect(findClosedEvent(closed.inner)).toMatchObject({ kind: CloseKind.AtExpiry, owed: 40_000n, refunded: 0n });
  });
});
```

- [ ] **Step 14: Run them to see them fail**

Run: `pnpm --filter @lxfoundry/stint-program-client test top-up.test.ts`
Expected: FAIL: `getTopUpInstruction` is not exported by the client (it is not generated yet).

- [ ] **Step 15: Write the instruction**

Create `programs/stint/src/instructions/top_up.rs`:

```rust
use anchor_lang::prelude::*;
use anchor_spl::associated_token::get_associated_token_address;
use anchor_spl::token::TokenAccount;

use crate::errors::StintError;
use crate::events::ToppedUp;
use crate::maths;
use crate::state::Session;

/// Extends a session (spec section 4.3). The vault is funded by an earlier instruction of the same transaction;
/// `top_up` credits what has reached the vault since the last credit, which moves `paid_until`. Only the session's
/// authority may sign it.
#[event_cpi]
#[derive(Accounts)]
pub struct TopUp<'info> {
    pub authority: Signer<'info>,

    #[account(mut, has_one = authority @ StintError::Unauthorized)]
    pub session: Account<'info, Session>,

    /// Exactly the associated token account of the session for its mint (S6, S7).
    #[account(
        address = get_associated_token_address(&session.key(), &session.mint) @ StintError::AccountMismatch,
    )]
    pub vault: Account<'info, TokenAccount>,
}

pub fn top_up_handler(ctx: Context<TopUp>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    // Refused from `paid_until` on, when nothing new has arrived, and past `max_seconds` (spec section 4.3).
    let maths::TopUpAmounts { added, deposited, paid_until } =
        maths::top_up_amounts(&ctx.accounts.session, ctx.accounts.vault.amount, now)?;
    let session_key = ctx.accounts.session.key();
    ctx.accounts.session.deposited = deposited;
    emit_cpi!(ToppedUp { session: session_key, added, deposited, paid_until });
    Ok(())
}
```

- [ ] **Step 16: Register the instruction**

In `programs/stint/src/instructions/mod.rs`, replace

```rust
pub mod claim;
pub mod close;
pub mod open;

pub use claim::*;
pub use close::*;
pub use open::*;
```

with

```rust
pub mod claim;
pub mod close;
pub mod open;
pub mod top_up;

pub use claim::*;
pub use close::*;
pub use open::*;
pub use top_up::*;
```

In `programs/stint/src/lib.rs`, replace

```rust
    pub fn close(ctx: Context<Close>, kind: CloseKind) -> Result<()> {
        instructions::close::close_handler(ctx, kind)
    }
```

with

```rust
    pub fn close(ctx: Context<Close>, kind: CloseKind) -> Result<()> {
        instructions::close::close_handler(ctx, kind)
    }

    pub fn top_up(ctx: Context<TopUp>) -> Result<()> {
        instructions::top_up::top_up_handler(ctx)
    }
```

It goes last so that the generated `StintInstruction` enum keeps the members it has, in their order.

- [ ] **Step 17: Build the program and regenerate the client**

Run: `anchor build && pnpm generate:client && git status --short`
Expected: the build finishes and updates `target/deploy/stint.so` and `target/idl/stint.json`. The generator creates
`packages/program-client/src/generated/instructions/topUp.ts` and modifies
`packages/program-client/src/generated/instructions/index.ts` and `packages/program-client/src/generated/programs/stint.ts`
(a `StintInstruction.TopUp` member and a `topUp` entry in the plugin). `git status --short` lists those three files,
`programs/stint/src/instructions/top_up.rs`, `programs/stint/src/instructions/mod.rs`, `programs/stint/src/lib.rs`,
`packages/program-client/test/program/fixture.ts` and `packages/program-client/test/program/top-up.test.ts`, and
nothing else. If any other generated file changed, stop and report it: the event `ToppedUp` and the errors were in the
IDL already.

- [ ] **Step 18: Check the names the tests rely on**

Run: `grep -n -e "export const TOP_UP_DISCRIMINATOR" -e "export function getTopUpInstruction<" -e "^  authority: " -e "^  session: " -e "^  vault: " -e "^  eventAuthority: " -e "^  program: " packages/program-client/src/generated/instructions/topUp.ts`
Expected: seven lines: the declarations of `TOP_UP_DISCRIMINATOR` and `getTopUpInstruction`, and the five members of
`TopUpInput` (`authority`, `session`, `vault`, `eventAuthority`, `program`). The input has no instruction argument. If
a name differs, correct the fixture's `topUp` and the test to match the generated code, not the generated code.

- [ ] **Step 19: Run the tests to see them pass**

Run: `cargo test -p stint && pnpm --filter @lxfoundry/stint-program-client test && pnpm --filter @lxfoundry/stint-program-client typecheck`
Expected: PASS. `28 passed` in the Rust run; every test of the program-client suite, including all 12 of
`top-up.test.ts`; no type error.

- [ ] **Step 20: Run the Solana program analyser on `top_up.rs`**

The `program_autofixer` tool of the Solana docs MCP server (`.mcp.json`) takes Rust program code and returns issues.
`CLAUDE.md` allows it on program code from this repository. Run it on `programs/stint/src/instructions/top_up.rs` with
`framework: "anchor"`, apply every Critical and High finding, and run it again until it reports none. Medium and Low
findings and suggestions are advisory: note them in the commit message body only if one changes behaviour. If the tool
is unavailable, say so in the task report. If a finding changed the file, run Step 17's build and Step 19's tests again.

- [ ] **Step 21: Commit the instruction and the regenerated client**

```bash
git add programs/stint/src/instructions/top_up.rs programs/stint/src/instructions/mod.rs programs/stint/src/lib.rs \
  packages/program-client/src/generated packages/program-client/test/program/fixture.ts \
  packages/program-client/test/program/top-up.test.ts
git commit -m "Add the top_up instruction and its generated client"
```

- [ ] **Step 22: Check the whole workspace against the new client**

Run: `pnpm typecheck && pnpm --filter @lxfoundry/stint-x402 test && git status --short`
Expected: PASS. The generated `StintInstruction` enum gained a member and the instruction parser a case, which no
other package branches on. `git status --short` prints nothing: everything is committed.

---

### Task 2: The scheme: top-up offers, durations, payloads, transactions and checks

`@lxfoundry/stint-x402` knows the `topUp` action only by name: it can read a `topUp` entry, but it cannot build one,
check its duration, read a `topUp` payload, build the transaction or check it. This task adds each of these, as spec
sections 5.1 to 5.4 describe them. The gate (Task 4) builds offers and checks durations with them; the client
(Task 5) builds the transaction; the facilitator (Task 3) checks it.

Decisions this task makes, from the code and the spec:
- **The funding comes from the refund owner's account.** Spec section 5.4 asks that the funding move exactly
  `amount`; it does not say from where. `checkTopUpTransaction` requires the associated token account of the stored
  `refund_owner`, as an open requires the funding to come from the account of the `refund_owner` it names: a close
  refunds that account, so a refund always goes back to where the money came from. Task 3 writes this into the spec.
- **The checks read the session as the chain stores it.** The authority, the mint and the refund owner come from the
  session account, which the caller reads, not from the transaction.
- **The rent payer has no place in a top-up.** Nothing in a top-up is created, so the rent payer may appear nowhere.
- **A top-up's payload names no session.** The session is `accepted.extra.session`; the payload is
  `{ type: "topUp", transaction }`. Task 2 writes this into spec section 5.3.

**Files:**
- Modify: `packages/x402/src/constants.ts`, `packages/x402/src/types.ts`, `packages/x402/src/offer.ts`,
  `packages/x402/src/wire.ts`, `packages/x402/src/transactions.ts`, `packages/x402/src/checks.ts`,
  `docs/specs/stint-system.md` (section 5.3)
- Modify (types only, Step 11): `apps/facilitator/src/verify.ts`, `apps/facilitator/src/settle.ts`
- Test: `packages/x402/test/offer.test.ts`, `packages/x402/test/wire.test.ts`, `packages/x402/test/checks.test.ts`

**Interfaces:**
- Consumes: Task 1's generated client: `getTopUpInstruction({ authority, session, vault, eventAuthority, program })`,
  `parseTopUpInstruction`, `StintInstruction.TopUp`, `findSessionPda`, `STINT_PROGRAM_ADDRESS`, `type Session`. In
  `checks.ts`: `checkPayerPositions`, `layoutBody`, `isTransferChecked`, `isStint`, `tryParse`, `checkSigners`.
- Produces (all exported from `@lxfoundry/stint-x402`):
  - `TOP_UP_MARGIN_SECONDS = 10`.
  - `interface TopUpPayload { type: "topUp"; transaction: string }`; `ElapsedPayload = OpenPayload | TopUpPayload |
    ClosePayload`; `readElapsedPayload` returns a `TopUpPayload` for a `topUp` payload.
  - `type TopUpOfferInput = OfferInput & { session: Address }`; `buildTopUpOffer(input: TopUpOfferInput):
    ElapsedRequirements` (amount `rate × seconds`, `extra.action: "topUp"`, `extra.session` set).
  - `checkTopUpDuration(terms: Terms, covered: bigint, seconds: number): DurationCheck`: `{ ok: true }` for a whole
    number from 1 to `maxSeconds - covered`, else `{ ok: false, minSeconds: 1, maxSeconds: max(0, maxSeconds - covered) }`.
  - `interface BuildTopUpInput { requirements: ElapsedRequirements; authority: TransactionSigner; decimals: number }`;
    `buildTopUpTransaction(input): Promise<string>` (base64 wire transaction, the fee payer's slot empty; throws for an
    entry that is not a top-up).
  - `interface TopUpFacts { session: Address; authority: Address }`; `checkTopUpTransaction(tx: InspectedTransaction,
    requirements: ElapsedRequirements, stored: Pick<Session, "authority" | "mint" | "refundOwner">, keys:
    FacilitatorKeys): Promise<Check<TopUpFacts>>`.

- [ ] **Step 1: Write the failing tests of the offer and the duration**

In `packages/x402/test/offer.test.ts`, replace

```ts
  buildOpenOffer,
  checkOpenDuration,
```

with

```ts
  buildOpenOffer,
  buildTopUpOffer,
  checkOpenDuration,
  checkTopUpDuration,
```

and replace

```ts
  it("accepts open durations from minSeconds to maxSeconds only (spec §5.2)", () => {
```

with

```ts
  it("builds a top-up entry: the deposit for its seconds, action topUp, the session set (spec §5.1)", () => {
    const entry = buildTopUpOffer({ ...input, seconds: 12, session: input.payTo });
    expect(entry.amount).toBe("12000");
    expect(entry.extra).toMatchObject({ action: "topUp", session: input.payTo, seconds: 12, rate: "1000", minSeconds: 5, maxSeconds: 120 });
    expect(readElapsedRequirements(entry)).toEqual(entry);
  });

  it("accepts top-up durations from 1 to what maxSeconds leaves after the covered seconds, whatever minSeconds (spec §5.2)", () => {
    const terms = input.terms; // 5 to 120 s
    expect(checkTopUpDuration(terms, 30n, 1)).toEqual({ ok: true });
    expect(checkTopUpDuration(terms, 30n, 90)).toEqual({ ok: true });
    for (const seconds of [0, 91, 2.5, Number.NaN]) {
      expect(checkTopUpDuration(terms, 30n, seconds)).toEqual({ ok: false, minSeconds: 1, maxSeconds: 90 });
    }
    // A session paid for maxSeconds has no room left; nor has one paid for more, which an open never allows.
    expect(checkTopUpDuration(terms, 120n, 1)).toEqual({ ok: false, minSeconds: 1, maxSeconds: 0 });
    expect(checkTopUpDuration(terms, 121n, 1)).toEqual({ ok: false, minSeconds: 1, maxSeconds: 0 });
  });

  it("accepts open durations from minSeconds to maxSeconds only (spec §5.2)", () => {
```

- [ ] **Step 2: Write the failing test of the payload**

In `packages/x402/test/wire.test.ts`, replace

```ts
  it("reads open and close payloads, and nothing else", () => {
```

with

```ts
  it("reads open, top-up and close payloads, and nothing else", () => {
```

and replace

```ts
    expect(readElapsedPayload({ ...base, payload: { type: "topUp", transaction: "AQ==" } })).toBeUndefined();
```

with

```ts
    expect(readElapsedPayload({ ...base, payload: { type: "topUp", transaction: "AQ==" } })).toEqual({ type: "topUp", transaction: "AQ==" });
    expect(readElapsedPayload({ ...base, payload: { type: "topUp", transaction: "" } })).toBeUndefined();
    expect(readElapsedPayload({ ...base, payload: { type: "refund", transaction: "AQ==" } })).toBeUndefined();
```

- [ ] **Step 3: Write the failing tests of the transaction and its checks**

In `packages/x402/test/checks.test.ts`, replace

```ts
import { getCreateAssociatedTokenIdempotentInstruction } from "@solana-program/token";
import { beforeAll, describe, expect, it } from "vitest";
import { CloseKind, type Session } from "@lxfoundry/stint-program-client";
import {
  associatedTokenAddress,
  buildCloseTransaction,
  buildOpenOffer,
  buildOpenTransaction,
  checkCloseTransaction,
  checkOpenTransaction,
```

with

```ts
import { TOKEN_PROGRAM_ADDRESS, getCreateAssociatedTokenIdempotentInstruction } from "@solana-program/token";
import { beforeAll, describe, expect, it } from "vitest";
import { CloseKind, STINT_PROGRAM_ADDRESS, findSessionPda, type Session } from "@lxfoundry/stint-program-client";
import {
  associatedTokenAddress,
  buildCloseTransaction,
  buildOpenOffer,
  buildOpenTransaction,
  buildTopUpOffer,
  buildTopUpTransaction,
  checkCloseTransaction,
  checkOpenTransaction,
  checkTopUpTransaction,
```

and replace

```ts
describe("sessionMatches (spec §7.2, check 4)", () => {
```

with

```ts
describe("top-up transactions (spec §5.3, §5.4)", () => {
  let buyer: KeyPairSigner;
  let feePayer: Address;
  let rentPayer: Address;
  let session: Address;
  let entry: ElapsedRequirements;
  let stored: Pick<Session, "authority" | "mint" | "refundOwner">;

  beforeAll(async () => {
    buyer = await generateKeyPairSigner();
    feePayer = (await generateKeyPairSigner()).address;
    rentPayer = (await generateKeyPairSigner()).address;
    [session] = await findSessionPda(buyer.address, 7n);
    entry = buildTopUpOffer({ ...offerInput({ facilitator: { ...offerInput().facilitator, feePayer, rentPayer } }), seconds: 12, session });
    stored = { authority: buyer.address, mint: entry.asset as Address, refundOwner: buyer.address };
  });

  const keys = () => ({ feePayer, rentPayer });
  const built = () => buildTopUpTransaction({ requirements: entry, authority: buyer, decimals: 6 });
  const check = async (wire: string, against: typeof stored = stored) => checkTopUpTransaction(inspectTransaction(wire)!, entry, against, keys());

  it("builds what the facilitator accepts: the funding, then stint.top_up, signed by the authority only", async () => {
    const wire = await built();
    const tx = inspectTransaction(wire)!;
    expect(tx.feePayer).toBe(feePayer);
    expect([...tx.signed]).toEqual([buyer.address]);
    expect(tx.instructions.map((ix) => ix.programAddress)).toEqual([TOKEN_PROGRAM_ADDRESS, STINT_PROGRAM_ADDRESS]);
    expect(await check(wire)).toEqual({ ok: true, value: { session, authority: buyer.address } });
  });

  it("refuses to build from an entry that is not a top-up", async () => {
    await expect(buildTopUpTransaction({ requirements: buildOpenOffer(offerInput()), authority: buyer, decimals: 6 })).rejects.toThrow(/top-up/);
  });

  it("refuses a deposit that is not exactly the amount", async () => {
    const wire = await buildTopUpTransaction({ requirements: { ...entry, amount: "11999" }, authority: buyer, decimals: 6 });
    expect(await check(wire)).toMatchObject({ ok: false, reason: "invalid_amount" });
  });

  it("refuses a top-up of another session", async () => {
    const [other] = await findSessionPda(buyer.address, 8n);
    const wire = await buildTopUpTransaction({ requirements: { ...entry, extra: { ...entry.extra, session: other } }, authority: buyer, decimals: 6 });
    expect(await check(wire)).toMatchObject({ ok: false, reason: "invalid_terms" });
  });

  it("refuses a top-up signed by a key other than the session's authority", async () => {
    const wire = await buildTopUpTransaction({ requirements: entry, authority: await generateKeyPairSigner(), decimals: 6 });
    expect(await check(wire)).toMatchObject({ ok: false, reason: "invalid_payload" });
  });

  it("refuses funding from an account other than the refund owner's, and a session in another mint", async () => {
    // The session refunds a wallet that is not the signer's: the funding must come from that wallet's account.
    expect(await check(await built(), { ...stored, refundOwner: (await generateKeyPairSigner()).address })).toMatchObject({
      ok: false,
      reason: "invalid_terms",
    });
    expect(await check(await built(), { ...stored, mint: feePayer })).toMatchObject({ ok: false, reason: "invalid_terms" });
  });

  it("accepts a compute-unit limit, and refuses an instruction outside the layout", async () => {
    const wire = await built();
    const withLimit = await rebuild(wire, buyer, (ixs) => [getSetComputeUnitLimitInstruction({ units: 100_000 }), ...ixs]);
    expect(await check(withLimit)).toMatchObject({ ok: true });
    const reversed = await rebuild(wire, buyer, (ixs) => [...ixs].reverse());
    expect(await check(reversed)).toMatchObject({ ok: false, reason: "unexpected_instruction" });
    const twice = await rebuild(wire, buyer, (ixs) => [ixs[0]!, ...ixs]);
    expect(await check(twice)).toMatchObject({ ok: false, reason: "unexpected_instruction" });
  });

  it("refuses the rent payer anywhere in a top-up", async () => {
    // Here the rent payer is the funding transfer's authority: a top-up creates nothing, so it has no place at all.
    const misplaced = await rebuild(await built(), buyer, ([transfer, topUp]) => [
      {
        ...transfer!,
        accounts: transfer!.accounts!.map((meta, at) =>
          at === 3 ? { address: rentPayer, role: AccountRole.READONLY_SIGNER, signer: createNoopSigner(rentPayer) } : meta,
        ),
      } as Instruction,
      topUp!,
    ]);
    expect(await check(misplaced)).toMatchObject({ ok: false, reason: "payer_misuse" });
  });

  it("refuses an extra signer, and a forged signature", async () => {
    const wire = await built();
    const extra = await generateKeyPairSigner();
    const withExtra = await rebuild(wire, buyer, (ixs) => [ixs[0]!, withExtraSigner(ixs[1]!, extra)]);
    expect(await check(withExtra)).toMatchObject({ ok: false, reason: "invalid_payload" });
    expect(await check(forged(wire, buyer.address))).toMatchObject({ ok: false, reason: "invalid_payload" });
  });
});

describe("sessionMatches (spec §7.2, check 4)", () => {
```

- [ ] **Step 4: Run them to see them fail**

Run: `pnpm --filter @lxfoundry/stint-x402 test`
Expected: FAIL: `buildTopUpOffer`, `checkTopUpDuration`, `buildTopUpTransaction` and `checkTopUpTransaction` are not
exported, and `readElapsedPayload` returns `undefined` for the `topUp` payload.

- [ ] **Step 5: Add the margin and the payload type**

In `packages/x402/src/constants.ts`, add at the end of the file:

```ts

/**
 * A top-up is refused when its session's paid time ends within this many seconds, on the facilitator's clock, so that the
 * transaction lands before the end (spec §5.4): from `paid_until` on, the program refuses it.
 */
export const TOP_UP_MARGIN_SECONDS = 10;
```

In `packages/x402/src/types.ts`, replace

```ts
export interface ClosePayload {
  readonly type: "close";
  readonly transaction: string;
}

export type ElapsedPayload = OpenPayload | ClosePayload;
```

with

```ts
/** A top-up's payload: the session it extends is `accepted.extra.session` (spec §5.3). */
export interface TopUpPayload {
  readonly type: "topUp";
  readonly transaction: string;
}

export interface ClosePayload {
  readonly type: "close";
  readonly transaction: string;
}

export type ElapsedPayload = OpenPayload | TopUpPayload | ClosePayload;
```

In `packages/x402/src/wire.ts`, replace

```ts
  if (inner.type === "close") return { type: "close", transaction: inner.transaction };
```

with

```ts
  if (inner.type === "topUp") return { type: "topUp", transaction: inner.transaction };
  if (inner.type === "close") return { type: "close", transaction: inner.transaction };
```

- [ ] **Step 6: Add the top-up entry and its durations**

In `packages/x402/src/offer.ts`, replace

```ts
export type CloseRequirementsInput = Omit<OfferInput, "seconds"> & { readonly session: Address };
```

with

```ts
export type CloseRequirementsInput = Omit<OfferInput, "seconds"> & { readonly session: Address };

export type TopUpOfferInput = OfferInput & { readonly session: Address };
```

replace

```ts
/** The requirements a gate sends with a close: nothing deposited (spec §5.5). */
```

with

```ts
/** One `accepts` entry for a top-up of `seconds` on `session` (spec §5.1): the deposit is `rate × seconds`, as an open's is. */
export function buildTopUpOffer(input: TopUpOfferInput): ElapsedRequirements {
  return build(input, input.seconds, amountFor(input.terms.rate, input.seconds), "topUp", input.session);
}

/** The requirements a gate sends with a close: nothing deposited (spec §5.5). */
```

and replace

```ts
const isU64String = (value: unknown) => typeof value === "string" && /^(0|[1-9][0-9]{0,19})$/.test(value);
```

with

```ts
/**
 * Valid top-up durations: whole seconds from 1 to what `maxSeconds` leaves after the `covered` seconds the session's
 * deposit already buys; `minSeconds` does not apply (spec §5.2). A refusal states the bounds, and its `maxSeconds` is 0
 * when the session is already paid for `maxSeconds`.
 */
export function checkTopUpDuration(terms: Terms, covered: bigint, seconds: number): DurationCheck {
  const room = BigInt(terms.maxSeconds) > covered ? Number(BigInt(terms.maxSeconds) - covered) : 0;
  return Number.isInteger(seconds) && seconds >= 1 && seconds <= room ? { ok: true } : { ok: false, minSeconds: 1, maxSeconds: room };
}

const isU64String = (value: unknown) => typeof value === "string" && /^(0|[1-9][0-9]{0,19})$/.test(value);
```

- [ ] **Step 7: Add the transaction**

In `packages/x402/src/transactions.ts`, replace

```ts
  getCloseInstruction,
  getOpenInstruction,
  type Session,
} from "@lxfoundry/stint-program-client";
```

with

```ts
  getCloseInstruction,
  getOpenInstruction,
  getTopUpInstruction,
  type Session,
} from "@lxfoundry/stint-program-client";
```

and replace

```ts
export interface BuildCloseInput {
```

with

```ts
export interface BuildTopUpInput {
  /** A `topUp` entry: `extra.session` names the session it extends. */
  readonly requirements: ElapsedRequirements;
  readonly authority: TransactionSigner;
  /** The asset's decimals, from the client's allowlist (spec §5.1, "Decimals"). */
  readonly decimals: number;
}

/**
 * The `topUp` layout of spec §5.3: fund the session's vault with exactly `amount` from the authority's associated token
 * account, then `stint.top_up`. Refunds go to the session's stored refund owner, which is the authority for every session
 * this client opens. The fee payer's slot stays empty; nobody else signs.
 */
export async function buildTopUpTransaction(input: BuildTopUpInput): Promise<string> {
  const { requirements, authority } = input;
  const extra = requirements.extra;
  if (extra.action !== "topUp" || extra.session === undefined) throw new Error("Not a top-up entry: no topUp action, or no session");
  const mint = address(requirements.asset);
  const session = address(extra.session);
  const vault = await associatedTokenAddress(session, mint);
  const instructions = [
    getTransferCheckedInstruction({
      source: await associatedTokenAddress(authority.address, mint),
      mint,
      destination: vault,
      authority,
      amount: BigInt(requirements.amount),
      decimals: input.decimals,
    }),
    getTopUpInstruction({ authority, session, vault, ...(await eventAccounts()) }),
  ];
  return compile(
    address(extra.feePayer),
    { blockhash: blockhash(extra.recentBlockhash), lastValidBlockHeight: BigInt(extra.lastValidBlockHeight) },
    instructions,
  );
}

export interface BuildCloseInput {
```

- [ ] **Step 8: Add the checks**

In `packages/x402/src/checks.ts`, replace

```ts
  parseCloseInstruction,
  parseOpenInstruction,
  type CloseKind,
```

with

```ts
  parseCloseInstruction,
  parseOpenInstruction,
  parseTopUpInstruction,
  type CloseKind,
```

and replace

```ts
export interface CloseFacts {
```

with

```ts
export interface TopUpFacts {
  readonly session: Address;
  readonly authority: Address;
}

/**
 * The static checks of spec §5.4 for a `topUp`, against the session as the chain stores it: the layout (one funding
 * transfer, then `stint.top_up`), the session the entry names and its canonical vault, the session's authority, and the
 * funding, which moves exactly `amount` of the session's mint from the refund owner's associated token account, so that a
 * refund goes back where the money came from. A top-up creates nothing, so the rent payer appears nowhere. Simulation,
 * the blockhash, the margin before `paid_until` and the `maxSeconds` total are the caller's.
 */
export async function checkTopUpTransaction(
  tx: InspectedTransaction,
  requirements: ElapsedRequirements,
  stored: Pick<Session, "authority" | "mint" | "refundOwner">,
  keys: FacilitatorKeys,
): Promise<Check<TopUpFacts>> {
  const positions = checkPayerPositions(tx, keys, () => false);
  if (!positions.ok) return positions;
  const body = layoutBody(tx);
  if (!body.ok) return body;
  const [transfer, topUp, ...rest] = body.value;
  if (!transfer || !topUp || rest.length > 0 || !isTransferChecked(transfer) || !isStint(topUp, StintInstruction.TopUp)) {
    return refuse("unexpected_instruction", "a top-up is: one funding transfer, stint.top_up");
  }
  const t = tryParse(() => parseTransferCheckedInstruction(transfer));
  const u = tryParse(() => parseTopUpInstruction(topUp));
  if (!t || !u) return refuse("unexpected_instruction", "an instruction of the top-up is malformed");

  const extra = requirements.extra;
  if (extra.programId !== STINT_PROGRAM_ADDRESS) return refuse("invalid_payment_requirements", "another program");
  if (extra.session === undefined || u.accounts.session.address !== extra.session) {
    return refuse("invalid_terms", "the top-up is for another session than the entry's");
  }
  if (u.accounts.authority.address !== stored.authority) return refuse("invalid_payload", "the top-up is not signed by the session's authority");
  const session = address(extra.session);
  const asset = address(requirements.asset);
  const vault = await associatedTokenAddress(session, stored.mint);
  if (stored.mint !== asset || u.accounts.vault.address !== vault) {
    return refuse("invalid_terms", "the session's mint or vault is not the entry's");
  }
  if (
    t.accounts.mint.address !== asset ||
    t.accounts.destination.address !== vault ||
    t.accounts.source.address !== (await associatedTokenAddress(stored.refundOwner, asset))
  ) {
    return refuse("invalid_terms", "the funding must move the asset from the refund owner's account into the vault");
  }
  if (t.data.amount !== BigInt(requirements.amount)) {
    return refuse("invalid_amount", `the funding moves ${t.data.amount}, not ${requirements.amount}`);
  }
  // The authority and the transfer authority may be the same key.
  const signers = await checkSigners(tx, new Set([keys.feePayer, stored.authority, t.accounts.authority.address]), keys);
  if (!signers.ok) return signers;
  return { ok: true, value: { session, authority: stored.authority } };
}

export interface CloseFacts {
```

- [ ] **Step 9: Run the tests to see them pass**

Run: `pnpm --filter @lxfoundry/stint-x402 test && pnpm --filter @lxfoundry/stint-x402 typecheck`
Expected: PASS; no type error.

If `refuses the rent payer anywhere in a top-up` reports `invalid_terms` or `invalid_payload` instead of
`payer_misuse`, the payer check is not running first: `checkPayerPositions` must be the first check, as it is in
`checkOpenTransaction`.

- [ ] **Step 10: State the top-up payload in the spec**

In `docs/specs/stint-system.md`, section 5.3, replace

```markdown
- `payload.session` is informative: the facilitator derives the address itself.
```

with

```markdown
- `payload.session` is informative: the facilitator derives the address itself.
- A top-up's payload is `{ "type": "topUp", "transaction": "<base64, partially signed>" }`. The session it extends is
  `accepted.extra.session`.
```

- [ ] **Step 11: Let the facilitator's types hold a `topUp` payload**

`ElapsedPayload` gained a member, so the `type: elapsed.type` that `verifyPayment` returns
(`apps/facilitator/src/verify.ts`) can now be `"topUp"`, and `settlePayment` passes it on to `submitSettlement`. Both
types must name it, or the workspace no longer type-checks. Only the types change here: Task 3 gives a top-up its own
checks and settlement.

In `apps/facilitator/src/verify.ts`, replace

```ts
      readonly type: "open" | "close";
```

with

```ts
      readonly type: "open" | "topUp" | "close";
```

In `apps/facilitator/src/settle.ts`, replace

```ts
export interface SignedSettlement {
  readonly type: "open" | "close";
```

with

```ts
export interface SignedSettlement {
  readonly type: "open" | "topUp" | "close";
```

- [ ] **Step 12: Check the packages that use the scheme, and commit**

Run: `pnpm typecheck && pnpm --filter @lxfoundry/stint-x402 test && pnpm --filter @lxfoundry/stint-facilitator test && pnpm --filter @lxfoundry/stint-gate test`
Expected: PASS. A `topUp` payload now reaches the facilitator's close branch, which refuses it; Task 3 gives it its
own branch, and until then no test sends one. One commit holds the scheme and the facilitator's types, so that every
commit type-checks.

```bash
git add packages/x402 docs/specs/stint-system.md apps/facilitator/src/verify.ts apps/facilitator/src/settle.ts
git commit -m "Add top-up offers, durations, payloads, transactions and checks to the scheme"
```

---

### Task 3: The facilitator verifies and settles top-ups

The facilitator refuses nothing about a top-up because it has never been sent one: `verifyPayment` has an open
branch, and treats every other payload as a close. This task gives it the checks of spec section 5.4 for a `topUp`,
and lets `/settle` report the deposit of a confirmed top-up as it does an open's.

Decisions this task makes, from the code and the spec:
- **The margin uses the facilitator's clock.** Spec section 12.4 lists the facilitator's clock as what decides the 10 s
  margin. `FacilitatorContext` gains an optional `clock` (milliseconds, default `Date.now`), which the tests set.
  `startFacilitator` does not expose it: no target moves the facilitator's clock in this stage.
- **The order of the checks.** The session must exist (`unknown_session`) and match the requirements
  (`invalid_terms`) before anything else is read from it. Then the margin (`session_expired`), the static checks of
  Task 2, and the `maxSeconds` total (`invalid_amount`). Simulation comes last, as for the other types, so that a
  refused top-up costs one read and no simulation.
- **`invalid_amount` for the `maxSeconds` total.** Spec section 5.4 lists the check and names no reason for it. The
  amount is what takes the session past `maxSeconds`, and the gate lists only durations that fit, so this refusal
  means a client asked for an entry the gate never offered.
- **The rent payer signs nothing in a top-up,** and funds nothing: its funding budget is zero, as for a close.

**Files:**
- Modify: `apps/facilitator/src/verify.ts`, `apps/facilitator/src/settle.ts`, `docs/specs/stint-system.md` (section 5.4)
- Test: `apps/facilitator/test/verify.test.ts`, `apps/facilitator/test/settle.test.ts`

**Interfaces:**
- Consumes: Task 2's `checkTopUpTransaction`, `buildTopUpOffer`, `buildTopUpTransaction`, `TOP_UP_MARGIN_SECONDS`;
  Task 1's `paidUntil`, `findSessionPda`.
- Produces:
  - `FacilitatorContext.clock?: () => number` (milliseconds).
  - `verifyPayment` accepts a `topUp` payload and returns `{ ok: true, type: "topUp", tx, payer: <the session's
    authority>, session }`, or refuses with `unknown_session`, `invalid_terms`, `session_expired`, `invalid_payload`,
    `invalid_amount`, `unexpected_instruction`, `payer_misuse`, `blockhash_expired` or `simulation_failed`.
  - `submitSettlement` answers a confirmed top-up (`SignedSettlement.type` names `"topUp"` since Task 2) with
    `{ success: true, transaction, network, payer, amount: <the requirements' amount> }`.
  - The facilitator's `/verify` and `/settle` therefore accept a top-up from a gate (Task 4).

- [ ] **Step 1: Write the failing tests of a top-up's verification**

In `apps/facilitator/test/verify.test.ts`, replace

```ts
import { STINT_PROGRAM_ADDRESS, getSessionEncoder, getSessionSize } from "@lxfoundry/stint-program-client";
import {
  associatedTokenAddress,
  buildCloseTransaction,
  buildOpenOffer,
  buildOpenTransaction,
  buildCloseRequirements,
  type ElapsedRequirements,
} from "@lxfoundry/stint-x402";
```

with

```ts
import { STINT_PROGRAM_ADDRESS, findSessionPda, getSessionEncoder, getSessionSize } from "@lxfoundry/stint-program-client";
import {
  associatedTokenAddress,
  buildCloseTransaction,
  buildOpenOffer,
  buildOpenTransaction,
  buildCloseRequirements,
  buildTopUpOffer,
  buildTopUpTransaction,
  type ElapsedRequirements,
} from "@lxfoundry/stint-x402";
```

and replace the last two lines of the file,

```ts
  });
});
```

with

```ts
  });

  describe("a top-up", () => {
    let session: Address;
    let topUpOffer: ElapsedRequirements;
    /** The session opened at 1,800,000,000 with 30,000 at 1,000 per second: paid until 1,800,000,030. */
    const STARTED_AT = 1_800_000_000n;

    const storedSession = (overrides: { rate?: bigint; deposited?: bigint } = {}) => ({
      owner: STINT_PROGRAM_ADDRESS,
      data: Uint8Array.from(
        getSessionEncoder().encode({
          version: 1,
          bump: 255,
          authority: buyer.address,
          seed: 1n,
          mint: MINT,
          receiver: offer.payTo as Address,
          receiverAuthorizer: authorizer.address,
          refundOwner: buyer.address,
          rentPayer: rentPayer.address,
          rate: overrides.rate ?? 1_000n,
          minSeconds: 5,
          maxSeconds: 120,
          startedAt: STARTED_AT,
          deposited: overrides.deposited ?? 30_000n,
          claimed: 0n,
        }),
      ),
    });

    const topUpPayload = async (signedBy: KeyPairSigner = buyer, requirements: ElapsedRequirements = topUpOffer) => {
      const transaction = await buildTopUpTransaction({ requirements, authority: signedBy, decimals: 6 });
      return payload(requirements, { type: "topUp", transaction });
    };

    /** The facilitator's clock at `seconds` after the session's start. */
    const at = (seconds: number) => {
      ctx = { ...ctx, clock: () => (Number(STARTED_AT) + seconds) * 1000 };
    };

    /** A node holding the session, with the facilitator's clock 5 s into it: 25 s before the end of its paid time. */
    const withSession = async (overrides: { rate?: bigint; deposited?: bigint } = {}) => {
      await resetNode();
      node.accounts.set(session, storedSession(overrides));
      at(5);
    };

    beforeAll(async () => {
      [session] = await findSessionPda(buyer.address, 1n);
      topUpOffer = buildTopUpOffer({
        network: NETWORK,
        asset: MINT,
        payTo: offer.payTo as Address,
        receiverAuthorizer: authorizer.address,
        terms: { rate: 1_000n, minSeconds: 5, maxSeconds: 120 },
        seconds: 12,
        facilitator: { feePayer, rentPayer: rentPayer.address, programId: STINT_PROGRAM_ADDRESS, closeUrl: "http://127.0.0.1:4021/close" },
        lifetime: { blockhash: BLOCKHASH, lastValidBlockHeight: 1_234n },
        maxTimeoutSeconds: 60,
        idleCloseSeconds: 10,
        closeOnOutage: true,
        session,
      });
    });

    it("accepts a top-up that passes every check and simulates, with the session's authority as the payer", async () => {
      await withSession();
      expect(await verifyPayment(ctx, await topUpPayload(), topUpOffer)).toMatchObject({ ok: true, type: "topUp", payer: buyer.address, session });
      expect(node.simulated).toBe(1);
    });

    it("refuses a session that does not exist", async () => {
      await resetNode();
      at(5);
      expect(await verifyPayment(ctx, await topUpPayload(), topUpOffer)).toMatchObject({ ok: false, reason: "unknown_session" });
      expect(node.simulated).toBe(0);
    });

    it("refuses a session whose terms differ from the offer", async () => {
      await withSession({ rate: 999n, deposited: 29_970n });
      expect(await verifyPayment(ctx, await topUpPayload(), topUpOffer)).toMatchObject({ ok: false, reason: "invalid_terms" });
      expect(node.simulated).toBe(0);
    });

    it.each([21, 30, 35])("refuses a top-up %s s into a session paid for 30 s: within 10 s of its end, or after it", async (seconds) => {
      await withSession();
      at(seconds);
      expect(await verifyPayment(ctx, await topUpPayload(), topUpOffer)).toMatchObject({ ok: false, reason: "session_expired" });
      expect(node.simulated).toBe(0);
    });

    it("accepts a top-up exactly 10 s before the end of the paid time", async () => {
      await withSession();
      at(20);
      expect(await verifyPayment(ctx, await topUpPayload(), topUpOffer)).toMatchObject({ ok: true, type: "topUp" });
    });

    it("refuses a top-up that would take the session past maxSeconds", async () => {
      // Paid for 110 s of 120: 12 s more would make 122.
      await withSession({ deposited: 110_000n });
      expect(await verifyPayment(ctx, await topUpPayload(), topUpOffer)).toMatchObject({ ok: false, reason: "invalid_amount" });
      expect(node.simulated).toBe(0);
    });

    it("refuses a top-up signed by a key other than the session's authority", async () => {
      await withSession();
      expect(await verifyPayment(ctx, await topUpPayload(await generateKeyPairSigner()), topUpOffer)).toMatchObject({
        ok: false,
        reason: "invalid_payload",
      });
      expect(node.simulated).toBe(0);
    });

    it("refuses a top-up payload against an open's requirements, and an open payload against a top-up's", async () => {
      await withSession();
      expect(await verifyPayment(ctx, { ...(await topUpPayload()), accepted: offer }, offer)).toMatchObject({ ok: false, reason: "invalid_payload" });
      expect(await verifyPayment(ctx, { ...(await openPayload()), accepted: topUpOffer }, topUpOffer)).toMatchObject({
        ok: false,
        reason: "invalid_payload",
      });
    });

    it("refuses a simulation in which the rent payer funds anything", async () => {
      await withSession();
      node.simulation = {
        err: null,
        innerInstructions: [
          {
            index: 1,
            instructions: [
              {
                programId: "11111111111111111111111111111111",
                parsed: { type: "transfer", info: { source: rentPayer.address, destination: session, lamports: 1 } },
              },
            ],
          },
        ],
      };
      expect(await verifyPayment(ctx, await topUpPayload(), topUpOffer)).toMatchObject({ ok: false, reason: "payer_misuse" });
    });
  });
});
```

- [ ] **Step 2: Write the failing test of a top-up's settlement**

In `apps/facilitator/test/settle.test.ts`, replace

```ts
  const signed = (type: "open" | "close"): SignedSettlement => ({
    type,
    wire: "AQ==",
    signature: SIGNATURE,
    blockhash: BLOCKHASH,
    payer,
    amount: type === "open" ? "30000" : "0",
  });
```

with

```ts
  const signed = (type: SignedSettlement["type"], amount = type === "close" ? "0" : "30000"): SignedSettlement => ({
    type,
    wire: "AQ==",
    signature: SIGNATURE,
    blockhash: BLOCKHASH,
    payer,
    amount,
  });
```

and replace the last two lines of the file,

```ts
  });
});
```

with

```ts
  });

  it("answers a top-up's deposit once it is confirmed, without reading the transaction", async () => {
    const { rpc, reads } = fakeRpc({ statuses: [confirmed], transactions: [() => null] });
    expect(await submitSettlement(ctx(rpc), signed("topUp", "12000"))).toEqual({
      success: true,
      transaction: SIGNATURE,
      network: NETWORK,
      payer,
      amount: "12000",
    });
    expect(reads.transactions).toBe(0);
  });
});
```

- [ ] **Step 3: Run them to see them fail**

Run: `pnpm --filter @lxfoundry/stint-facilitator test verify.test.ts settle.test.ts`
Expected: FAIL. A top-up payload reaches the close branch, whose layout check refuses it as `unexpected_instruction`,
so the tests that expect a top-up accepted, or refused for its own reasons, fail. Three pass by coincidence: the two
that expect `unknown_session` and `invalid_terms` (the close branch makes the same two checks first), and the one that
sends a payload against the other action's requirements (the check that the payload's type matches the action comes
before any branch). The new test of `settle.test.ts` fails too: the top-up is answered as a close, without its amount.

- [ ] **Step 4: Verify a top-up**

In `apps/facilitator/src/verify.ts`, replace

```ts
import { STINT_PROGRAM_ADDRESS, fetchMaybeSession, getSessionSize } from "@lxfoundry/stint-program-client";
import {
  X402_VERSION,
  associatedTokenAddress,
  checkCloseTransaction,
  checkOpenTransaction,
```

with

```ts
import { STINT_PROGRAM_ADDRESS, fetchMaybeSession, getSessionSize, paidUntil } from "@lxfoundry/stint-program-client";
import {
  TOP_UP_MARGIN_SECONDS,
  X402_VERSION,
  associatedTokenAddress,
  checkCloseTransaction,
  checkOpenTransaction,
  checkTopUpTransaction,
```

replace

```ts
  /** How a confirmed close's transaction is re-read while the node returns nothing. Default 5 reads, 400 ms apart. */
  readonly readRetry?: RetryOptions;
}
```

with

```ts
  /** How a confirmed close's transaction is re-read while the node returns nothing. Default 5 reads, 400 ms apart. */
  readonly readRetry?: RetryOptions;
  /** The facilitator's clock, in milliseconds: it decides the top-up margin of spec §5.4. Default `Date.now`. */
  readonly clock?: () => number;
}
```

and replace

```ts
  } else {
    if (!extra.session) return refuse("invalid_payment_requirements", "a close names its session");
```

with

```ts
  } else if (elapsed.type === "topUp") {
    if (!extra.session) return refuse("invalid_payment_requirements", "a top-up names its session");
    const session = address(extra.session);
    const stored = await fetchMaybeSession(ctx.rpc, session, { commitment: "confirmed" });
    if (!stored.exists) return refuse("unknown_session", "no such session");
    if (!sessionMatches(stored.data, sellerTermsOf(requirements))) {
      return refuse("invalid_terms", "the session's terms differ from the requirements");
    }
    // The transaction must land before the end: from `paid_until` on, the program refuses it (spec §4.3).
    const now = BigInt(Math.floor((ctx.clock ?? Date.now)() / 1000));
    if (paidUntil(stored.data) - now < BigInt(TOP_UP_MARGIN_SECONDS)) {
      return refuse("session_expired", `the session's paid time ends in less than ${TOP_UP_MARGIN_SECONDS} s`);
    }
    const check = await checkTopUpTransaction(tx, requirements, stored.data, ctx.keys);
    if (!check.ok) return check;
    if (stored.data.deposited + BigInt(requirements.amount) > stored.data.rate * BigInt(stored.data.maxSeconds)) {
      return refuse("invalid_amount", "the top-up would take the session past maxSeconds");
    }
    facts = { payer: stored.data.authority, session };
  } else {
    if (!extra.session) return refuse("invalid_payment_requirements", "a close names its session");
```

The funding budget stays at zero for a top-up, as the line `let funding: Funding = { destinations: [], budget: 0n };`
already sets it: the rent payer funds nothing.

- [ ] **Step 5: Settle a top-up**

In `apps/facilitator/src/settle.ts` (whose `SignedSettlement.type` names `"topUp"` since Task 2), replace

```ts
  /** The amount an open deposits; a close reports what its `Closed` event says it paid. */
```

with

```ts
  /** The amount an open or a top-up deposits; a close reports what its `Closed` event says it paid. */
```

and replace

```ts
  if (signed.type === "open") return { success: true, transaction: signature, network, payer, amount: signed.amount };
```

with

```ts
  if (signed.type !== "close") return { success: true, transaction: signature, network, payer, amount: signed.amount };
```

`settlePayment` needs no change: the rent payer signs only an `open` (`if (verified.type === "open")`), and the
amount it passes is the requirements' amount.

- [ ] **Step 6: Run the tests to see them pass**

Run: `pnpm --filter @lxfoundry/stint-facilitator test && pnpm --filter @lxfoundry/stint-facilitator typecheck`
Expected: PASS; no type error.

- [ ] **Step 7: State the top-up checks in the spec**

In `docs/specs/stint-system.md`, section 5.4, replace the row

```markdown
| `topUp` | The session exists and its terms match the gate's offer. The signer is its `authority`. `paid_until` is at least 10 s away, so the transaction lands before the end. The funding moves exactly `amount`. The total stays within `maxSeconds` |
```

with

```markdown
| `topUp` | The session exists and its terms match the gate's offer. The signer is its `authority`. `paid_until` is at least 10 s away on the facilitator's clock, so the transaction lands before the end (`session_expired` otherwise). The funding moves exactly `amount` of the session's mint into its vault, from the associated token account of its stored `refund_owner`, so that a refund goes back to the account the money came from. The total stays within `maxSeconds` (`invalid_amount` otherwise). The rent payer appears nowhere: a top-up creates no account |
```

and, in the table of reasons, replace

```markdown
| `session_expired` | A top-up after `paid_until` |
```

with

```markdown
| `session_expired` | A top-up after `paid_until`, or within 10 s of it |
```

- [ ] **Step 8: Commit**

```bash
git add apps/facilitator docs/specs/stint-system.md
git commit -m "Verify and settle top-ups in the facilitator"
```

---

### Task 4: The gate's top-up route

The gate has no route for a top-up, and its end timer, which stage 4 made re-read the session, is the only way it
learns of a later `paid_until`. This task adds `POST /sessions/:id/top-up` (spec section 7.1): a `402` with top-up
offers, then the payment, verified and settled through the facilitator like an open. Once the top-up settles, the
gate moves its end timer to the new end. A connection attached afterwards receives the new `paidUntil`.

Decisions this task makes, from the code and the spec:
- **Only a tracked session can be topped up.** Like a close or a connect, the route answers `404 unknown_session` for a
  session this gate does not track, for one whose account is gone, and for one whose account now holds another
  session. Adoption of sessions opened directly on the program is not built.
- **Once the end timer has fired, a top-up is refused at the gate.** The session is past its end on the gate's clock,
  and from `paid_until` on the program refuses a top-up. The answer is the one a connect gets then: a `402` with offers
  for a new session, here with the reason `session_expired`. The facilitator's own `session_expired` (the 10 s margin)
  is answered the same way. Every other refusal is a `402` with the top-up offers again.
- **The durations are read from the chain.** The deposit may have moved since the open (a top-up made on-chain
  directly), so the route reads the session and lists the menu durations that fit (spec section 5.2). When none fits,
  or the request names one that does not, the answer is `400 invalid_duration` with the bounds.
- **The new end is worked out, not read.** The program credits at least `amount` (spec section 4.3), so the end is
  `paid_until` of the deposit read before the payment plus `amount`. If the program credited more (tokens sent to the
  vault by mistake, or another top-up meanwhile), the end timer finds the later end when it fires, as it finds any
  top-up this gate did not settle. No read after the settlement means no read that can fail after the buyer has paid.
- **A top-up that settles while the end close is in flight.** The top-up resumes the session; the end close, which
  then fails with `NotExpired`, must not arm a retry over the new end timer. `expire` stops after its pass when the
  session was resumed during it (`resume` clears `endRetry`).
- **A top-up only moves the end.** `resume` is split: `extend` sets the new end and the end timer, and `resume` adds
  forwarding and the idle timer. The route calls `resume` only when the end timer has fired; otherwise `extend`, so a
  top-up does not arm again an idle timer whose close failed (a failed close leaves the session to run to its end, and
  spec section 7.3 does not retry a close refused because the buyer's refund account is closed).
- **The `200` reports the later end it knows.** If the end timer's re-read found a top-up made elsewhere while this one
  settled, the session already runs later than the worked-out end: the answer is the later of the two.
- **A pending top-up** (`202`) needs nothing more from the route: if it lands, the gate finds the later end as it finds
  any top-up it did not settle, through its subscription to the account (Task 7) or, failing that, the end timer's
  re-read. `paidLonger` is what both the route and the subscription call with a later end.

**Files:**
- Modify: `packages/gate/src/gate.ts`, `docs/specs/stint-system.md` (section 7.1)
- Modify (test support): `packages/gate/test/harness.ts`
- Create: `packages/gate/test/top-up.test.ts`

**Interfaces:**
- Consumes: Task 2's `buildTopUpOffer`, `checkTopUpDuration`, `buildTopUpTransaction` (in the test harness),
  `type ElapsedRequirements`; Task 1's `paidUntil`. The facilitator (Task 3) is faked in this task's tests.
- Produces:
  - `POST /sessions/:id/top-up?seconds=N`: `402` (top-up offers for the session, in the body and the
    `PAYMENT-REQUIRED` header, with `resource.url` the route itself); `402 session_expired` with open offers once the
    end timer has fired, or when the facilitator answers `session_expired`; `402` with the facilitator's reason and the
    top-up offers for any other refusal; `200 {paidUntil}` (Unix seconds, a number) with `PAYMENT-RESPONSE`; `202
    {transaction}` with `PAYMENT-RESPONSE` while the settlement is pending; `400 {error: "invalid_duration", minSeconds:
    1, maxSeconds}`; `404 {error: "unknown_session"}`.
  - `SessionInfo.paidUntil` follows the session's end: `attach` and `teardown` receive the latest.
  - The test harness: `hold.settleTopUp?: Promise<void>`; a settled top-up credits the fake chain's `deposited`;
    `helpers()` gains `topUpOffers(session, seconds?)`, `prepareTopUp(session, seconds = 10)` and
    `sendTopUp(session, payload, seconds = 10)`.

- [ ] **Step 1: Teach the test harness about top-ups**

In `packages/gate/test/harness.ts`, replace

```ts
import {
  USDC_DEVNET,
  buildOpenTransaction,
  createSessionToken,
  encodePaymentSignatureHeader,
  readElapsedPayload,
```

with

```ts
import {
  USDC_DEVNET,
  buildOpenTransaction,
  buildTopUpTransaction,
  createSessionToken,
  encodePaymentSignatureHeader,
  readElapsedPayload,
  readElapsedRequirements,
```

replace

```ts
  hold: { provision?: Promise<void>; settleClose?: Promise<void>; readSession?: Promise<void> };
```

with

```ts
  hold: { provision?: Promise<void>; settleClose?: Promise<void>; settleTopUp?: Promise<void>; readSession?: Promise<void> };
```

replace

```ts
      settle: async (payload) => {
        harness.calls.settle.push(payload);
        if (readElapsedPayload(payload)?.type === "close") {
          await harness.hold.settleClose;
          harness.onSettleClose?.();
          if (harness.fail.settleClose) throw new Error("facilitator down");
        }
        return harness.settleAnswer(payload);
      },
```

with

```ts
      settle: async (payload) => {
        harness.calls.settle.push(payload);
        const type = readElapsedPayload(payload)?.type;
        if (type === "close") {
          await harness.hold.settleClose;
          harness.onSettleClose?.();
          if (harness.fail.settleClose) throw new Error("facilitator down");
        }
        if (type === "topUp") await harness.hold.settleTopUp;
        const answer = harness.settleAnswer(payload);
        // A top-up that settles is credited on the fake chain, as the program credits it.
        const session = type === "topUp" && answer.success ? (readElapsedRequirements(payload.accepted)?.extra.session as Address | undefined) : undefined;
        const stored = session && harness.sessions.get(session);
        if (session && stored) harness.sessions.set(session, { ...stored, deposited: stored.deposited + BigInt(payload.accepted.amount) });
        return answer;
      },
```

and replace

```ts
  return { offers, open, send, prepareOpen, closeWith, settleDown, token, connect };
}
```

with

```ts
  const topUpUrl = (session: Address, seconds?: number) =>
    `${get().url}/sessions/${session}/top-up${seconds === undefined ? "" : `?seconds=${seconds}`}`;

  /** The gate's answer to a top-up request without a payment: 402 with its offers, or a refusal. */
  async function topUpOffers(session: Address, seconds?: number): Promise<{ status: number; body: Record<string, unknown>; header: string | null }> {
    const response = await fetch(topUpUrl(session, seconds), { method: "POST" });
    return { status: response.status, body: (await response.json()) as Record<string, unknown>, header: response.headers.get("payment-required") };
  }

  /** A payment for the top-up of `seconds` that the gate offers for `session`, signed by the harness's buyer. */
  async function prepareTopUp(session: Address, seconds = 10): Promise<PaymentPayload> {
    const { body } = await topUpOffers(session, seconds);
    const required = body as unknown as PaymentRequired;
    const offer = required.accepts[0]!;
    const transaction = await buildTopUpTransaction({ requirements: offer as never, authority: get().buyer, decimals: 6 });
    return { x402Version: 2, resource: required.resource, accepted: offer, payload: { type: "topUp", transaction } };
  }

  async function sendTopUp(
    session: Address,
    payload: PaymentPayload,
    seconds = 10,
  ): Promise<{ status: number; body: Record<string, unknown>; paymentResponse: string | null }> {
    const response = await fetch(topUpUrl(session, seconds), {
      method: "POST",
      headers: { "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(payload) },
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown>, paymentResponse: response.headers.get("payment-response") };
  }

  return { offers, open, send, prepareOpen, closeWith, settleDown, token, connect, topUpOffers, prepareTopUp, sendTopUp };
}
```

Run: `pnpm --filter @lxfoundry/stint-gate test && pnpm --filter @lxfoundry/stint-gate typecheck`
Expected: PASS, the existing tests unchanged: no test sends a top-up yet.

- [ ] **Step 2: Write the failing tests of the route**

Create `packages/gate/test/top-up.test.ts`:

```ts
import type { Address } from "@solana/kit";
import { decodePaymentResponseHeader, readElapsedPayload, type PaymentRequired } from "@lxfoundry/stint-x402";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NOW_MS, helpers, startHarness, type FakeTimer, type Harness } from "./harness.js";

/** What a deposit of 30,000 at 1,000 per second lasts, in the harness's sessions. */
const END_DUE = NOW_MS + 30_000;
/** The end after a top-up of 10 s. */
const EXTENDED_DUE = NOW_MS + 40_000;

describe("the gate's top-up route (spec §7.1)", () => {
  let h: Harness;
  const { open, prepareOpen, settleDown, token, connect, topUpOffers, prepareTopUp, sendTopUp } = helpers(() => h);

  beforeEach(async () => {
    h = await startHarness();
  });

  afterEach(async () => {
    expect(h.escaped).toEqual([]);
    await h.gate.close();
    h.server.closeAllConnections();
    await new Promise((resolve) => h.server.close(resolve));
  });

  const ofType = (type: string) => h.calls.settle.filter((payload) => readElapsedPayload(payload)?.type === type);
  const accepts = (body: Record<string, unknown>) => (body as unknown as PaymentRequired).accepts;
  /** The one timer still waiting that is due at `dueMs` on the session clock. */
  function pendingDue(dueMs: number): FakeTimer {
    const found = h.timers.pending.filter((timer) => timer.dueMs === dueMs);
    expect(found).toHaveLength(1);
    return found[0]!;
  }
  /** Makes the fake facilitator's settlement of a top-up or of a close wait until the returned function is called. */
  function hold(slot: "settleTopUp" | "settleClose"): () => void {
    let release!: () => void;
    h.hold[slot] = new Promise<void>((resolve) => (release = resolve));
    return release;
  }
  /** An open session with one connection: `frames` collects what the buyer's socket receives. */
  async function openConnected() {
    const { session } = await open();
    const { socket } = await connect(session, await token(session, "connect"));
    const frames: string[] = [];
    socket!.on("message", (data) => frames.push(String(data)));
    return { session, server: h.attached.at(-1)!, frames };
  }

  it("answers 402 with one top-up entry per menu duration that fits, naming the session, in the body and the header", async () => {
    const { session } = await open();

    const { status, body, header } = await topUpOffers(session);

    expect(status).toBe(402);
    expect(header).not.toBeNull();
    // The menu is 30 s and 60 s, and the session is paid for 30 s of 120: both fit.
    expect(accepts(body).map((entry) => [entry.amount, entry.extra?.action, entry.extra?.session, entry.extra?.seconds])).toEqual([
      ["30000", "topUp", session, 30],
      ["60000", "topUp", session, 60],
    ]);
    expect((body.resource as { url: string }).url).toBe(`${h.url}/sessions/${session}/top-up`);
    expect(ofType("topUp")).toEqual([]);
  });

  it("lists only the menu durations that still fit, reading the deposit from the chain", async () => {
    const { session } = await open();
    h.sessions.set(session, { ...h.sessions.get(session)!, deposited: 80_000n }); // topped up elsewhere: 40 s of 120 left

    expect(accepts((await topUpOffers(session)).body).map((entry) => entry.extra?.seconds)).toEqual([30]);
  });

  it("answers 400 invalid_duration, with the bounds, for a duration that does not fit, and when no duration fits", async () => {
    const { session } = await open();

    for (const seconds of [0, 91, 2.5]) {
      expect(await topUpOffers(session, seconds)).toMatchObject({ status: 400, body: { error: "invalid_duration", minSeconds: 1, maxSeconds: 90 } });
    }
    // 1 s is below minSeconds (5), which a top-up does not have to meet.
    expect((await topUpOffers(session, 1)).status).toBe(402);
    h.sessions.set(session, { ...h.sessions.get(session)!, deposited: 120_000n });
    expect(await topUpOffers(session)).toMatchObject({ status: 400, body: { error: "invalid_duration", minSeconds: 1, maxSeconds: 0 } });
    expect(ofType("topUp")).toEqual([]);
  });

  it("answers 404 for a session it does not track, for one whose account is gone, and for an id that is not an address", async () => {
    const { session: untracked } = await prepareOpen(); // on the fake chain, but never opened through this gate
    expect(await topUpOffers(untracked)).toMatchObject({ status: 404, body: { error: "unknown_session" } });

    const { session } = await open();
    h.sessions.delete(session);
    expect(await topUpOffers(session)).toMatchObject({ status: 404, body: { error: "unknown_session" } });

    expect(await topUpOffers("1".repeat(44) as Address)).toMatchObject({ status: 404, body: { error: "unknown_session" } });
  });

  it("takes the payment: verifies and settles it, answers 200 with the new paid_until, and moves the end timer there", async () => {
    const { session } = await open();
    const payload = await prepareTopUp(session, 10);

    const { status, body, paymentResponse } = await sendTopUp(session, payload, 10);

    expect(status).toBe(200);
    expect(body).toEqual({ paidUntil: EXTENDED_DUE / 1000 });
    expect(decodePaymentResponseHeader(paymentResponse!)).toMatchObject({ success: true });
    expect(h.calls.verify.at(-1)).toEqual(payload);
    expect(ofType("topUp")).toEqual([payload]);
    expect(pendingDue(EXTENDED_DUE)).toBeDefined();
    expect(h.timers.pending.filter((timer) => timer.dueMs === END_DUE)).toEqual([]);
  });

  it("keeps forwarding past the old end of the paid time", async () => {
    const { session, server, frames } = await openConnected();
    await sendTopUp(session, await prepareTopUp(session, 10), 10);

    h.clock.now = END_DUE + 1_000;
    server.send("tick:extended");

    await expect.poll(() => frames).toContain("tick:extended");
    expect(h.timers.pending.map((timer) => timer.dueMs)).toEqual([EXTENDED_DUE]);
    expect(h.calls.teardown).toEqual([]);
  });

  it("hands a connection attached after the top-up the new paid_until", async () => {
    const { session } = await open();
    await sendTopUp(session, await prepareTopUp(session, 10), 10);

    await connect(session, await token(session, "connect"));

    expect(h.calls.attach.at(-1)?.paidUntil).toBe(BigInt(EXTENDED_DUE / 1000));
  });

  it("refuses a top-up once the end timer has fired: 402 session_expired, with offers for a new session", async () => {
    const { session } = await openConnected();
    h.fail.settleClose = true; // the end close fails, as an AtExpiry close does while the chain's clock lags
    h.timers.fire(pendingDue(END_DUE));
    await expect.poll(() => h.timers.pending.map((timer) => timer.delayMs)).toEqual([3_000]);

    const { status, body } = await topUpOffers(session, 10);

    expect(status).toBe(402);
    expect(body.error).toBe("session_expired");
    expect(accepts(body).map((entry) => entry.extra?.action)).toEqual(["open", "open"]);
    expect(ofType("topUp")).toEqual([]);
  });

  it("answers 402 with the facilitator's reason when it refuses the top-up, settles nothing, and leaves the end timer", async () => {
    const { session } = await open();
    const payload = await prepareTopUp(session, 10);
    h.verifyAnswer = { isValid: false, invalidReason: "invalid_amount" };

    const { status, body } = await sendTopUp(session, payload, 10);

    expect(status).toBe(402);
    expect(body.error).toBe("invalid_amount");
    expect(accepts(body).map((entry) => [entry.extra?.action, entry.extra?.seconds])).toEqual([["topUp", 10]]);
    expect(ofType("topUp")).toEqual([]);
    expect(pendingDue(END_DUE)).toBeDefined();
  });

  it("answers the facilitator's session_expired with offers for a new session", async () => {
    const { session } = await open();
    const payload = await prepareTopUp(session, 10);
    h.verifyAnswer = { isValid: false, invalidReason: "session_expired" };

    const { status, body } = await sendTopUp(session, payload, 10);

    expect(status).toBe(402);
    expect(body.error).toBe("session_expired");
    expect(accepts(body).map((entry) => entry.extra?.action)).toEqual(["open", "open"]);
  });

  it("answers 402 with the reason when the settlement fails, and leaves the session as it was", async () => {
    const { session } = await open();
    const payload = await prepareTopUp(session, 10);
    h.settleAnswer = () => ({ success: false, errorReason: "simulation_failed", transaction: "", network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" });

    const { status, body } = await sendTopUp(session, payload, 10);

    expect(status).toBe(402);
    expect(body.error).toBe("simulation_failed");
    expect(h.sessions.get(session)?.deposited).toBe(30_000n);
    expect(pendingDue(END_DUE)).toBeDefined();
  });

  it("answers 202 with the transaction while the settlement is pending, and leaves the end timer", async () => {
    const { session } = await open();
    const payload = await prepareTopUp(session, 10);
    h.settleAnswer = () => ({ success: false, errorReason: "settlement_pending", transaction: "pending-sig", network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" });

    const { status, body, paymentResponse } = await sendTopUp(session, payload, 10);

    expect(status).toBe(202);
    expect(body).toEqual({ transaction: "pending-sig" });
    expect(decodePaymentResponseHeader(paymentResponse!)).toMatchObject({ success: false, errorReason: "settlement_pending" });
    expect(pendingDue(END_DUE)).toBeDefined();
  });

  it("refuses a payment that does not accept a top-up of this session for the duration asked, before verifying it", async () => {
    const { session } = await open();
    const other = await open();
    const verifications = h.calls.verify.length;
    const { payload: anOpen } = await prepareOpen();

    for (const payload of [anOpen, await prepareTopUp(session, 30), await prepareTopUp(other.session, 10)]) {
      expect(await sendTopUp(session, payload, 10)).toMatchObject({ status: 402, body: { error: "invalid_payment_requirements" } });
    }
    expect(h.calls.verify).toHaveLength(verifications);
    expect(ofType("topUp")).toEqual([]);
  });

  it("resumes forwarding, and keeps the new end timer, when its end timer fires while the top-up settles", async () => {
    const { session, server, frames } = await openConnected();
    const releaseTopUp = hold("settleTopUp");
    const releaseClose = hold("settleClose");
    const paying = sendTopUp(session, await prepareTopUp(session, 10), 10);
    await expect.poll(() => ofType("topUp")).toHaveLength(1); // the top-up's settlement is in flight
    h.fail.settleClose = true; // the end close will fail: by then the top-up has moved paid_until
    h.timers.fire(pendingDue(END_DUE)); // forwarding stops; the end close waits in the facilitator
    await expect.poll(() => ofType("close")).toHaveLength(1);

    releaseTopUp();
    expect((await paying).status).toBe(200);
    server.send("tick:resumed");
    await expect.poll(() => frames).toContain("tick:resumed");
    releaseClose(); // the end close fails now, after the top-up resumed the session
    await settleDown();

    expect(h.timers.pending.map((timer) => timer.dueMs)).toEqual([EXTENDED_DUE]);
    expect(h.calls.teardown).toEqual([]);
  });

  it("leaves an idle close that failed alone: a top-up moves the end timer and arms no idle timer", async () => {
    const { session } = await open();
    h.fail.settleClose = true;
    h.timers.fire(pendingDue(NOW_MS + 10_000)); // the idle timer: its close fails, and the session runs on to its end
    await expect.poll(() => ofType("close")).toHaveLength(1);
    await settleDown();
    h.fail.settleClose = false;

    expect((await sendTopUp(session, await prepareTopUp(session, 10), 10)).status).toBe(200);

    expect(h.timers.pending.map((timer) => timer.dueMs)).toEqual([EXTENDED_DUE]);
  });

  it("answers the later end it knows when its end timer found a top-up made elsewhere while this one settled", async () => {
    const { session } = await openConnected();
    const releaseTopUp = hold("settleTopUp");
    const paying = sendTopUp(session, await prepareTopUp(session, 10), 10);
    await expect.poll(() => ofType("topUp")).toHaveLength(1);
    h.sessions.set(session, { ...h.sessions.get(session)!, deposited: 70_000n }); // 40 s more, topped up on-chain meanwhile
    h.timers.fire(pendingDue(END_DUE)); // the end timer's re-read finds it: the session runs on to +70 s
    await expect.poll(() => h.timers.pending.map((timer) => timer.dueMs)).toEqual([NOW_MS + 70_000]);

    releaseTopUp();

    expect((await paying).body).toEqual({ paidUntil: NOW_MS / 1000 + 70 });
    expect(h.timers.pending.map((timer) => timer.dueMs)).toEqual([NOW_MS + 70_000]);
  });
});
```

- [ ] **Step 3: Run them to see them fail**

Run: `pnpm --filter @lxfoundry/stint-gate test top-up.test.ts`
Expected: FAIL. No route serves `/top-up` yet, so `handleRequest` leaves the request to the host, the harness answers
`404` with an empty body, and `topUpOffers` fails to parse it as JSON: every test fails.

- [ ] **Step 4: Add the route**

In `packages/gate/src/gate.ts`, make these replacements.

The imports: replace

```ts
  buildCloseRequirements,
  buildCloseTransaction,
  buildOpenOffer,
  checkOpenDuration,
```

with

```ts
  buildCloseRequirements,
  buildCloseTransaction,
  buildOpenOffer,
  buildTopUpOffer,
  checkOpenDuration,
  checkTopUpDuration,
```

and replace

```ts
  type FacilitatorExtra,
  type OfferInput,
```

with

```ts
  type ElapsedRequirements,
  type FacilitatorExtra,
  type OfferInput,
```

The tracked session's `info`: replace

```ts
interface Tracked<U> {
  readonly info: SessionInfo;
```

with

```ts
interface Tracked<U> {
  /** What the resource is handed. Its `paidUntil` follows the session's, so a connection attached after a top-up gets the new end. */
  info: SessionInfo;
```

The routes: replace

```ts
const SESSION_PATH = /^\/sessions\/([1-9A-HJ-NP-Za-km-z]{32,44})\/(ws|close)$/;
/** `GET /sessions/:id` (the status); `SESSION_PATH` holds the routes that end in `/ws` or `/close`. */
```

with

```ts
const SESSION_PATH = /^\/sessions\/([1-9A-HJ-NP-Za-km-z]{32,44})\/(ws|close|top-up)$/;
/** `GET /sessions/:id` (the status); `SESSION_PATH` holds the routes that end in `/ws`, `/close` or `/top-up`. */
```

The 402: replace

```ts
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
```

with

```ts
  /** A 402 listing `accepts` for the payment at `resource` (spec §5.1), in the body and in the `PAYMENT-REQUIRED` header. */
  function sendPaymentRequired(response: ServerResponse, resource: string, accepts: readonly ElapsedRequirements[], error?: string): void {
    const body: PaymentRequired = {
      x402Version: X402_VERSION,
      ...(error === undefined ? {} : { error }),
      resource: { url: resource },
      accepts: [...accepts],
    };
    sendJson(response, 402, body, { [HEADERS.paymentRequired]: encodePaymentRequiredHeader(body) });
  }

  /** A 402 offering a new session, one entry per duration. */
  async function paymentRequired(response: ServerResponse, durations: readonly number[], error?: string): Promise<void> {
    const base = await offerBase();
    sendPaymentRequired(response, `${config.origin}/sessions`, durations.map((seconds) => buildOpenOffer({ ...base, seconds })), error);
  }
```

`resume` is split in two: `extend` moves the end, which is all a top-up does to a session whose end timer has not fired,
and `resume` also lets forwarding go on and arms the idle timer again where the drop of the last connection could not.
Replace

```ts
  /** The session was paid for longer: forwarding resumes in both directions, and the end timer is set for the new end of the paid time. */
  function resume(tracked: Tracked<U>, until: bigint): void {
    if (tracked.muted) {
      for (const [socket, original] of tracked.muted) {
        socket.send = original.send;
        socket.emit = original.emit;
      }
    }
    tracked.muted = undefined;
    tracked.endRetry = undefined;
    tracked.paidUntil = until;
    armEnd(tracked);
```

with

```ts
  /**
   * The session was paid for longer: the end timer is set for the new end of the paid time, which the resource's
   * `SessionInfo` carries from then on. Nothing else changes: an idle timer whose close failed is not armed again, since a
   * failed close leaves the session to run to the end of its paid time.
   */
  function extend(tracked: Tracked<U>, until: bigint): void {
    tracked.endRetry = undefined;
    tracked.paidUntil = until;
    tracked.info = { ...tracked.info, paidUntil: until };
    armEnd(tracked);
  }

  /** The session was paid for longer while forwarding was stopped: forwarding resumes in both directions, and the session is extended. */
  function resume(tracked: Tracked<U>, until: bigint): void {
    if (tracked.muted) {
      for (const [socket, original] of tracked.muted) {
        socket.send = original.send;
        socket.emit = original.emit;
      }
    }
    tracked.muted = undefined;
    extend(tracked, until);
```

The rest of `resume`, which arms the idle timer when no connection is left and none is pending, stays as it is.

`expire` arms nothing after a pass during which a top-up resumed the session: replace

```ts
   * seconds. `resume` starts the short waits again.
   */
  async function expire(tracked: Tracked<U>): Promise<void> {
    mute(tracked);
    const retry = (tracked.endRetry ??= { since: sessionClock(), delayMs: endRetryMs });
    if (await attempt(tracked)) return;
```

with

```ts
   * seconds. `resume` starts the short waits again. A top-up through this gate can resume the session while a pass runs
   * (its settlement was in flight when the timer fired): the pass then arms nothing, since the end timer is set already.
   */
  async function expire(tracked: Tracked<U>): Promise<void> {
    mute(tracked);
    const retry = (tracked.endRetry ??= { since: sessionClock(), delayMs: endRetryMs });
    if (await attempt(tracked)) return;
    // `resume` clears `endRetry`: the session runs on to its new end, for which the end timer is set.
    if (tracked.endRetry !== retry) return;
```

The route itself: replace

```ts
  /** Checks 1 to 3 of spec §7.2. Check 4 holds for every tracked session: it opened with this gate's terms. */
```

with

```ts
  /**
   * The session is paid until `until`, if that is later than the end the gate knows: forwarding goes on if the end timer has
   * fired, and otherwise only the end moves. A session that has ended stays ended.
   */
  function paidLonger(tracked: Tracked<U>, until: bigint): void {
    if (tracked.ended || until <= tracked.paidUntil) return;
    if (tracked.muted) resume(tracked, until);
    else extend(tracked, until);
  }

  /**
   * `POST /sessions/:id/top-up` (spec §7.1): a 402 listing top-up offers, then the payment. Only a session this gate tracks
   * can be topped up. Once its end timer has fired, the session cannot be extended (spec §4.3): the answer is a 402 with
   * `session_expired` and offers for a new session, as a connect gets then. The durations that fit come from the chain,
   * since a top-up made elsewhere may have moved the deposit (spec §5.2). Once the top-up settles, the end timer moves to
   * the end of the deposit read before the payment plus the amount: the program credits at least that (spec §4.3), and
   * if it credited more, the end timer finds the later end when it fires, as it finds any top-up this gate did not settle.
   */
  async function topUp(request: IncomingMessage, response: ServerResponse, url: URL, session: Address): Promise<void> {
    const tracked = sessions.get(session);
    if (!tracked || tracked.ended) return sendJson(response, 404, { error: "unknown_session" });
    if (tracked.muted) return paymentRequired(response, menu, "session_expired");
    const stored = await upstream(() => config.chain.readSession(session));
    if (!stored || stored.startedAt !== tracked.stored.startedAt || !sessionMatches(stored, seller)) {
      return sendJson(response, 404, { error: "unknown_session" });
    }
    const covered = stored.deposited / stored.rate;
    const requested = url.searchParams.get("seconds");
    const durations =
      requested === null ? menu.filter((seconds) => checkTopUpDuration(config.terms, covered, seconds).ok) : [Number(requested)];
    // When no duration of the menu fits, the 400 states the bounds, so that the buyer can ask for one that does.
    const checks =
      durations.length === 0 ? [checkTopUpDuration(config.terms, covered, 0)] : durations.map((seconds) => checkTopUpDuration(config.terms, covered, seconds));
    for (const check of checks) {
      if (!check.ok) return sendJson(response, 400, { error: "invalid_duration", minSeconds: check.minSeconds, maxSeconds: check.maxSeconds });
    }

    const resource = `${config.origin}/sessions/${session}/top-up`;
    const offers = async () => {
      const base = await offerBase();
      return durations.map((seconds) => buildTopUpOffer({ ...base, seconds, session }));
    };
    // A refusal because the session has run out offers a new session; any other offers the top-up again.
    const refusal = async (reason: string) =>
      reason === "session_expired" ? paymentRequired(response, menu, reason) : sendPaymentRequired(response, resource, await offers(), reason);

    const header = request.headers[HEADERS.paymentSignature.toLowerCase()];
    if (typeof header !== "string") return sendPaymentRequired(response, resource, await offers());
    let payload: PaymentPayload;
    try {
      payload = decodePaymentSignatureHeader(header);
    } catch {
      return refusal("invalid_payload");
    }
    const accepted = readElapsedRequirements(payload.accepted);
    if (!accepted || accepted.extra.action !== "topUp" || accepted.extra.session !== session || !durations.includes(accepted.extra.seconds)) {
      return refusal("invalid_payment_requirements");
    }
    // The requirements as this gate issues them, with the advisory fields of the entry the client accepted (spec §5.5).
    const requirements = buildTopUpOffer({
      ...(await offerBase({
        blockhash: accepted.extra.recentBlockhash,
        lastValidBlockHeight: BigInt(accepted.extra.lastValidBlockHeight),
      })),
      maxTimeoutSeconds: accepted.maxTimeoutSeconds,
      seconds: accepted.extra.seconds,
      session,
    });

    const verified = await upstream(() => config.facilitator.verify(payload, requirements));
    if (!verified.isValid) return refusal(verified.invalidReason ?? "invalid_payload");
    const settled = await upstream(() => config.facilitator.settle(payload, requirements));
    const paymentResponse = { [HEADERS.paymentResponse]: encodePaymentResponseHeader(settled) };
    log({ event: "topUp", session, success: settled.success, reason: settled.errorReason });
    if (!settled.success) {
      // A pending top-up needs nothing more here: if it lands, its later end is found as one this gate did not settle is.
      if (settled.errorReason === "settlement_pending") return sendJson(response, 202, { transaction: settled.transaction }, paymentResponse);
      return refusal(settled.errorReason ?? "simulation_failed");
    }
    const until = paidUntil({ ...stored, deposited: stored.deposited + BigInt(requirements.amount) });
    paidLonger(tracked, until);
    // The session may already run later than this top-up alone makes it: the end timer found one made elsewhere meanwhile.
    sendJson(response, 200, { paidUntil: Number(until > tracked.paidUntil ? until : tracked.paidUntil) }, paymentResponse);
  }

  /** Checks 1 to 3 of spec §7.2. Check 4 holds for every tracked session: it opened with this gate's terms. */
```

The dispatch: replace

```ts
        const match = SESSION_PATH.exec(url.pathname);
        if (request.method === "POST" && match?.[2] === "close") {
          const id = match[1]!;
          if (!isAddress(id)) sendJson(response, 404, { error: "unknown_session" });
          else await closeSession(request, response, id);
          return true;
        }
```

with

```ts
        const match = SESSION_PATH.exec(url.pathname);
        if (request.method === "POST" && (match?.[2] === "close" || match?.[2] === "top-up")) {
          const id = match[1]!;
          if (!isAddress(id)) sendJson(response, 404, { error: "unknown_session" });
          else if (match[2] === "close") await closeSession(request, response, id);
          else await topUp(request, response, url, id);
          return true;
        }
```

- [ ] **Step 5: Run the tests to see them pass**

Run: `pnpm --filter @lxfoundry/stint-gate test && pnpm --filter @lxfoundry/stint-gate typecheck`
Expected: PASS, the new file's 16 tests and every earlier one; no type error.

If `resumes forwarding, and keeps the new end timer, when its end timer fires while the top-up settles` fails with a
pending timer whose `delayMs` is 3,000, the guard in `expire` is missing or placed after the `arm`.

- [ ] **Step 6: Check that the guard is what the race test rests on**

Put `//` in front of the line `if (tracked.endRetry !== retry) return;` in `expire`.

Run: `pnpm --filter @lxfoundry/stint-gate test top-up.test.ts`
Expected: FAIL in `resumes forwarding, and keeps the new end timer, when its end timer fires while the top-up settles`
only: a retry timer due 3 s after the end replaced the new end timer.

Remove the `//`. Run the same command: PASS.

- [ ] **Step 7: State the route's answers in the spec**

In `docs/specs/stint-system.md`, section 7.1, replace the row

```markdown
| `POST /sessions/:id/top-up?seconds=N` | Top up | `402`; `200 {paidUntil}`; `202 {transaction}` while the settlement is pending; `400 invalid_duration` |
```

with

```markdown
| `POST /sessions/:id/top-up?seconds=N` | Top up | `402` (offers for this session; once the end timer has fired, or when the facilitator answers `session_expired`, the reason `session_expired` with offers for a new session); `200 {paidUntil}`; `202 {transaction}` while the settlement is pending; `400 invalid_duration`; `404` for a session this gate does not track |
```

- [ ] **Step 8: Commit**

```bash
git add packages/gate docs/specs/stint-system.md
git commit -m "Add the top-up route to the gate, and move the end timer when a top-up settles"
```

- [ ] **Step 9: Check the packages that use the gate**

Run: `pnpm typecheck && pnpm --filter @lxfoundry/stint-client test && pnpm --filter @lxfoundry/stint-example-stream test`
Expected: PASS. The gate's configuration gained no member, so `packages/client/test/gate.ts` still builds one from
literals.

---

### Task 5: The client and the tools: `session.topUp` and `stint_top_up`

A buyer has nothing to call: the client can open and close, and the tools have no top-up. This task adds
`session.topUp({ seconds })` (spec section 9.4) and the tool `stint_top_up` (spec section 9.5). The MCP server serves
every tool it is given, so it serves this one without a change to its code, and so does the example agent.

Decisions this task makes, from the code and the spec:
- **A top-up is checked against the session's opening entry.** Besides the checks an open passes (the allowlists, the
  facilitator's keys, the rate, the minimum charge), the top-up entry must name the session and offer the same terms,
  seller and receiver authorizer as the entry the session opened with. A seller cannot raise the rate of a running
  session through its top-up offer.
- **`maxPerSession` counts what the session holds.** The session keeps the total of its opening deposit and its
  top-ups through this client (`session.cost`), and a top-up must keep that total within `maxPerSession` (spec section
  9.2). The duration must fit what `maxSeconds` leaves after the seconds that total covers (spec section 9.3).
- **Reserved before any `await`.** As for an open, the amount is locked in the period budget and added to the session's
  total in the same synchronous step as the check, so that two concurrent top-ups cannot both pass. Both are undone
  when the gate refuses the payment before settlement (`400`, `402`, or `404`, which the route answers before it looks
  at a payment), and when nothing was sent.
- **Not confirmed is not refused.** A `202`, a `5xx` or a failure to reach the gate after the payment was sent leaves
  the amount locked and throws, as an open does: the payment may still land. Polling is not built.
- **`paidUntil` and `cost` become getters** on the session object, so that they follow its top-ups. Their types do not
  change.
- **The tool refuses a session the gate ended or the buyer closed** before it asks the gate, with the messages the other
  tools use.
- **A 402 that offers no top-up is a refusal with its reason.** Once its end timer has fired, the gate answers a top-up
  request with `402 session_expired` and offers for a new session only. The client throws a `StintError` with status
  402 and the gate's body, and says that the paid time has run out, so the tool and an agent see why.

**Files:**
- Modify: `packages/client/src/policy.ts`, `packages/client/src/client.ts`, `packages/client/src/tools.ts`,
  `packages/client/src/index.ts`, `examples/agent/src/prompt.ts`
- Modify (test support): `packages/client/test/gate.ts`
- Test: `packages/client/test/policy.test.ts`, `packages/client/test/client.test.ts`,
  `packages/client/test/tools.test.ts`, `packages/mcp/test/stdio.test.ts`, `examples/agent/test/agent.test.ts`

**Interfaces:**
- Consumes: Task 4's route; Task 2's `buildTopUpTransaction`, `checkTopUpDuration`.
- Produces:
  - `checkTopUp(policy: Policy, offer: ElapsedRequirements, requested: number, context: TopUpContext): PolicyCheck`, with
    `TopUpContext = { opened: ElapsedRequirements; session: Address; sessionTotal: bigint; locked: bigint; signer: Address }`.
  - `StintSession.topUp(options: { seconds: number }): Promise<TopUpReceipt>`, with
    `TopUpReceipt = { paidUntil: number; cost: bigint }`; `StintSession.paidUntil` and `StintSession.cost` follow the
    session's top-ups. A refusal throws a `StintError` whose `status` is the gate's (`400`, `402`, `404`) and whose
    `body` is the gate's answer; a policy refusal throws a `StintError` without a status, whose message begins
    `Policy refuses the top-up:`.
  - `SessionTools.tools.stint_top_up: Tool<TopUpInput, TopUpOutput>`, with `TopUpInput = { sessionId: string; seconds:
    number }` and `TopUpOutput = { paidUntil: number; cost: string }`.
  - The test gate: `TestGate.verifyAnswer: VerifyResponse` (default `{ isValid: true }`), which a test changes to make the
    facilitator refuse.

- [ ] **Step 1: Write the failing tests of the policy**

In `packages/client/test/policy.test.ts`, replace

```ts
import { checkOffer, type Policy } from "../src/index.js";
```

with

```ts
import { checkOffer, checkTopUp, type Policy, type TopUpContext } from "../src/index.js";
```

and add at the end of the file:

```ts

describe("checkTopUp (spec §9.2, §9.3)", () => {
  const session = address("SysvarS1otHashes111111111111111111111111111");
  const topUp: ElapsedRequirements = { ...offer, amount: "10000", extra: { ...offer.extra, action: "topUp", session, seconds: 10 } };
  const context: TopUpContext = { opened: offer, session, sessionTotal: 30_000n, locked: 30_000n, signer };
  const withTopUpExtra = (extra: object): ElapsedRequirements => ({ ...topUp, extra: { ...topUp.extra, ...extra } });

  it("accepts a top-up within every limit, with the asset's decimals", () => {
    expect(checkTopUp(policy, topUp, 10, context)).toEqual({ ok: true, decimals: 6, amount: 10_000n });
  });

  it("accepts a duration below minSeconds, which a top-up does not have to meet", () => {
    const short = { ...withTopUpExtra({ seconds: 1 }), amount: "1000" };
    expect(checkTopUp(policy, short, 1, context)).toEqual({ ok: true, decimals: 6, amount: 1_000n });
  });

  it.each<[string, ElapsedRequirements, number, Partial<TopUpContext>?]>([
    ["an open offer", offer, 30],
    ["another session", withTopUpExtra({ session: signer }), 10],
    ["another rate than the session's", { ...withTopUpExtra({ rate: "999" }), amount: "9990" }, 10],
    ["another seller than the session's", { ...topUp, payTo: signer }, 10],
    ["another receiver authorizer than the session's", withTopUpExtra({ receiverAuthorizer: signer }), 10],
    ["another maxSeconds than the session's", withTopUpExtra({ maxSeconds: 200 }), 10],
    ["another duration than requested", topUp, 11],
    ["more than maxSeconds leaves after what the session covers", { ...withTopUpExtra({ seconds: 91 }), amount: "91000" }, 91],
    ["an amount that is not rate × seconds", { ...topUp, amount: "10001" }, 10],
    ["more than maxPerSession with what the session holds", topUp, 10, { sessionTotal: 90_001n }],
    ["more than the period budget", topUp, 10, { locked: 190_001n }],
  ])("refuses %s", (_, candidate, requested, overrides) => {
    expect(checkTopUp(policy, candidate, requested, { ...context, ...overrides }).ok).toBe(false);
  });

  it("refuses an offer that names the client's own signer as the fee payer, as an open's check does", () => {
    expect(checkTopUp(policy, withTopUpExtra({ feePayer: signer }), 10, context)).toEqual({
      ok: false,
      reason: "the offer names this client's own signer as the fee payer",
    });
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @lxfoundry/stint-client test policy.test.ts`
Expected: FAIL: `checkTopUp` is not exported.

- [ ] **Step 3: Implement the policy**

Replace the contents of `packages/client/src/policy.ts` with:

```ts
import type { Address } from "@solana/kit";
import { STINT_PROGRAM_ADDRESS } from "@lxfoundry/stint-program-client";
import { SOLANA_DEVNET, USDC_DEVNET, checkTopUpDuration, type ElapsedRequirements } from "@lxfoundry/stint-x402";

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
  /** The most one session may lock: its opening deposit and every top-up together. */
  readonly maxPerSession: bigint;
  readonly budget: { readonly amount: bigint; readonly periodSeconds: number };
  /** Default 300. */
  readonly maxMinSeconds?: number;
}

type Refusal = { readonly ok: false; readonly reason: string };

export type PolicyCheck = { readonly ok: true; readonly decimals: number; readonly amount: bigint } | Refusal;

const no = (reason: string): Refusal => ({ ok: false, reason });

/**
 * The checks every payment shares (spec §9.3). `signer` is the buyer's key, which must not be the facilitator's fee
 * payer or rent payer: its signature would then authorize what the facilitator's keys are confined from (spec §5.3).
 * Then the allowlists, the rate and the minimum charge. Returns the asset's decimals.
 */
function checkSellerAndTerms(policy: Policy, offer: ElapsedRequirements, signer: Address): { readonly ok: true; readonly decimals: number } | Refusal {
  const extra = offer.extra;
  if (extra.feePayer === signer) return no("the offer names this client's own signer as the fee payer");
  if (extra.rentPayer === signer) return no("the offer names this client's own signer as the rent payer");
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
  return { ok: true, decimals: asset.decimals };
}

/** The amount: exactly `rate × seconds`, within `maxPerSession` with what the session already holds, and within the period budget. */
function checkAmount(policy: Policy, offer: ElapsedRequirements, sessionTotal: bigint, locked: bigint, decimals: number): PolicyCheck {
  const amount = BigInt(offer.amount);
  if (amount !== BigInt(offer.extra.rate) * BigInt(offer.extra.seconds)) return no("the amount is not rate × seconds");
  if (sessionTotal + amount > policy.maxPerSession) return no(`${sessionTotal + amount} exceeds maxPerSession ${policy.maxPerSession}`);
  if (locked + amount > policy.budget.amount) return no(`${amount} would exceed the period budget`);
  return { ok: true, decimals, amount };
}

/** The checks before signing an open (spec §9.3). `locked` is what this period already locked. */
export function checkOffer(policy: Policy, offer: ElapsedRequirements, requested: number, locked: bigint, signer: Address): PolicyCheck {
  const extra = offer.extra;
  if (extra.action !== "open") return no("not an open offer");
  const allowed = checkSellerAndTerms(policy, offer, signer);
  if (!allowed.ok) return allowed;
  if (extra.seconds !== requested) return no(`the offer is for ${extra.seconds} s, not the ${requested} s requested`);
  if (!Number.isInteger(extra.seconds) || extra.seconds < extra.minSeconds || extra.seconds > extra.maxSeconds) {
    return no(`${extra.seconds} s is outside ${extra.minSeconds}..${extra.maxSeconds}`);
  }
  return checkAmount(policy, offer, 0n, locked, allowed.decimals);
}

/** What a top-up is checked against: the session it extends, as this client opened it. */
export interface TopUpContext {
  /** The entry the session opened with: a top-up must offer the same terms, for the same seller. */
  readonly opened: ElapsedRequirements;
  readonly session: Address;
  /** What the session holds through this client: its opening deposit and earlier top-ups. */
  readonly sessionTotal: bigint;
  /** What this period already locked, across sessions. */
  readonly locked: bigint;
  readonly signer: Address;
}

/**
 * The checks before signing a top-up (spec §9.3): an open's, then the session and the same terms and seller as the entry
 * it opened with, a duration that fits what `maxSeconds` leaves after the seconds the session's deposit covers, and an
 * amount within `maxPerSession` together with what the session already holds.
 */
export function checkTopUp(policy: Policy, offer: ElapsedRequirements, requested: number, context: TopUpContext): PolicyCheck {
  const extra = offer.extra;
  if (extra.action !== "topUp") return no("not a top-up offer");
  if (extra.session !== context.session) return no(`the offer is for session ${extra.session}, not ${context.session}`);
  const allowed = checkSellerAndTerms(policy, offer, context.signer);
  if (!allowed.ok) return allowed;
  const was = context.opened;
  if (
    offer.network !== was.network ||
    offer.asset !== was.asset ||
    offer.payTo !== was.payTo ||
    extra.programId !== was.extra.programId ||
    extra.receiverAuthorizer !== was.extra.receiverAuthorizer ||
    extra.rate !== was.extra.rate ||
    extra.minSeconds !== was.extra.minSeconds ||
    extra.maxSeconds !== was.extra.maxSeconds
  ) {
    return no("the offer's terms differ from the session's");
  }
  if (extra.seconds !== requested) return no(`the offer is for ${extra.seconds} s, not the ${requested} s requested`);
  const rate = BigInt(extra.rate);
  const duration = checkTopUpDuration({ rate, minSeconds: extra.minSeconds, maxSeconds: extra.maxSeconds }, context.sessionTotal / rate, extra.seconds);
  if (!duration.ok) return no(`${extra.seconds} s is outside 1..${duration.maxSeconds}, what maxSeconds leaves`);
  return checkAmount(policy, offer, context.sessionTotal, context.locked, allowed.decimals);
}
```

In `packages/client/src/index.ts`, replace

```ts
export { checkOffer, type Asset, type Policy, type PolicyCheck } from "./policy.js";
```

with

```ts
export { checkOffer, checkTopUp, type Asset, type Policy, type PolicyCheck, type TopUpContext } from "./policy.js";
```

Run: `pnpm --filter @lxfoundry/stint-client test policy.test.ts && pnpm --filter @lxfoundry/stint-client typecheck`
Expected: PASS: the new tests of `checkTopUp` and the earlier tests of `checkOffer`, whose messages are unchanged; no
type error.

- [ ] **Step 4: Let a test make the test gate's facilitator refuse**

In `packages/client/test/gate.ts`, replace

```ts
import { USDC_DEVNET, type PaymentPayload } from "@lxfoundry/stint-x402";
```

with

```ts
import { USDC_DEVNET, type PaymentPayload, type VerifyResponse } from "@lxfoundry/stint-x402";
```

replace

```ts
  /** While set, the chain cannot return the `Closed` event of a confirmed close. */
  hideClosedEvent: boolean;
```

with

```ts
  /** While set, the chain cannot return the `Closed` event of a confirmed close. */
  hideClosedEvent: boolean;
  /** What the facilitator answers `/verify` with. Default `{ isValid: true }`. */
  verifyAnswer: VerifyResponse;
```

replace

```ts
      verify: async () => ({ isValid: true }),
```

with

```ts
      verify: async () => testGate.verifyAnswer,
```

and replace

```ts
    hideClosedEvent: false,
```

with

```ts
    hideClosedEvent: false,
    verifyAnswer: { isValid: true },
```

The test gate's chain answers every read with a deposit of 30,000, so each top-up is offered on a session paid for
30 s of 120, and the gate works out the new end from that deposit: a second top-up through it reports the end of the
first session plus its own seconds only. The tests below make one top-up through it.

- [ ] **Step 5: Write the failing tests of `session.topUp`**

In `packages/client/test/client.test.ts`, replace

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
```

with

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
```

and replace the last two lines of the file,

```ts
  });
});
```

with

```ts
  });

  it("tops up: pays the top-up offer it asked for, built by itself and signed only as the authority, and moves paidUntil", async () => {
    const client = createStintClient({ signer: buyer, policy });
    const session = await client.open(gate.url, { seconds: 30 });
    const before = session.paidUntil;

    expect(await session.topUp({ seconds: 5 })).toEqual({ paidUntil: before + 5, cost: 5_000n });

    expect(session.paidUntil).toBe(before + 5);
    expect(session.cost).toBe(35_000n);
    expect(client.remainingBudget()).toBe(5_000n);
    const payment = gate.payments.at(-1)!;
    expect(payment.accepted.extra).toMatchObject({ action: "topUp", session: session.id, seconds: 5 });
    expect(readElapsedPayload(payment)).toMatchObject({ type: "topUp" });
    expect([...inspectTransaction(readElapsedPayload(payment)!.transaction)!.signed]).toEqual([buyer.address]);
  });

  it("refuses a top-up its policy does not allow, before signing anything, and locks nothing", async () => {
    const client = createStintClient({ signer: buyer, policy });
    const session = await client.open(gate.url, { seconds: 30 });
    await expect(session.topUp({ seconds: 11 })).rejects.toThrow(/budget/); // 11,000 of the 10,000 left
    const capped = createStintClient({ signer: buyer, policy: { ...policy, maxPerSession: 34_000n } });
    const other = await capped.open(gate.url, { seconds: 30 });
    await expect(other.topUp({ seconds: 5 })).rejects.toThrow(/maxPerSession/); // 35,000 in all

    expect(gate.payments).toHaveLength(2); // the two opens
    expect(client.remainingBudget()).toBe(10_000n);
    expect(session.cost).toBe(30_000n);
  });

  it("unlocks what it locked when the gate refuses the top-up, and reports the gate's status and reason", async () => {
    const client = createStintClient({ signer: buyer, policy });
    const session = await client.open(gate.url, { seconds: 30 });
    const before = session.paidUntil;
    gate.verifyAnswer = { isValid: false, invalidReason: "session_expired" };

    await expect(session.topUp({ seconds: 5 })).rejects.toMatchObject({ status: 402, body: { error: "session_expired" } });

    expect(client.remainingBudget()).toBe(10_000n);
    expect(session.cost).toBe(30_000n);
    expect(session.paidUntil).toBe(before);
  });

  it("reports a duration the gate does not offer without locking anything", async () => {
    const client = createStintClient({ signer: buyer, policy });
    const session = await client.open(gate.url, { seconds: 30 });

    await expect(session.topUp({ seconds: 91 })).rejects.toMatchObject({ status: 400, body: { error: "invalid_duration", maxSeconds: 90 } });
    expect(client.remainingBudget()).toBe(10_000n);
  });

  it("reserves before it awaits, so concurrent top-ups cannot take a session past maxPerSession", async () => {
    const client = createStintClient({ signer: buyer, policy: { ...policy, maxPerSession: 40_000n, budget: { amount: 100_000n, periodSeconds: 3_600 } } });
    const session = await client.open(gate.url, { seconds: 30 });

    const results = await Promise.allSettled([session.topUp({ seconds: 6 }), session.topUp({ seconds: 6 })]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const refused = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(String(refused[0]?.reason)).toMatch(/maxPerSession/);
    expect(gate.payments).toHaveLength(2);
    expect(session.cost).toBe(36_000n);
  });

  it("refuses to top up a session it has closed, without asking the gate", async () => {
    const client = createStintClient({ signer: buyer, policy });
    const session = await client.open(gate.url, { seconds: 30 });
    await session.close();

    await expect(session.topUp({ seconds: 5 })).rejects.toThrow(/closed/);
    expect(gate.payments).toHaveLength(2); // the open and the close
  });

  it("reports a gate's 402 that offers no top-up with its status and reason, and signs nothing", async () => {
    const client = createStintClient({ signer: buyer, policy });
    const session = await client.open(gate.url, { seconds: 30 });
    const realFetch = globalThis.fetch;
    // What the gate answers once its end timer has fired: a 402 offering a new session only.
    vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) =>
      String(input).includes("/top-up")
        ? Promise.resolve(Response.json({ x402Version: 2, error: "session_expired", resource: { url: `${gate.url}/sessions` }, accepts: [] }, { status: 402 }))
        : realFetch(input, init),
    );
    try {
      await expect(session.topUp({ seconds: 5 })).rejects.toMatchObject({
        message: "The session's paid time has run out: it cannot be extended",
        status: 402,
        body: { error: "session_expired" },
      });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(gate.payments).toHaveLength(1);
    expect(client.remainingBudget()).toBe(10_000n);
  });
});
```

- [ ] **Step 6: Run them to see them fail**

Run: `pnpm --filter @lxfoundry/stint-client test client.test.ts`
Expected: FAIL: `session.topUp is not a function` in the seven new tests; the earlier tests pass.

- [ ] **Step 7: Implement `session.topUp`**

Replace the contents of `packages/client/src/client.ts` with:

```ts
import { address, type Address, type KeyPairSigner } from "@solana/kit";
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
import { WebSocket } from "ws";
import { checkOffer, checkTopUp, type Policy } from "./policy.js";

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

/** `paid` and `refunded` are absent when the gate could not read the `Closed` event of a confirmed close. */
export interface CloseReceipt {
  readonly paid?: bigint;
  readonly refunded?: bigint;
  readonly transaction: string;
}

/** What a top-up bought. */
export interface TopUpReceipt {
  /** The session's new end, in Unix seconds. */
  readonly paidUntil: number;
  /** What the top-up cost, in base units. */
  readonly cost: bigint;
}

export interface StintSession {
  readonly id: Address;
  readonly gateUrl: string;
  /** Unix seconds: the end of the paid time, moved by each top-up made through this session. */
  readonly paidUntil: number;
  readonly wsUrl: string;
  /** Everything the session holds through this client, in base units: the opening deposit and each top-up. */
  readonly cost: bigint;
  connect(): Promise<WebSocket>;
  /**
   * Buys `seconds` more paid time (spec §9.4). The gate's offer is checked against the policy and against the terms the
   * session opened with before anything is signed. A session whose paid time has run out cannot be extended.
   */
  topUp(options: { readonly seconds: number }): Promise<TopUpReceipt>;
  /** The status the gate reports from the chain (spec §7.1): estimates use the gate's clock. */
  status(): Promise<SessionStatus>;
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

  /**
   * Locks `amount` in the period budget, and returns what unlocks it. It is called in the same synchronous step as the
   * policy check, so that concurrent payments cannot both pass against the same locked amount. Once signed, a payment may
   * land whatever the answer, so the amount stays locked unless the gate refused the payment before settlement.
   */
  function reserve(amount: bigint): () => void {
    const entry = { at: now(), amount };
    ledger.push(entry);
    return () => {
      const index = ledger.indexOf(entry);
      if (index >= 0) ledger.splice(index, 1);
    };
  }

  /** The offers the gate answers a first request with: a 402 (spec §5.1). */
  async function offersFrom(endpoint: string): Promise<PaymentRequired> {
    const first = await fetch(endpoint, { method: "POST" });
    if (first.status !== 402) {
      const body = await readBody(first);
      throw new StintError(`Expected 402 from ${endpoint}, got ${first.status}: ${describeBody(body)}`, first.status, body);
    }
    const header = first.headers.get(HEADERS.paymentRequired);
    const required = (header ? decodePaymentRequiredHeader(header) : await first.json()) as PaymentRequired;
    if (required.x402Version !== X402_VERSION) throw new StintError(`x402Version ${required.x402Version} is not supported`);
    return required;
  }

  /** Sends a payment, its `PAYMENT-SIGNATURE` header already encoded, and returns the gate's answer. */
  async function send(endpoint: string, signature: string): Promise<{ status: number; body: unknown }> {
    const response = await fetch(endpoint, { method: "POST", headers: { [HEADERS.paymentSignature]: signature } });
    return { status: response.status, body: await readBody(response) };
  }

  function sessionFrom(
    gateUrl: string,
    opened: { session: string; paidUntil: number; wsUrl: string },
    offer: ElapsedRequirements,
    deposit: bigint,
  ): StintSession {
    const audience = new URL(gateUrl).origin;
    const token = (purpose: TokenPurpose) => createSessionToken(options.signer, { session: opened.session, audience, purpose });
    let closed = false;
    let paidUntil = opened.paidUntil;
    let cost = deposit;
    const session: StintSession = {
      id: address(opened.session),
      gateUrl,
      get paidUntil() {
        return paidUntil;
      },
      wsUrl: opened.wsUrl,
      get cost() {
        return cost;
      },
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
      async topUp({ seconds }) {
        if (closed) throw new StintError("The session is closed");
        const endpoint = `${gateUrl}/sessions/${opened.session}/top-up?seconds=${seconds}`;
        const required = await offersFrom(endpoint);
        // The entry is echoed exactly as received: the object decoded from the gate's response.
        const entry = required.accepts
          .map(readElapsedRequirements)
          .find((candidate) => candidate?.extra.action === "topUp" && candidate.extra.seconds === seconds);
        // Once its end timer has fired, the gate answers with offers for a new session only, and says why.
        if (!entry) {
          const expired = required.error === "session_expired";
          throw new StintError(expired ? "The session's paid time has run out: it cannot be extended" : `No top-up offer for ${seconds} s`, 402, required);
        }
        const check = checkTopUp(options.policy, entry, seconds, {
          opened: offer,
          session: session.id,
          sessionTotal: cost,
          locked: locked(),
          signer: options.signer.address,
        });
        if (!check.ok) throw new StintError(`Policy refuses the top-up: ${check.reason}`);
        // Reserved in the same synchronous step as the check, against the period budget and maxPerSession alike.
        const release = reserve(check.amount);
        cost += check.amount;
        const undo = () => {
          release();
          cost -= check.amount;
        };
        let signature: string;
        try {
          const transaction = await buildTopUpTransaction({ requirements: entry, authority: options.signer, decimals: check.decimals });
          const payload: PaymentPayload = {
            x402Version: X402_VERSION,
            resource: required.resource,
            accepted: entry,
            payload: { type: "topUp", transaction },
          };
          signature = encodePaymentSignatureHeader(payload);
        } catch (error) {
          undo(); // nothing was sent
          throw error;
        }
        const answer = await send(endpoint, signature);
        // Refused before settlement, so nothing was charged: the route answers 404 before it looks at a payment.
        if (answer.status === 400 || answer.status === 402 || answer.status === 404) {
          undo();
          throw new StintError(`The gate refused the top-up: ${describeBody(answer.body)}`, answer.status, answer.body);
        }
        if (answer.status !== 200) {
          throw new StintError(`The top-up is not confirmed (HTTP ${answer.status}); the payment may still land`, answer.status, answer.body);
        }
        const toppedUp = answer.body as { paidUntil: number };
        paidUntil = Math.max(paidUntil, toppedUp.paidUntil);
        return { paidUntil: toppedUp.paidUntil, cost: check.amount };
      },
      async status() {
        const response = await fetch(`${gateUrl}/sessions/${opened.session}`);
        const body = await readBody(response);
        if (response.status === 404) throw new StintError("The session is closed, or was never opened", 404, body);
        if (response.status !== 200) throw new StintError(`Status failed (HTTP ${response.status}): ${describeBody(body)}`, response.status, body);
        return body as SessionStatus;
      },
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
      const required = await offersFrom(endpoint);

      // The entry is echoed exactly as received: the object decoded from the gate's response.
      const offer = required.accepts
        .map(readElapsedRequirements)
        .find((entry) => entry?.extra.action === "open" && (seconds === undefined || entry.extra.seconds === seconds));
      if (!offer) throw new StintError(`No elapsed offer${seconds === undefined ? "" : ` for ${seconds} s`}`);
      const check = checkOffer(options.policy, offer, seconds ?? offer.extra.seconds, locked(), options.signer.address);
      if (!check.ok) throw new StintError(`Policy refuses the offer: ${check.reason}`);

      // Reserved in the same synchronous step as the check, so that concurrent opens cannot both pass against the same
      // locked amount.
      const release = reserve(check.amount);
      let built: Awaited<ReturnType<typeof buildOpenTransaction>>;
      let signature: string;
      try {
        built = await buildOpenTransaction({ requirements: offer, authority: options.signer, decimals: check.decimals });
        const payload: PaymentPayload = {
          x402Version: X402_VERSION,
          resource: required.resource,
          accepted: offer,
          payload: { type: "open", transaction: built.transaction, session: built.session },
        };
        signature = encodePaymentSignatureHeader(payload);
      } catch (error) {
        release(); // nothing was sent
        throw error;
      }
      const answer = await send(endpoint, signature);
      if (answer.status === 402 || answer.status === 400) {
        release(); // refused before settlement: nothing was charged
        throw new StintError(`The gate refused the payment: ${describeBody(answer.body)}`, answer.status, answer.body);
      }
      if (answer.status !== 201) {
        throw new StintError(`The open is not confirmed (HTTP ${answer.status}); the payment may still land`, answer.status, answer.body);
      }
      const opened = answer.body as { session: string; paidUntil: number; wsUrl: string };
      if (opened.session !== built.session) throw new StintError("The gate reported another session", 201, answer.body);
      return sessionFrom(gateUrl, opened, offer, check.amount);
    },
  };
}
```

An open still treats a `404` as "not confirmed": its route answers `404` after the settlement when the account is
gone, so the payment may have landed.

In `packages/client/src/index.ts`, replace

```ts
export { StintError, createStintClient, type ClientOptions, type CloseReceipt, type StintClient, type StintSession } from "./client.js";
```

with

```ts
export {
  StintError,
  createStintClient,
  type ClientOptions,
  type CloseReceipt,
  type StintClient,
  type StintSession,
  type TopUpReceipt,
} from "./client.js";
```

- [ ] **Step 8: Run the client's tests to see them pass**

Run: `pnpm --filter @lxfoundry/stint-client test policy.test.ts client.test.ts`
Expected: PASS, the seven new tests of `session.topUp`, the new tests of `checkTopUp`, and every earlier test of the
policy and the client.

- [ ] **Step 9: Write the failing tests of `stint_top_up`**

In `packages/client/test/tools.test.ts`, the two hand-written sessions need the new member. Replace

```ts
        connect: () => Promise.reject(new Error("not used")),
        status: () => Promise.reject(new Error("not used")),
```

with

```ts
        connect: () => Promise.reject(new Error("not used")),
        topUp: () => Promise.reject(new Error("not used")),
        status: () => Promise.reject(new Error("not used")),
```

and replace

```ts
          connect: async () => socket as unknown as WebSocket,
          status: () => Promise.reject(new Error("not used")),
```

with

```ts
          connect: async () => socket as unknown as WebSocket,
          topUp: () => Promise.reject(new Error("not used")),
          status: () => Promise.reject(new Error("not used")),
```

Then replace

```ts
  it("answers an unknown session with a readable error", async () => {
```

with

```ts
  it("tops up an open session, and reports its new end and what the top-up cost", async () => {
    const session = await connected();
    const { paidUntil } = await session.tools.stint_session_status.run({ sessionId: session.sessionId });

    expect(await session.tools.stint_top_up.run({ sessionId: session.sessionId, seconds: 10 })).toEqual({
      paidUntil: paidUntil + 10,
      cost: "10000",
    });
    expect(session.settlements()).toBe(2); // the open and the top-up
  });

  it("refuses to top up a session the buyer has closed, without asking the gate", async () => {
    const session = await connected();
    await session.tools.stint_close_session.run({ sessionId: session.sessionId });

    await expect(session.tools.stint_top_up.run({ sessionId: session.sessionId, seconds: 10 })).rejects.toThrow(/closed/);
    expect(session.settlements()).toBe(2); // the open and the close
  });

  it.each(ENDED)("refuses to top up a session the gate ended with %s, without asking the gate", async (code, message) => {
    const session = await connected();
    await session.dropWith(code);

    await expect(session.tools.stint_top_up.run({ sessionId: session.sessionId, seconds: 10 })).rejects.toThrow(message);
    expect(session.settlements()).toBe(1);
  });

  it("answers an unknown session with a readable error", async () => {
```

`stint_session_status` reports the `paidUntil` the test gate reads from its chain, which is the session's: the open
reported the same.

- [ ] **Step 10: Run them to see them fail**

Run: `pnpm --filter @lxfoundry/stint-client test tools.test.ts`
Expected: FAIL: `stint_top_up` does not exist on the tools.

- [ ] **Step 11: Add the tool**

In `packages/client/src/tools.ts`, replace

```ts
export interface CloseAllOutput {
```

with

```ts
export interface TopUpInput {
  readonly sessionId: string;
  readonly seconds: number;
}
/** `paidUntil` is the session's new end, in Unix seconds; `cost` is what this top-up cost, in base units. */
export interface TopUpOutput {
  readonly paidUntil: number;
  readonly cost: string;
}

export interface CloseAllOutput {
```

replace

```ts
    readonly stint_session_status: Tool<StatusInput, StatusOutput>;
```

with

```ts
    readonly stint_session_status: Tool<StatusInput, StatusOutput>;
    readonly stint_top_up: Tool<TopUpInput, TopUpOutput>;
```

and replace

```ts
      stint_send: {
        name: "stint_send",
```

with

```ts
      stint_top_up: {
        name: "stint_top_up",
        description:
          "Buys more time on an open session before its paid time runs out. The extra deposit is held in escrow like the first, and what is not used is still refunded at close. A session whose paid time has run out cannot be extended: open a new one.",
        inputSchema: strict(
          { sessionId: sessionIdSchema, seconds: { type: "integer", minimum: 1, description: "How many seconds to add" } },
          ["sessionId", "seconds"],
        ),
        async run(input) {
          const state = get(input.sessionId);
          const ended = endedByGate(state);
          if (ended) throw new ToolError(ended);
          if (state.closed || state.closing) throw new ToolError("The session is closed");
          const receipt = await state.session.topUp({ seconds: input.seconds });
          return { paidUntil: receipt.paidUntil, cost: receipt.cost.toString() };
        },
      },
      stint_send: {
        name: "stint_send",
```

In `packages/client/src/index.ts`, replace

```ts
  type StatusOutput,
  type Tool,
```

with

```ts
  type StatusOutput,
  type Tool,
  type TopUpInput,
  type TopUpOutput,
```

- [ ] **Step 12: Name the tool where the tool lists are pinned**

In `packages/mcp/test/stdio.test.ts`, replace

```ts
      "stint_send",
      "stint_session_status",
    ]);
```

with

```ts
      "stint_send",
      "stint_session_status",
      "stint_top_up",
    ]);
```

In `examples/agent/test/agent.test.ts`, replace

```ts
      stint_send: tool("stint_send", { ok: true }),
```

with

```ts
      stint_top_up: tool("stint_top_up", { paidUntil: 2, cost: "10000" }),
      stint_send: tool("stint_send", { ok: true }),
```

and replace

```ts
      "stint_send",
      "stint_session_status",
    ]);
    expect(JSON.stringify(first.body.system)).toMatch(/Open a session first/);
```

with

```ts
      "stint_send",
      "stint_session_status",
      "stint_top_up",
    ]);
    expect(JSON.stringify(first.body.system)).toMatch(/Open a session first/);
    expect(JSON.stringify(first.body.system)).toMatch(/stint_top_up/);
```

In `examples/agent/src/prompt.ts`, replace

```ts
- Use stint_send and stint_receive to talk to the stream, and stint_session_status to see how much time is left.
```

with

```ts
- Use stint_send and stint_receive to talk to the stream, and stint_session_status to see how much time is left.
- If the task needs more time than you bought, buy more with stint_top_up before the paid time runs out: a session
  whose time has run out cannot be extended.
```

- [ ] **Step 13: Run every test of the packages this task touched**

Run: `pnpm typecheck && pnpm --filter @lxfoundry/stint-client test && pnpm --filter @lxfoundry/stint-mcp test && pnpm --filter @lxfoundry/stint-example-agent test`
Expected: PASS; no type error. The test that checks every tool for a strict schema covers `stint_top_up`.

- [ ] **Step 14: Commit**

```bash
git add packages/client packages/mcp/test/stdio.test.ts examples/agent
git commit -m "Add session.topUp to the client and the stint_top_up tool"
```

---

### Task 6: Scenarios 4 and 34, with an on-chain top-up and a gate clock ahead in the harness

Rule 8 of `CLAUDE.md`: a behaviour that crosses components is done when its end-to-end scenarios pass on `local`. This
task writes scenario 4 (a top-up before expiry extends the session; after expiry one is refused) and scenario 34 (a
top-up lands on-chain while the gate is closing at expiry), and makes both `required`. Scenario 34 needs two things the
harness cannot do yet: start the gate with its session clock ahead of the wall clock, and top up on-chain without the
gate or the facilitator.

What each scenario proves, on `local` and on `devnet`:
- **Scenario 4.** A session of 20 s (30 s on devnet, where every step takes longer). A top-up of 10 s (20 s on devnet),
  made right after the open, answers the new `paidUntil` (the old one plus its seconds), and the chain shows the
  deposit grown by its cost. It comes before the connection that watches the session, so the target's subscription
  wait (5 s on devnet) does not bring it near the facilitator's 10 s margin; a plain connection holds the session
  meanwhile, since the test gate closes a session that has had no connection for 10 s. Then the watching connection
  replaces it, a payer changes a watched account every 500 ms, and frames keep arriving after the first `paidUntil`. Five seconds before the new end, a top-up is refused with `402
  session_expired` (the margin) and the buyer's USDC does not move. The connection is dropped with `4402` within 30 s
  of the new end; the `AtExpiry` close's `paid_until` is the new one, and it pays the receiver the opening deposit and
  the top-up. After the close, a top-up is refused with `404 unknown_session`, the buyer's USDC does not move, and the
  client's budget holds the two payments only.
- **Scenario 34.** The gate restarted with its session clock 5 s ahead. A session of 15 s plus the target's
  subscription wait (17 s locally, 30 s on devnet), connected and watched as above, so that frames flow for some
  seconds before the gate's end timer fires. The end timer fires 5 s before `paidUntil`: from a second after that, no
  frame arrives.
  2.5 s before `paidUntil` the authority tops up 12 s on-chain. The chain shows the deposit grown and `paidUntil` moved
  by 12 s; frames arrive again after the first `paidUntil` (the gate resumed); the gate stops forwarding again when its
  end timer fires before the new end, closes with `AtExpiry` once the chain reaches it, and drops the connection with
  `4402`. The close pays the receiver the opening deposit and the top-up: the top-up counts. The gate is restarted as
  an ordinary one at the end, whatever happened.

The two scenarios share the connection and the payments with scenario 3. A helper, `watchWhilePaying`, does it for
them. Scenario 3 keeps its own copy: moving a required scenario onto the helper is not this stage's change.

**Files:**
- Modify: `conformance/src/types.ts`, `conformance/src/index.ts`, `conformance/src/catalogue.ts`
- Create: `conformance/src/watch.ts`, `conformance/src/scenarios/04-top-up.ts`,
  `conformance/src/scenarios/34-top-up-while-closing.ts`
- Modify: `e2e/src/targets/services.ts`, `e2e/src/targets/direct.ts`, `e2e/src/targets/local.ts`,
  `e2e/src/targets/devnet.ts`
- Modify: `README.md` (`## Status`), `docs/specs/stint-system.md` (section 12.2)
- Test: `conformance/test/types.test.ts`, `conformance/test/catalogue.test.ts`, `e2e/test/services.test.ts`,
  `e2e/test/direct-chain.test.ts`, `e2e/test/local-target.test.ts`, `e2e/test/devnet-target.test.ts`

**Interfaces:**
- Consumes: Tasks 1 to 5: the program's `top_up` and `getTopUpInstruction`, `STINT_ERROR__SESSION_EXPIRED`,
  `paidUntil`; the gate's route; the client's `session.topUp`, `StintError`; the conformance helpers `buyerClient`,
  `sessionSeconds`, `closePollMs`, `readUntil`, `awaitClose`, `expectEqual`, `expectTrue`, `sleep`, `waitFor`,
  `receivedAmount`; `tokenBalanceChanges` and `associatedTokenAddress` from the scheme.
- Produces:
  - `interface GateStartOptions { sessionClockAheadMs?: number }`; `StackControl.startGate(options?: GateStartOptions):
    Promise<void>`; `Services.startGate(options?: GateStartOptions)`.
  - `DirectChain.topUp(options: { buyer: Buyer; session: Address; seconds: number }): Promise<string>`.
  - `rejectedWithProgramError` exported from `@lxfoundry/stint-conformance`.
  - `watchWhilePaying(context, session, payer, watched): Promise<Watch>` in `conformance/src/watch.ts`.
  - Scenarios 4 and 34 `required`; the local report reads `Status: required 9, pending 26 · Result: pass 9, fail 0,
    pending 25, not applicable 1`.

- [ ] **Step 1: Write the failing type test**

In `conformance/test/types.test.ts`, replace

```ts
import type { Address, KeyPairSigner } from "@solana/kit";
import { describe, expectTypeOf, it } from "vitest";
import type { DirectChain, DirectSession, ScenarioContext, StackControl } from "../src/index.js";
```

with

```ts
import type { Address, KeyPairSigner } from "@solana/kit";
import { describe, expectTypeOf, it } from "vitest";
import type { Buyer, DirectChain, DirectSession, GateStartOptions, ScenarioContext, StackControl } from "../src/index.js";
```

and replace the last two lines of the file,

```ts
  });
});
```

with

```ts
  });

  it("describe a gate started with its session clock ahead, and a top-up made straight on the program", () => {
    expectTypeOf<Parameters<StackControl["startGate"]>>().toEqualTypeOf<[options?: GateStartOptions]>();
    expectTypeOf<GateStartOptions["sessionClockAheadMs"]>().toEqualTypeOf<number | undefined>();
    expectTypeOf<Parameters<DirectChain["topUp"]>[0]>().toEqualTypeOf<{ readonly buyer: Buyer; readonly session: Address; readonly seconds: number }>();
    expectTypeOf<ReturnType<DirectChain["topUp"]>>().toEqualTypeOf<Promise<string>>();
  });
});
```

- [ ] **Step 2: Run the typecheck to see it fail**

Run: `pnpm --filter @lxfoundry/stint-conformance typecheck`
Expected: FAIL: `GateStartOptions` is not exported, and `DirectChain` has no `topUp`.

- [ ] **Step 3: Add the members to the context's types**

In `conformance/src/types.ts`, replace

```ts
/** What a scenario may do to the services that the target runs (spec §12.2). */
export interface StackControl {
```

with

```ts
/** How `StackControl.startGate` starts the gate. */
export interface GateStartOptions {
  /**
   * Milliseconds by which the gate's session clock runs ahead of the wall clock (spec §7.3): its idle and end timers fire
   * that much early, while the chain's clock still decides every amount (scenario 34). Default 0.
   */
  readonly sessionClockAheadMs?: number;
}

/** What a scenario may do to the services that the target runs (spec §12.2). */
export interface StackControl {
```

replace

```ts
  /** Starts the gate again on the port it had, so that `gateUrl` stays valid. The new gate has no memory of earlier sessions. */
  startGate(): Promise<void>;
```

with

```ts
  /**
   * Starts the gate again on the port it had, so that `gateUrl` stays valid. The new gate has no memory of earlier sessions.
   * `options` hold for that gate only: the next start without them brings up an ordinary one.
   */
  startGate(options?: GateStartOptions): Promise<void>;
```

and replace

```ts
  close(session: DirectSession, closer: KeyPairSigner): Promise<string>;
  /** A new key that holds nothing. */
```

with

```ts
  close(session: DirectSession, closer: KeyPairSigner): Promise<string>;
  /**
   * Tops up `session` on the program: `rate x seconds` from the buyer's USDC account into the session's vault, then
   * `top_up` signed by the buyer as the session's authority, in one transaction whose fee a harness key pays. It works on
   * any session the buyer opened, through the gate or not, and goes through neither the gate nor the facilitator. Returns
   * the transaction's signature, and rejects if the program refuses the top-up.
   */
  topUp(options: { readonly buyer: Buyer; readonly session: Address; readonly seconds: number }): Promise<string>;
  /** A new key that holds nothing. */
```

In `conformance/src/index.ts`, replace

```ts
export { expectEqual, expectTrue, sleep, waitFor } from "./assert.js";
```

with

```ts
export { expectEqual, expectTrue, sleep, waitFor } from "./assert.js";
export { rejectedWithProgramError } from "./helpers.js";
```

Run: `pnpm --filter @lxfoundry/stint-conformance typecheck`
Expected: PASS. `pnpm --filter @lxfoundry/stint-e2e typecheck` fails: `createDirectChain` returns no `topUp`. Steps 4 to
8 add it.

- [ ] **Step 4: Write the failing test of a gate started with its clock ahead**

In `e2e/test/services.test.ts`, replace

```ts
  it("stops the gate and starts it again on the same URL, with the facilitator and Kora as they were", async () => {
```

with

```ts
  /** Opens a 30 s session through the gate at `url`, reads the time left that the gate reports, and closes the session. */
  async function reportedTimeLeft(url: string): Promise<number> {
    const buyer = await newBuyer(chain.network.rpc, chain.keys.mintAuthority.signer, 1_000_000n);
    const { tools } = createSessionTools(
      createStintClient({
        signer: buyer.signer,
        policy: { maxRate: 10_000n, maxPerSession: 1_000_000n, budget: { amount: 1_000_000n, periodSeconds: 3_600 } },
      }),
    );
    const opened = await tools.stint_open_session.run({ url, seconds: 30, reason: "clock test" });
    const { timeLeftSeconds } = await tools.stint_session_status.run({ sessionId: opened.sessionId });
    await tools.stint_close_session.run({ sessionId: opened.sessionId });
    return timeLeftSeconds;
  }

  it("starts a gate whose session clock runs ahead when asked to, and an ordinary one at the next start", async () => {
    const own = await start();
    const url = own.stream.url;
    await own.stopGate();
    await own.startGate({ sessionClockAheadMs: 20_000 });

    // 30 s bought, on a gate whose session clock runs 20 s ahead: it counts at most 10 s left.
    expect(await reportedTimeLeft(url)).toBeLessThanOrEqual(10);

    await own.stopGate();
    await own.startGate();
    expect(own.stream.url).toBe(url);
    expect(await reportedTimeLeft(url)).toBeGreaterThanOrEqual(25);
  }, 90_000);

  it("stops the gate and starts it again on the same URL, with the facilitator and Kora as they were", async () => {
```

- [ ] **Step 5: Write the failing test of an on-chain top-up**

In `e2e/test/direct-chain.test.ts`, replace

```ts
import { sleep, type DirectChain } from "@lxfoundry/stint-conformance";
import { CloseKind, fetchMaybeSession, fetchSession } from "@lxfoundry/stint-program-client";
```

with

```ts
import { rejectedWithProgramError, sleep, type DirectChain } from "@lxfoundry/stint-conformance";
import { CloseKind, STINT_ERROR__SESSION_EXPIRED, fetchMaybeSession, fetchSession, paidUntil } from "@lxfoundry/stint-program-client";
```

and replace

```ts
  it("leaves the session to whoever closes it: refused before its paid time, and accepted from then on from a key that holds nothing", async () => {
```

with

```ts
  it("tops up a session on the program, signed by the buyer, until its paid time runs out: then SessionExpired", async () => {
    const buyer = await buyerWith(1_000_000n);
    const opened = await direct.open({ buyer, seconds: 8 });

    await direct.topUp({ buyer, session: opened.session, seconds: 10 });

    const after = (await fetchSession(stack.network.rpc, opened.session, { commitment: "confirmed" })).data;
    expect(after).toMatchObject({ deposited: 18_000n, claimed: 0n, startedAt: opened.startedAt });
    expect(paidUntil(after)).toBe(opened.paidUntil + 10n);
    await expect.poll(chainClockReaches(opened.paidUntil + 10n), { timeout: 30_000, interval: 250 }).toBe(true);
    const refused = await direct.topUp({ buyer, session: opened.session, seconds: 1 }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(rejectedWithProgramError(refused, STINT_ERROR__SESSION_EXPIRED)).toBe(true);
    // Closed by the buyer, so that nothing is left of it: the receiver is paid the 18 s.
    const signature = await direct.close(opened, buyer.signer);
    expect(await fetchClosedEvent(stack.network.rpc, signature, ONE_READ)).toMatchObject({ owed: 18_000n, refunded: 0n });
  }, 60_000);

  it("leaves the session to whoever closes it: refused before its paid time, and accepted from then on from a key that holds nothing", async () => {
```

- [ ] **Step 6: Run them to see them fail**

Run: `pnpm --filter @lxfoundry/stint-e2e test services.test.ts direct-chain.test.ts`
Expected: FAIL: `direct.topUp is not a function`, and the first `reportedTimeLeft` reports about 29 s, since the
option is ignored. (Vitest runs the files despite the type error of Step 3.)

- [ ] **Step 7: Start the gate with its clock ahead**

In `e2e/src/targets/services.ts`, replace

```ts
import { randomUUID } from "node:crypto";
import type { Rpc, SolanaRpcApi } from "@solana/kit";
```

with

```ts
import { randomUUID } from "node:crypto";
import type { Rpc, SolanaRpcApi } from "@solana/kit";
import type { GateStartOptions } from "@lxfoundry/stint-conformance";
```

replace

```ts
  /**
   * Starts the gate again on the port it had. The new gate has no memory of earlier sessions. Safe to repeat when the calls are
```

with

```ts
  /**
   * Starts the gate again on the port it had. The new gate has no memory of earlier sessions. `options` hold for that gate only:
   * the next start without them brings up an ordinary one. Safe to repeat when the calls are
```

replace

```ts
  startGate(): Promise<void>;
  /** Stops everything that is running, a stopped gate included. Safe to repeat. */
```

with

```ts
  startGate(options?: GateStartOptions): Promise<void>;
  /** Stops everything that is running, a stopped gate included. Safe to repeat. */
```

and replace

```ts
    const startGate = async (): Promise<void> => {
      if (running || stopped) return;
      const started = await startStreamOn(streamConfig, port);
```

with

```ts
    const startGate = async (options: GateStartOptions = {}): Promise<void> => {
      if (running || stopped) return;
      const ahead = options.sessionClockAheadMs ?? 0;
      // Its idle and end timers fire `ahead` early; the chain's clock still decides every amount.
      const config: StreamConfig =
        ahead === 0 ? streamConfig : { ...streamConfig, gate: { ...streamConfig.gate, sessionClock: () => Date.now() + ahead } };
      const started = await startStreamOn(config, port);
```

In `e2e/src/targets/local.ts` and in `e2e/src/targets/devnet.ts`, replace `startGate: () => services.startGate(),`
with `startGate: (options) => services.startGate(options),`, keeping each line's indentation (six spaces in
`local.ts`, four in `devnet.ts`).

- [ ] **Step 8: Top up on-chain**

In `e2e/src/targets/direct.ts`, replace

```ts
  getCloseInstruction,
  getOpenInstruction,
  paidUntil,
} from "@lxfoundry/stint-program-client";
```

with

```ts
  getCloseInstruction,
  getOpenInstruction,
  getTopUpInstruction,
  paidUntil,
} from "@lxfoundry/stint-program-client";
```

replace

```ts
 * Sessions opened and closed straight on the program, for the scenarios that need one that no gate, facilitator or
 * sweeper holds (spec §12.2). The open is the layout of spec §5.3 with real signers: the rent payer creates the vault,
```

with

```ts
 * Sessions opened, topped up and closed straight on the program, for the scenarios that need one that no gate, facilitator
 * or sweeper holds, or a top-up that none of them makes (spec §12.2). The open is the layout of spec §5.3 with real
 * signers: the rent payer creates the vault,
```

and replace

```ts
    newKey: () => generateKeyPairSigner(),
```

with

```ts
    async topUp({ buyer, session, seconds }) {
      if (!Number.isInteger(seconds) || seconds < 1) throw new Error(`A top-up buys a whole number of seconds, at least 1: got ${seconds}`);
      const vault = await associatedTokenAddress(session, USDC_DEVNET_MINT);
      return sendInstructions(
        rpc,
        feePayer,
        [
          getTransferCheckedInstruction({
            source: buyer.usdcAccount,
            mint: USDC_DEVNET_MINT,
            destination: vault,
            authority: buyer.signer,
            amount: terms.rate * BigInt(seconds),
            decimals: USDC_DECIMALS,
          }),
          getTopUpInstruction({ authority: buyer.signer, session, vault, ...(await eventAccounts()) }),
        ],
        send,
      );
    },

    newKey: () => generateKeyPairSigner(),
```

- [ ] **Step 9: Run them to see them pass, and commit**

Run: `pnpm typecheck && pnpm --filter @lxfoundry/stint-conformance test && pnpm --filter @lxfoundry/stint-e2e test services.test.ts direct-chain.test.ts`
Expected: PASS.

```bash
git add conformance e2e
git commit -m "Let the harness start the gate with its clock ahead, and top up on the program"
```

- [ ] **Step 10: Write the watching helper**

Create `conformance/src/watch.ts`:

```ts
import type { StintSession } from "@lxfoundry/stint-client";
import { sleep } from "./assert.js";
import { receivedAmount } from "./scenarios/22-example-agent-task.js";
import type { Buyer, ScenarioContext } from "./types.js";

/** What a connection received about a watched account, and how it ended. */
export interface Watch {
  /** When each frame about the watched account arrived, in milliseconds on the wall clock. */
  readonly frames: readonly number[];
  /** The connection's close code, once it has closed. */
  readonly closeCode: number | undefined;
  /** Set when a payment that should have changed the account failed. */
  readonly paymentFailure: unknown;
  /** Stops the payments, waits for the one in flight, and drops the connection. */
  stop(): Promise<void>;
}

/**
 * Connects to `session`, subscribes to `watched`'s USDC account, and has `payer` send it one base unit every 500 ms until
 * `stop`. Whatever the gate forwards shows up as a frame, so the frames show when the session was served (scenarios 4 and
 * 34). The watched account must exist before the subscription: the node then sends one message per change (scenario 22).
 */
export async function watchWhilePaying(context: ScenarioContext, session: StintSession, payer: Buyer, watched: Buyer): Promise<Watch> {
  const frames: number[] = [];
  let closeCode: number | undefined;
  let paymentFailure: unknown;
  const socket = await session.connect();
  socket.on("message", (data) => {
    try {
      if (receivedAmount(JSON.parse(String(data)), watched.usdcAccount) !== undefined) frames.push(Date.now());
    } catch {
      // not JSON, so not a frame about the account
    }
  });
  socket.on("close", (code) => {
    closeCode = code;
  });
  socket.on("error", () => {});
  socket.send(JSON.stringify({ op: "subscribe", accounts: [watched.usdcAccount] }));
  await sleep(context.subscriptionSettleMs); // the subscription is in place before the first payment

  let paying = true;
  const payments = (async () => {
    try {
      while (paying) {
        await context.sendUsdc(payer, watched.usdcAccount, 1n);
        await sleep(500);
      }
    } catch (error) {
      paymentFailure = error;
    }
  })();
  return {
    frames,
    get closeCode() {
      return closeCode;
    },
    get paymentFailure() {
      return paymentFailure;
    },
    async stop() {
      paying = false;
      await payments;
      socket.terminate();
    },
  };
}
```

- [ ] **Step 11: Write scenario 4 and run it while pending**

Create `conformance/src/scenarios/04-top-up.ts`:

```ts
import type { Address } from "@solana/kit";
import { StintError, type StintSession } from "@lxfoundry/stint-client";
import { CloseKind, fetchMaybeSession, paidUntil, type Session } from "@lxfoundry/stint-program-client";
import { associatedTokenAddress, tokenBalanceChanges } from "@lxfoundry/stint-x402";
import { expectEqual, expectTrue, sleep, waitFor } from "../assert.js";
import { awaitClose } from "../closes.js";
import { buyerClient, closePollMs, sessionSeconds } from "../helpers.js";
import { readUntil } from "../reads.js";
import type { ScenarioContext } from "../types.js";
import { watchWhilePaying } from "../watch.js";

/**
 * The top-up before expiry, made right after the open, and what it changed: the session's deposit and its new end. It comes
 * before the connection that watches the session and its subscription wait, so it is well outside the facilitator's 10 s
 * margin whatever the target; the chain's clock, which set the end, can lag the facilitator's.
 */
async function topUpBeforeExpiry(
  context: ScenarioContext,
  session: StintSession,
  stored: Session,
  seconds: number,
): Promise<{ readonly deposited: bigint; readonly endMs: number }> {
  const firstEndMs = session.paidUntil * 1_000;
  expectTrue(firstEndMs - Date.now() > 12_000, "the first top-up is more than 12 s before the end: the open took too long");
  const extended = await session.topUp({ seconds });
  expectEqual(extended.cost, stored.rate * BigInt(seconds), "the top-up costs rate x seconds");
  expectEqual(extended.paidUntil * 1_000, firstEndMs + seconds * 1_000, "the top-up moves paid_until by the seconds it bought");
  expectEqual(session.paidUntil, extended.paidUntil, "the session reports the new paid_until");
  const readSession = () => fetchMaybeSession(context.rpc, session.id, { commitment: "confirmed" });
  const toppedUp = await readUntil(context.readRetry, readSession, (read) => read.exists && read.data.deposited > stored.deposited);
  expectTrue(toppedUp.exists, "the session is still open after the top-up");
  expectEqual(toppedUp.data.deposited, stored.deposited + extended.cost, "the top-up is credited to the deposit");
  expectEqual(toppedUp.data.startedAt, stored.startedAt, "the session keeps its start");
  expectEqual(paidUntil(toppedUp.data), BigInt(extended.paidUntil), "the chain's paid_until is the one the gate answered");
  return { deposited: toppedUp.data.deposited, endMs: extended.paidUntil * 1_000 };
}

/** How a top-up was refused: the gate's HTTP status and the reason its body gives; undefined if it went through. */
async function refusalOf(attempt: Promise<unknown>): Promise<{ readonly status?: number; readonly reason?: unknown } | undefined> {
  try {
    await attempt;
    return undefined;
  } catch (error) {
    if (!(error instanceof StintError)) throw error;
    return { status: error.status, reason: (error.body as { error?: unknown } | undefined)?.error };
  }
}

/**
 * Scenario 4 (spec §12.7): a top-up before expiry extends the session; after expiry, a top-up is refused. Once topped up,
 * the buyer stays connected while a payer keeps changing a watched account, so the frames show how long the gate serves
 * the session. A top-up within the facilitator's 10 s margin before the end is refused too. Neither refusal costs the
 * buyer anything.
 */
export async function topUpBeforeAndAfterExpiry(context: ScenarioContext): Promise<void> {
  const buyer = await context.newBuyer(100_000n); // 20 s, then 10 s more: 30,000 (50,000 on devnet)
  const payer = await context.newBuyer(1_000n);
  const watched = await context.newBuyer(0n);
  const client = buyerClient(buyer);
  const session = await client.open(context.gateUrl, { seconds: sessionSeconds(context.target, 20) });
  const readSession = () => fetchMaybeSession(context.rpc, session.id, { commitment: "confirmed" });
  const opened = await readUntil(context.readRetry, readSession, (read) => read.exists);
  expectTrue(opened.exists, "the session exists on-chain after the open");
  const stored = opened.data;
  const usdcOf = async (account: Address) =>
    BigInt((await context.rpc.getTokenAccountBalance(account, { commitment: "confirmed" }).send()).value.amount);
  const firstEndMs = session.paidUntil * 1_000;

  // Before expiry: the top-up adds its seconds to the end of the paid time, and its cost to the deposit. A connection holds
  // the session meanwhile, since the gate closes a session that has had none for 10 s (its idle close), and an open and a
  // top-up confirmed one after the other can take that long on devnet. The watching connection replaces it at once.
  const holding = await session.connect();
  holding.on("error", () => {});
  const { deposited, endMs } = await topUpBeforeExpiry(context, session, stored, sessionSeconds(context.target, 10)).finally(() =>
    holding.terminate(),
  );

  const watch = await watchWhilePaying(context, session, payer, watched);
  try {
    // 5 s before the new end, within the facilitator's 10 s margin, a top-up is refused and takes nothing.
    await sleep(Math.max(0, endMs - 5_000 - Date.now()));
    const before = await usdcOf(buyer.usdcAccount);
    const late = await refusalOf(session.topUp({ seconds: 5 }));
    expectEqual(late?.status, 402, "a top-up 5 s before the end is refused with 402");
    expectEqual(late?.reason, "session_expired", "a top-up 5 s before the end is refused as session_expired");
    expectEqual(await usdcOf(buyer.usdcAccount), before, "the refused top-up takes nothing from the buyer");

    await waitFor(
      () => watch.closeCode !== undefined,
      Math.max(1_000, endMs + 30_000 - Date.now()),
      "the connection is closed within 30 s of the new paid_until",
    );
  } finally {
    await watch.stop();
  }
  expectEqual(watch.closeCode, 4402, "the connection is dropped with 4402");
  expectTrue(watch.paymentFailure === undefined, "every payment that changed the watched account went through");
  expectTrue(
    watch.frames.some((at) => at > firstEndMs + 2_000 && at < endMs - 1_000),
    "frames arrived after the first paid_until: the top-up extended the session",
  );
  expectEqual(watch.frames.filter((at) => at > endMs + 5_000).length, 0, "no frame arrived more than 5 s after the new paid_until");

  const found = await awaitClose(context.rpc, session.id, context.readRetry, 15_000, "the expiry close is on-chain", closePollMs(context.target));
  const { event } = found;
  expectEqual(event.kind, CloseKind.AtExpiry, "the session is closed with AtExpiry");
  expectEqual(event.paidUntil * 1_000n, BigInt(endMs), "the close's paid_until is the one the top-up moved it to");
  expectEqual(event.claimed + event.owed, deposited, "the receiver is paid the opening deposit and the top-up");
  expectEqual(event.refunded + event.redirected, 0n, "nothing is refunded");
  const changes = await tokenBalanceChanges(context.rpc, found.signature, context.readRetry);
  const receiverToken = await associatedTokenAddress(stored.receiver, stored.mint);
  expectEqual(changes.get(receiverToken), event.owed + event.redirected, "the receiver's gain in the close");

  // After expiry the session is gone: a top-up is refused before anything is signed, and takes nothing.
  const afterClose = await usdcOf(buyer.usdcAccount);
  const after = await refusalOf(session.topUp({ seconds: 5 }));
  expectEqual(after?.status, 404, "a top-up after the end is refused with 404");
  expectEqual(after?.reason, "unknown_session", "a top-up after the end is refused as unknown_session");
  expectEqual(await usdcOf(buyer.usdcAccount), afterClose, "the refused top-up takes nothing from the buyer");
  expectEqual(client.remainingBudget(), 1_000_000n - deposited, "the refused top-ups lock nothing");
}
```

In `conformance/src/catalogue.ts`, replace

```ts
import { expiry } from "./scenarios/03-expiry.js";
```

with

```ts
import { expiry } from "./scenarios/03-expiry.js";
import { topUpBeforeAndAfterExpiry } from "./scenarios/04-top-up.js";
```

and replace `  pending(4, "Top-up before and after expiry"),` with:

```ts
  pending(4, "Top-up before and after expiry", [], "shared", topUpBeforeAndAfterExpiry),
```

Run: `pnpm typecheck && pnpm e2e:local`
Expected: the table row `| 4. Top-up before and after expiry | local | pending | pass (make required) | ... |`, the
summary `Status: required 7, pending 28 · Result: pass 8, fail 0, pending 26, not applicable 1`, and `Make required: 1`.
(The catalogue test expects a pending scenario to have no run, so `pnpm test` fails until Step 13: that is the ratchet,
not a fault.) If scenario 4 fails, its error names the check that failed. Do not weaken an assertion: stop and report
which observation did not hold.

- [ ] **Step 12: Make the tests expect scenario 4 required, and watch them fail**

In `conformance/test/catalogue.test.ts` and in `e2e/test/local-target.test.ts`, replace
`const REQUIRED = [1, 2, 3, 9, 16, 22, 26];` with `const REQUIRED = [1, 2, 3, 4, 9, 16, 22, 26];`. In
`e2e/test/devnet-target.test.ts`, replace `const required = [1, 2, 3, 9, 16, 22, 26];` with
`const required = [1, 2, 3, 4, 9, 16, 22, 26];`.

Run: `pnpm --filter @lxfoundry/stint-conformance test catalogue.test.ts`
Expected: FAIL: scenario 4's status is `pending`.

- [ ] **Step 13: Make scenario 4 required, run, and commit**

In `conformance/src/catalogue.ts`, replace
`  pending(4, "Top-up before and after expiry", [], "shared", topUpBeforeAndAfterExpiry),` with:

```ts
  required(4, "Top-up before and after expiry", topUpBeforeAndAfterExpiry),
```

Run: `pnpm typecheck && pnpm --filter @lxfoundry/stint-conformance test && pnpm e2e:local`
Expected: PASS; the report reads `Status: required 8, pending 27 · Result: pass 8, fail 0, pending 26, not applicable 1`,
with no "Make required" line.

```bash
git add conformance e2e/test
git commit -m "Run scenario 4, a top-up before and after expiry, and make it required"
```

- [ ] **Step 14: Write scenario 34 and run it while pending**

Create `conformance/src/scenarios/34-top-up-while-closing.ts`:

```ts
import { CloseKind, fetchMaybeSession, paidUntil } from "@lxfoundry/stint-program-client";
import { associatedTokenAddress, tokenBalanceChanges } from "@lxfoundry/stint-x402";
import { expectEqual, expectTrue, sleep, waitFor } from "../assert.js";
import { awaitClose } from "../closes.js";
import { buyerClient, closePollMs, sessionSeconds } from "../helpers.js";
import { readUntil } from "../reads.js";
import type { ScenarioContext, StackControl } from "../types.js";
import { watchWhilePaying } from "../watch.js";

/** How far ahead of the wall clock the gate's session clock runs (spec §12.7): its end timer fires this long before paid_until. */
const GATE_AHEAD_MS = 5_000;
/** How long before paid_until the authority tops up: after the gate's end timer has fired, early enough to land before the end. */
const TOP_UP_LEAD_MS = 2_500;
/** How long after forwarding stops a frame may still arrive: one the gate forwarded just before. */
const IN_FLIGHT_MS = 1_000;
/** What the authority buys on-chain. */
const TOP_UP_SECONDS = 12;

/**
 * Runs `work` on a gate whose session clock runs `aheadMs` ahead of the wall clock, and starts an ordinary gate again
 * afterwards, whatever happened. The gate is the run's common one, as in scenario 26: spec §12.2 gives scenario 34 a stack
 * of its own, and restarting the common gate is safe only because the runner runs one scenario at a time.
 */
export async function withGateClockAhead<T>(stack: StackControl, aheadMs: number, work: () => Promise<T>): Promise<T> {
  await stack.stopGate();
  try {
    await stack.startGate({ sessionClockAheadMs: aheadMs });
    return await work();
  } finally {
    await stack.stopGate();
    await stack.startGate();
  }
}

/**
 * Scenario 34 (spec §12.7): a top-up lands while the gate is closing at expiry. The gate's session clock runs 5 s ahead, so
 * its end timer fires 5 s before paid_until: it stops forwarding, and its AtExpiry close fails with NotExpired, since the
 * chain's clock has not reached paid_until. Meanwhile the authority tops up on-chain, through neither the gate nor the
 * facilitator. The gate resumes forwarding and sets its end timer for the new paid_until, and the session runs on to it;
 * the close then counts the top-up.
 */
export async function topUpWhileClosingAtExpiry(context: ScenarioContext): Promise<void> {
  const stack = context.stack;
  if (!stack) throw new Error("scenario 34 needs a target that provides stack control");
  const direct = context.direct;
  if (!direct) throw new Error("scenario 34 needs a target that provides direct chain access");
  await withGateClockAhead(stack, GATE_AHEAD_MS, async () => {
    const buyer = await context.newBuyer(100_000n); // at most 30 s, then 12 s more: 42,000
    const payer = await context.newBuyer(1_000n);
    const watched = await context.newBuyer(0n);
    // The connection and its subscription wait come before the gate's end timer fires, 5 s before the end: the session
    // lasts that wait longer (17 s locally, 30 s on devnet, where the wait is 5 s).
    const seconds = sessionSeconds(context.target, 15) + Math.ceil(context.subscriptionSettleMs / 1_000);
    const session = await buyerClient(buyer).open(context.gateUrl, { seconds });
    const readSession = () => fetchMaybeSession(context.rpc, session.id, { commitment: "confirmed" });
    const opened = await readUntil(context.readRetry, readSession, (read) => read.exists);
    expectTrue(opened.exists, "the session exists on-chain after the open");
    const stored = opened.data;
    const endMs = session.paidUntil * 1_000;
    /** When the gate's end timer fires, on the wall clock. */
    const firedAtMs = endMs - GATE_AHEAD_MS;
    let newEndMs = endMs;
    let deposited = stored.deposited;

    const watch = await watchWhilePaying(context, session, payer, watched);
    try {
      expectTrue(firedAtMs - Date.now() > 3_000, "frames flow for 3 s before the gate's end timer fires: the open took too long");
      // The gate's end timer fires 5 s before paid_until: forwarding stops, and its AtExpiry close fails with NotExpired.
      await sleep(Math.max(0, endMs - TOP_UP_LEAD_MS - Date.now()));
      expectTrue(watch.frames.some((at) => at < firedAtMs), "frames arrived before the gate's end timer fired");
      expectEqual(
        watch.frames.filter((at) => at >= firedAtMs + IN_FLIGHT_MS).length,
        0,
        "the gate stopped forwarding when its end timer fired, before paid_until",
      );

      // Meanwhile the authority tops up on-chain.
      await direct.topUp({ buyer, session: session.id, seconds: TOP_UP_SECONDS });
      const toppedUp = await readUntil(context.readRetry, readSession, (read) => read.exists && read.data.deposited > stored.deposited);
      expectTrue(toppedUp.exists, "the session is still open after the top-up");
      expectEqual(toppedUp.data.deposited, stored.deposited + stored.rate * BigInt(TOP_UP_SECONDS), "the top-up is credited to the deposit");
      newEndMs = Number(paidUntil(toppedUp.data)) * 1_000;
      expectEqual(newEndMs, endMs + TOP_UP_SECONDS * 1_000, "the top-up moves paid_until by the seconds it bought");
      deposited = toppedUp.data.deposited;

      // The gate resumes: changes to the account are forwarded again after the first paid_until, before its end timer fires
      // again, 5 s before the new paid_until.
      await waitFor(
        () => watch.frames.some((at) => at > endMs),
        Math.max(1_000, newEndMs - GATE_AHEAD_MS - Date.now()),
        "the gate forwards again after the first paid_until: it resumed when the top-up landed",
      );
      // The session runs on to its new end: the gate closes it with AtExpiry and drops the connection with 4402.
      await waitFor(
        () => watch.closeCode !== undefined,
        Math.max(1_000, newEndMs + 30_000 - Date.now()),
        "the connection is closed within 30 s of the new paid_until",
      );
    } finally {
      await watch.stop();
    }
    expectEqual(watch.closeCode, 4402, "the connection is dropped with 4402");
    expectTrue(watch.paymentFailure === undefined, "every payment that changed the watched account went through");
    expectEqual(
      watch.frames.filter((at) => at >= newEndMs - GATE_AHEAD_MS + IN_FLIGHT_MS).length,
      0,
      "the gate stopped forwarding again when its end timer fired before the new paid_until",
    );

    const found = await awaitClose(context.rpc, session.id, context.readRetry, 15_000, "the expiry close is on-chain", closePollMs(context.target));
    const { event } = found;
    expectEqual(event.kind, CloseKind.AtExpiry, "the session is closed with AtExpiry");
    expectEqual(event.paidUntil * 1_000n, BigInt(newEndMs), "the close's paid_until is the one the top-up moved it to");
    expectTrue(event.at >= event.paidUntil, "the chain's clock had reached the new paid_until at the close");
    expectEqual(event.claimed + event.owed, deposited, "the receiver is paid the opening deposit and the top-up: the top-up counts");
    expectEqual(event.refunded + event.redirected, 0n, "nothing is refunded");
    const changes = await tokenBalanceChanges(context.rpc, found.signature, context.readRetry);
    const receiverToken = await associatedTokenAddress(stored.receiver, stored.mint);
    expectEqual(changes.get(receiverToken), event.owed + event.redirected, "the receiver's gain in the close");
  });
}
```

In `conformance/src/catalogue.ts`, replace

```ts
import { expiredSessionNobodyCloses } from "./scenarios/26-expired-session-nobody-closes.js";
```

with

```ts
import { expiredSessionNobodyCloses } from "./scenarios/26-expired-session-nobody-closes.js";
import { topUpWhileClosingAtExpiry } from "./scenarios/34-top-up-while-closing.js";
```

and replace `  pending(34, "A top-up lands while the gate is closing at expiry", ["stack"], "ownStack"),` with:

```ts
  pending(34, "A top-up lands while the gate is closing at expiry", ["stack"], "ownStack", topUpWhileClosingAtExpiry),
```

Run: `pnpm typecheck && pnpm e2e:local`
Expected: the row `| 34. A top-up lands while the gate is closing at expiry | local | pending | pass (make required) | ... |`,
the summary `Status: required 8, pending 27 · Result: pass 9, fail 0, pending 25, not applicable 1`, and
`Make required: 1`. If it fails, read the error and stop and report, as in Step 11. Two failures have a known cause:
- `the gate stopped forwarding when its end timer fired` fails: the restarted gate's session clock is not ahead
  (Step 7), so its end timer fires at `paidUntil` and frames keep coming until then.
- The on-chain top-up is rejected with the program's error 6003 (`SessionExpired`): it landed after `paidUntil`. Look
  at what made it slow before touching `TOP_UP_LEAD_MS`.

- [ ] **Step 15: Make the tests expect scenario 34 required, and watch them fail**

In `conformance/test/catalogue.test.ts` and in `e2e/test/local-target.test.ts`, replace
`const REQUIRED = [1, 2, 3, 4, 9, 16, 22, 26];` with `const REQUIRED = [1, 2, 3, 4, 9, 16, 22, 26, 34];`. In
`e2e/test/devnet-target.test.ts`, replace `const required = [1, 2, 3, 4, 9, 16, 22, 26];` with
`const required = [1, 2, 3, 4, 9, 16, 22, 26, 34];`.

The required scenarios now take about three minutes, and the limit of the two tests that run them all is 300 s. In
`e2e/test/local-target.test.ts`, replace

```ts
/**
 * The required scenarios, all passing on `local`. Together they take about two minutes: scenario 1 sleeps 7 s, 3 runs about
 * 25 s, 9 about 15 s, 16 about 15 s and 26 about 20 s, so the test's limit is generous.
 */
```

with

```ts
/**
 * The required scenarios, all passing on `local`. Together they take about three minutes: scenario 1 sleeps 7 s, 3 runs
 * about 25 s, 4 about 35 s, 9 about 15 s, 16 about 15 s, 26 about 20 s and 34 about 35 s, so the test's limit is generous.
 */
```

and, in the test `passes every required scenario, and reports the others`, replace `  }, 300_000);` with
`  }, 420_000);`. In `e2e/test/devnet-target.test.ts`, in the test `passes the required scenarios with buyers funded from
the funding key`, replace `Together they take about two minutes.` with `Together they take about three minutes.` and
`  }, 300_000);` with `  }, 420_000);`.

Run: `pnpm --filter @lxfoundry/stint-conformance test catalogue.test.ts`
Expected: FAIL: scenario 34's status is `pending`.

- [ ] **Step 16: Make scenario 34 required**

In `conformance/src/catalogue.ts`, replace
`  pending(34, "A top-up lands while the gate is closing at expiry", ["stack"], "ownStack", topUpWhileClosingAtExpiry),`
with:

```ts
  required(34, "A top-up lands while the gate is closing at expiry", topUpWhileClosingAtExpiry, ["stack"], "ownStack"),
```

- [ ] **Step 17: Record the stage in the README and the spec**

In `README.md`, in `## Status`, replace the paragraph

```markdown
Work in progress. Working today: the Solana program, deployed on devnet (`open`, `claim`, and `close`, which pays
the seller for the time used, or for the whole paid time once it has run out, and refunds the rest); the x402
`elapsed` scheme; the facilitator with its sweeper, the gate with its timers, the client library, an MCP server
and an example agent.
A session ends by itself: the gate drops its connection with `4402` when the paid time runs out, closes a session
that nobody connects to, and the sweeper closes an expired session that nobody closed, if it names the
facilitator's own rent payer. Seven of the 35 end-to-end scenarios of the
[specification](docs/specs/stint-system.md) (section 12.7) pass on a local network and on devnet, and the run
report lists the other 28 as pending. Not built yet: top-ups, fallback closes, refusals of bad payments and
settlement records, and resilience across restarts.
```

with

```markdown
Work in progress. Working today: the Solana program (`open`, `top_up`, `claim`, and `close`, which pays the seller
for the time used, or for the whole paid time once it has run out, and refunds the rest; the devnet deployment is
of the earlier version, without `top_up`, until it is upgraded); the x402 `elapsed` scheme; the facilitator with its
sweeper, the gate with its timers, the client library, an MCP server and an example agent.
A session ends by itself: the gate drops its connection with `4402` when the paid time runs out, closes a session
that nobody connects to, and the sweeper closes an expired session that nobody closed, if it names the
facilitator's own rent payer. A buyer can top up a session before its paid time runs out, which moves its end; a
session whose paid time has run out cannot be extended. Nine of the 35 end-to-end scenarios of the
[specification](docs/specs/stint-system.md) (section 12.7) pass on a local network, seven of them also on devnet,
and the run report lists the other 26 as pending. Not built yet: fallback closes, refusals of bad payments and
settlement records, and resilience across restarts.
```

In `docs/specs/stint-system.md`, section 12.2, replace

```markdown
  restart or add instances of them. In particular, it can stop the gate and start it again on the same
  address while the facilitator, its sweeper and Kora keep running (scenario 26).
```

with

```markdown
  restart or add instances of them. In particular, it can stop the gate and start it again on the same
  address while the facilitator, its sweeper and Kora keep running (scenario 26), and start it with its session
  clock running ahead of the wall clock (scenario 34).
```

- [ ] **Step 18: Run every check, and commit**

Run: `pnpm typecheck && pnpm test && pnpm e2e:local`
Expected: PASS; the report reads `Status: required 9, pending 26 · Result: pass 9, fail 0, pending 25, not applicable
1`, with no "Make required" line. Run `pnpm e2e:local` twice more: scenarios 4 and 34 pass each time. A scenario that
passes once in three is not done: find what makes it flaky before going on.

```bash
git add conformance e2e/test README.md docs/specs/stint-system.md
git commit -m "Run scenario 34, a top-up while the gate closes at expiry, and make it required"
```

---

### Task 7: The gate follows each session's account

Spec section 7.3: when an open settles, the gate subscribes to the session account at `confirmed` and stays
subscribed until the session ends; a top-up seen on the account moves the end timer. Until this task the gate learns of
a top-up it did not settle (one made on-chain directly, or one whose settlement was pending) only when its end timer
fires and re-reads the session, and forwarding stops for that read. This task adds the subscription. A later
`paid_until` on the same session moves the end timer at once, through `paidLonger` (Task 4), which also resumes
forwarding if the end timer has already fired, as in scenario 34.

Decisions this task makes, from the code and the spec:
- **The chain offers the subscription, optionally.** `GateChain` gains an optional `watchSession`; `createRpcChain`
  provides it when it is given an RPC subscriptions client. A chain without it (the client package's test gate, built
  from a literal) works as before: the end timer's re-read is the fallback, and stays in place with a subscription too.
- **Only a later end is acted on here.** A notification that the account is gone, or holds another session (another
  `started_at`, or terms this gate does not offer), changes nothing: the end timer deals with it at the end, as it does
  today. Dropping the connections of a session another party closed, with `4402` or `4410` from the `Closed` event
  (spec section 7.3), comes with the stage that needs it.
- **A subscription that fails, or cannot start, is logged and not replaced.** This is a limitation of the stage, not
  the design, so the spec is not edited; its cost is under "What this stage builds, and what it leaves for later": the
  gate behaves as it did without a subscription.
- **One subscription per session, from `provision` to `end`.** It starts once, when the open settles and the session is
  provisioned (a repeated open finds it tracked and starts nothing), after the session's timers, so that the session
  ends by itself whatever becomes of its subscription. It stops when the session ends, whatever ends it, and when the
  gate stops; a gate that has stopped starts none. A top-up that lands before the subscription is in place is found by
  the end timer.
- **A later end seen during the end timer's re-read leaves nothing to close.** The notification resumes the session
  while the re-read is in flight; the re-read then finds no later end than the one the gate now knows, and `attempt`
  would send an `AtExpiry` close the program refuses. `attempt` returns once the session is no longer muted.

**Files:**
- Modify: `packages/gate/src/chain.ts`, `packages/gate/src/gate.ts`, `e2e/src/targets/services.ts`
- Modify (test support): `packages/gate/test/harness.ts`
- Create: `packages/gate/test/follow.test.ts`
- Test: `packages/gate/test/chain.test.ts`, `e2e/test/direct-chain.test.ts`

**Interfaces:**
- Consumes: Task 4's `paidLonger(tracked, until)`, `extend`, `resume`; Task 6's `DirectChain.topUp`; Kit's
  `RpcSubscriptions<SolanaRpcSubscriptionsApi>`, `accountNotifications`, `parseBase64RpcAccount`,
  `createSolanaRpcSubscriptions`.
- Produces:
  - `GateChain.watchSession?(session: Address, onChange: (stored: Session | undefined) => void, onError: (error:
    unknown) => void): () => void`.
  - `createRpcChain(rpc, subscriptions?)`: with `subscriptions`, a chain whose `watchSession` subscribes to the account
    at `confirmed`, in base64, and decodes each notification as `readSession` decodes a read.
  - The gate subscribes in `provision` and ends the subscription in `end` and in `close`; it logs `{ event:
    "subscription_error", session, error }` for a subscription that fails.
  - The test harness: `calls.watch: Address[]`, `watchers: Map<Address, { onChange, onError }>`, `unwatched: Address[]`.
  - The harness's services give the gate `createRpcChain(rpc, createSolanaRpcSubscriptions(rpcWsUrl))`.

- [ ] **Step 1: Write the failing tests of the chain's subscription**

In `packages/gate/test/chain.test.ts`, replace

```ts
import { generateKeyPairSigner, getBase64Decoder, type Address, type Rpc, type SolanaRpcApi } from "@solana/kit";
```

with

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
```

and add at the end of the file:

```ts

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
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @lxfoundry/stint-gate test chain.test.ts`
Expected: FAIL: `watchSession` is undefined, so every new test but the last fails with a `TypeError`.

- [ ] **Step 3: Give the chain its subscription**

Replace the contents of `packages/gate/src/chain.ts` with:

```ts
import {
  containsBytes,
  fetchEncodedAccount,
  parseBase64RpcAccount,
  type Address,
  type MaybeEncodedAccount,
  type Rpc,
  type RpcSubscriptions,
  type SolanaRpcApi,
  type SolanaRpcSubscriptionsApi,
} from "@solana/kit";
import {
  SESSION_DISCRIMINATOR,
  STINT_PROGRAM_ADDRESS,
  decodeSession,
  getSessionSize,
  type ClosedEvent,
  type Session,
} from "@lxfoundry/stint-program-client";
import { fetchClosedEvent } from "@lxfoundry/stint-x402";

/** The chain reads the gate needs, so tests can replace them. */
export interface GateChain {
  latestBlockhash(): Promise<{ readonly blockhash: string; readonly lastValidBlockHeight: bigint }>;
  /** The session at `confirmed`, or undefined when the address holds no Stint session. */
  readSession(session: Address): Promise<Session | undefined>;
  closedEvent(signature: string): Promise<ClosedEvent | undefined>;
  /**
   * Follows the account at `session` at `confirmed` (spec §7.3): `onChange` receives the session after each change to the
   * account, or undefined once the address holds no Stint session; `onError` receives a subscription that failed or ended,
   * after which nothing more is reported. Returns what ends the subscription. Optional: a gate whose chain cannot follow an
   * account finds a top-up it did not settle when its end timer fires.
   */
  watchSession?(session: Address, onChange: (stored: Session | undefined) => void, onError: (error: unknown) => void): () => void;
}

/** The session an account holds, or undefined: no account, a wallet, an account of another program, or a closed one. */
function sessionIn(account: MaybeEncodedAccount): Session | undefined {
  if (!account.exists || account.programAddress !== STINT_PROGRAM_ADDRESS) return undefined;
  if (account.data.length < getSessionSize() || !containsBytes(account.data, SESSION_DISCRIMINATOR, 0)) return undefined;
  return decodeSession(account).data;
}

/** The chain over an RPC client and, to follow session accounts, an RPC subscriptions client. */
export function createRpcChain(rpc: Rpc<SolanaRpcApi>, subscriptions?: RpcSubscriptions<SolanaRpcSubscriptionsApi>): GateChain {
  const chain: GateChain = {
    latestBlockhash: async () => (await rpc.getLatestBlockhash({ commitment: "confirmed" }).send()).value,
    // Any address can be asked about: a wallet, or an account of another program, is not a session.
    readSession: async (session) => sessionIn(await fetchEncodedAccount(rpc, session, { commitment: "confirmed" })),
    closedEvent: (signature) => fetchClosedEvent(rpc, signature),
  };
  if (!subscriptions) return chain;
  return {
    ...chain,
    watchSession(session, onChange, onError) {
      const controller = new AbortController();
      (async () => {
        const notifications = await subscriptions
          .accountNotifications(session, { commitment: "confirmed", encoding: "base64" })
          .subscribe({ abortSignal: controller.signal });
        for await (const { value } of notifications) {
          // Typed as possibly missing, the account parses to a `MaybeEncodedAccount`, as a read's does.
          onChange(sessionIn(parseBase64RpcAccount(session, value as typeof value | null)));
        }
        throw new Error(`${session}: notifications ended`);
      })().catch((error: unknown) => {
        // Ending the subscription ends its notifications too: that is not a failure.
        if (!controller.signal.aborted) onError(error);
      });
      return () => controller.abort();
    },
  };
}
```

- [ ] **Step 4: Run them to see them pass, and commit**

Run: `pnpm --filter @lxfoundry/stint-gate test chain.test.ts && pnpm --filter @lxfoundry/stint-gate typecheck`
Expected: PASS: the new tests and the earlier tests of `readSession`, whose behaviour did not change; no type error.

Check that the tests rest on the abort guard: replace `if (!controller.signal.aborted) onError(error);` with
`onError(error);`, and run `pnpm --filter @lxfoundry/stint-gate test chain.test.ts`. Expected: FAIL in "reports the
session after each change…" and "reports nothing once it has been stopped", and only there. Put the guard back and run
it again: PASS.

```bash
git add packages/gate/src/chain.ts packages/gate/test/chain.test.ts
git commit -m "Let the gate's chain follow a session account over RPC subscriptions"
```

- [ ] **Step 5: Give the test harness a chain that follows accounts**

In `packages/gate/test/harness.ts`, replace

```ts
  readonly calls: { verify: PaymentPayload[]; settle: PaymentPayload[]; provision: SessionInfo[]; attach: SessionInfo[]; teardown: EndReason[] };
```

with

```ts
  readonly calls: {
    verify: PaymentPayload[];
    settle: PaymentPayload[];
    provision: SessionInfo[];
    attach: SessionInfo[];
    teardown: EndReason[];
    /** The session of each subscription the gate started. */
    watch: Address[];
  };
```

replace

```ts
  /** What the gate logged. */
  readonly logs: Record<string, unknown>[];
}
```

with

```ts
  /** What the gate logged. */
  readonly logs: Record<string, unknown>[];
  /** The gate's subscriptions to session accounts, until it ends them: a test reports a change to the account through one. */
  readonly watchers: Map<Address, { onChange: (stored: Session | undefined) => void; onError: (error: unknown) => void }>;
  /** The sessions whose subscription the gate has ended, in order. */
  readonly unwatched: Address[];
}
```

replace

```ts
  fail: { supported: boolean; settleClose: boolean; closedEvent: boolean; provision: boolean; teardown: boolean };
```

with

```ts
  fail: { supported: boolean; settleClose: boolean; closedEvent: boolean; provision: boolean; teardown: boolean; watch: boolean };
```

replace

```ts
    calls: { verify: [], settle: [], provision: [], attach: [], teardown: [] },
```

with

```ts
    calls: { verify: [], settle: [], provision: [], attach: [], teardown: [], watch: [] },
```

replace

```ts
    fail: { supported: false, settleClose: false, closedEvent: false, provision: false, teardown: false },
```

with

```ts
    fail: { supported: false, settleClose: false, closedEvent: false, provision: false, teardown: false, watch: false },
```

replace

```ts
    attached: [],
    logs: [],
  } as unknown as Harness;
```

with

```ts
    attached: [],
    logs: [],
    watchers: new Map(),
    unwatched: [],
  } as unknown as Harness;
```

and replace

```ts
      return { claimed: 0n, owed: 8_000n, refunded: 22_000n, redirected: 0n, kind: CloseKind.Standard } as ClosedEvent;
    },
  };
```

with

```ts
      return { claimed: 0n, owed: 8_000n, refunded: 22_000n, redirected: 0n, kind: CloseKind.Standard } as ClosedEvent;
    },
    watchSession: (session, onChange, onError) => {
      if (harness.fail.watch) throw new Error("subscriptions down");
      harness.calls.watch.push(session);
      harness.watchers.set(session, { onChange, onError });
      return () => {
        harness.watchers.delete(session);
        harness.unwatched.push(session);
      };
    },
  };
```

Run: `pnpm --filter @lxfoundry/stint-gate test && pnpm --filter @lxfoundry/stint-gate typecheck`
Expected: PASS: the gate does not call `watchSession` yet, and no test reports a change.

- [ ] **Step 6: Write the failing tests of the gate's subscription**

Create `packages/gate/test/follow.test.ts`:

```ts
import type { Address } from "@solana/kit";
import type { Session } from "@lxfoundry/stint-program-client";
import { readElapsedPayload } from "@lxfoundry/stint-x402";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NOW_MS, helpers, startHarness, type FakeTimer, type Harness } from "./harness.js";

/** What a deposit of 30,000 at 1,000 per second lasts, in the harness's sessions. */
const END_DUE = NOW_MS + 30_000;
/** The end once 10 s more have been paid for. */
const EXTENDED_DUE = NOW_MS + 40_000;

describe("the gate's subscription to the session account (spec §7.3)", () => {
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

  /** The one timer still waiting that is due at `dueMs` on the session clock. */
  function pendingDue(dueMs: number): FakeTimer {
    const found = h.timers.pending.filter((timer) => timer.dueMs === dueMs);
    expect(found).toHaveLength(1);
    return found[0]!;
  }
  /** Reports a change to the session's account as the chain would: the account as it now stands, or none. */
  function notify(session: Address, change: Partial<Session> | "gone"): void {
    const watcher = h.watchers.get(session);
    if (!watcher) throw new Error(`no subscription to ${session}`);
    const now = change === "gone" ? undefined : { ...h.sessions.get(session)!, ...change };
    if (now) h.sessions.set(session, now);
    else h.sessions.delete(session);
    watcher.onChange(now);
  }
  /** An open session with one connection: `frames` collects what the buyer's socket receives. */
  async function openConnected() {
    const { session } = await open();
    const { socket } = await connect(session, await token(session, "connect"));
    const frames: string[] = [];
    socket!.on("message", (data) => frames.push(String(data)));
    return { session, server: h.attached.at(-1)!, frames };
  }

  it("subscribes once when an open settles, and ends the subscription when the session ends", async () => {
    const { session, payload } = await prepareOpen();
    expect((await send(payload)).status).toBe(201);
    expect((await send(payload)).status).toBe(201); // a repeated open finds the session tracked

    expect(h.calls.watch).toEqual([session]);
    expect((await closeWith(session)).status).toBe(200);
    expect(h.unwatched).toEqual([session]);
    expect(h.watchers.size).toBe(0);
  });

  it("moves the end timer when a top-up made elsewhere shows on the account, and hands later connections the new end", async () => {
    const { session } = await open();

    notify(session, { deposited: 40_000n });

    expect(pendingDue(EXTENDED_DUE)).toBeDefined();
    expect(h.timers.pending.filter((timer) => timer.dueMs === END_DUE)).toEqual([]);
    await connect(session, await token(session, "connect"));
    expect(h.calls.attach.at(-1)?.paidUntil).toBe(BigInt(EXTENDED_DUE / 1000));
  });

  it("resumes forwarding at once when the top-up shows after the end timer fired", async () => {
    const { session, server, frames } = await openConnected();
    h.fail.settleClose = true; // the end close fails, as an AtExpiry close does before the chain's clock reaches the end
    h.timers.fire(pendingDue(END_DUE));
    await expect.poll(() => h.timers.pending.map((timer) => timer.delayMs)).toEqual([3_000]);

    notify(session, { deposited: 40_000n });

    expect(h.timers.pending.map((timer) => timer.dueMs)).toEqual([EXTENDED_DUE]);
    server.send("tick:resumed");
    await expect.poll(() => frames).toContain("tick:resumed");
    expect(h.calls.teardown).toEqual([]);
  });

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

  it("logs a subscription that fails, and keeps the session and its end timer", async () => {
    const { session } = await open();

    h.watchers.get(session)!.onError(new Error("socket closed"));

    expect(h.logs).toContainEqual({ event: "subscription_error", session, error: "socket closed" });
    expect(pendingDue(END_DUE)).toBeDefined();
  });

  it("ends every subscription when the gate stops", async () => {
    const first = await open();
    const second = await open();

    await h.gate.close();

    expect([...h.unwatched].sort()).toEqual([first.session, second.session].sort());
  });

  it("sends no close when the top-up shows on the account while the end timer's re-read is in flight", async () => {
    const { session, server, frames } = await openConnected();
    const reads = h.reads.session;
    let release!: () => void;
    h.hold.readSession = new Promise<void>((resolve) => (release = resolve));
    h.timers.fire(pendingDue(END_DUE)); // forwarding stops; the end timer's re-read waits
    await expect.poll(() => h.reads.session).toBe(reads + 1);

    notify(session, { deposited: 40_000n }); // the session resumes while the re-read is in flight
    release();
    await settleDown();

    expect(h.calls.settle.filter((payload) => readElapsedPayload(payload)?.type === "close")).toEqual([]);
    expect(h.timers.pending.map((timer) => timer.dueMs)).toEqual([EXTENDED_DUE]);
    server.send("tick:resumed");
    await expect.poll(() => frames).toContain("tick:resumed");
    expect(h.calls.teardown).toEqual([]);
  });

  it("starts no subscription for a session provisioned after the gate stopped", async () => {
    let release!: () => void;
    h.hold.provision = new Promise<void>((resolve) => (release = resolve));
    const { payload } = await prepareOpen();
    const opening = send(payload);
    await expect.poll(() => h.calls.provision).toHaveLength(1);

    await h.gate.close();
    release();
    await opening;

    expect(h.calls.watch).toEqual([]);
  });

  it("logs a subscription that cannot start, and still opens the session with its timers", async () => {
    h.fail.watch = true;

    const { session, status } = await open();

    expect(status).toBe(201);
    expect(h.logs).toContainEqual({ event: "subscription_error", session, error: "subscriptions down" });
    expect(pendingDue(END_DUE)).toBeDefined();
  });
});
```

- [ ] **Step 7: Run them to see them fail**

Run: `pnpm --filter @lxfoundry/stint-gate test follow.test.ts`
Expected: FAIL: the gate starts no subscription, so `h.calls.watch` is empty and `notify` throws `no subscription to …`;
the test of a gate that stops fails on an empty `unwatched`, and the test of a subscription that cannot start finds no
log entry. The test of a session provisioned after the gate stopped passes already: nothing subscribes yet.

- [ ] **Step 8: Follow the account in the gate**

In `packages/gate/src/gate.ts`, make these replacements.

The tracked session holds the subscription: replace

```ts
  /** Cancels each pending timer. */
  readonly pending: Partial<Record<TimerSlot, () => void>>;
```

with

```ts
  /** Cancels each pending timer. */
  readonly pending: Partial<Record<TimerSlot, () => void>>;
  /** Ends the subscription to the session's account, when the chain offers one. */
  unwatch?: () => void;
```

The subscription starts when the session is provisioned: replace

```ts
  async function provision(session: Address, stored: Session): Promise<Tracked<U>> {
```

with

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
          if (!stored || stored.startedAt !== tracked.stored.startedAt || !sessionMatches(stored, seller)) return;
          paidLonger(tracked, paidUntil(stored));
        },
        failed,
      );
    } catch (error) {
      failed(error);
    }
  }

  async function provision(session: Address, stored: Session): Promise<Tracked<U>> {
```

and replace

```ts
    sessions.set(session, tracked);
    armIdle(tracked);
    armEnd(tracked);
    return tracked;
```

with

```ts
    sessions.set(session, tracked);
    armIdle(tracked);
    armEnd(tracked);
    // After the timers: the session ends by itself whatever becomes of its subscription.
    follow(tracked);
    return tracked;
```

A later end seen during the end timer's re-read leaves nothing to close: replace

```ts
    if (!tracked.closing && (await settledByChain(tracked))) return true;
```

with

```ts
    if (!tracked.closing && (await settledByChain(tracked))) return true;
    // The account's subscription (or the route) resumed the session during the re-read: there is nothing to close.
    if (!tracked.muted) return true;
```

It ends with the session: replace

```ts
    disarm(tracked, "idle");
    disarm(tracked, "end");
    sessions.delete(tracked.info.session);
```

with

```ts
    disarm(tracked, "idle");
    disarm(tracked, "end");
    sessions.delete(tracked.info.session);
    tracked.unwatch?.();
```

and with the gate: replace

```ts
      for (const tracked of sessions.values()) {
        disarm(tracked, "idle");
        disarm(tracked, "end");
        for (const socket of tracked.connections) socket.close(1001, "gate stopping");
```

with

```ts
      for (const tracked of sessions.values()) {
        disarm(tracked, "idle");
        disarm(tracked, "end");
        tracked.unwatch?.();
        for (const socket of tracked.connections) socket.close(1001, "gate stopping");
```

and replace

```ts
  /** Stops the gate's timers and drops every connection. It does not end the sessions: nothing is closed on chain. */
```

with

```ts
  /** Stops the gate's timers and subscriptions, and drops every connection. It does not end the sessions: nothing is closed on chain. */
```

- [ ] **Step 9: Run the gate's tests to see them pass**

Run: `pnpm --filter @lxfoundry/stint-gate test && pnpm --filter @lxfoundry/stint-gate typecheck`
Expected: PASS: the new file's 12 tests and every earlier one; no type error. If "sends no close when the top-up shows on
the account…" fails with a close settled, the guard in `attempt` is missing or comes before the re-read.

- [ ] **Step 10: Check that the tests rest on the subscription**

Put `//` in front of the line `paidLonger(tracked, paidUntil(stored));` in `follow`.

Run: `pnpm --filter @lxfoundry/stint-gate test follow.test.ts`
Expected: FAIL in the two tests that move the end timer and resume forwarding, and only in those.

Remove the `//`. Run the same command: PASS.

- [ ] **Step 11: Commit**

The spec is not edited: section 7.3 describes a gate that stays subscribed until the session ends, and a subscription
that is not replaced when it fails is this stage's limitation, recorded under "What this stage builds, and what it
leaves for later".

```bash
git add packages/gate
git commit -m "Follow each session's account in the gate, and move the end timer on a top-up it did not settle"
```

- [ ] **Step 12: Write the failing end-to-end test**

In `e2e/test/direct-chain.test.ts`, replace

```ts
import { fetchToken } from "@solana-program/token";
```

with

```ts
import { fetchToken } from "@solana-program/token";
import { createStintClient } from "@lxfoundry/stint-client";
```

and replace

```ts
  it("tops up a session on the program, signed by the buyer, until its paid time runs out: then SessionExpired", async () => {
```

with

```ts
  it("has the stack's gate follow a top-up made on the program: it accepts a connection within its margin of the old end", async () => {
    const buyer = await buyerWith(1_000_000n);
    const client = createStintClient({
      signer: buyer.signer,
      policy: { maxRate: 10_000n, maxPerSession: 1_000_000n, budget: { amount: 1_000_000n, periodSeconds: 3_600 } },
    });
    // 8 s, and no connection until near its end: under the stack's idle close of 10 s.
    const session = await client.open(stack.stream.url, { seconds: 8 });
    const oldEndMs = session.paidUntil * 1_000;
    // The gate's subscription is not acknowledged when the open answers; the local target's subscription wait covers it.
    await sleep(1_500);

    await direct.topUp({ buyer, session: session.id, seconds: 20 });
    await sleep(Math.max(0, oldEndMs - 1_000 - Date.now()));

    // 1 s before the old end, within the gate's 2 s margin: a gate that has not seen the top-up refuses with 402.
    const socket = await session.connect();
    socket.terminate();
    await session.close();
  }, 60_000);

  it("tops up a session on the program, signed by the buyer, until its paid time runs out: then SessionExpired", async () => {
```

- [ ] **Step 13: Run it to see it fail**

Run: `pnpm --filter @lxfoundry/stint-e2e test direct-chain.test.ts`
Expected: FAIL in the new test only: `The gate refused the connection (HTTP 402)`. The harness gives the gate a chain
without subscriptions, so it still holds the old end.

- [ ] **Step 14: Give the harness's gate a chain that follows accounts**

In `e2e/src/targets/services.ts`, replace

```ts
import type { Rpc, SolanaRpcApi } from "@solana/kit";
```

with

```ts
import { createSolanaRpcSubscriptions, type Rpc, type SolanaRpcApi } from "@solana/kit";
```

and replace

```ts
        chain: createRpcChain(options.rpc),
```

with

```ts
        // The gate follows each session's account over the node's WebSocket (spec §7.3).
        chain: createRpcChain(options.rpc, createSolanaRpcSubscriptions(options.rpcWsUrl)),
```

- [ ] **Step 15: Run every check, and commit**

Run: `pnpm typecheck && pnpm test && pnpm e2e:local`
Expected: PASS, the new end-to-end test included; the report reads `Status: required 9, pending 26 · Result: pass 9,
fail 0, pending 25, not applicable 1`. In scenario 34 the gate now resumes on the account's notification rather than at
its next retry; its checks are the same.

```bash
git add e2e
git commit -m "Give the harness's gate a chain that follows session accounts"
```

---

### Task 8: Upgrade the devnet program and run the required scenarios there

This task is done with the person who holds the keys. It changes no code except the timing and configuration values that
its rules allow: it upgrades the program on devnet to the build of Tasks 1 to 7, checks the bytes, runs the nine
required scenarios on devnet, and records the result.

**Files:**
- Modify: `README.md` (the devnet section: the deployed hash and the scenarios that pass there; `## Status`), and a
  timing or configuration value, if the run measures one that must change

**Interfaces:**
- Consumes: Task 1's program, Tasks 2 to 7's services and scenarios, `scripts/deploy-devnet.sh`,
  `scripts/verify-deployment.sh`, `pnpm e2e:devnet`, and the keys of "Before you start".
- Produces: the upgraded program on devnet, its verified hash, and a devnet run in which every required scenario
  passes.

**Rules for this task.**
- A change to a **timing or a configuration value** (a retry count, a poll interval, a time-out, an amount of SOL, how
  long a scenario waits for something to happen, a scenario's session length on devnet, and in scenario 34
  `TOP_UP_LEAD_MS` and `IN_FLIGHT_MS` within the bounds below) is made here, with a commit that says what it measured. A
  wait may be lengthened only to what devnet was measured to take; what a scenario checks is never changed.
  `GATE_AHEAD_MS` stays 5 s: the specification sets it.
- A change to an **assertion**, a scenario's checks, the gate, the facilitator, the client or the program is not made
  here. If a scenario fails on devnet for a reason that is not timing or configuration, stop and report: the failure is
  a finding about the design. Do not weaken a check to get a green run.
- Never put a key, the seed, or an RPC URL with its API key into a commit, a log that is committed, or a pull request.

- [ ] **Step 1: [Operator] Build the program verifiably**

From the repository root, in WSL, on the stage's branch:

```bash
anchor build --verifiable        # needs Docker; writes target/verifiable/stint.so
```

Expected: `target/verifiable/stint.so` exists. It is larger than the previous build (188,200 bytes) by the size of
`top_up`. The dry run of Step 2 checks its ELF header (SBPF v3).

- [ ] **Step 2: [Operator] Dry-run the upgrade, then upgrade**

```bash
env_value() { grep "^$1=" .env.devnet | cut -d= -f2- | sed 's/[[:space:]]#.*$//' | tr -d "'\"\r"; }
url="$(env_value STINT_DEVNET_RPC_URL)"    # read from the file: typed in, the URL (which may carry an API key) would stay in the shell history
scripts/deploy-devnet.sh --payer ~/.config/stint/devnet.json --upgrade-authority ~/.config/stint/upgrade-authority.json --program target/verifiable/stint.so --url "$url" --dry-run
scripts/deploy-devnet.sh --payer ~/.config/stint/devnet.json --upgrade-authority ~/.config/stint/upgrade-authority.json --program target/verifiable/stint.so --url "$url"
```

The script also reads the program keypair `target/deploy/stint-keypair.json`, the one of the first deployment
(`anchor build --verifiable` does not create it). Expected: the dry run prints the checks and the command it would run,
and sends nothing. The second command upgrades the program in place and extends its data account if the larger build
needs it: it needs the SOL of the buffer (returned) and of any extension (kept). If it ends with `Max retries
exceeded`, the endpoint is too throttled: close the buffer it names with `solana program close <buffer> --url "$url"
--keypair ~/.config/stint/devnet.json --authority ~/.config/stint/upgrade-authority.json` (the buffer's authority is
the upgrade authority) and run it again on a provider URL.

- [ ] **Step 3: Verify the deployed bytes**

```bash
scripts/verify-deployment.sh target/verifiable/stint.so
```

Expected: `devnet program 5iCYPq… is target/verifiable/stint.so (sha256 …, … bytes)`. Keep the line: the hash goes in
the pull request and in the README.

- [ ] **Step 4: [Operator] Run the scenarios on devnet**

```bash
pnpm e2e:devnet
```

Expected: the preflight passes, the report prints, and it reads `Status: required 9, pending 26 · Result: pass 9, fail
0, pending 23, not applicable 3`; the process ends by itself with exit status 0 and no `clean-up problems` on stderr.
The run takes several minutes: scenarios 3, 4, 16, 26 and 34 wait for a paid time to run out, and scenario 9 for grace
periods. It ends with a line `after clean-up, funding key … holds … USDC base units`: the USDC figure must be the one
the run started with, and the lamports must differ by fees only.

If a scenario fails, the report names it and the check, and `e2e/report/kora.log` holds Kora's log (git-ignored; every
URL in it is cut to its host). Diagnose by the symptom:

| Symptom | Likely cause | What to do |
|---|---|---|
| Scenario 4: `the first top-up is more than 12 s before the end` fails, or the first top-up is refused with `402 session_expired` | The open took more than the 18 s that the 30 s session leaves, or devnet's clock lags the facilitator's by that much | Lengthen scenario 4's opening session (its `sessionSeconds(context.target, 20)`) by the measured delay, and record it |
| Scenario 34: `frames flow for 3 s before the gate's end timer fires` fails | The open and the 5 s subscription wait took more than the 30 s session allows before the end timer fires, 5 s early | Lengthen scenario 34's session (its `sessionSeconds(context.target, 15)`) by the measured delay, and record it |
| Scenario 4: the top-up 5 s before the end is not refused | The facilitator's clock and the chain's disagree by more than 5 s | Stop and report: the facilitator decides the margin on its own clock (spec §5.4), and a gap that large is a finding |
| Scenario 34: the on-chain top-up fails with error 6003 (`SessionExpired`) | It landed after `paidUntil`: the confirmation took longer than the 2.5 s lead, or devnet's clock runs ahead of the wall clock | Raise `TOP_UP_LEAD_MS` to the measured time, at most 3,500, so that `IN_FLIGHT_MS` still fits before it. Record the measurement |
| Scenario 34: `the gate stopped forwarding when its end timer fired` fails | A frame forwarded just before the gate stopped arrived more than 1 s later | Raise `IN_FLIGHT_MS` to the measured delay, keeping `GATE_AHEAD_MS - IN_FLIGHT_MS > TOP_UP_LEAD_MS`. If no frame should have been in flight, stop and report: the gate did not stop forwarding |
| Scenario 34: `the gate forwards again after the first paid_until` times out | The gate resumes on the account's notification (Task 7), or, if its subscription failed, at the re-read after its next failed close. Neither saw the top-up before the end timer's next firing, or the payments were too slow to land in the window. The harness does not capture the gate's log, so a `subscription_error` is not visible | Look at the timestamps of the frames and of the top-up's confirmation. If the gate never resumed, stop and report: whether the subscription failed is the first thing to find out, from a run with the gate's `log` set |
| Scenario 3, 4 or 34: `4402` not received within 30 s | Confirmations are slow, or the devnet clock lags the gate's, so the gate's `AtExpiry` close fails with `NotExpired` and is retried | A `4402` later than the 30 s after `paid_until` that the specification allows is a finding about the design: stop and report it. Only the slack that `awaitClose` adds for the chain to confirm (15 s) may be lengthened, to the observed lag |
| Scenario 26 times out | The sweeper did not close the session: its interval (5 s on devnet) and the confirmation outlasted the scenario's wait | Lengthen the scenario's wait by the measured delay; never shorten the check |
| `Cleaning up what earlier runs left failed` at start-up | A session or account was left by a run that ended abnormally, or the provider refuses the listing of the program's accounts | `pnpm e2e:devnet clean`, then run again; set `STINT_DEVNET_SCAN_RPC_URL=https://api.devnet.solana.com` in `.env.devnet` if the listing is refused |

After any change: `pnpm typecheck && pnpm test && pnpm e2e:devnet`.

- [ ] **Step 5: [Operator] Check that nothing is left open, and run once more**

```bash
env_value() { grep "^$1=" .env.devnet | cut -d= -f2- | sed 's/[[:space:]]#.*$//' | tr -d "'\"\r"; }
url="$(env_value STINT_DEVNET_SCAN_RPC_URL)"; url="${url:-$(env_value STINT_DEVNET_RPC_URL)}"
curl -s "$url" -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"getProgramAccounts","params":["5iCYPqLjCWw5KzQTU6NBUhR2hxg5SWGmS1ctUn3qESvr",{"commitment":"confirmed","dataSlice":{"offset":0,"length":0},"filters":[{"dataSize":250}]}]}'
```

Expected: `"result":[]`. If a session is listed, run `pnpm e2e:devnet clean` once and look again. Then run `pnpm
e2e:devnet` a second time: it passes the same way, and the funding key's USDC figure is the same as after the first
run.

- [ ] **Step 6: Record the result**

Three edits in `README.md`; the paragraphs wrap in the file, so match on the words and keep the wrapping:

1. In `## Deploying to devnet`, in the paragraph that begins `On devnet the program is`, replace the size and the hash
   (`188,200 bytes, sha256` and the hexadecimal string after it) with the size and the sha256 that Step 3 printed. Keep
   the rest of the paragraph, which already says that an upgrade changes the hash.
2. In `## Status` (written in Task 6), make two changes. Replace `the Solana program (` with `the Solana program,
   deployed on devnet (`, and remove `; the devnet deployment is of the earlier version, without `top_up`, until it is
   upgraded` (the sentence then reads `… and refunds the rest); the x402 …`). Then replace `pass on a local network,
   seven of them also on devnet, and the run report` with `pass on a local network and on devnet, and the run report`.
3. In `## Running the scenarios on devnet`, change the sentence `Scenarios 1, 2, 3, 9, 16, 22 and 26 pass on devnet.`
   to `Scenarios 1, 2, 3, 4, 9, 16, 22, 26 and 34 pass on devnet.`.

In the pull request's description, record the upgrade, the verified hash, the devnet report and the funding key's
before and after lines.

```bash
git add README.md
git commit -m "Record the upgraded devnet program and the scenarios that pass there"
```

---

## Done when

- `scripts/check-toolchain.sh` passes, and so do `cargo test -p stint`, `pnpm typecheck`, `pnpm test` and `pnpm
  e2e:local`, locally in WSL and in continuous integration. The generated client is current (CI's diff check passes).
- The local report reads `Status: required 9, pending 26 · Result: pass 9, fail 0, pending 25, not applicable 1`:
  scenarios 1, 2, 3, 4, 9, 16, 22, 26 and 34 are `required` and pass.
- The program tests cover `top_up` as spec section 12.1 lists it (every signer, account substitution, refused after
  expiry, funding by a preceding transfer), and the four properties of that section hold as property tests over
  sequences of claims and top-ups, with two more: a top-up lands only before the end, and the deposit never buys more
  than `max_seconds`.
- A buyer tops up through the gate with `session.topUp` or `stint_top_up`; the gate moves its end timer; a top-up within
  10 s of the end, or after it, is refused and costs nothing; a top-up that lands on-chain while the gate is closing at
  expiry makes the gate resume.
- The gate follows each session's account: a top-up it did not settle moves its end timer at once (the end-to-end test
  of Task 7 connects within the margin of the old end), and a subscription that fails leaves the end timer's re-read as
  the fallback.
- The upgraded program is on devnet, `scripts/verify-deployment.sh` confirms its bytes, and `pnpm e2e:devnet` passes
  the nine required scenarios twice in a row and leaves no session open.
- The pull request's description records the verified executable hash, the devnet report, and any deviation from this
  plan.

## Spec edits made by this stage

Each is made in the task that needs it, and states a fact the code relies on:
- §5.3: a top-up's payload, `{ type: "topUp", transaction }`, and where its session is named (Task 2);
- §5.4: the `topUp` checks: the facilitator's clock decides the 10 s margin, the funding comes from the refund
  owner's account, `invalid_amount` past `maxSeconds`, no place for the rent payer; and `session_expired` within
  10 s of the end (Task 3);
- §7.1: the top-up route's answers, `404` and the `session_expired` refusal among them (Task 4);
- §12.2 (stack control): the harness can start the gate with its session clock ahead (Task 6).

Not edited, on purpose: §7.3's handling of an account closed by another party and its subscription that lasts until the
session ends, §7.1's subscription after a `202` to an open, and §12.2's isolation groups. The spec describes the system
as it is meant to be. This stage's gate acts on a later end only, leaves a closed account to its end timer, does not
replace a subscription that fails, and scenario 34 runs on the common stack: the deviations recorded under "What this
stage builds, and what it leaves for later".
