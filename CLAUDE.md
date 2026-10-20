# CLAUDE.md — stint

Stint is an open-source payment layer that lets AI agents **rent time on long-lived connections,
and get back what they don't use**. The connection can be a real-time data stream over WebSocket,
and by design any connection that stays open for minutes or hours, such as a remote browser.
- An agent requests access and receives an HTTP 402 response, following the x402 protocol.
- It pays once, in USDC on Solana, to open a time-boxed session. The payment is held by an on-chain
  program, which releases it to the seller by elapsed time.
- Closing early refunds the unused remainder on-chain. At expiry, the connection closes.

It is for developers who sell real-time data or long-lived services to agents, and for developers
who build those agents.

## Architecture (implementation-relevant facts)

The specs in `docs/specs/` are the reference once written. These facts are settled:

- **x402 scheme `elapsed`:** the amount is set by elapsed time.
  - The instruction that opens the session travels inside the x402 payment transaction, so paying
    and opening succeed or fail together.
  - The facilitator is self-hosted. **Kora** co-signs as fee payer, with a policy that allows only
    the programs the scheme needs. The agent holds only USDC.
- **On-chain program:** holds each session's escrow.
  - Release is by the clock, from open until close or expiry, whether or not the buyer is
    connected. Releasing funds needs no buyer signature after open.
  - On close, the remainder is refunded to the account the funds came from, which is recorded at
    open and not assumed to be the signer.
  - It accepts any token transfer into the session vault in the same transaction as the open,
    whoever authorised it.
- **Seller-side gate:** it does not depend on the resource.
  - It checks the session credential when a WebSocket connection opens, and closes the connection
    at expiry or cancel.
  - It never reads what flows through.
  - It learns of a cancel by subscribing to the session account.
- **Resource adapters:** provision at open, teardown at close or expiry. The data stream needs no
  provisioning; a remote browser would be started and stopped.
- **Session credential:** accepted in the connection URL as well as in a header, because some
  clients can only pass a bare URL.
- **Terms are set per resource:** price per unit of time, minimum and maximum duration.
- **Agent tools are split:** session tools (open, top up, status, close) and resource tools.
- **Optional funding from an allowance:** a recurring delegation on the Solana Foundation's
  Subscriptions & Allowances program (`De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44`).
  - The agent, as delegatee, pulls into the session vault in the same transaction as the open.
  - Without it, the agent pays from its own USDC.
- **Network and token:** devnet first. USDC on devnet is mint
  `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` (classic SPL Token, 6 decimals).

## Layout

- `.claude/`: vendored skills, the SessionStart hook, settings.
- `docs/specs/`: specs.
- `docs/plans/`: implementation plans.

Code layout: section 3.3 of `docs/specs/stint-system.md`.

## Toolchain

Named in section 3.5 of `docs/specs/stint-system.md`: Anchor, Codama clients for `@solana/kit`,
TypeScript on Node.js, LiteSVM and Surfpool, version 0 transactions. Exact versions, the package
manager, the test runner and the build, test and run commands are pinned by the implementation
plan, and recorded here once set. On Windows, everything runs inside WSL 2 (the Solana and Anchor
toolchains require it).

## Rules

1. **Self-contained repo.** All code, comments, commit messages and docs must make sense with only
   this repository checked out. Never reference files, paths or documents outside it.
2. **No secrets, ever, in any commit.** API keys, wallet mnemonics, private keys and keypair files
   live in `.env` or outside the repo (gitignored); commit `.env.example` with empty values.
   On-chain addresses are fine.
3. **Commit messages are neutral, technical and present tense** ("verify the payment before
   serving the resource"). Never framed around an audience, an event, a deadline or a pitch.
4. **Testnet or devnet first.** No mainnet transaction from code that has not passed the test
   circuit. Mainnet configuration changes get their own commit.
5. **Public-facing docs (README, API reference, specs) describe what the system does** — never
   event, campaign or competition tactics, and never a schedule.
6. **Work on a branch** (`<type>/<short-slug>`), never on a detached HEAD.
7. **Captured fixtures are scrubbed at capture time** of personal data. This repository is
   publishable at any moment, and nobody re-reads a committed JSON file.
8. **Done means integrated.** A behaviour that crosses components is done when the end-to-end
   scenarios covering it pass on the `local` target (section 12 of
   `docs/specs/stint-system.md`), not when its unit tests pass.
   - Write the scenario first, as `pending`.
   - Make it `required` in the change where it first passes.
   - A required scenario never goes back to `pending`.

## Skills

`.claude/skills/` holds vendored, general-purpose public skill libraries; provenance, pinned
commits and licences are in [`.claude/skills/VENDORED.md`](.claude/skills/VENDORED.md). Do not add
project-specific content there. No git worktrees: skills that used to create one create a dedicated
branch instead. Plans are written to `docs/plans/`, specs to `docs/specs/` (overriding the upstream
`docs/superpowers/…` defaults).

- **Solana.** `.claude/skills/solana-dev/` is the Solana Foundation's official skill (see
  `VENDORED.md`).
  - The Solana docs MCP is configured in `.mcp.json` as `solana-mcp-server`. **Never
    `claude mcp add` it:** the skill's auto-install would otherwise add a duplicate.
  - `program_autofixer` sends the code it is given to a third-party server. Use it only on program
    code from this repository, never on secrets or `.env` content.
