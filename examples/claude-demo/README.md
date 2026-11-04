# Example: a Stint session in Claude Desktop

An MCP server whose panel shows a Stint session in Claude Desktop. Ask Claude to start the Stint demo: it calls
`stint_demo`, and the panel shows

- the agent's wallet on devnet and its USDC, with a link to Circle's faucet while no session runs and the wallet holds
  less than 0.100 USDC;
- **Launch**: a 100 s session at the seller's gate, paid 0.100 USDC over x402, with the exchange as it happens
  (`POST /sessions?seconds=100`, `402 Payment Required` and its terms, `PAYMENT-SIGNATURE`, then `201 Created` and the
  settled transaction), the paid time draining, and a count of the stream's messages about the agent's own USDC
  account, which arrive when its money moves;
- **Top up +100 s** and **Close now**: the same exchange for a top-up, or the close with what was paid and refunded;
- at the end of the paid time, the gate closing the session and the seller paid in full.

Each step links to devnet's Explorer. The panel's buttons and the chat act on the same session: "top up" or "close it"
in the chat calls `stint_demo_top_up` or `stint_demo_close`.

| Tool | What it does |
|---|---|
| `stint_demo` | Shows the panel and returns the state. The model calls it when asked to start or see the demo |
| `stint_demo_state` | The state, for the panel's reads. With `refreshBalance: true` it reads the wallet's USDC again. Marked as the panel's own: it is not offered to the model |
| `stint_demo_launch` | Opens a 100 s session and pays 0.100 USDC for it. Refused while a session runs, and when the wallet holds less |
| `stint_demo_top_up` | Buys 100 s more. Refused with 13 s of paid time or less left, and when 100 s more would pass the seller's longest session (300 s) |
| `stint_demo_close` | Closes the session now: the seller is paid for the time used and the rest is refunded. Refused once the paid time is over, when the gate closes the session itself |

A tool takes no argument but `refreshBalance` on `stint_demo_state`. An argument a tool does not name is refused, as a
tool error that names it.

## Install it in Claude Desktop

Build the extension in WSL or on Linux, from the repository root:

    pnpm --filter @lxfoundry/stint-claude-demo run build
    pnpm --filter @lxfoundry/stint-claude-demo run mcpb

Both commands run under WSL or on Linux: the pack script runs the `mcpb` shim in `node_modules/.bin` as a program. They
write

- `examples/claude-demo/dist/claude-demo.cjs` (about 2 MB): the server and every dependency in one script, with the
  panel's HTML inside it;
- `examples/claude-demo/dist/stint-claude-demo.mcpb` (about 450 KB): that script, the manifest and an icon, as one
  Claude Desktop extension.

The two files run on any Node.js from 22, with no repository, no `node_modules` and no WSL: Claude Desktop's own Node.js
runs the extension, on Windows and on macOS.

Copy the `.mcpb` to the machine that runs Claude Desktop (from WSL, for instance to `/mnt/c/Users/<you>/Downloads/`) and
open it with Claude Desktop: double-click it, or use Settings → Extensions → Advanced settings → Install Extension.
Claude Desktop asks for:

