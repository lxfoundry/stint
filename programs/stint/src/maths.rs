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

/// Whether a close sends the residual to the receiver: from `paid_until` on (`now >= paid_until`),
/// when there is a residual and the refund account no longer exists.
pub fn redirects(residual: u64, now: i64, paid_until: i64, refund_account_gone: bool) -> bool {
    residual > 0 && now >= paid_until && refund_account_gone
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

    #[test]
    fn redirects_only_from_paid_until_with_a_residual_and_a_missing_refund_account() {
        assert!(redirects(1, 1_030, 1_030, true));
        assert!(redirects(1, 5_000, 1_030, true));
        // One second early, no residual, or an account that exists: the refund is paid as before.
        assert!(!redirects(1, 1_029, 1_030, true));
        assert!(!redirects(0, 1_030, 1_030, true));
        assert!(!redirects(1, 1_030, 1_030, false));
    }
}
