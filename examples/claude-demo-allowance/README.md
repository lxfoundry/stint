# Example: a Stint session funded by an allowance, in Claude Desktop

The [Claude Desktop example](../claude-demo/README.md), with every open and top-up pulled from an owner's allowance on
the Solana Foundation's Subscriptions & Allowances program instead of the agent's own USDC. Ask Claude to start the
Stint allowance demo: it calls `stint_allowance_demo`, and the panel shows

- **the owner:** its address and USDC, with Circle's faucet link while it holds less than 0.100 USDC;
- **the agent:** its address. It holds no USDC and no SOL;
- **the allowance**, read from the chain: pulled and the cap this period, what is left, and when the period ends. With
  none granted yet, the panel gives the command that grants one, with the agent's address in it;
- **Launch**, **Top up +100 s** and **Close now**, as in the first example: each payment pulled from the owner, each
  refund to the owner, and the owner's USDC log;
- a launch past the cap, sent and refused by the chain, and said in words: "Refused on-chain: the allowance for this
  period is used up (…)".

| Tool | What it does |
|---|---|
| `stint_allowance_demo` | Shows the panel and returns the state, with the allowance |
| `stint_allowance_demo_state` | The state, for the panel's reads. Not offered to the model |
| `stint_allowance_demo_launch` | Opens a 100 s session, 0.100 USDC pulled from the owner's allowance |
| `stint_allowance_demo_top_up` | Buys 100 s more, pulled the same way |
| `stint_allowance_demo_close` | Closes the session now: the seller is paid for the time used, and the rest goes back to the owner |

The tools have names of their own, so both examples can be installed in Claude Desktop at once.

## Install it in Claude Desktop

Build it in WSL or on Linux, from the repository root:

    pnpm --filter @lxfoundry/stint-claude-demo-allowance run build
    pnpm --filter @lxfoundry/stint-claude-demo-allowance run mcpb

They write `examples/claude-demo-allowance/dist/claude-demo-allowance.cjs` and
`examples/claude-demo-allowance/dist/stint-claude-demo-allowance.mcpb`.

Copy the `.mcpb` to the machine that runs Claude Desktop (from WSL, for instance to `/mnt/c/Users/<you>/Downloads/`) and
open it with Claude Desktop: double-click it, or use Settings → Extensions → Advanced settings → Install Extension.
Claude Desktop asks for:

| Setting | Meaning |
|---|---|
| Wallet folder | The folder in which the server keeps a `stint-demo-allowance` folder of its own, for the agent's key (`agent.json`) and `owner.json`. As in the first example |
| Gate URL | The seller's gate. Default `https://stint-demo.lxfoundry.ai` |
| Owner's address | The owner who grants the agent its allowance. Required |
| Allowance nonce | The grant's `--nonce`; empty for 0 |

Then ask Claude, in a new chat, to start the Stint allowance demo. The panel shows the agent's address and the command
that grants it an allowance: run it from the repository, as [Allowance funding](../../README.md#allowance-funding)
describes, with the owner's keypair. The command names devnet's public node in `STINT_RPC_URL`, which the grant reads,
and the keypair at `$HOME/.config/stint/allowance-owner.json`, the allowance guide's file: with another file, such as
that section's `owner.json`, change the path after `--keypair`.
The panel's strip shows the allowance within a few seconds. [The allowance guide](../../docs/live-demo-allowance.md#5-the-agent-in-claude-desktop-the-allowance-extension)
walks through a run, with screenshots.

Without the extension, run the bundle from `claude_desktop_config.json`, as the first example's
[Run it without the extension](../claude-demo/README.md#run-it-without-the-extension) does, with `STINT_DEMO_HOME`,
`STINT_DEMO_ALLOWANCE_OWNER` and, if the grant named one, `STINT_DEMO_ALLOWANCE_NONCE`.

## How it works

- It runs the first example's code, unchanged: the copy that holds the state and the one that forwards to it, the
  agent's key, the demo's state machine, the x402 exchange recorder, the panel's model. See
  [How it works](../claude-demo/README.md#how-it-works) there.
- The demo's wallet is the **owner's** USDC account: the balance, the faucet link, the log and the stream's messages are
  about the account the money moves from and back to. The agent's key only signs.
- The session tools are the client's, funded with `allowance: { owner, nonce }`, and with no node. So a payment the
  allowance cannot fund is signed and sent: the seller's facilitator simulates it, the Subscriptions & Allowances program
  refuses the pull, and the gate answers `402` with `simulation_failed` (spec §10.3). The extension reads the allowance
  with its own node, for the strip, and words the refusal from a read made after it.
- The extension never holds the owner's key: it cannot grant an allowance, or raise one.
- The policy is the first example's: at most 0.001 USDC a second, 1.000 USDC per session and 2.000 USDC an hour, devnet
  only. The allowance's cap applies on top of it.
