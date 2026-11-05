# Optional: an agent funded by an allowance

In the [live demo](live-demo.md), the agent pays from its own wallet. Here an owner funds it instead. The owner grants
the agent's key an **allowance** on the Solana Foundation's Subscriptions & Allowances program: an amount per period,
which the program enforces on-chain. Each open and top-up is then pulled from the owner's USDC account, in the same
transaction as the open or the top-up. An early close refunds the owner, and a payment past the period's cap is
refused. From start to end, the agent's key holds no USDC and no SOL.

It runs against the same seller, [`stint-demo.lxfoundry.ai`](https://stint-demo.lxfoundry.ai), on Solana devnet: test
USDC, no real money. Unlike the live demo, the owner needs a terminal and the repository, to grant the allowance. The
agent runs either in Claude Desktop, with the allowance extension (step 5), or in Claude Code, with the repository's MCP
server (steps 5b to 8). It takes about 20 minutes, most of them setting up.

| Step | Who | What happens on-chain |
|---|---|---|
| Grant | the owner | a delegation of 0.300 USDC per hour, for one day |
| Open, 200 s | the agent | 0.200 USDC pulled from the owner into the session's vault |
| Top up, 100 s | the agent | 0.100 USDC more pulled: the hour's cap is used up |
| Close early | the agent | the seller is paid for the time used, and the rest goes back to the owner. The cap stays used |
| Open again | the agent | refused: the allowance for this period is used up |

The table and the sample outputs below are from the Claude Code route (steps 5b to 8): it was checked with Claude Code
2.1.318 in WSL 2 (Ubuntu 24.04) on Windows 11. With the extension (step 5), the panel suggests a grant of 0.200 USDC per
hour, and each open and top-up is 0.100 USDC.

## What you need

For the owner, on both routes:

- **Linux or macOS, or WSL 2 on Windows.** On Windows, run every terminal command below inside WSL.
- **git, Node.js 24.22.0 and pnpm 12.14.0**, the versions the repository pins (`.nvmrc`, and `engines` and
  `packageManager` in `package.json`). `pnpm install` stops on any other Node.js version. With nvm, `nvm install` in the
  repository's folder installs the pinned one.
- **The Solana CLI** (Agave), which includes `solana-keygen` and `spl-token`:
  [Install the Solana CLI](https://docs.anza.xyz/cli/install).
- A browser, for the faucets and devnet's Explorer.

For the agent, on one route:

- **The extension route (step 5):** Claude Desktop, on Windows or macOS.
- **The Claude Code route (steps 5b to 8):** Claude Code, installed in the same environment as the commands above
  (inside WSL on Windows): [set up Claude Code](https://code.claude.com/docs/en/setup).

What it costs, all on devnet: the owner needs less than 0.004 SOL for the grant (the rent of two accounts and the fee;
the rent comes back at the revoke) and at least 0.300 USDC. The agent needs nothing.

## 1. Get the code

    git clone https://github.com/lxfoundry/stint.git
    cd stint
    pnpm install

Run every later command from this folder.

## 2. Make two keys

The **owner** holds the budget; the **agent** is the key that the session tools sign with. Make both new, for this
alone: the allowance takes the owner's USDC account's one delegate slot, and until the allowance is revoked or expires,
the agent's key can pull up to the cap into any USDC account.

**Extension route (step 5):** make the owner's key only: leave out the `allowance-agent.json` line and the `AGENT=` line
below. The extension makes the agent's key, and its panel shows the address in step 5. In step 3, skip the agent's
check. In step 4, run only the `export` line: the panel gives the grant command there, with the agent's address in it.

    mkdir -p "$HOME/.config/stint"
    solana-keygen new --no-bip39-passphrase -o "$HOME/.config/stint/allowance-owner.json"
    solana-keygen new --no-bip39-passphrase -o "$HOME/.config/stint/allowance-agent.json"

Then keep their addresses, and the owner's USDC account, in the shell:

    OWNER=$(solana-keygen pubkey "$HOME/.config/stint/allowance-owner.json")
    AGENT=$(solana-keygen pubkey "$HOME/.config/stint/allowance-agent.json")
    USDC=4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU
    OWNER_USDC=$(spl-token address --token "$USDC" --owner "$OWNER" --verbose -u devnet | sed -n 's/^Associated token address: //p')
    echo "owner $OWNER, its USDC account $OWNER_USDC, agent $AGENT"

`USDC` is Circle's devnet USDC mint. The later steps use these four variables: in a new terminal, run the four lines
again. On the extension route, `AGENT` stays empty until step 5 sets it from the panel's address.

## 3. Fund the owner, not the agent

1. **SOL:** `solana airdrop 0.1 "$OWNER" --url devnet`. If the airdrop is refused, use
   [faucet.solana.com](https://faucet.solana.com/): choose devnet and paste the owner's address. It allows 2 requests
   every 8 hours.
2. **USDC:** at [faucet.circle.com](https://faucet.circle.com/), choose USDC and **Solana Devnet**, paste the owner's
   address, and send: 20 USDC. This also creates the owner's USDC account, which the grant needs.
3. Check both: the first prints the owner's SOL, the second `20`.

       solana balance "$OWNER" --url devnet
       spl-token balance --address "$OWNER_USDC" -u devnet

The agent gets nothing: `solana balance "$AGENT" --url devnet` prints `0 SOL`, and
`spl-token balance "$USDC" --owner "$AGENT" -u devnet` answers `Could not find token account …`. Both stay that way.
On the extension route, make these two checks after step 5 sets `AGENT`.

## 4. Grant the allowance

The command reads its node from `STINT_RPC_URL`, and works on devnet only: it checks the node's genesis hash before it
sends anything. On the extension route, run only the `export` line below, and go on to step 5: the rest of this step is
the Claude Code route's.

    export STINT_RPC_URL=https://api.devnet.solana.com
    EXPIRES=$(date -u -d '+1 day' +%Y-%m-%dT%H:%M:%SZ)     # on macOS: date -u -v+1d +%Y-%m-%dT%H:%M:%SZ
    pnpm stint allowance grant --keypair "$HOME/.config/stint/allowance-owner.json" --agent "$AGENT" --per-period 300000 --period 3600 --expires "$EXPIRES"

That is 300000 base units (0.300 USDC: USDC has 6 decimals) every 3600 s, for one day. The first period starts when
the grant lands. It prints the delegation's address and the transaction, such as:

    granted: delegation 55HZmMwLy4icQoTtnUjoApY7HNKLGmDKpXcE6a7CdHb4, 300000 base units every 3600 s until 2026-11-06T16:15:32.000Z
    transaction 5aKkwxkF48LN6ND3bSZTT6ktJATW2KsGJrDzJDYxGtyq8Mw1CMUGhamhoJHpkKECpBkgnBknfnkdDAMjZRvJ7jqR

The transaction, signed by the owner alone, creates two accounts of the Subscriptions & Allowances program: the owner's
Subscription Authority, which it makes the delegate of the owner's USDC account, and the delegation. Read it back:

    pnpm stint allowance status --owner "$OWNER" --agent "$AGENT"

    delegation 55HZmMwLy4icQoTtnUjoApY7HNKLGmDKpXcE6a7CdHb4
    active: 0 of 300000 pulled this period, 300000 left; the period ends at 1793898951; expires at 1793981732
    the owner holds 20000000

Times are Unix seconds: `date -u -d @1793898951` turns one into a date. `spl-token display "$OWNER_USDC" -u devnet`
shows the owner's USDC account with its new delegate, the Subscription Authority:

    Delegation:
      Delegate: 6GZB8CdT4fbWopAyhskYYFXtpgbKJ3498s3hhvRVq8b4
      Allowance: 18446744073709.551615

The approval has no limit (the most a token account can hold): the cap is the delegation's, which the program checks
at each pull.

## 5. The agent in Claude Desktop: the allowance extension

1. Download **`stint-claude-demo-allowance.mcpb`** from the allowance extension's release (the release page of
   `claude-demo-allowance-v0.1.0`), or build it from the repository, as the extension's
   [README](../examples/claude-demo-allowance/README.md#install-it-in-claude-desktop) says, and open it with Claude
   Desktop (Settings → Extensions → Advanced settings → Install Extension).
2. Settings: keep the wallet folder and the gate URL; put the owner's address (`echo $OWNER`) in **Owner's address**;
   leave the nonce empty. The extension makes the agent its own key.
3. In a new chat, ask: "Start the Stint allowance demo." The panel shows the owner's USDC, the agent's address, and,
   with no allowance yet, the command that grants one, with the agent's address in it. Set `AGENT` to that address in
   your terminal: step 3's agent check, and steps 7 and 9, use it.
4. Run that command in the terminal, from the repository, with `STINT_RPC_URL` exported (step 4). The strip then shows
   that nothing is pulled of 0.200 USDC this period, and when the period ends.
5. **Launch**, then **Top up +100 s**: each 0.100 USDC is pulled from the owner, and the strip shows the cap used up.
   **Close now** refunds the owner; the strip still shows 0.200 pulled. **Launch** again: refused on-chain, with the
   reason in words.
6. Check the money with step 7, and clean up with step 9.

Steps 5b, 6 and 8 run the agent in Claude Code instead; steps 7 and 9 serve both routes.

## 5b. Give Claude Code the session tools, funded by the allowance

Register the repository's MCP server with Claude Code, from the repository's folder:

    claude mcp add \
      --env STINT_KEYPAIR_PATH="$HOME/.config/stint/allowance-agent.json" \
      --env STINT_MAX_RATE=1000 --env STINT_MAX_PER_SESSION=600000 \
      --env STINT_BUDGET_AMOUNT=2000000 --env STINT_BUDGET_PERIOD_SECONDS=3600 \
      --env STINT_ALLOWANCE_OWNER="$OWNER" \
      --env STINT_RPC_URL=https://api.devnet.solana.com \
      --transport stdio stint \
      -- "$PWD/node_modules/.bin/tsx" "$PWD/packages/mcp/src/cli.ts"

The options come before the server's name, `stint`, and `--transport stdio` sits between the last `--env` and the
name: `--env` takes several values, and would read a name that follows it as one more.

| Variable | What it does here |
|---|---|
| `STINT_KEYPAIR_PATH` | The agent's key, which signs every payment |
| `STINT_ALLOWANCE_OWNER` | Every open and top-up is pulled from this owner's allowance |
| `STINT_RPC_URL` | The client reads the allowance before it signs, and the `stint_allowance` tool reports it |
| `STINT_MAX_RATE`, `STINT_MAX_PER_SESSION`, `STINT_BUDGET_*` | The client's own spending limits, enforced in code. They are set above the allowance here, so the cap you meet is the program's |

Claude Code does not see this shell's variables, so print the second prompt of step 6 now, with the owner's USDC
account in it, and keep it to paste:

    echo "Open a 200-second Stint session at https://stint-demo.lxfoundry.ai, and in the same turn subscribe on it to the account $OWNER_USDC by sending {\"op\":\"subscribe\",\"accounts\":[\"$OWNER_USDC\"]}. Then give me the session's address as a link to devnet's Explorer."

Then start Claude Code, from the same folder, with the server's tools allowed:

    claude --allowedTools "mcp__stint__*"

`/mcp` lists the `stint` server and its state. The tools are allowed up front because the seller's gate closes a
session that has no connection 30 s after it opens: a permission prompt between the open and the subscription could
take longer than that.

## 6. Run the session

This step is the Claude Code route's. Ask Claude, one prompt at a time. The session's 200 s start at the open, in the
second prompt. Claude's own wording varies; the tool results it reads are quoted below.

**1. What the agent pays with.**

> What do you pay with? Call stint_allowance and give me the figures in USDC.

It answers from the chain: an allowance from the owner, 0.300 USDC per period, nothing pulled yet, and the owner's
balance.

    {"funding":"allowance","owner":"CciCZMJsih7NY5pet9kc1siPSj7169WSFZoTTQ5dGezx","status":"active","perPeriod":"300000","pulledThisPeriod":"0","leftThisPeriod":"300000","periodEndsAt":1793898951,"expiresAt":1793981732,"ownerBalance":"20000000"}

**2. Open a session, and watch the owner's account on the stream.** Paste the prompt that step 5b printed:

> Open a 200-second Stint session at https://stint-demo.lxfoundry.ai, and in the same turn subscribe on it to the
> account 2jPivp36NKaGtT2kYKmJHkaEzdEpMFJftv6UGhEd5a9U by sending
> {"op":"subscribe","accounts":["2jPivp36NKaGtT2kYKmJHkaEzdEpMFJftv6UGhEd5a9U"]}. Then give me the session's address as
> a link to devnet's Explorer.

The open costs 0.200 USDC, pulled from the owner:

    {"sessionId":"GMRzTri1DBLWdNrqAe1FLcUydm6CzxQikhT7ygdgW9Hb","paidUntil":1793896094,"cost":"200000","remainingBudget":"1800000"}

`remainingBudget` is the client's own hourly limit in code (`STINT_BUDGET_AMOUNT`, 2.000 USDC), not the allowance: the
allowance is what `stint_allowance` reports. The session's page on Explorer shows its open: one transaction, signed by
the agent and by two of the seller's keys (they pay the fee and the new accounts' rent), that creates the session's
vault, pulls the deposit through the Subscriptions & Allowances program (a `transferChecked` of 0.2 USDC from the
owner's account) and opens the session.

The stream sends changes only, so the open's pull, which landed before the subscription, is not in it: Claude may say
that nothing has arrived yet.

**3. Top up, and see the pull on the stream.**

> Top up the session by 100 seconds. Then wait up to 30 seconds for the stream's message about that account, and tell
> me the token amount it reports.

The top-up costs 0.100 USDC, pulled from the owner like the open, and the stream the agent pays for reports the owner's
USDC account at 19.7: it shows the payment that funds it.

    {"paidUntil":1793896194,"cost":"100000"}
    {"type":"account","address":"2jPivp36NKaGtT2kYKmJHkaEzdEpMFJftv6UGhEd5a9U","slot":"518997779", … "tokenAmount":{"amount":"19700000","decimals":6,"uiAmount":19.7,"uiAmountString":"19.7"} …}

**4. The allowance, used up.**

> Check your allowance again.

    {"funding":"allowance", … "perPeriod":"300000","pulledThisPeriod":"300000","leftThisPeriod":"0", … "ownerBalance":"19700000"}

**5. Close early.**

> Close the session now.

The seller is paid for the time used, and the rest is refunded, in one transaction, to the owner's USDC account, not to
the agent. Here, 104 of the 300 s paid:

    {"paid":"104000","refunded":"196000","transaction":"3e5VE8hr396SXh7zSBESuG5BP7WmjHjtiiGDxFgzX3K4vo4q15Ph8aCq1nuCMw2LhnpNHtnAtvAse6Es4Asf3bW5"}

**6. The refund does not restore the allowance.**

> Check your allowance once more.

Still 0.300 pulled and nothing left, while the owner's balance is up by the refund (19.700 + 0.196 = 19.896): the
program counts what was pulled.

    {"funding":"allowance", … "pulledThisPeriod":"300000","leftThisPeriod":"0", … "ownerBalance":"19896000"}

**7. Past the cap.**

> Open another 100-second session there.

Refused before anything is signed, and nothing moves:

    The allowance cannot fund this payment: the allowance for this period is used up: 300000 of 300000 pulled, 0 left, 100000 needed; the period ends at 1793898951

The agent has no tool that raises its allowance: only the owner's key can grant one.

If the paid time runs out before the close, the gate closes the session at its end and the seller is paid in full: go
on with prompt 6. A top-up is refused with 13 s or less left.

## 7. Check the money

The figures are from the Claude Code run. With the extension, the grant and the pulls are 0.200 USDC, not 0.300.

- **The owner's USDC account:** `solana transaction-history "$OWNER_USDC" --url devnet` lists five transactions,
  newest first: the close (the refund in), the top-up and the open (each a pull out), the grant, and the faucet's
  transfer. Each signature opens on devnet's Explorer at `https://explorer.solana.com/tx/<signature>?cluster=devnet`.
- **The agent:** still `0 SOL`, and still no token account (step 3's two commands).
- **The allowance:** `pnpm stint allowance status --owner "$OWNER" --agent "$AGENT"`:

      delegation 55HZmMwLy4icQoTtnUjoApY7HNKLGmDKpXcE6a7CdHb4
      active: 300000 of 300000 pulled this period, 0 left; the period ends at 1793898951; expires at 1793981732
      the owner holds 19896000

## 8. Optional: the program's own refusal

This step is the Claude Code route's. With `STINT_RPC_URL`, the client reads the allowance and refuses a payment before
it signs. Without it, the client signs and sends the payment, and the chain's rules refuse it: the seller's facilitator
simulates the transaction, the Subscriptions & Allowances program fails the pull, and the gate answers `402`. Do this
before the period ends, while the cap is still used up.

Quit Claude Code, register the server again without `STINT_RPC_URL`, and start it again. The server also inherits
Claude Code's own environment, so unset the variable that step 4 exported first, or the server still reads it:

    claude mcp remove stint
    claude mcp add \
      --env STINT_KEYPAIR_PATH="$HOME/.config/stint/allowance-agent.json" \
      --env STINT_MAX_RATE=1000 --env STINT_MAX_PER_SESSION=600000 \
      --env STINT_BUDGET_AMOUNT=2000000 --env STINT_BUDGET_PERIOD_SECONDS=3600 \
      --env STINT_ALLOWANCE_OWNER="$OWNER" \
      --transport stdio stint \
      -- "$PWD/node_modules/.bin/tsx" "$PWD/packages/mcp/src/cli.ts"
    unset STINT_RPC_URL
    claude --allowedTools "mcp__stint__*"

> Open a 100-second Stint session at https://stint-demo.lxfoundry.ai.

This time the payment is signed and sent, and the gate refuses it with the seller's offer again, shortened here:

    The gate refused the payment: {"x402Version":2,"error":"simulation_failed","resource":{"url":"https://stint-demo.lxfoundry.ai/sessions"},"accepts":[ … ]} (with an allowance, this is how a payment it cannot fund is refused: used up for the period, expired or revoked, or the owner's balance too low)

The gate names only the reason, `simulation_failed`: the hint in brackets is the client's. The owner's balance does not
move. `stint_allowance` now reports only the funding and the owner (`{"funding":"allowance","owner":"…"}`): it has no
node to read the allowance from.

Claude may also remark that the offer's `closeUrl` is a `127.0.0.1` address. The hosted seller keeps its facilitator
internal, so that fallback close is not reachable from outside: the gate closes sessions itself, as in every step
above.

## 9. Clean up

Close any session before you quit the agent's app. With the extension, press **Close now** in the panel before you quit
Claude Desktop. With Claude Code, ask Claude to close it: Claude Code stops its servers within a second when its
session ends, too soon for a close. A session left running loses its connection, and the gate closes it 30 s later,
refunding the owner. A session with less than 30 s left runs to its end.

With Claude Code, remove the server (the extension route has no such step):

    claude mcp remove stint

Then revoke, on both routes. With the extension, `$AGENT` is the agent's address shown in the panel:

    export STINT_RPC_URL=https://api.devnet.solana.com     # again, in a new terminal or if step 8 unset it
    pnpm stint allowance revoke --keypair "$HOME/.config/stint/allowance-owner.json" --agent "$AGENT" --close-authority

    revoked: delegation 55HZmMwLy4icQoTtnUjoApY7HNKLGmDKpXcE6a7CdHb4, and the owner's Subscription Authority closed, with its approval on the owner's USDC account
    transaction 5foaypAjuMzQnsXnj7nUP3F1T5RfubJr8yyfxZMRL4oSfVcWejNivgqZVn4XegD74Gk55UoPzw7eBzDx1Lw5V6hg

The revoke closes the delegation. `--close-authority` also closes the owner's Subscription Authority and removes its
approval on the owner's USDC account: `spl-token display "$OWNER_USDC" -u devnet` shows `Delegation: (not set)`. The
rent of both comes back to the owner. In the run above, the grant took 0.0029 SOL, and the whole run cost the owner two
fees of 0.000005 SOL.

To run the session again with the same keys (step 5, or steps 6 to 8), do it before the revoke: wait for the period to
end (`status` prints when), and the cap is free again.

## If something goes wrong

| What you see | What to do |
|---|---|
| `STINT_RPC_URL must be set to an http or https URL…` | Export it in this terminal (step 4) |
| The grant fails on the owner's token account | The owner has no USDC account yet: get USDC from Circle's faucet first (step 3) |
| The grant fails for lack of SOL | Fund the owner with devnet SOL (step 3) |
| `no such allowance`, or the agent reports none | The grant names another agent: check that `--agent` is the address of `allowance-agent.json`, or, with the extension, the address in the panel |
| The allowance is used up at the first open | A run earlier in the same period used it: wait for the period to end (`status` prints when) |
| Claude looks for `OWNER_USDC` and finds it empty | Claude Code does not see your shell's variables: paste the prompt that step 5b printed, with the address in it |
| The session ended before the stream's first message | The gate's 30 s idle close: open and subscribe in the same prompt, with the tools allowed up front (step 5b) |
| `/mcp` shows `stint` failed | Start `claude` from the repository's folder, where the server was added; check that `pnpm install` ran |
| In step 8, the refusal still starts `The allowance cannot fund this payment` | The server still has a node: `unset STINT_RPC_URL` in the terminal before starting `claude` |
| `SessionStart:startup hook error … python: not found` when Claude Code starts | The repository's own development hook, which needs `python`. It does not affect the demo |
| HTTP 429 from the node | The public devnet node limits requests: use a devnet URL from an RPC provider for `STINT_RPC_URL` |
| No panel, and the extension stopped: `STINT_DEMO_ALLOWANCE_OWNER is required…` or `…must be a Solana address…` after `stint-claude-demo-allowance:` in Claude Desktop's log (on the Windows Store build, `%LOCALAPPDATA%\Claude\Logs\main.log`, the lines after `[UtilityProcess stderr]`) | Set the owner's address in the extension's settings |
| Claude declines to pay or to top up | Start a new session and ask again |

## What the owner should know

- Devnet only: the command refuses any other network, and the client accepts devnet USDC only.
- Use a dedicated owner wallet. The allowance takes the owner's USDC account's one delegate slot, and refunds return
  to that account.
- Until the allowance is revoked or expires, the agent's key can pull up to the period's cap into any USDC account, not
  only a session's vault. Keep the cap small and the expiry short, as here: 0.300 USDC an hour, for one day.

## How it works

- [Allowance funding](../README.md#allowance-funding) in the README: the command, the owner's costs, and the variables
  for the MCP server and the example agent.
- [The MCP server](../README.md#mcp-server): every variable, and the seven tools.
- [The allowance extension](../examples/claude-demo-allowance/README.md): its tools and its settings.
- The [specification](specs/stint-system.md), section 10: the grant, the transactions, and the refusals.
