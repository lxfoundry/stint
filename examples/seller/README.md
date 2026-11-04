# Example seller deployment

One Node process that sells the example stream (`examples/solana-stream`) on devnet. It runs Kora as a child process,
the facilitator with its sweeper, and the stream with the gate mounted. The stream listens on `$HOST:$PORT`, the
facilitator on 127.0.0.1. Kora 2.0.5 has no bind option and listens on every interface, at a port picked at start;
it refuses every request but `GET /liveness` without its API key, which only this process holds, and on Fly.io only
the stream's port is public. Other machines in the same Fly.io organization can reach every port over its private
network, and Kora refuses them without its API key.

The offer: 1000 base units of devnet USDC a second (0.001 USDC/s), sessions from 5 s to 1000 s, 100 s when a request
names no duration (0.100 USDC), and a session that nobody connects to for 30 s is closed by the gate.

The stream answers `GET /` with a static page (`src/landing.ts`): the offer, drawn from the same settings, how to try it
in Claude Desktop (the [live demo guide](../../docs/live-demo.md)), and what Stint provides. `/health` answers the
platform's checks.

## Configuration

| Variable | Meaning |
|---|---|
| `STINT_SELLER_SEED` | 64 hexadecimal characters (`openssl rand -hex 32`), or a recovery phrase of 12 to 24 words in quotes. Every key of the deployment derives from it, by this example's own rule, so a phrase does not give the addresses a wallet shows for it. Required; secret |
| `STINT_SELLER_RPC_URL` | A devnet RPC endpoint, http or https. Required; it may carry an API key, so treat it as a secret |
| `STINT_SELLER_WS_URL` | Its WebSocket endpoint. Default: the RPC URL with `ws` for `http`. It may carry an API key too |
| `STINT_SELLER_SCAN_RPC_URL` | An endpoint that answers `getProgramAccounts`, for the start-up and the sweeper, if the RPC URL's provider refuses it, such as `https://api.devnet.solana.com`. Default: the RPC URL |
| `PORT` | The stream's port. Default 8080 |
| `HOST` | The stream's address. Default `0.0.0.0` |
| `PUBLIC_ORIGIN` | The origin buyers reach the stream at, such as `https://stint-demo.lxfoundry.ai`. Required: session tokens are checked against it |
| `KORA_BIN` | The `kora` binary. Default: `kora` on the `PATH` (the image has it at `/usr/local/bin/kora`) |

The process refuses to start unless both RPC endpoints report devnet's genesis hash and the Stint program is deployed.
A variable that is missing or malformed is named, with every other one that is, and the process exits with status 1.

## Keys

Five keys derive from the seed, by this example's own rule:

| Index | Key | Holds |
|---|---|---|
| 0 | funding | The devnet SOL you send it. At each start it tops the next two up to 0.05 SOL each, and pays for the seller's USDC account and the start-up's closes |
| 1 | Kora's fee payer | SOL for the fees of every payment and close |
| 2 | rent payer | SOL for each open session's accounts, returned when the session closes |
| 3 | receiver authorizer | Nothing: it signs the gate's closes, and the start-up's |
| 4 | seller | The USDC that buyers pay |

Use a seed made for this deployment: not the devnet harness's `STINT_DEVNET_SEED`, nor another deployment's. At each
start the process closes the open sessions of this deployment that are still paid for (those whose rent payer and
receiver authorizer are its own), so two processes on one seed would close each other's sessions and spend from the
same keys. The harness's seed also controls the harness's funding key: a copy of it on a server is a copy of that key,
even though this example derives other addresses from it.

Make a seed and print the addresses (in WSL, from the repository root):

    (umask 077; mkdir -p ~/.config/stint; openssl rand -hex 32 > ~/.config/stint/seller-seed)
    STINT_SELLER_SEED="$(cat ~/.config/stint/seller-seed)" pnpm --filter @lxfoundry/stint-example-seller start keys

