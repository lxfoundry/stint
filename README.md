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
4. An owner can fund the agent's sessions from an allowance of the Solana Foundation's Subscriptions & Allowances
   program: a budget per period, enforced on-chain, which the agent cannot raise.

**Try it:** the [live demo](docs/live-demo.md) runs a session in Claude Desktop against a seller on devnet, with nothing
to build: download the extension, fund the agent's wallet with test USDC, and rent time on a live stream.

## What Stint provides

| Part | Where | What it does |
|---|---|---|
| The Solana program | [`programs/stint`](programs/stint) | Holds each session's deposit in a vault of its own and settles it by the chain's clock: `open`, `top_up`, `claim`, `close`. Deployed on devnet, built verifiably |
| The `elapsed` x402 scheme | [`@lxfoundry/stint-x402`](packages/x402) | The offer (a price per second, the time bought, a minimum, a maximum), the payment transaction, its checks, and the session token |
| The facilitator | [`@lxfoundry/stint-facilitator`](apps/facilitator) | Checks each payment against its offer before anything is signed, settles it through Kora, which pays the fees, keeps a record of each settlement, closes expired sessions, and closes a session for a buyer with no SOL |
| The gate | [`@lxfoundry/stint-gate`](packages/gate) | Middleware in front of a long-lived connection: sells sessions, checks each one on Solana, and ends the connection when the paid time ends |
| The client | [`@lxfoundry/stint-client`](packages/client) | Opens, tops up and closes sessions, with spending limits enforced in code, whatever a seller offers or a model asks |
| The MCP server | [`@lxfoundry/stint-mcp`](packages/mcp) | Gives any MCP host the session tools |
| Allowance funding | [Allowance funding](#allowance-funding) | An owner grants an agent a budget per period with the Subscriptions & Allowances program. Each open and top-up is pulled from it, refunds go back to the owner, and past the period's cap the program refuses the pull |
| The program's client | [`@lxfoundry/stint-program-client`](packages/program-client) | Generated from the program's interface with Codama, on `@solana/kit` |
| Examples | [`examples/`](examples) | A seller deployment, a session in Claude Desktop, an agent, and the stream it sells |

All of it is MIT licensed. The packages are workspace packages of this repository; none is published to a registry.

Brand assets and usage rules: [`brand/`](brand/README.md).

## Status

Work in progress. Working today: the Solana program, deployed on devnet (`open`, `top_up`, `claim`, and `close`,
which pays the seller for the time used, or for the whole paid time once it has run out, and refunds the rest); the
x402 `elapsed` scheme; the facilitator with its sweeper and its sponsored close (a buyer with no SOL closes its
session through the facilitator when the gate cannot), the gate with its timers, the client library, which falls back
on the facilitator's sponsored close, then on a close of its own when it has a node and SOL, an MCP server and an
example agent.
A session ends by itself: the gate drops its connection with `4402` when the paid time runs out, closes a session
that nobody connects to, and for a session that another party closed, stops forwarding at once and drops its
connections once it has looked the close up (within about 2 s); the sweeper closes an expired session that nobody
closed, if it names the facilitator's own rent payer. A buyer can top up a session before its paid time runs out,
which moves its end; a session whose paid time has run out cannot be extended. The facilitator refuses a payment that
does not match its offer with its reason before anything is signed, and keeps a record of each settlement, so that a
payment sent twice is settled once and answered twice. Twenty-one of the 35 end-to-end scenarios of the
[specification](docs/specs/stint-system.md) (section 12.7) pass on a local network and on devnet, and the run report
lists the other 14 as pending. Not built yet: a store for settlement records that survives a restart of the
facilitator (it keeps them in memory), the gate's watch of a payment whose settlement is pending, the facilitator's
rate limits, and resilience across restarts.
The [plans](docs/plans/README.md) list the stages that remain.

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
    pnpm e2e:devnet                           # the same scenarios on devnet (needs .env.devnet and a deployed program)
    pnpm e2e:devnet funds                     # the address to fund for it, and what that address holds
    pnpm e2e:devnet clean                     # the clean-up alone

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
open (and any open still in flight) is closed first, so the unused part of each deposit comes back. The server
waits at most 90 s for that, and then exits with an error.

Register it with an MCP host as a command, from the repository root. For Claude Code:

    claude mcp add stint \
      --env STINT_KEYPAIR_PATH=$HOME/.config/stint/agent.json --env STINT_MAX_RATE=5000 \
      --env STINT_MAX_PER_SESSION=600000 --env STINT_BUDGET_AMOUNT=2000000 --env STINT_BUDGET_PERIOD_SECONDS=3600 \
      -- "$PWD/node_modules/.bin/tsx" "$PWD/packages/mcp/src/cli.ts"

stdout carries the protocol, so the entry point writes nothing else to it. Run the host inside WSL on
Windows, where the toolchain lives.

## Example agent

`examples/agent` gives the session tools to a Claude model through the Anthropic SDK's tool runner, at low
effort, with server-side fallback, and lets it watch a token account on the example stream until a
payment arrives. It takes the same `STINT_*` variables as the MCP server, plus `ANTHROPIC_API_KEY`,
`STINT_GATE_URL` and `STINT_WATCH_ACCOUNT`:

    pnpm e2e:serve:devnet    # starts a stack on devnet, prints the gate's URL and a watched account, pays it every 30 s
    pnpm --filter @lxfoundry/stint-example-agent start

`serve` prints `gateUrl` and `watchedAccount`: copy them into `STINT_GATE_URL` and `STINT_WATCH_ACCOUNT`. The
agent stops once it has worked out the last payment from two consecutive messages about the account.

`STINT_KEYPAIR_PATH` names a keypair file made for the agent that holds devnet USDC and nothing else: do not
point it at the key that deploys the program or at the harness's funding key. Every spending limit is enforced by the client's policy in code. The stream's messages reach the model as
data and cannot raise one. Every session is closed before the agent returns, whatever happened.

## Examples: a seller deployment, and a session in Claude Desktop

[`examples/seller`](examples/seller/README.md) runs Kora, the facilitator with its sweeper and the example stream with
its gate in one process, deployable on Fly.io as one always-on machine that sells the stream on devnet.
[`examples/claude-demo`](examples/claude-demo/README.md) is an MCP server whose panel shows a Stint session in Claude
Desktop: the agent's wallet, the x402 exchange, the paid time draining, a top-up, and an early close with its refund.
The [live demo guide](docs/live-demo.md) installs it from the latest release, against the hosted seller at
`https://stint-demo.lxfoundry.ai`, whose page at `/` describes the offer.

## Deploying to devnet

The program is upgradeable on devnet and built verifiably. Both scripts refuse any cluster whose
genesis hash is not devnet's: the Solana CLI's own default is mainnet.

    anchor build --verifiable                  # needs Docker; writes target/verifiable/stint.so
    scripts/deploy-devnet.sh --payer ~/.config/stint/devnet.json --upgrade-authority ~/.config/stint/upgrade-authority.json --program target/verifiable/stint.so --dry-run
    scripts/deploy-devnet.sh --payer ~/.config/stint/devnet.json --upgrade-authority ~/.config/stint/upgrade-authority.json --program target/verifiable/stint.so
    scripts/verify-deployment.sh target/verifiable/stint.so

The payer needs about 1.8 SOL plus fees while the deploy runs, and the script asks for 2.2 (about 0.9 SOL
stays in the program's data account; the buffer's share returns). Run the same command again to upgrade: `solana program deploy`
upgrades in place, and extends the program's data account when the new build is larger. The upgrade
authority is the payer unless `--upgrade-authority` names another key; keep it a key of its own, apart
from the payer, which holds the SOL. Before any
mainnet deployment it must move to a multisig or be revoked.

The program's ID is in `Anchor.toml`; its keypair is `target/deploy/stint-keypair.json` and is never
committed. Back it up.

On devnet the program is `5iCYPqLjCWw5KzQTU6NBUhR2hxg5SWGmS1ctUn3qESvr`, its upgrade authority is
`3DjL1cy8rLGXbNrHRDHUrUk1RuEsxSLGybL6kMY1oWgZ`, and `scripts/verify-deployment.sh` confirmed that its bytes are
`target/verifiable/stint.so` as `anchor build --verifiable` built it: 197,624 bytes, sha256
`0412176d9fae34018d7284995aced3c1e502780a22f026ebd1dcbae7b6d38c0a`. An upgrade changes the hash.
## Running the scenarios on devnet

`pnpm e2e:devnet` runs the end-to-end scenarios against devnet, with the program deployed by
`scripts/deploy-devnet.sh`. It is run on demand, never as a merge gate: the public network is shared and
rate-limited. Create `.env.devnet` (git-ignored; `.env.example` lists the names) with:

- `STINT_DEVNET_RPC_URL`: a devnet endpoint (and `STINT_DEVNET_WS_URL` if its WebSocket URL is not the
  same address with `ws` for `http`);
- `STINT_DEVNET_SCAN_RPC_URL`, optional: the endpoint that lists the program's accounts, which is how the
  clean-up finds open sessions. Some providers' free tiers refuse that method (Alchemy's does: the run's
  start-up fails with `HTTP error (400)`); set this to another endpoint that answers it, such as
  `https://api.devnet.solana.com`. It is asked for devnet's genesis hash at preflight, for the clean-up's
  listings (at the start and at the end of a run) and by the facilitator's sweeper, every 5 s while a run
  lasts, and the rest goes to `STINT_DEVNET_RPC_URL`;
