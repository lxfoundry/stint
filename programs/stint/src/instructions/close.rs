use anchor_lang::prelude::*;
use anchor_spl::associated_token::get_associated_token_address;
use anchor_spl::token::{self, CloseAccount, Token, TokenAccount, Transfer};

use crate::errors::StintError;
use crate::events::{CloseKind, Closed};
use crate::maths;
use crate::state::{Session, SESSION_SEED};

/// Closes a session (spec section 4.3): pays what is owed, refunds the rest, and returns the rent.
#[event_cpi]
#[derive(Accounts)]
pub struct Close<'info> {
    pub closer: Signer<'info>,

    #[account(mut, close = rent_payer)]
    pub session: Account<'info, Session>,

    #[account(
        mut,
        address = get_associated_token_address(&session.key(), &session.mint) @ StintError::AccountMismatch,
    )]
    pub vault: Account<'info, TokenAccount>,

    /// CHECK: the receiver's associated token account. Unchecked so that a closed account arrives as
    /// a System-owned one (S12); SPL Token validates it whenever a non-zero amount moves.
    #[account(
        mut,
        address = get_associated_token_address(&session.receiver, &session.mint) @ StintError::AccountMismatch,
    )]
    pub receiver_token: UncheckedAccount<'info>,

    /// CHECK: the refund owner's associated token account; unchecked for the same reason.
    #[account(
        mut,
        address = get_associated_token_address(&session.refund_owner, &session.mint) @ StintError::AccountMismatch,
    )]
    pub refund_to: UncheckedAccount<'info>,

    /// CHECK: receives the rent deposits; must be the stored rent payer.
    #[account(mut, address = session.rent_payer @ StintError::AccountMismatch)]
    pub rent_payer: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
}

pub fn close_handler(ctx: Context<Close>, kind: CloseKind) -> Result<()> {
    // Only `Standard` is supported so far; the other kinds are refused rather than guessed at.
    require!(kind == CloseKind::Standard, StintError::InvalidTerms);

    let now = Clock::get()?.unix_timestamp;
    let session = &ctx.accounts.session;
    let paid_until = maths::paid_until(session.started_at, session.deposited, session.rate)?;
    let closer = ctx.accounts.closer.key();
    if now < paid_until {
        require!(
            closer == session.authority || closer == session.receiver_authorizer,
            StintError::Unauthorized
        );
    }

    let elapsed = maths::elapsed(session.started_at, paid_until, now);
    let charged = maths::charged(session.min_seconds, elapsed, false);
    let due = maths::due(session.deposited, session.rate, charged);
    let owed = maths::owed(session.claimed, due);
    let refunded = ctx
        .accounts
        .vault
        .amount
        .checked_sub(owed)
        .ok_or_else(|| error!(StintError::MathOverflow))?;

    let authority = session.authority;
    let seed = session.seed.to_le_bytes();
    let bump = [session.bump];
    let signer_seeds: &[&[&[u8]]] = &[&[SESSION_SEED, authority.as_ref(), &seed, &bump]];
    let token_program = ctx.accounts.token_program.key();

    // A transfer of zero is skipped: its destination need not exist (spec section 4.3).
    //
    // Limit: a missing `refund_to` or `receiver_token` fails the close whenever an amount is owed to
    // it. Spec section 4.3 redirects a residual owed to a closed refund account to the receiver once
    // `paid_until` has passed; that is not implemented yet, so until it is, the refund account's owner
    // can keep a session open by closing that account and sending the vault one base unit.
    for (amount, destination) in [
        (owed, ctx.accounts.receiver_token.to_account_info()),
        (refunded, ctx.accounts.refund_to.to_account_info()),
    ] {
        if amount > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    token_program,
                    Transfer {
                        from: ctx.accounts.vault.to_account_info(),
                        to: destination,
                        authority: ctx.accounts.session.to_account_info(),
                    },
                    signer_seeds,
                ),
                amount,
            )?;
        }
    }

    token::close_account(CpiContext::new_with_signer(
        token_program,
        CloseAccount {
            account: ctx.accounts.vault.to_account_info(),
            destination: ctx.accounts.rent_payer.to_account_info(),
            authority: ctx.accounts.session.to_account_info(),
        },
        signer_seeds,
    ))?;

    let claimed = ctx.accounts.session.claimed;
    emit_cpi!(Closed {
        session: ctx.accounts.session.key(),
        kind,
        claimed,
        owed,
        refunded,
        redirected: 0,
        closed_by: closer,
        paid_until,
        at: now,
    });
    Ok(())
}