| Setting | Meaning |
|---|---|
| Wallet folder | The folder in which the server keeps a `stint-demo` folder of its own, made if it is missing, for the agent's key (`agent.json`) and `owner.json`. It must be on a file system with hard links (see [The agent's wallet](#the-agents-wallet)). The default, your home folder, is fine |
| Gate URL | The seller's gate. Default `https://stint-demo.lxfoundry.ai`, the example seller deployment (`examples/seller`) |

Then ask Claude, in a new chat, to start the Stint demo. It calls `stint_demo`, Claude Desktop asks you to allow the
call, and the panel appears once you do.

## Run it without the extension

Claude Desktop's configuration file, `claude_desktop_config.json`, can run the bundle with Node.js 22 or later, which
must be on the `PATH` of the account that runs Claude Desktop. The file is opened from Settings → Developer → Edit Config
(`%APPDATA%\Claude\claude_desktop_config.json` on Windows, `~/Library/Application Support/Claude/claude_desktop_config.json`
on macOS). Add the server, with the absolute path of the bundle (`dist/claude-demo.cjs`, which can be copied anywhere):

```json
{
  "mcpServers": {
    "stint-demo": {
      "command": "node",
      "args": ["C:\\path\\to\\claude-demo.cjs"],
      "env": { "STINT_DEMO_HOME": "C:\\Users\\you" }
    }
  }
}
```

On macOS the paths are POSIX paths, such as `/Users/you/claude-demo.cjs` and `/Users/you`. The variables:

| Variable | Meaning |
|---|---|
| `STINT_DEMO_HOME` | An absolute path to a folder on a file system with hard links. The server keeps its files in its `stint-demo` folder (here `C:\Users\you\stint-demo`), and creates both if they are missing. Required |
| `STINT_DEMO_GATE_URL` | The seller's gate: an http or https URL with no credentials, query or fragment. Default `https://stint-demo.lxfoundry.ai` |
| `STINT_DEMO_RPC_URL` | Where the balance and a session's close are read: an http or https URL with no credentials. Default `https://api.devnet.solana.com`. It may carry an API key; every URL in a log line is cut to its scheme and host. Not a setting of the extension |

An empty gate or RPC value is the default. A variable that is missing or malformed is named, with every other one that is,
on stderr, and the server exits with status 1.

`pnpm --filter @lxfoundry/stint-claude-demo run dev` runs the server from source instead, with the same variables,
building the panel at start. `pnpm --filter @lxfoundry/stint-claude-demo test` runs the package's tests.

## The agent's wallet

- At its first start, the server writes a new key to `stint-demo/agent.json` in the wallet folder: a Solana CLI keypair
  file (a JSON array of 64 bytes), readable by its owner only (mode 0600). It never overwrites that file, and makes a key
  only for a policy that allows devnet alone. Its address is on stderr, and in the panel.
- The key is written whole to a temporary file in the same folder, which is then published with `link`: a hard link
  from `agent.json` to the temporary file, which fails if the name is taken. So `agent.json` never exists half written,
  and copies that start at once make one key. **`STINT_DEMO_HOME` must therefore be a folder on a file system with hard
  links**: NTFS, APFS or ext4, not FAT or exFAT. On a file system without them the first start fails, with no key made.
- **On Windows**, Claude Desktop runs the server natively, and file modes mean nothing there: the folder is protected by
  the permissions of your user profile, so keep it inside the profile (the default, your home folder, is).
- **Under WSL**, on the plain-node route, use a folder on the Linux side (such as `~/stint-wallet`), not one on a Windows
  drive (`/mnt/c/...`): WSL reads back every mode there as 777, so the key file is not private.
- A crash or a kill between writing the key and publishing it can leave an `agent.json.<pid>.<uuid>.tmp` file in that
  folder. It holds a key that was never shown or funded (mode 0600), and is never read as the wallet. It can be deleted.
- It needs devnet USDC only: the seller's facilitator pays the fees, so the agent holds no SOL. Copy its address from the
  panel, get USDC at Circle's faucet, `https://faucet.circle.com/` (choose Solana Devnet and paste the address), then press
  **Refresh**. The panel's faucet link asks Claude Desktop to open it; if it will not, the panel shows the page's
  address to copy.
- Its limits, enforced by the client's policy whatever the seller offers or the model asks: at most 1000 base units a
  second (0.001 USDC/s), at most 0.300 USDC per session (an open and two top-ups), at most 2.000 USDC an hour across
  sessions, counted as it is paid in, refunds or not; devnet and devnet USDC only.

## How it works

- Claude Desktop starts two copies of the server. The first to create `stint-demo/owner.json` in the wallet folder
  owns the wallet and the session: it holds the key, the client and the state. The other forwards each call to it over HTTP
  on 127.0.0.1, with the Bearer token that file holds (`owner.json` is mode 0600; the endpoint listens on 127.0.0.1
  only). So the panel's buttons and the chat's tool calls act on the same session, whichever copy receives them.
- Before each call, the owner reads `owner.json` again, and runs the call only if the file still names it. If another
  copy's record is there, it stops serving and forwards; if the file is gone, it writes it again, which succeeds only
  while no other copy has.
- A forwarder waits at most 120 s for the owner's answer to a launch, top-up or close, and 15 s for a read. When a
  forwarded call fails because the owner went away, the forwarder takes over, with a fresh state: at once if the owner's
  process is gone, and after 5 s of silence if the process still exists. A launch, top-up or close that the owner may
  have run is not sent again: the tool answers that it may or may not have happened, and the panel shows what did.
  `stint_demo` and `stint_demo_state`, which only read, are asked again.
- Every action goes through the client's session tools, so every payment passes the client's policy checks. The x402
  exchange the panel shows is recorded from the client's own requests to the gate, by one wrapper around `fetch` in the
  owner.
- The panel reads the state every 2 s, every 0.5 s while an action runs, one read at a time, and redraws the time left
  every 250 ms, its clock corrected by the server's. A state stamped before the one drawn is ignored. The owner follows
  the session at each read: it counts the stream's messages and notes the connection's close code. A session that ends
  without Close now has its close looked up on the chain (at most every 4 s), for the amounts paid and refunded.
- A session ends in one of three ways: **closed** (Close now, or the model's `stint_demo_close`), **expired** (its paid
  time ran out, and the seller was paid in full) or **ended** (the gate or another party closed it before its end, such as
  the gate's idle close).
- Quitting Claude Desktop closes the session as a best effort. When the server's standard input closes, as when Claude
  Desktop quits and lets its servers finish, the owner closes the session if it is still paid for, so that the unused part
  of the deposit comes back; it waits at most 90 s. Claude Desktop may end its servers within seconds, though. If the
  process is killed first, nothing runs in it: the stream connection drops, and the gate's idle close, about 60 s later,
  closes the session and refunds the rest the same way. A session with less than 60 s left then runs to its end, and the
  seller is paid in full.
- Stdout carries the protocol; everything for a person goes to stderr, one line per tool call, prefixed
  `stint-claude-demo: `, in each copy that handles the call (a forwarder logs `<tool> forwarded`, the owner
  `<tool> ok in <n> ms`), but for the panel's state reads, which are logged only when they fail. Claude Desktop keeps each
  server's stderr in `%LOCALAPPDATA%\Claude\Logs\mcp-server-<name>.log` on Windows.
