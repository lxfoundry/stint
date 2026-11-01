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

/// `rate × seconds`, for the deposit bounds of `open`.
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
