# A Stint session funded by an allowance, in Claude Desktop

A second Claude Desktop extension, `examples/claude-demo-allowance` ("Stint allowance demo"). It shows the session of
`examples/claude-demo` in the same kind of panel, but every open and top-up is pulled from an owner's allowance on the
Solana Foundation's Subscriptions & Allowances program (spec §10), not paid from the agent's own USDC.

It is an example, like `examples/claude-demo`: nothing in `packages/`, `apps/` or `programs/` changes, and nothing in
`examples/claude-demo/` changes either. The first extension stays as built and released.

## What a person sees

1. The owner grants the agent an allowance with `pnpm stint allowance grant`, from the repository (README, "Allowance
   funding"). The extension holds the agent's key only: it never holds the owner's, and it cannot grant or raise an
   allowance.
2. In Claude Desktop, "Start the Stint allowance demo" shows the panel:
   - **the owner:** the owner's address and USDC balance, with Circle's faucet link while the owner holds less than
     0.100 USDC;
   - **the agent:** its address, marked as holding nothing;
   - **the budget strip:** pulled and the cap this period, what is left, and when the period ends, read from the
     chain;
   - with no allowance granted yet, the exact grant command, with the agent's address in it and a suggested
     0.200 USDC an hour for one day.
3. **Launch** (100 s, 0.100 USDC) and **Top up +100 s** are pulled from the owner. The wallet log has one line per
   movement of the **owner's** USDC (`[launch] 19.896 - 0.100 = 19.796 USDC`), and the stream counts the messages about
   the owner's account.
4. **Close now** refunds the owner. The strip still shows what was pulled: a refund does not restore the allowance.
5. **Launch** past the cap is sent, and refused by the chain: the seller's facilitator simulates the transaction, the
   program fails the pull, and the gate answers `402` with `simulation_failed`. The panel says so in words, from a read
   of the allowance made after the refusal: "Refused on-chain: the allowance for this period is used up (0.200 of
   0.200 pulled; it resets at 17:15 UTC)". Launch stays enabled when nothing is left, so that the refusal can be seen;
   a hint says that it will be refused.

## Settings

| Manifest setting | Variable | Meaning |
|---|---|---|
| Wallet folder | `STINT_DEMO_HOME` | As in `examples/claude-demo`. The extension keeps its files in a `stint-demo-allowance` folder inside it, so that it never shares `agent.json` or `owner.json` with the first extension |
| Gate URL | `STINT_DEMO_GATE_URL` | As in `examples/claude-demo`. Default `https://stint-demo.lxfoundry.ai` |
| Owner | `STINT_DEMO_ALLOWANCE_OWNER` | The owner's address. Required: a missing or malformed address is named on stderr, and the server exits with status 1 |
| Nonce | `STINT_DEMO_ALLOWANCE_NONCE` | The delegation's nonce, a whole number. Default 0 |
| (not a setting) | `STINT_DEMO_RPC_URL` | As in `examples/claude-demo`: where the balance, the close and the allowance are read |

The policy is `examples/claude-demo`'s (`DEMO_POLICY`): 0.001 USDC a second, 1.000 USDC per session, 2.000 USDC an
hour, devnet and devnet USDC only. The allowance's cap applies on top of it.

## Design

### What is reused, unchanged

The new package imports these modules of `examples/claude-demo` by relative path (`../../claude-demo/src/…`,
`../../claude-demo/app/…`):

| Module | What it gives |
|---|---|
| `src/owner.ts` | The election of one copy that holds the state, and the forwarding of the other (`createRouter`) |
| `src/wallet.ts` | The agent's key (`ensureDemoFolder`, `loadOrCreateWallet`), in the folder given |
| `src/demo.ts` | The demo's state machine (`createDemo`): launch, top-up, close, the stream, the wallet log |
| `src/chain.ts` | The reads of the chain (`createRpcDemoChain`) for the address given |
| `src/exchange.ts` | The recorder of the x402 exchange (`recordExchanges`) |
| `src/tools.ts` | The call handler (`createCallHandler`), keyed by the first extension's tool names |
| `src/state.ts` | The state's types and constants |
| `app/model.ts`, `app/poller.ts` | The panel's formatting and its polling |

