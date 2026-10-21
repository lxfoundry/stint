use anchor_lang::prelude::*;

pub mod errors;
pub mod events;
pub mod instructions;
pub mod maths;
pub mod state;

use instructions::*;

declare_id!("5iCYPqLjCWw5KzQTU6NBUhR2hxg5SWGmS1ctUn3qESvr");

#[program]
pub mod stint {
    use super::*;

    pub fn open(ctx: Context<Open>, seed: u64, rate: u64, min_seconds: u32, max_seconds: u32) -> Result<()> {
        instructions::open::open_handler(ctx, seed, rate, min_seconds, max_seconds)
    }
}
