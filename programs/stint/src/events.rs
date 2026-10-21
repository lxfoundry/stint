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
