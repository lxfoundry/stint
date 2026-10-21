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
