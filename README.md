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
