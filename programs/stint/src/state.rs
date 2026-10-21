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