Send the funding key (the first line) at least 0.5 SOL from a devnet faucet, such as `https://faucet.solana.com`. The
start-up says how much it needs if it holds too little.

### Keep a margin on the funding key

Keep at least 0.05 SOL on the funding key beyond what a start sends to the two keys it tops up (at most 0.1 SOL, when
both are empty), and look at its balance before each deploy (for example `solana balance <address> --url devnet`).

The start-up's own check is smaller. It keeps 0.01 SOL beyond what it sends, and only when it has something to send: a
restart that finds the two keys full and the seller's USDC account in place checks nothing. Yet the start-up closes each
session an earlier process left open, and the funding key pays for each close: the rent of up to two token accounts,
the receiver's and the buyer's, which the close creates if they are gone (2,039,280 lamports each), and the fee of two
signatures (5,000 lamports each). That is 2 × 2,039,280 + 2 × 5,000 = 4,088,560 lamports, about 0.0041 SOL, for each
session it closes. 0.05 SOL pays for 12 sessions (12 × 4,088,560 = 49,062,720 lamports); the start-up's 0.01 SOL, for
one or two.

A close the key cannot pay for is not retried. Its session is listed under `failed` in the `start_clean_up` line, and it
runs to the end of its paid time, when the sweeper closes it: the seller is paid in full, and the buyer is not refunded
the unused time.

## Running it locally

Run it locally on a seed of its own, never the deployment's: its start-up closes the open sessions of its seed's rent
payer, and on the deployment's seed that would close the live deployment's sessions, refunding their buyers and
dropping their connections. Make the local seed once, fund its funding key as above, and run it with Kora 2.0.5 on the
`PATH` (`cargo install kora-cli --version 2.0.5 --locked`, or `KORA_BIN`):

    (umask 077; mkdir -p ~/.config/stint; openssl rand -hex 32 > ~/.config/stint/seller-seed-local)
    STINT_SELLER_SEED="$(cat ~/.config/stint/seller-seed-local)" pnpm --filter @lxfoundry/stint-example-seller start keys
    STINT_SELLER_SEED="$(cat ~/.config/stint/seller-seed-local)" STINT_SELLER_RPC_URL=https://api.devnet.solana.com \
      PUBLIC_ORIGIN=http://127.0.0.1:8080 HOST=127.0.0.1 pnpm --filter @lxfoundry/stint-example-seller start

The public endpoint needs no key. A keyed one is not typed on the command line, where the shell keeps it in its history:
read it with `read -rsp` as in step 2 below, and pass it as `STINT_SELLER_RPC_URL="$RPC_URL"`.

It logs one JSON line per event on stdout, `at` first, with every URL cut to its scheme and host:

    {"at":"2026-01-01T12:00:00.000Z","event":"start_clean_up","closed":[],"failed":[]}
    {"at":"2026-01-01T12:00:09.000Z","event":"ready","url":"http://127.0.0.1:8080","origin":"http://127.0.0.1:8080","seller":"<the seller's address>"}

`ready` comes once the stream listens. Then:

    curl -s http://127.0.0.1:8080/health                                   # {"ok":true}
    curl -si -X POST 'http://127.0.0.1:8080/sessions?seconds=100' | head -1  # HTTP/1.1 402 Payment Required

Ctrl-C stops the stream, the facilitator and Kora, and ends the process with status 0.

## Deploying on Fly.io

From the repository root, with `flyctl` signed in:

1. Create the app (the name in `fly.toml`; change both if it is taken):

       fly apps create stint-demo