### What is new

- **`src/config.ts`:** the settings above.
- **`src/main.ts`:** the first extension's start-up (its `main` and `createOwnerSide`), with three differences:
  - the chain is built on the **owner's** address, so that the balance, the faucet link, the wallet log and the
    stream's subscription all follow the owner's USDC account, where the money moves;
  - the session tools come from `createStintClient({ signer, policy, allowance: { owner, nonce } })`, with **no
    `rpc`**, so that a payment the allowance cannot fund reaches the seller and is refused by the program's simulation
    (spec §10.3);
  - the demo is wrapped by `withAllowance` (below).
- **`src/allowance.ts`, `withAllowance`:** a `Demo` whose every state carries `allowance`, read with the extension's
  own node through the client library's `readAllowance`:
  - `{ status: "none" }`, or `{ status, perPeriod, pulled, left, periodEnd, expiresAt }`, amounts as base-unit
    strings and times as Unix seconds;
  - each read is bounded in time; a read that fails keeps the last value, marked stale, and is logged;
  - the error of a launch or a top-up that the gate refused with `simulation_failed` is reworded from a read of the
    allowance made after it: used up for the period, larger than the cap, expired, not started, no allowance, or the
    owner's balance too low. When the read explains nothing, it names the general reasons. The original message is
    kept, after the words.
- **`src/server.ts`:** the first extension's MCP server, with its own server name (`stint-claude-demo-allowance`),
  instructions and tool descriptions (each payment pulled from the owner's allowance, the strip, the refusal), and its
  own tool names, each mapped onto the call handler's: `stint_allowance_demo`, `stint_allowance_demo_state`,
  `stint_allowance_demo_launch`, `stint_allowance_demo_top_up`, `stint_allowance_demo_close`. Both extensions can then
  be installed at once.
- **`app/panel.html`, `app/panel.ts`:** the first extension's panel with the owner, the agent and the budget strip, the
  grant command, and the new tool names.
- **`scripts/`, `mcpb/manifest.json`:** the bundle `dist/claude-demo-allowance.cjs` and the package
  `dist/stint-claude-demo-allowance.mcpb`, built as the first extension's are.
- **`src/index.ts`:** the parts an end-to-end test composes.

### Failure behaviour

- A missing or malformed owner, nonce, gate or node: the server names each on stderr and exits 1, as the first
  extension does.
- No allowance, or one that cannot fund the payment: the launch is sent and refused, and the panel shows why. Nothing
  is locked: the client's policy releases what it reserved when a payment is refused.
- A node that cannot be read: the strip shows the last value as stale, and launches go on (the chain decides).
- Claude Desktop killing the extension: as in the first extension, the gate's idle close ends the session and refunds
  the owner.

## Testing

- **Unit tests:** the config; `withAllowance` with a fake demo and fake reads (the strip, a failed read, every
  rewording); the server's tool names and their mapping; the panel's new formatting; the manifest.
- **End to end, on the local network:** through the e2e package's grant fixture, a launch pulls from the owner and the
  agent holds no USDC account; after the cap is used, a launch is refused with `simulation_failed` and the panel's
  reworded reason.
- **By hand:** the `.mcpb` in Claude Desktop against the hosted seller, with an allowance granted by the CLI: launch,
  top-up, close, the refused launch, each line checked on the chain.

## Docs and release

- The package's `README.md`.
- `docs/live-demo-allowance.md`: an owner part (keys, funding, the grant), then two routes for the agent: this
  extension, or Claude Code with the MCP server.
- A release of its own, which is not marked as the latest, so that the latest release keeps serving the first
  extension's package.

## Out of scope

- Any code for the owner beyond the existing command: the extension never holds the owner's key.
- A node for the session tools: the client's own check before signing (spec §10.3) is not used here.
- Restoring a session after the extension restarts (as in the first extension).
