//! The arithmetic of spec section 4.2. Every product goes through `u128`, so no intermediate
//! overflows; a result that does not fit its type fails with `MathOverflow`.

use anchor_lang::prelude::*;

use crate::errors::StintError;
use crate::state::Session;

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

/// `min(deposited, rate × elapsed)`: everything the receiver has earned so far, and the most that claims have paid in
/// total. It never includes the minimum charge, and it stops at the deposit.
pub fn earned(deposited: u64, rate: u64, elapsed: u64) -> u64 {
    capped(deposited, rate, elapsed)
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
    capped(deposited, rate, charged)
}

/// `min(deposited, rate × seconds)` through `u128`: the shape of both `earned` and `due`.
fn capped(deposited: u64, rate: u64, seconds: u64) -> u64 {
    let amount = u128::from(rate) * u128::from(seconds);
    // The minimum with a u64 always fits in a u64.
    u64::try_from(amount.min(u128::from(deposited))).unwrap_or(deposited)
}

/// `max(claimed, due) - claimed`: what a close still pays the receiver.
pub fn owed(claimed: u64, due: u64) -> u64 {
    claimed.max(due) - claimed
}

/// Whether a close sends the residual to the receiver: from `paid_until` on (`now >= paid_until`),
/// when there is a residual and the refund account no longer exists.
pub fn redirects(residual: u64, now: i64, paid_until: i64, refund_account_gone: bool) -> bool {
    residual > 0 && now >= paid_until && refund_account_gone
}

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
pub fn cost(rate: u64, seconds: u32) -> u128 {
    u128::from(rate) * u128::from(seconds)
}

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

    #[test]
    fn redirects_only_from_paid_until_with_a_residual_and_a_missing_refund_account() {
        assert!(redirects(1, 1_030, 1_030, true));
        assert!(redirects(1, 5_000, 1_030, true));
        // One second early, no residual, or an account that exists: the refund is paid as before.
        assert!(!redirects(1, 1_029, 1_030, true));
        assert!(!redirects(0, 1_030, 1_030, true));
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
