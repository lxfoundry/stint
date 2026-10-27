use anchor_lang::prelude::*;
use anchor_spl::associated_token::get_associated_token_address;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::errors::StintError;
use crate::events::Opened;
use crate::maths;
use crate::state::{Session, SESSION_SEED, SESSION_VERSION};

/// Opens a session (spec section 4.3). The vault is funded by an earlier instruction of the same
/// transaction; `open` credits what the vault holds.
#[event_cpi]
#[derive(Accounts)]
#[instruction(seed: u64)]
pub struct Open<'info> {
    pub authority: Signer<'info>,

    #[account(mut)]
    pub rent_payer: Signer<'info>,

    /// `init`, never `init_if_needed`: an open at the address of a live session fails (S12).
    #[account(
        init,
        payer = rent_payer,
        space = Session::SIZE,
        seeds = [SESSION_SEED, authority.key().as_ref(), &seed.to_le_bytes()],
        bump,
    )]
    pub session: Account<'info, Session>,

    pub mint: Account<'info, Mint>,

    /// Exactly the associated token account of the session for the mint (S6, S7).
    #[account(
        address = get_associated_token_address(&session.key(), &mint.key()) @ StintError::AccountMismatch,
    )]
    pub vault: Account<'info, TokenAccount>,

    /// CHECK: the seller's wallet, stored as the payout owner. Payouts go to its associated token
    /// account, which `close` derives and checks.
    pub receiver: UncheckedAccount<'info>,

    /// CHECK: the seller's gate key, stored. It signs closes; it never receives funds.
    pub receiver_authorizer: UncheckedAccount<'info>,

    /// CHECK: the wallet whose associated token account receives refunds, stored.
    pub refund_owner: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn open_handler(
    ctx: Context<Open>,
    seed: u64,
    rate: u64,
    min_seconds: u32,
    max_seconds: u32,
) -> Result<()> {
    require!(rate > 0, StintError::InvalidTerms);
    require!(min_seconds > 0 && min_seconds <= max_seconds, StintError::InvalidTerms);

    let session_key = ctx.accounts.session.key();
    // A payout account equal to the vault could never be emptied, so the vault could never close.
    require_keys_neq!(ctx.accounts.receiver.key(), session_key, StintError::InvalidTerms);
    require_keys_neq!(ctx.accounts.refund_owner.key(), session_key, StintError::InvalidTerms);

    let deposited = ctx.accounts.vault.amount;
    require!(
        u128::from(deposited) >= maths::cost(rate, min_seconds),
        StintError::DepositTooSmall
    );
    require!(
        u128::from(deposited) <= maths::cost(rate, max_seconds),
        StintError::DepositTooLarge
    );

    let started_at = Clock::get()?.unix_timestamp;
    let paid_until = maths::paid_until(started_at, deposited, rate)?;
    let authority = ctx.accounts.authority.key();

    ctx.accounts.session.set_inner(Session {
        version: SESSION_VERSION,
        bump: ctx.bumps.session,
        authority,
        seed,
        mint: ctx.accounts.mint.key(),
        receiver: ctx.accounts.receiver.key(),
        receiver_authorizer: ctx.accounts.receiver_authorizer.key(),
        refund_owner: ctx.accounts.refund_owner.key(),
        rent_payer: ctx.accounts.rent_payer.key(),
        rate,
        min_seconds,
        max_seconds,
        started_at,
        deposited,
        claimed: 0,
    });

    emit_cpi!(Opened {
        session: session_key,
        authority,
        rate,
        min_seconds,
        max_seconds,
        deposited,
        started_at,
        paid_until,
    });
    Ok(())
}