2. Set the secrets. They go to `fly` on its standard input, as `NAME=VALUE` lines: the seed is read from its file and
   the RPC URL from a prompt that does not echo it, so that nothing secret is on a command line (where the shell keeps
   it in its history and `ps` shows it) or on the screen. `printf` and `read` are shell built-ins. `PUBLIC_ORIGIN`,
   `HOST` and `PORT` are in `fly.toml`; change `PUBLIC_ORIGIN` to your host name.

       read -rsp 'Devnet RPC URL: ' RPC_URL; echo
       { printf 'STINT_SELLER_SEED=%s\n' "$(cat ~/.config/stint/seller-seed)"
         printf 'STINT_SELLER_RPC_URL=%s\n' "$RPC_URL"
         printf 'STINT_SELLER_SCAN_RPC_URL=%s\n' https://api.devnet.solana.com
       } | fly secrets import --stage -a stint-demo
       unset RPC_URL

   `--stage` keeps the secrets for the deploy below; run later without it, the command also redeploys a running machine.
   If the endpoint's WebSocket address is not its RPC URL with `ws` for `http`, add a `STINT_SELLER_WS_URL` line the same
   way.

3. Deploy. The build context is the repository root; Kora's build takes several minutes the first time. `--ha=false`
   keeps the first deploy to one machine: by default Fly.io adds a spare, and two machines are two processes on one seed.

       fly deploy . --config examples/seller/fly.toml --dockerfile examples/seller/Dockerfile \
         --ignorefile examples/seller/Dockerfile.dockerignore --ha=false

4. Give the app its host name, then add a `CNAME` record from that name to `stint-demo.fly.dev` at your DNS provider,
   with the provider's proxy off (DNS only): Fly.io issues the TLS certificate and must receive the requests itself.

       fly certs add stint-demo.lxfoundry.ai -a stint-demo
       fly certs show stint-demo.lxfoundry.ai -a stint-demo    # until the certificate is issued

5. Check it:

       fly status -a stint-demo                           # one machine
       curl -s https://stint-demo.lxfoundry.ai/health     # {"ok":true}
       curl -s -X POST 'https://stint-demo.lxfoundry.ai/sessions?seconds=100'

   The last answers `402` with one offer: `amount` `"100000"`, `extra.rate` `"1000"`, `extra.seconds` 100,
   `extra.minSeconds` 5, `extra.maxSeconds` 1000, `extra.idleCloseSeconds` 30, and `resource.url`
   `https://stint-demo.lxfoundry.ai/sessions`. `fly logs -a stint-demo` shows the process's log.

## In operation

- The machine runs all the time: `fly.toml` turns off Fly.io's automatic stop and start, and keeps one machine.
- The gate keeps its sessions in memory. A deploy or a restart drops every open connection and every session the gate
  knew. The new process's start-up then closes each session the old one left open while it is still paid for: the
  seller is paid for the time used and the buyer gets the rest back. A session whose paid time has run out by then is
  the sweeper's. Keep the margin on the funding key for those closes (above).
- The stream listens only after that start-up, which `fly.toml` allows 90 s. A buyer's close made before it fails to
  connect, and the start-up's close ends the session on the chain, where the buyer's client can see it. After it
  listens, a close for a session the new gate does not know answers `404`: such a session, the sweeper's or one whose
  close failed, ends at its paid time.
- The facilitator is not public. The `closeUrl` in the offers names its internal address, `http://127.0.0.1:<port>/close`:
  a client that falls back on the sponsored close would call that address on the buyer's own machine, so that
  fallback does not apply to this deployment. The gate's close is the path.
- If Kora exits, the process logs `{"at":…,"event":"kora_exited","code":…,"output":…}` with the end of Kora's output,
  stops, and exits with status 1. Once the seller's stop has begun, Kora's exit is part of the stop and logs nothing: a
  Ctrl-C in a terminal reaches Kora too. A Ctrl-C during the start is acted on when the start ends, so a Kora that exits
  on it before then is still logged, and fails the start if the facilitator has not yet reached it. `fly.toml` sets the restart policy to `always`, so Fly.io starts the machine again
  whatever the exit code; its default, `on-failure`, gives up after a number of retries. `/health` answers for the
  stream only.
- On SIGINT or SIGTERM the process stops the stream, the facilitator, then Kora, and exits with status 0, at the latest
  15 s after the signal. `fly.toml` sends SIGINT and waits 20 s before the kill.
- Kora is started with the RPC URL on its command line, so the URL is visible to the machine's processes (`ps`).
