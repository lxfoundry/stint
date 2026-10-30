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
