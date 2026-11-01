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