- `STINT_DEVNET_SEED`: a recovery phrase of 12 to 24 words in quotes, or 64 hexadecimal characters
  (`openssl rand -hex 32`). Every key of the target derives from it, by the harness's own rule, so the
  addresses are not the ones a wallet shows for the same phrase. Use a phrase made for this, never one
  that holds funds elsewhere, and keep a copy off this machine.

`pnpm e2e:devnet funds` prints the funding key's address and balances, then `✓ Funded` when it holds enough
for a run, or what it still needs. Fund that address once, with at
least 0.5 SOL from a devnet faucet and 5 USDC from Circle's (Solana Devnet). It is the only key to
watch: it plays no part in any scenario, and the fees that runs spend are the only thing that does not
come back to it.

Scenarios 1, 2, 3, 4, 5, 6, 7, 9, 13, 14, 15, 16, 17, 18, 19, 22, 24, 25, 26, 32 and 34 pass on devnet.

A run checks that the endpoint is devnet and that the program is deployed, then cleans up: it closes
every session that the seed's keys have open and returns what they hold to the funding key. On a first
run there is nothing to do; after a run that was killed it repairs what that run left. Then it funds the
keys it needs from the funding key, runs the scenarios, and cleans up again. `pnpm e2e:devnet clean`
does the clean-up alone. Run one at a time per seed: the clean-up closes every session that the seed's
keys have open, whichever run opened it. A session that an outside key opened, naming the seed's seller
as its receiver, is reported and left alone. If the start-up clean-up fails, the run does not start; `pnpm e2e:devnet --force` goes
on regardless. The report is written to `e2e/report/`. Kora is started with the RPC
URL on its command line, so a URL that carries an API key is visible to other users of the machine (`ps`).
Its log, which a failed run writes to `e2e/report/kora.log` (git-ignored), has every URL cut to its scheme and host.

## Licence

[MIT](LICENSE). The third-party skills vendored under `.claude/skills` keep their own licences, listed in
`.claude/skills/VENDORED.md`.
