<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="brand/readme-header-dark.svg">
    <img src="brand/readme-header.svg" alt="Stint: rent time on live connections, get the rest back" width="100%">
  </picture>
</p>

Stint is an open-source payment layer that lets AI agents rent time on long-lived connections, and
get back what they don't use:
1. An agent pays once over [x402](https://www.x402.org) to open a time-boxed session.
2. A Solana program releases the payment to the seller as time elapses.
3. If the agent closes the session early, the unused remainder is refunded on-chain.

Brand assets and usage rules: [`brand/`](brand/README.md).

## Development

The toolchain is pinned in `CLAUDE.md` (section "Toolchain") and checked by
`scripts/check-toolchain.sh`. On Windows, work inside WSL 2.

    anchor build                              # build the program
    cargo test -p stint                       # program unit tests
    pnpm install
    pnpm generate:client                      # regenerate the program client after an interface change
    scripts/fetch-subscriptions-program.sh    # fetch and check the Subscriptions program copy, once
    pnpm test                                 # unit and integration tests
    pnpm e2e:local                            # end-to-end scenarios on the local target

The end-to-end report is written to `e2e/report/report.md`.

## MCP server

`@lxfoundry/stint-mcp` serves the session tools over MCP, on stdio, for any MCP host. It is configured
by environment variables, and refuses to start without the caps:

| Variable | Meaning |
|---|---|
| `STINT_KEYPAIR_PATH` | The absolute path of a Solana CLI keypair file, a JSON array of 64 bytes (`~` is not expanded). Required |
| `STINT_MAX_RATE` | The highest rate accepted, in base units per second. Required |
| `STINT_MAX_PER_SESSION` | The most one session may lock, in base units. Required |
| `STINT_BUDGET_AMOUNT`, `STINT_BUDGET_PERIOD_SECONDS` | The most locked across sessions per period. Required |
| `STINT_MAX_MIN_SECONDS` | The highest minimum charge accepted. Default 300 |
| `STINT_SELLERS`, `STINT_PROGRAMS`, `STINT_NETWORKS`, `STINT_ASSETS` | Optional allowlists, comma-separated (`mint:decimals` for assets) |

Every limit is enforced by the client's code, whatever a seller offers or the model asks. The agent's
key holds USDC and no SOL. When the host disconnects, or the process is stopped, every session still
open (and any open still in flight) is closed first, so the unused part of each deposit comes back.

Register it with an MCP host as a command, from the repository root. For Claude Code:

    claude mcp add stint \
      --env STINT_KEYPAIR_PATH=$HOME/.config/stint/agent.json --env STINT_MAX_RATE=5000 \
      --env STINT_MAX_PER_SESSION=600000 --env STINT_BUDGET_AMOUNT=2000000 --env STINT_BUDGET_PERIOD_SECONDS=3600 \
      -- "$PWD/node_modules/.bin/tsx" "$PWD/packages/mcp/src/cli.ts"

stdout carries the protocol, so the entry point writes nothing else to it. Run the host inside WSL on
Windows, where the toolchain lives.
