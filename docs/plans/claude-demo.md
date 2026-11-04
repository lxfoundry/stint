# An example seller deployment, and a Stint session in Claude Desktop — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or
> executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for
> tracking.

**Goal:** Two new example packages. `examples/seller` is an example seller deployment: Kora, the facilitator with its
sweeper, and the example stream with its gate, composed in one Node process that runs on Fly.io as one always-on
machine and sells the stream on devnet at 0.001 USDC a second. `examples/claude-demo` is an example MCP server that
shows a Stint session in Claude Desktop: an MCP App panel shows the agent's wallet, the x402 exchange of an open as it
happens, the paid time draining, a top-up, an early close with its refund, and the end of a session left to expire;
the same actions are tools the model can call from the chat.

**Architecture:** The seller composes the existing packages the way the end-to-end harness's `startServices` and
`startDevnetStack` do, with code of its own for what the harness keeps to itself (key derivation, the Kora launcher,
SOL top-ups, the start-up close of sessions left open); the stream gains one optional setting, the public origin it
announces to its gate. The demo server drives the client library's shared session tools (`createSessionTools`), so
every action passes the client's policy; it records the x402 exchange by wrapping the global `fetch`, and it keeps the
demo's state in one of the two copies of itself that Claude Desktop starts, the other forwarding to it over a
loopback HTTP endpoint. The panel is one HTML file, bundled with esbuild and inlined into the server's single-file
bundle, which a `.mcpb` package carries.

**Tech Stack:** TypeScript 7.0.2, vitest 5.0.5, tsx 4.23.15, `@solana/kit` 8.5.0, `@modelcontextprotocol/server`
2.4.0, `@modelcontextprotocol/ext-apps` 2.0.4, zod 4.6.7, esbuild 0.28.2, `@anthropic-ai/mcpb` 2.1.2, Kora 2.0.5,
Node.js 24.22.0, pnpm 12.14.0, Docker, Fly.io.

**Spec:** `docs/specs/stint-system.md`, sections 3.3 (layout), 5.1 to 5.4 (the 402 and its headers), 6.1 and 6.4 (the
facilitator, its sweeper), 7.1 and 7.2 (the gate's routes and session tokens: `aud` is the gate's origin), 7.4 (close
codes), 8 (the example stream's messages), 9.2 to 9.6 (the client's policy, its tools, the MCP server). The design of
the two examples is stated in this plan: no spec section describes them, and none changes but §3.3's layout.

## Global Constraints

- Platform: Linux x86-64; on Windows, everything runs inside WSL 2. Run every command from the repository root, inside
  WSL (for one command from Windows: `wsl -e bash -lc 'cd "<the repository in /mnt/…>" && <command>'`). Scratch files of
  tests go under each package's `.cache/` (git-ignored), never `/tmp`.
- **Devnet only.** The seller refuses to start unless its RPC (and its scan RPC) reports devnet's genesis hash
  `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG`. The demo's policy allows devnet alone, and it creates a key only for
  such a policy.
- **Scope:** nothing changes in `packages/`, `apps/`, `programs/`, `conformance/` or `e2e/`. The one change to existing
  code is in `examples/solana-stream/` (Task 1). Docs that change: `README.md` (one section), `docs/plans/README.md`
  (one paragraph), `docs/specs/stint-system.md` §3.3 (two lines). `pnpm-lock.yaml` changes through installs only.
- New packages import the product libraries through `workspace:*` and their `package.json` exports only. Nothing
  imports `@lxfoundry/stint-e2e`: its only export, `e2e/src/index.ts`, loads `@solana/surfpool` (through
  `network/surfnet.ts` and `fixtures/keys.ts`), a native module.
- Exact versions: `@modelcontextprotocol/server` 2.4.0, `@modelcontextprotocol/client` 2.4.0,
  `@modelcontextprotocol/core` 2.4.0, `@modelcontextprotocol/ext-apps` 2.0.4, `zod` 4.6.7, `@solana/kit` 8.5.0,
  `@solana-program/system` 0.16.0, `@solana-program/token` 0.18.0, `esbuild` 0.28.2, `@anthropic-ai/mcpb` 2.1.2,
  Kora `kora-cli` 2.0.5, Rust 1.99.1, Node.js 24.22.0, pnpm 12.14.0.
- **The seller's terms:** rate 1000 base units a second (USDC has 6 decimals: 0.001 USDC/s), `minSeconds` 5,
  `maxSeconds` 300, `durations: [100]`, idle close 60 s, devnet USDC `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`.
- **The demo's policy:** `maxRate` 1000, `maxPerSession` 300000 (an open and two top-ups), a budget of 2000000 per
  3600 s (2.000 USDC an hour), devnet, devnet USDC, the Stint program (the client's default).
- **The demo's files** (`agent.json`, `owner.json`) live in the `stint-demo` subfolder of `STINT_DEMO_HOME`, which the
  server creates before anything else.
- **No secrets in any commit.** The seller's seed and RPC URLs live in its environment (`fly secrets`); the agent's key
  file lives in the folder named by `STINT_DEMO_HOME`, outside the repository. No message or log quotes a seed, a key
  file's contents or an RPC URL; the seller's log lines pass through `redactUrls`.
- Amounts are `bigint` in TypeScript; in the demo's state and on the wire they are base-unit decimal strings. Times in
  the demo's state are Unix seconds, except `now` and each row's `at`, in milliseconds.
- Explorer links are built by the server only, from text that `isSignature` or `isAddress` accepts.
- The panel writes text with `textContent` only, never `innerHTML`, and sets styles through the CSSOM only.
- In the MCP server, stdout carries the protocol: everything for a person goes to stderr, one line per tool call.
- Test first: write the failing test, run it, implement, run it again, commit.
- Commit messages are neutral, technical and in the present tense, and end with the line
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Rule 8 of `CLAUDE.md` concerns behaviours the spec's scenarios cover. No scenario covers the examples; the stream's
  new setting is optional, and `pnpm e2e:local` must still pass after Task 1.

## Design changes the code base required

Where the code base made this plan depart from the design it started from, each kept as small as it could be:

1. **The offers' `closeUrl` names the facilitator's internal address.** `startFacilitator` publishes
   `closeUrl: ${url}/close` from the address it listens on (`apps/facilitator/src/server.ts:91`), and only the stream's
   port is public, so a buyer's fallback to the sponsored close cannot reach this deployment's facilitator: the client
   would call `http://127.0.0.1:<port>/close` on the buyer's own machine. The gate's close is the buyer's path; the
   seller's README says so. Serving `/close` publicly would need a route on the stream's server, which this plan does
   not add.
2. **The start-up clean-up closes the sessions still paid for, and leaves expired ones to the sweeper.** It closes each
   session whose rent payer and receiver authorizer are the deployment's and whose paid time has not run out on the
   chain's clock (the Clock sysvar), with a `Standard` close signed by the receiver authorizer, which pays the seller
   for the time used and refunds the rest. As the harness's clean-up does (`e2e/src/devnet/funds.ts:267-275`), the
   same transaction first creates, idempotently, the receiver's token account and the buyer's refund account. So the
   README states that a restart's open sessions are closed at the next start, with a refund, rather than that they run
   to their paid time; those past their paid time are the sweeper's, as it already does (spec §6.4).
3. **The seller's keys derive with a label of their own** (`stint-example-seller/<index>`, the harness uses
   `stint-devnet-harness/<index>`), at the same indices (funding 0, Kora's fee payer 1, rent payer 2, receiver
   authorizer 3, seller 4). The harness's seed therefore gives other keys; the README still asks for a seed made for
   the deployment, and says why. The seed is read as the harness reads its own: 64 hexadecimal characters, or a
   recovery phrase of 12 to 24 words (`e2e/src/devnet/config.ts:40-67`).
4. **SOL is topped up to a target** (0.05 SOL for Kora's fee payer and for the rent payer) instead of a fixed amount
   sent at every start: a deployment has no end-of-run clean-up that would return it.
5. **The Docker ignore file is `examples/seller/Dockerfile.dockerignore`**, passed to `fly deploy --ignorefile`
   (BuildKit reads it next to the Dockerfile for a local `docker build`), because no file may be added at the root.
6. **The demo depends on `@modelcontextprotocol/client`, `@modelcontextprotocol/core` and `zod` at run time**: they are
   peers that `@modelcontextprotocol/ext-apps` 2.0.4 requires. It does not depend on `@solana-program/token`: the
   scheme package's `associatedTokenAddress` (`packages/x402/src/transactions.ts:40`) gives the agent's USDC account.
7. **The panel's HTML enters the server bundle through esbuild's `define`** (`PANEL_HTML`), not through an `.html`
   import with the `text` loader, so that the type check needs no declaration for `.html` and no built file.
8. **The state gains two fields**: `session.endedAt` (Unix seconds; the capsule stops at the close, not at the panel's
   clock), and `error` (the last action's failure, so that a tool the model called and that failed shows in the panel).
   The module that defines the state also holds the constants both sides share (`LAUNCH_SECONDS`, `TOP_UP_SECONDS`,
   `LAUNCH_AMOUNT`, `FAUCET_URL`, `PANEL_URI`, `TOOL`), still with no imports.
9. **`owner.json` is read a second time, 250 ms later, when it cannot be parsed**: `openSync(path, "wx")` creates the
   file before its content is written, and both copies start at once. Only then does a copy treat it as stale.
10. **The owner sends the stream subscription again, at most every 15 s, at state reads while the session runs.** The
    stream ignores an account a connection already watches (`examples/solana-stream/src/adapter.ts:91`), and the
    client's `stint_send` opens the connection again if it dropped, so this keeps an idle connection alive through
    proxies and brings back a dropped one.
11. **"Close now" is refused once the paid time is over**, and the quit-time close is skipped then: the gate is closing
    the session itself, and a buyer's close racing it would wait for the gate's pending close (up to 180 s).
12. **`STINT_DEMO_RPC_URL`** names the node the demo reads the balance and the closes from (default
    `https://api.devnet.solana.com`), alongside `STINT_DEMO_HOME` and `STINT_DEMO_GATE_URL`.
13. **No end-to-end test of the demo against the local stack**: `startLocalStack` is exported only through the e2e
    index, which loads Surfpool (constraint above). The manual devnet run (Task 15) covers it.
14. **The demo's files live in a `stint-demo` subfolder of `STINT_DEMO_HOME`**, created before the election, so that the
    `.mcpb`'s default (the home folder) does not fill the home folder itself.
15. **The demo's budget is 2000000 base units an hour (2.000 USDC)**, not 600000, so that a manual run and its retries
    fit in it; `maxRate` and `maxPerSession` are as designed.
16. **A forwarder repeats a call by itself only when the owner never received it** (the connection was refused, or
    the owner answered `401`, `404` or `409` without running a tool) **or when the tool only reads**
    (`stint_demo`, `stint_demo_state`). After a launch, top-up or close whose outcome it cannot know, it elects again
    and answers with a tool error: running it again could pay twice and orphan the first session.
17. **The seller exits when Kora exits**, so that Fly.io restarts the machine; `/health` stays the stream's own route
    (its `GET /health` in `examples/solana-stream/src/server.ts`) and does not probe Kora, since the stream may change
    only by its origin. Kora's output is kept as a 64 KiB tail, not for the life of the process.
18. **Kora listens on `0.0.0.0`**: Kora 2.0.5 has no bind option (`kora rpc start --help` lists only `--port`), and a
    run in WSL showed it listening on `0.0.0.0`. On Fly.io only the declared service (the stream's 8080) is public.
    Other machines in the same Fly.io organization can reach every port over its private network, and Kora refuses
    them without its API key (measured: `401` without the key, `200` with it; `/liveness` answers either way).
19. **The image installs the seller's dependency graph alone** (`pnpm install --frozen-lockfile --filter
    @lxfoundry/stint-example-seller...`), not the whole workspace. Measured with pnpm 12.14.0 on a copy of this
    workspace (with `@lxfoundry/stint-example-stream...`): the frozen, filtered install is accepted ("Scope: 4 of 11
    workspace projects"), installs the root's development dependencies with it (`tsx` included, so
    `node_modules/.bin/tsx` is there), and leaves out `e2e/` and Surfpool. pnpm itself is installed with
    `npm i -g pnpm@12.14.0` rather than through Corepack.
20. **`stint_demo_state` is logged only when it fails**: the panel calls it every 2 s, and a line per poll would bury
    the other calls. Every other tool call is logged, once in each copy that handles it.
21. **The quit-time close is a best effort on Windows.** If Claude Desktop ends its servers without closing their
    standard input, nothing runs; the gate's idle close (60 s after the connection drops) then refunds the rest. The
    README says so instead of promising the quit-time close.

## As built

The code differs from the code this plan shows in these ways, each a behaviour of the built examples:

- **The stream's origin must be an http or https URL.** `StreamConfig.origin` keeps only the origin of such a URL. A host
  and a port with no scheme, or a `file` or `ftp` URL, throws before the stream listens, without quoting the value: the
  gate would otherwise announce an `aud` that no token names.
- **Kora's kept output drops a cut first line before it is shown.** Once the 64 KiB tail has been cut, its first line,
  which the cut may have begun inside a URL, is left out of the log and of the start-up errors, and `redactUrls` runs
  on what is left.
- **Kora ends with the seller.** `startKora` kills Kora (SIGKILL) when the process exits, so that a stop that hangs or a
  start that is cut short leaves no Kora running with the fee payer's key. The entry point stops the seller on SIGINT or
  SIGTERM, one that arrives while it is still starting included, and on an error nobody handles, and it ends 15 s after
  the signal or the error at the latest, whatever the stop is doing. Kora's start gives up at its deadline (30 s) even
  when Kora takes the `GET /liveness` request and never answers it: each request waits only for the time left.
- **The image and the machine keep secrets and restarts apart from the command line.** The seed and the RPC URL reach
  `fly secrets import` on standard input, and seed files are made under `umask 077`. The Docker ignore file is an
  allowlist (`*`, then what the Dockerfile copies) that also repeats the repository's secret patterns at any depth. The
  machine's restart policy is `always`: a seller that exits when Kora does is started again, where the default gives up
  after a number of retries.
- **`agent.json` is published atomically.** The key is written whole to a private temporary file beside it (mode 0600),
  which is linked to `agent.json`, and the link fails if the name is taken. The name never exists half written, copies
  that start at once make one key, and a file that is there but incomplete is read for about 0.4 s before it is called
  invalid. A crash can leave an `agent.json.*.tmp` file, and the folder needs a file system with hard links. A removal of
  the temporary file that fails is logged and changes nothing else. The server also writes a `.gitignore` holding `*`
  into the `stint-demo` folder when it has none, so that a repository around the folder never commits the key.
- **The Explorer link checks never throw.** `isSignature` and `isAddress` throw on text of the right length that holds
  a character outside base58, with an error that quotes the text. Any throw means "not valid": no link is made and
  nothing of the text is kept.
- **The owner is fenced.** Before it runs a call, in its own branch and in its endpoint, the owner reads `owner.json` and
  runs the call only if the file still names it. If another copy's record is there, it stops serving, drops its state
  and forwards; if the file is gone, it creates it again, which succeeds only while no other copy has. The check is bound
  to the state it guards: a call that took an earlier state is refused once a later one exists.
- **Liveness, forwarding and unknown outcomes.** An owner is alive when it answers `/ping` with its own pid. An owner
  whose process is gone is taken over at once; a silent one whose process exists is asked again for 5 s first. A
  forwarded launch, top-up or close waits 120 s, and a read 15 s; a timeout is an unknown outcome. An unknown outcome is
  answered with a tool error even when the election that follows fails, and an unreadable `owner.json` is removed only
  if it is the same file, unreadable throughout.
- **A stream connection, a shutdown and a slow node do not hold the session.** The stream subscription is not awaited,
  and a session has at most one in flight, so a connection that never opens holds neither a launch, a close nor a state
  read. A launch checks for shutdown again after it reads the balance, so that no session opens after a shutdown. Every
  request to the node gives up after 10 s, and a read that failed is made again at the next state read. A state read
  waits at most 5 s for the balance and the close lookup together, so that a forwarded read is answered within its 15 s:
  a read still running carries on, none is started beside it, and its result is seen at a later state read.
- **Every tool has a strict input schema.** An argument that a tool does not name is a tool error that names it, never
  dropped. The launch description tells the model to open the panel first.
- **The panel**: the used part of a closed capsule is drawn in the text colour, inside its Signal outline; its hairlines
  use the host's border colour when it sets one, and Mist (light surface) or Slate (dark surface) otherwise; the page's
  surface is marked dark or light from the colour it is painted, and Signal is text or fill only on a dark one; the
  funding row shows only while no session runs; state reads go one at a time, and a state stamped before the one drawn
  is ignored.
- **One `fetch` wrapper per process, and every built state is closed at shutdown.** The exchange recorder is installed
  on the `fetch` the process had at the start, so that a later state's recorder replaces an earlier one's and never
  wraps it. On the way out, the sessions of every state the copy built are closed, those of states it dropped included,
  and a state built while it leaves opens nothing.

## What this plan builds, and what it leaves

Built: the stream's optional public origin; the seller package with its configuration, keys, Kora launcher, chain
set-up, entry point, Dockerfile and Fly.io configuration; the demo package with its shared state type, panel model,
configuration, wallet, Explorer links, exchange recorder, owner election, session logic, tool handler, MCP server,
panel, entry points, bundle and `.mcpb`; the docs lines.

Not built, and not to be built here:
- **A public sponsored close for the seller** (deviation 1), and several seller machines: the gate keeps sessions in
  memory (spec §7), so the deployment is one machine.
- **Persisting the demo's state**: a restart of Claude Desktop starts from no session; the wallet persists.
- **A demo on another network or token**: the policy and the wallet are devnet's.
- **Reconnecting the panel's session after the seller restarts**: the gate forgets it, and the start-up closes it.

## Parts nothing else depends on

Each of these can be left out, or added later, without changing anything else; each is marked "(optional)" where it
appears:
- the stream frame count (`follow`'s `stint_receive` drain in `src/demo.ts`, the `#frames` line in the panel);
- the copy button (`copyAddress` and `#copy`);
- the host's theme (`applyHost` and the `onhostcontextchanged` handler);
- rows that fill in while an action runs (the panel already falls back to the completed exchange: rows then appear
  when the action returns);
- the close link of an expired session found with `findClose` (`lookUpClose`); without it, the session's address link
  lists its close on Explorer;
- telling the model what the panel did (`tellModel`).

## Before you start

Work on the branch `feat/claude-demo`, from a clean tree. Tasks 1 to 14 need only the repository and the toolchain
(`pnpm install` fetches the new packages). Task 1's last step runs `pnpm e2e:local`, which needs `anchor build`,
`scripts/fetch-subscriptions-program.sh` and the `surfpool` and `kora` binaries, as the README says. Task 5's local
image build is optional and needs Docker. Task 15 is a person's run: a Fly.io account with `flyctl`, a DNS zone for the
public host name, devnet SOL, devnet USDC, and Claude Desktop on Windows.

## File structure

| File | Responsibility |
|---|---|
| `examples/solana-stream/src/server.ts` (modify) | `StreamConfig.origin`: the origin the gate announces and checks tokens against |
| `examples/solana-stream/test/server.test.ts` | The 402's `resource.url` follows the origin |
| `examples/seller/package.json`, `tsconfig.json` | The seller package `@lxfoundry/stint-example-seller` |
| `examples/seller/src/config.ts` | Environment variables → `SellerConfig`; `loadSeed` |
| `examples/seller/src/keys.ts` | The five keys from the seed; `describeKeys` |
| `examples/seller/src/kora.ts` | Kora's configuration files and its child process |
| `examples/seller/src/chain.ts` | Devnet checks, sending transactions, SOL top-ups, the seller's token account, the start-up close |
| `examples/seller/src/seller.ts` | `startSeller`: the composition; `sellerGateSettings`: the terms |
| `examples/seller/src/main.ts`, `index.ts` | The entry point (`keys` command, signals); the package's exports |
| `examples/seller/Dockerfile`, `Dockerfile.dockerignore`, `fly.toml`, `README.md` | The image, the Fly.io app, the operator's guide |
| `examples/seller/test/*.test.ts` | Config, keys, Kora's configuration and start, the chain helpers, the offer the seller sells |
| `examples/claude-demo/package.json`, `tsconfig.json`, `app/tsconfig.json` | The demo package `@lxfoundry/stint-claude-demo`; Node and DOM type checks |
| `examples/claude-demo/src/state.ts` | The state type and the constants the server and the panel share; no imports |
| `examples/claude-demo/app/model.ts` | DOM-free panel logic: amounts, time left, the capsule, refusals, headlines |
| `examples/claude-demo/src/config.ts` | Environment variables → `DemoConfig`; the demo's policy |
| `examples/claude-demo/src/wallet.ts` | `agent.json`: create once, never overwrite |
| `examples/claude-demo/src/links.ts` | Explorer links from validated base58 |
| `examples/claude-demo/src/exchange.ts` | The `fetch` wrapper that records the gate's 402 exchanges |
| `examples/claude-demo/src/owner.ts` | `owner.json`, the loopback endpoint, forwarding, re-election |
| `examples/claude-demo/src/chain.ts` | The agent's USDC balance and a session's close, from the RPC |
| `examples/claude-demo/src/demo.ts` | The owner's state and its actions over the session tools |
| `examples/claude-demo/src/tools.ts` | Tool descriptions, server instructions, the owner's call handler |
| `examples/claude-demo/src/server.ts` | The MCP server: the UI extension, the app tool and resource, the other tools |
| `examples/claude-demo/src/main.ts`, `cli.ts`, `dev.ts` | Wiring and shutdown; the bundle's entry; the source entry |
| `examples/claude-demo/app/panel.html`, `app/panel.ts` | The panel |
| `examples/claude-demo/scripts/panel.ts`, `build.ts`, `pack.ts` | The inlined panel HTML; `dist/claude-demo.cjs`; `dist/stint-claude-demo.mcpb` |
| `examples/claude-demo/mcpb/manifest.json`, `README.md` | The extension's manifest; the guide |
| `examples/claude-demo/test/*.test.ts`, `test/fixtures.ts` | Unit, server and stdio tests; shared test values |
| `README.md`, `docs/plans/README.md`, `docs/specs/stint-system.md` (modify) | One section, one paragraph, two layout lines |

---

### Task 1: The example stream announces a public origin to its gate

The client signs connect and close tokens with `aud = new URL(gateUrl).origin` (`packages/client/src/client.ts:315`),
and the gate checks them against its `origin` (`packages/gate/src/gate.ts:715`), from which it also builds `wsUrl`
(`gate.ts:220`) and each 402's `resource.url` (`gate.ts:273`, `660`). The stream derives that origin from its bind
address (`examples/solana-stream/src/server.ts:31-34`), so behind a proxy that ends TLS on a public host name every
token would be refused. The stream takes an optional `origin`.

**Files:**
- Modify: `examples/solana-stream/src/server.ts:8-36`
- Test: `examples/solana-stream/test/server.test.ts` (new)

**Interfaces:**
- Consumes: `createGate` and `GateConfig` (`packages/gate/src/types.ts:41-90`; `origin` is "the `aud` of session
  tokens"), `FacilitatorClient` (`packages/gate/src/facilitator.ts:4-8`), `GateChain` (`packages/gate/src/chain.ts:23-35`;
  `lastClose` and `watchSession` are optional), `HEADERS` and `decodePaymentRequiredHeader` (`packages/x402/src/constants.ts:14`,
  `packages/x402/src/wire.ts:4-11`).
- Produces: `StreamConfig.origin?: string` from `@lxfoundry/stint-example-stream`: an http or https URL whose origin the
  gate uses; absent, the bind address `http://<host>:<port>` as today. `RunningStream.url` stays the bind address.

- [ ] **Step 1: Write the failing test**

Create `examples/solana-stream/test/server.test.ts`:

```ts
import { generateKeyPairSigner } from "@solana/kit";
import type { FacilitatorClient, GateChain } from "@lxfoundry/stint-gate";
import { HEADERS, SOLANA_DEVNET, USDC_DEVNET, decodePaymentRequiredHeader } from "@lxfoundry/stint-x402";
import { afterEach, describe, expect, it } from "vitest";
import { startStream, type RunningStream, type StreamConfig } from "../src/index.js";

/** The Stint program: the gate offers sessions only through a facilitator that supports it. */
const PROGRAM = "5iCYPqLjCWw5KzQTU6NBUhR2hxg5SWGmS1ctUn3qESvr";
/** Nothing listens here: the stream's subscriptions connect only when a buyer subscribes, and none does. */
const NO_NODE = "ws://127.0.0.1:9";

async function gateConfig(): Promise<StreamConfig["gate"]> {
  const [feePayer, rentPayer, seller, receiverAuthorizer] = await Promise.all([
    generateKeyPairSigner(),
    generateKeyPairSigner(),
    generateKeyPairSigner(),
    generateKeyPairSigner(),
  ]);
  const facilitator: FacilitatorClient = {
    supported: async () => ({
      kinds: [
        {
          x402Version: 2,
          scheme: "elapsed",
          network: SOLANA_DEVNET,
          extra: { feePayer: feePayer.address, rentPayer: rentPayer.address, programId: PROGRAM, closeUrl: "http://127.0.0.1:9/close" },
        },
      ],
      extensions: [],
      signers: {},
    }),
    verify: async () => {
      throw new Error("no payment in these tests");
    },
    settle: async () => {
      throw new Error("no payment in these tests");
    },
  };
  const chain: GateChain = {
    latestBlockhash: async () => ({ blockhash: "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N", lastValidBlockHeight: 100n }),
    readSession: async () => undefined,
    closedEvent: async () => undefined,
  };
  return {
    network: SOLANA_DEVNET,
    asset: USDC_DEVNET,
    payTo: seller.address,
    receiverAuthorizer,
    terms: { rate: 1_000n, minSeconds: 5, maxSeconds: 300 },
    durations: [100],
    facilitator,
    chain,
  };
}

/** The `resource.url` of the 402 that the stream's gate answers a first open with. */
async function offeredAt(stream: RunningStream): Promise<string | undefined> {
  const response = await fetch(`${stream.url}/sessions?seconds=100`, { method: "POST" });
  expect(response.status).toBe(402);
  const header = response.headers.get(HEADERS.paymentRequired);
  expect(header).not.toBeNull();
  return decodePaymentRequiredHeader(header!).resource?.url;
}

describe("the origin the stream announces to its gate", () => {
  let stream: RunningStream | undefined;
  afterEach(async () => {
    await stream?.stop();
    stream = undefined;
  });

  it("is the public origin it is given, whatever address it listens on, and /health still answers", async () => {
    stream = await startStream({ rpcWsUrl: NO_NODE, origin: "https://stream.example/", gate: await gateConfig() });
    expect(await offeredAt(stream)).toBe("https://stream.example/sessions");
    expect((await fetch(`${stream.url}/health`)).status).toBe(200);
  });

  it("is the address it listens on when it is given none", async () => {
    stream = await startStream({ rpcWsUrl: NO_NODE, gate: await gateConfig() });
    expect(await offeredAt(stream)).toBe(`${stream.url}/sessions`);
  });

  it("refuses an origin that does not parse, before it listens", async () => {
    const started = startStream({ rpcWsUrl: NO_NODE, origin: "not a url", gate: await gateConfig() });
    // Before the change, the stream starts: it is stopped, so that the failing run leaves nothing listening.
    started.then((leaked) => leaked.stop(), () => undefined);
    await expect(started).rejects.toThrow(/Invalid URL/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @lxfoundry/stint-example-stream test server.test.ts`
Expected: FAIL in the first test, `expected 'http://127.0.0.1:…/sessions' to be 'https://stream.example/sessions'`, and in
the third, `promise resolved … instead of rejecting`. The second passes.

- [ ] **Step 3: Pass the origin through**

In `examples/solana-stream/src/server.ts`, replace:

```ts
export interface StreamConfig {
  readonly host?: string;
  /** 0 picks a free port (spec §12.4). */
  readonly port?: number;
```

with:

```ts
export interface StreamConfig {
  readonly host?: string;
  /** 0 picks a free port (spec §12.4). */
  readonly port?: number;
  /**
   * The origin buyers reach the stream at, such as `https://stream.example.com` behind a proxy that ends TLS: the gate's
   * origin, which session tokens name as their `aud` (spec §7.2) and which starts the `wsUrl` and `resource.url` it
   * answers with. Only its origin is kept. Default: the address the server listens on.
   */
  readonly origin?: string;
```

Then replace:

```ts
  const host = config.host ?? "127.0.0.1";
  const server = createServer();
```

with:

```ts
  const host = config.host ?? "127.0.0.1";
  // Parsed before the server listens: an origin that does not parse throws here, with nothing to stop.
  const publicOrigin = config.origin === undefined ? undefined : new URL(config.origin).origin;
  const server = createServer();
```

and replace:

```ts
  const gate = createGate({
    ...config.gate,
    origin: url,
```

with:

```ts
  const gate = createGate({
    ...config.gate,
    origin: publicOrigin ?? url,
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @lxfoundry/stint-example-stream test && pnpm --filter @lxfoundry/stint-example-stream typecheck`
Expected: PASS, every test of `adapter.test.ts` and `server.test.ts`; no type error.

- [ ] **Step 5: Check that the harness is unchanged**

Run: `pnpm typecheck && pnpm e2e:local`
Expected: no type error; the report's last line shows `fail 0`, with as many `required` scenarios as before (the
harness passes no `origin`).

- [ ] **Step 6: Commit**

```bash
git add examples/solana-stream/src/server.ts examples/solana-stream/test/server.test.ts
git commit -m "Let the example stream announce a public origin to its gate" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The seller package, its configuration and its keys

**Files:**
- Create: `examples/seller/package.json`, `examples/seller/tsconfig.json`
- Create: `examples/seller/src/config.ts`, `examples/seller/src/keys.ts`
- Test: `examples/seller/test/config.test.ts`, `examples/seller/test/keys.test.ts`
- Modify: `pnpm-lock.yaml` (by `pnpm install`)

**Interfaces:**
- Consumes: the harness's patterns, rewritten here: `loadDevnetConfig` (`e2e/src/devnet/config.ts:32-70`: URLs without
  credentials, messages that quote neither seed nor URL; a seed of 64 hexadecimal characters or a recovery phrase of
  12, 15, 18, 21 or 24 words, the phrase turned into 64 bytes as BIP-39 does: PBKDF2-HMAC-SHA512 over the NFKD phrase,
  salt `mnemonic`, 2048 rounds) and `deriveKey`/`KEY_INDEX` (`e2e/src/devnet/keys.ts:11-26`: HMAC-SHA-256 of the index
  keyed by the seed, of any length, taken as an Ed25519 private key, the 64-byte secret as private half then public
  half).
- Produces:
  - `interface SellerConfig { seed: Uint8Array; rpcUrl: string; wsUrl: string; scanRpcUrl?: string; host: string; port: number; publicOrigin: string }`,
    `class SellerConfigError extends Error { problems: readonly string[] }`,
    `loadSellerConfig(env: Readonly<Record<string, string | undefined>>): SellerConfig`,
    `loadSeed(env): Uint8Array` (throws `SellerConfigError`);
  - `KEY_INDEX = { funding: 0, koraFeePayer: 1, rentPayer: 2, receiverAuthorizer: 3, seller: 4 }`, `KEY_LABEL = "stint-example-seller"`,
    `interface SellerKey { signer: KeyPairSigner; secretKey: Uint8Array }`, `type SellerKeys = Record<KeyRole, SellerKey>`,
    `deriveSellerKey(seed, index): Promise<SellerKey>`, `deriveSellerKeys(seed): Promise<SellerKeys>`,
    `describeKeys(keys): string` (one line per key: address, two spaces, its role).

- [ ] **Step 1: Create the package**

Create `examples/seller/package.json`:

```json
{
  "name": "@lxfoundry/stint-example-seller",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "typecheck": "tsc -p tsconfig.json",
    "test": "vitest run",
    "start": "tsx src/main.ts"
  },
  "dependencies": {
    "@lxfoundry/stint-example-stream": "workspace:*",
    "@lxfoundry/stint-facilitator": "workspace:*",
    "@lxfoundry/stint-gate": "workspace:*",
    "@lxfoundry/stint-program-client": "workspace:*",
    "@lxfoundry/stint-x402": "workspace:*",
    "@solana-program/system": "0.16.0",
    "@solana-program/token": "0.18.0",
    "@solana/kit": "8.5.0",
    "@solana/sysvars": "8.5.0"
  }
}
```

`@solana/sysvars` reads the chain's clock (Task 3); it is the version the end-to-end harness already uses.

Create `examples/seller/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src", "test"]
}
```

Run: `pnpm install`
Expected: `pnpm-lock.yaml` gains the importer `examples/seller`, every version already in the lockfile; nothing is
downloaded that is not already in the store.

- [ ] **Step 2: Write the failing tests**

Create `examples/seller/test/config.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { SellerConfigError, loadSeed, loadSellerConfig } from "../src/config.js";

const SEED = "ab".repeat(32);
/** BIP-39's published test phrase, and the seed it gives with no passphrase. */
const PHRASE = `${"abandon ".repeat(11)}about`;
const PHRASE_SEED =
  "5eb00bbddcf069084889a8ab9155568165f5c453ccb85e70811aaed6f6da5fc19a5ac40b389cd370d086206dec8aa6c43daea6690f20ad3d8d48b2d2ce9e38e4";
const valid = {
  STINT_SELLER_SEED: SEED,
  STINT_SELLER_RPC_URL: "https://devnet.example/?api-key=secret",
  PUBLIC_ORIGIN: "https://stream.example/",
};

function problemsOf(env: Record<string, string>): string[] {
  try {
    loadSellerConfig(env);
  } catch (error) {
    if (error instanceof SellerConfigError) return [...error.problems];
    throw error;
  }
  throw new Error("expected a configuration error");
}

describe("the seller's configuration", () => {
  it("reads the seed, the endpoint, and the public origin, with the defaults for the rest", () => {
    const config = loadSellerConfig(valid);
    expect(Buffer.from(config.seed).toString("hex")).toBe(SEED);
    expect(config).toMatchObject({
      rpcUrl: "https://devnet.example/?api-key=secret",
      wsUrl: "wss://devnet.example/?api-key=secret",
      host: "0.0.0.0",
      port: 8080,
      publicOrigin: "https://stream.example",
    });
    expect(config.scanRpcUrl).toBeUndefined();
  });

  it("takes the WebSocket and scan endpoints, the host and the port when they are given", () => {
    const config = loadSellerConfig({
      ...valid,
      STINT_SELLER_WS_URL: "wss://ws.devnet.example",
      STINT_SELLER_SCAN_RPC_URL: "https://api.devnet.solana.com",
      HOST: "127.0.0.1",
      PORT: "0",
    });
    expect(config).toMatchObject({ wsUrl: "wss://ws.devnet.example", scanRpcUrl: "https://api.devnet.solana.com", host: "127.0.0.1", port: 0 });
  });

  it("lists every missing variable at once", () => {
    expect(problemsOf({})).toEqual([
      "STINT_SELLER_SEED is required: a recovery phrase of 12 to 24 words, or 64 hexadecimal characters (openssl rand -hex 32)",
      "STINT_SELLER_RPC_URL is required",
      "PUBLIC_ORIGIN is required: the http or https origin buyers reach the stream at, such as https://stream.example.com",
    ]);
  });

  it("refuses malformed values, and quotes neither the seed nor an endpoint", () => {
    const problems = problemsOf({
      STINT_SELLER_SEED: "not-a-seed",
      STINT_SELLER_RPC_URL: "ftp://user:pw@devnet.example",
      STINT_SELLER_WS_URL: "https://devnet.example",
      STINT_SELLER_SCAN_RPC_URL: "nope",
      PORT: "80a",
      PUBLIC_ORIGIN: "https://stream.example/path",
    });
    expect(problems).toHaveLength(6);
    expect(problems.join("\n")).not.toMatch(/not-a-seed|user:pw|devnet\.example|nope/);
  });

  it("reads the seed alone, for the keys command", () => {
    expect(Buffer.from(loadSeed({ STINT_SELLER_SEED: SEED })).toString("hex")).toBe(SEED);
    expect(() => loadSeed({})).toThrow(SellerConfigError);
  });

  it("turns a recovery phrase into its 64-byte BIP-39 seed, whatever its case and spacing", () => {
    expect(Buffer.from(loadSeed({ STINT_SELLER_SEED: PHRASE })).toString("hex")).toBe(PHRASE_SEED);
    expect(Buffer.from(loadSeed({ STINT_SELLER_SEED: `  ${PHRASE.toUpperCase().replaceAll(" ", "   ")} ` })).toString("hex")).toBe(PHRASE_SEED);
  });

  it("refuses a phrase of a length BIP-39 does not use, without quoting it", () => {
    let problems: readonly string[] = [];
    try {
      loadSeed({ STINT_SELLER_SEED: `${PHRASE} zoo` });
    } catch (error) {
      if (error instanceof SellerConfigError) problems = error.problems;
    }
    expect(problems).toEqual(["STINT_SELLER_SEED must be a recovery phrase of 12 to 24 words, or 64 hexadecimal characters"]);
  });
});
```

Create `examples/seller/test/keys.test.ts`:

```ts
import { createHmac } from "node:crypto";
import { createKeyPairSignerFromBytes, createKeyPairSignerFromPrivateKeyBytes } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { KEY_INDEX, deriveSellerKey, deriveSellerKeys, describeKeys } from "../src/keys.js";

const seed = Uint8Array.from({ length: 32 }, (_, index) => index);

describe("the seller's keys", () => {
  it("derives the same five distinct keys from the same seed", async () => {
    const first = await deriveSellerKeys(seed);
    const again = await deriveSellerKeys(seed);
    const addresses = Object.values(first).map((key) => key.signer.address);
    expect(new Set(addresses).size).toBe(5);
    expect(Object.values(again).map((key) => key.signer.address)).toEqual(addresses);
    expect(first.koraFeePayer.signer.address).toBe((await deriveSellerKey(seed, KEY_INDEX.koraFeePayer)).signer.address);
  });

  it("gives each key its 64-byte secret, private half then public half", async () => {
    const key = await deriveSellerKey(seed, KEY_INDEX.rentPayer);
    expect(key.secretKey).toHaveLength(64);
    expect((await createKeyPairSignerFromBytes(key.secretKey)).address).toBe(key.signer.address);
  });

  it("derives other keys than the devnet harness does from the same seed", async () => {
    const harness = await createKeyPairSignerFromPrivateKeyBytes(
      Uint8Array.from(createHmac("sha256", seed).update("stint-devnet-harness/1").digest()),
    );
    expect((await deriveSellerKey(seed, 1)).signer.address).not.toBe(harness.address);
  });

  it("names each key's role, funding key first", async () => {
    const keys = await deriveSellerKeys(seed);
    const lines = describeKeys(keys).split("\n");
    expect(lines).toHaveLength(5);
    expect(lines[0]).toBe(`${keys.funding.signer.address}  funding key: send it devnet SOL; it gives the next two theirs`);
    expect(lines[4]).toMatch(new RegExp(`^${keys.seller.signer.address}  the seller's wallet`));
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm --filter @lxfoundry/stint-example-seller test`
Expected: FAIL: `Failed to load url ../src/config.js` and `../src/keys.js` (the modules do not exist yet).

- [ ] **Step 4: Write the configuration**

Create `examples/seller/src/config.ts`:

```ts
import { pbkdf2Sync } from "node:crypto";

/** The seller's configuration, from environment variables (`examples/seller/README.md`). */
export interface SellerConfig {
  /**
   * The bytes every key of the deployment derives from (`deriveSellerKeys`): 32 from a hexadecimal seed, or 64 from a
   * recovery phrase, as BIP-39 turns a phrase into a seed.
   */
  readonly seed: Uint8Array;
  readonly rpcUrl: string;
  readonly wsUrl: string;
  /** An endpoint that lists the program's accounts, if `rpcUrl` refuses that. */
  readonly scanRpcUrl?: string;
  readonly host: string;
  readonly port: number;
  /** The origin buyers reach the stream at: the gate's origin (spec §7.2). */
  readonly publicOrigin: string;
}

/** Every problem with the environment, so that one start shows them all. */
export class SellerConfigError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Invalid configuration:\n${problems.map((problem) => `- ${problem}`).join("\n")}`);
    this.name = "SellerConfigError";
  }
}

type Env = Readonly<Record<string, string | undefined>>;

const text = (env: Env, name: string) => env[name]?.trim() || undefined;

/** A URL that parses, has one of the schemes and no credentials. Never quoted in a message: it can carry an API key. */
function isUrl(value: string, protocols: readonly string[]): boolean {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return protocols.includes(url.protocol) && url.username === "" && url.password === "";
}

const PHRASE_LENGTHS = [12, 15, 18, 21, 24];

/**
 * The seed of a recovery phrase as BIP-39 defines it: PBKDF2-HMAC-SHA512 over the phrase, 2048 rounds, the salt
 * "mnemonic", 64 bytes. The words are not checked against the word list or its checksum: a mistyped phrase gives other
 * keys, and the `keys` command shows the addresses it gives.
 */
function phraseSeed(words: readonly string[]): Uint8Array {
  return Uint8Array.from(pbkdf2Sync(words.join(" ").normalize("NFKD"), "mnemonic", 2048, 64, "sha512"));
}

/** 64 hexadecimal characters, or a recovery phrase of 12 to 24 words, as the devnet harness reads its own seed. Never quoted. */
function readSeed(env: Env, problems: string[]): Uint8Array | undefined {
  const seed = text(env, "STINT_SELLER_SEED");
  if (!seed) {
    problems.push("STINT_SELLER_SEED is required: a recovery phrase of 12 to 24 words, or 64 hexadecimal characters (openssl rand -hex 32)");
    return undefined;
  }
  if (/^[0-9a-fA-F]{64}$/.test(seed)) return Uint8Array.from(Buffer.from(seed, "hex"));
  const words = seed.toLowerCase().split(/\s+/);
  if (PHRASE_LENGTHS.includes(words.length) && words.every((word) => /^[a-z]+$/.test(word))) return phraseSeed(words);
  problems.push("STINT_SELLER_SEED must be a recovery phrase of 12 to 24 words, or 64 hexadecimal characters");
  return undefined;
}

/** The seed alone, for the `keys` command. */
export function loadSeed(env: Env): Uint8Array {
  const problems: string[] = [];
  const seed = readSeed(env, problems);
  if (!seed) throw new SellerConfigError(problems);
  return seed;
}

export function loadSellerConfig(env: Env): SellerConfig {
  const problems: string[] = [];
  const seed = readSeed(env, problems);

  const rpcUrl = text(env, "STINT_SELLER_RPC_URL");
  if (!rpcUrl) problems.push("STINT_SELLER_RPC_URL is required");
  else if (!isUrl(rpcUrl, ["http:", "https:"])) problems.push("STINT_SELLER_RPC_URL must be an http or https URL");
  const wsUrl = text(env, "STINT_SELLER_WS_URL");
  if (wsUrl && !isUrl(wsUrl, ["ws:", "wss:"])) problems.push("STINT_SELLER_WS_URL must be a ws or wss URL");
  const scanRpcUrl = text(env, "STINT_SELLER_SCAN_RPC_URL");
  if (scanRpcUrl && !isUrl(scanRpcUrl, ["http:", "https:"])) problems.push("STINT_SELLER_SCAN_RPC_URL must be an http or https URL");

  const portText = text(env, "PORT") ?? "8080";
  const port = Number(portText);
  if (!/^\d{1,5}$/.test(portText) || port > 65_535) problems.push(`PORT must be a port number from 0 to 65535, got "${portText}"`);
  const host = text(env, "HOST") ?? "0.0.0.0";

  const originText = text(env, "PUBLIC_ORIGIN");
  let publicOrigin: string | undefined;
  if (!originText) {
    problems.push("PUBLIC_ORIGIN is required: the http or https origin buyers reach the stream at, such as https://stream.example.com");
  } else {
    const url = isUrl(originText, ["http:", "https:"]) ? new URL(originText) : undefined;
    if (!url || url.pathname !== "/" || url.search !== "" || url.hash !== "") {
      problems.push("PUBLIC_ORIGIN must be an http or https origin, with no path, query or credentials");
    } else {
      publicOrigin = url.origin;
    }
  }

  if (problems.length > 0 || !seed || !rpcUrl || !publicOrigin) throw new SellerConfigError(problems);
  return {
    seed,
    rpcUrl,
    wsUrl: wsUrl ?? rpcUrl.replace(/^http/, "ws"),
    ...(scanRpcUrl ? { scanRpcUrl } : {}),
    host,
    port,
    publicOrigin,
  };
}
```

- [ ] **Step 5: Write the keys**

Create `examples/seller/src/keys.ts`:

```ts
import { createHmac } from "node:crypto";
import { createKeyPairSignerFromPrivateKeyBytes, getAddressEncoder, type KeyPairSigner } from "@solana/kit";

/**
 * Which index of the seed is which key: the funding key, which a person funds, then the stack's. An index is an
 * address: never reorder these, or the keys of an earlier deployment, and what they hold, are no longer found.
 */
export const KEY_INDEX = { funding: 0, koraFeePayer: 1, rentPayer: 2, receiverAuthorizer: 3, seller: 4 } as const;
export type KeyRole = keyof typeof KEY_INDEX;

/** The derivation's own label: a seed made for another use gives other keys here. */
export const KEY_LABEL = "stint-example-seller";

export interface SellerKey {
  readonly signer: KeyPairSigner;
  /** The 64 bytes Kora and the facilitator take: the private half, then the public half. */
  readonly secretKey: Uint8Array;
}

export type SellerKeys = { readonly [Role in KeyRole]: SellerKey };

/** The key at `index`: HMAC-SHA-256 of `stint-example-seller/<index>`, keyed by the seed, taken as an Ed25519 private key. */
export async function deriveSellerKey(seed: Uint8Array, index: number): Promise<SellerKey> {
  const privateKey = Uint8Array.from(createHmac("sha256", seed).update(`${KEY_LABEL}/${index}`).digest());
  const signer = await createKeyPairSignerFromPrivateKeyBytes(privateKey);
  return { signer, secretKey: Uint8Array.from([...privateKey, ...getAddressEncoder().encode(signer.address)]) };
}

export async function deriveSellerKeys(seed: Uint8Array): Promise<SellerKeys> {
  const roles = Object.keys(KEY_INDEX) as KeyRole[];
  const keys = await Promise.all(roles.map((role) => deriveSellerKey(seed, KEY_INDEX[role])));
  return Object.fromEntries(roles.map((role, position) => [role, keys[position]!])) as SellerKeys;
}

const ROLES: Readonly<Record<KeyRole, string>> = {
  funding: "funding key: send it devnet SOL; it gives the next two theirs",
  koraFeePayer: "Kora's fee payer: the fees of payments and closes",
  rentPayer: "the rent payer: each open session's accounts, returned at its close",
  receiverAuthorizer: "the receiver authorizer: signs the gate's closes, holds nothing",
  seller: "the seller's wallet: the USDC buyers pay",
};

/** One line per key, funding key first: its address, two spaces, its role. */
export function describeKeys(keys: SellerKeys): string {
  return (Object.keys(KEY_INDEX) as KeyRole[]).map((role) => `${keys[role].signer.address}  ${ROLES[role]}`).join("\n");
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm --filter @lxfoundry/stint-example-seller test && pnpm --filter @lxfoundry/stint-example-seller typecheck`
Expected: PASS, 11 tests; no type error.

- [ ] **Step 7: Commit**

```bash
git add examples/seller/package.json examples/seller/tsconfig.json examples/seller/src/config.ts examples/seller/src/keys.ts examples/seller/test/config.test.ts examples/seller/test/keys.test.ts pnpm-lock.yaml
git commit -m "Add the example seller's configuration and key derivation" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Kora, and the seller's chain set-up

The seller runs Kora as the harness does (`e2e/src/kora/process.ts:41-120`, `e2e/src/kora/config.ts`), and sets its
keys up before it starts: SOL for Kora's fee payer and the rent payer from the funding key, the seller's USDC account,
and the close of the sessions an earlier process left open (deviation 2). The harness's helpers stay in `e2e/`; these
are written here, small and tested.

**Files:**
- Create: `examples/seller/src/kora.ts`, `examples/seller/src/chain.ts`
- Test: `examples/seller/test/kora.test.ts`, `examples/seller/test/chain.test.ts`

**Interfaces:**
- Consumes: `getTransferSolInstruction` (`@solana-program/system` 0.16.0), `getCreateAssociatedTokenIdempotentInstructionAsync`
  (`@solana-program/token` 0.18.0), `getCloseInstruction`, `eventAccounts`, `fetchMaybeSession`, `getSessionDecoder`,
  `getSessionSize`, `SESSION_DISCRIMINATOR`, `paidUntil`, `CloseKind`, `STINT_PROGRAM_ADDRESS` (`@lxfoundry/stint-program-client`;
  `packages/program-client/src/helpers.ts:25-37`, `src/generated/instructions/close.ts:141-166`), `associatedTokenAddress`
  and `redactUrls` (`@lxfoundry/stint-x402`), `fetchSysvarClock` (`@solana/sysvars` 8.5.0, as
  `e2e/src/devnet/funds.ts:272` reads the chain's clock). The rent payer sits at byte 178 of a session account
  (`apps/facilitator/src/sweeper.ts:64`). Kora 2.0.5's `rpc start` takes `--port` and no bind address: it listens on
  `0.0.0.0`, and answers `401` to any request without its API key but `/liveness` (both measured in WSL).
- Produces:
  - from `src/kora.ts`: `KORA_ALLOWED_PROGRAMS`, `SUBSCRIPTIONS_PROGRAM_ADDRESS`, `interface KoraConfigInput`,
    `renderKoraConfig(input): string`, `renderSignersConfig(): string`, `KORA_LOG_TAIL = 64 * 1024`,
    `appendTail(current: string, chunk: string, limit?: number): string`,
    `interface KoraOptions { rpcUrl; config; feePayerSecretKey; apiKey; binary?; workDir? }`,
    `interface KoraProcess { url; apiKey; exit: Promise<number | null>; logs(): string; stop(): Promise<void> }`,
    `startKora(options): Promise<KoraProcess>`;
  - from `src/chain.ts`: `DEVNET_GENESIS_HASH`, `assertDevnet(rpc)`, `assertProgramDeployed(rpc)`,
    `sendInstructions(rpc, feePayer: KeyPairSigner, instructions, pollMs?, timeoutMs?): Promise<Signature>`,
    `lamportsToSend(balance: bigint, target: bigint): bigint`, `FUNDING_MARGIN_LAMPORTS = 10_000_000n`,
    `fundingNeeded(owed: bigint, needsAccount: boolean): bigint`, `topUpSol(rpc, from, to, target): Promise<bigint>`,
    `ensureTokenAccount(rpc, payer, owner, mint): Promise<Address>`, `interface ListedSession { address: Address; stored: Session }`,
    `closableAtStart(sessions, keys: { rentPayer: Address; receiverAuthorizer: Address }, nowSeconds: bigint): Address[]`,
    `listSessionsOf(rpc, rentPayer): Promise<ListedSession[]>`,
    `closeLeftSessions(rpc, scanRpc, funding: KeyPairSigner, keys: { rentPayer: Address; receiverAuthorizer: KeyPairSigner }): Promise<CleanUpReport>`
    (it reads "now" from the chain's Clock sysvar), `interface CleanUpReport { closed: Address[]; failed: { session: Address; error: string }[] }`.

- [ ] **Step 1: Write the failing tests**

Create `examples/seller/test/kora.test.ts`:

```ts
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { USDC_DEVNET } from "@lxfoundry/stint-x402";
import { describe, expect, it } from "vitest";
import { KORA_ALLOWED_PROGRAMS, KORA_LOG_TAIL, appendTail, renderKoraConfig, renderSignersConfig, startKora, type KoraOptions } from "../src/kora.js";

const PROGRAM = "5iCYPqLjCWw5KzQTU6NBUhR2hxg5SWGmS1ctUn3qESvr";
// Under the package, in a git-ignored directory: `/tmp` can be emptied at any time.
const scratch = fileURLToPath(new URL("../.cache/", import.meta.url));

/** Options for a Kora that cannot start, its working directory under the scratch folder. */
function options(binary: string): KoraOptions {
  mkdirSync(scratch, { recursive: true });
  return {
    rpcUrl: "http://127.0.0.1:9",
    config: { allowedPrograms: [...KORA_ALLOWED_PROGRAMS], allowedTokens: [USDC_DEVNET.mint], maxAllowedLamports: 1_000_000 },
    feePayerSecretKey: new Uint8Array(64),
    apiKey: "key",
    binary,
    workDir: scratch,
  };
}

describe("Kora's configuration", () => {
  it("allows only the programs and the token it is given, and no action of the fee payer's own", () => {
    const text = renderKoraConfig({ allowedPrograms: [...KORA_ALLOWED_PROGRAMS, PROGRAM], allowedTokens: [USDC_DEVNET.mint], maxAllowedLamports: 1_000_000 });
    expect(text).toContain(
      `allowed_programs = ["11111111111111111111111111111111", "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", "ComputeBudget111111111111111111111111111111", "${PROGRAM}"]`,
    );
    expect(text).toContain('allowed_tokens = ["4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"]');
    expect(text).toContain("max_allowed_lamports = 1000000");
    expect(text).toContain("sign_and_send_transaction = false");
    expect(text).not.toMatch(/^allow_\w+ = true$/m);
  });

  it("refuses a configuration with no token", () => {
    expect(() => renderKoraConfig({ allowedPrograms: [], allowedTokens: [], maxAllowedLamports: 1 })).toThrow(/at least one allowed token/);
  });

  it("reads the fee payer's key from Kora's environment, not from a file", () => {
    expect(renderSignersConfig()).toContain('private_key_env = "KORA_PRIVATE_KEY"');
  });
});

describe("starting Kora", () => {
  it("says so when its binary cannot be started", async () => {
    await expect(startKora(options("/nonexistent/kora"))).rejects.toThrow(/Could not start Kora \(\/nonexistent\/kora\)/);
  });

  it("says so when it exits before it is ready", async () => {
    // `false` takes any arguments and exits at once with status 1.
    await expect(startKora(options("false"))).rejects.toThrow(/Kora exited during startup/);
  });
});

describe("Kora's log", () => {
  it("keeps the latest 64 KiB of what Kora prints, however long it runs", () => {
    expect(appendTail("abc", "def", 4)).toBe("cdef");
    expect(appendTail("ab", "c", 4)).toBe("abc");
    expect(appendTail("", "x".repeat(KORA_LOG_TAIL + 10))).toHaveLength(KORA_LOG_TAIL);
  });
});
```

Create `examples/seller/test/chain.test.ts`:

```ts
import type { Address } from "@solana/kit";
import type { Session } from "@lxfoundry/stint-program-client";
import { describe, expect, it } from "vitest";
import { FUNDING_MARGIN_LAMPORTS, closableAtStart, fundingNeeded, lamportsToSend, type ListedSession } from "../src/chain.js";

const RENT_PAYER = "SysvarRent111111111111111111111111111111111" as Address;
const AUTHORIZER = "SysvarC1ock11111111111111111111111111111111" as Address;
const OTHER = "Stake11111111111111111111111111111111111111" as Address;
const [A, B, C, D] = [
  "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDyLb",
  "So11111111111111111111111111111111111111112",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
] as Address[];

/** A session of 100 s from 1,000 at 1000 base units a second, the deployment's own unless `fields` say otherwise. */
const listed = (address: Address, fields: Partial<Session> = {}): ListedSession => ({
  address,
  stored: { rentPayer: RENT_PAYER, receiverAuthorizer: AUTHORIZER, startedAt: 1_000n, deposited: 100_000n, rate: 1_000n, ...fields } as unknown as Session,
});

describe("the SOL the stack's keys are given", () => {
  it("tops a key up to its target, and sends nothing to one that holds as much or more", () => {
    expect(lamportsToSend(0n, 50_000_000n)).toBe(50_000_000n);
    expect(lamportsToSend(49_000_000n, 50_000_000n)).toBe(1_000_000n);
    expect(lamportsToSend(50_000_000n, 50_000_000n)).toBe(0n);
    expect(lamportsToSend(70_000_000n, 50_000_000n)).toBe(0n);
  });

  it("asks the funding key for a margin whenever it has to pay, the seller's missing token account included", () => {
    expect(fundingNeeded(0n, false)).toBe(0n);
    expect(fundingNeeded(0n, true)).toBe(FUNDING_MARGIN_LAMPORTS);
    expect(fundingNeeded(5_000_000n, false)).toBe(5_000_000n + FUNDING_MARGIN_LAMPORTS);
    expect(fundingNeeded(5_000_000n, true)).toBe(5_000_000n + FUNDING_MARGIN_LAMPORTS);
  });
});

describe("the sessions the start-up closes", () => {
  it("closes the deployment's own sessions that are still paid for, and leaves the rest to the sweeper or their owner", () => {
    const sessions = [listed(A), listed(B, { startedAt: 900n }), listed(C, { rentPayer: OTHER }), listed(D, { receiverAuthorizer: OTHER })];
    expect(closableAtStart(sessions, { rentPayer: RENT_PAYER, receiverAuthorizer: AUTHORIZER }, 1_050n)).toEqual([A]);
  });

  it("leaves a session alone from its paid_until on", () => {
    expect(closableAtStart([listed(A)], { rentPayer: RENT_PAYER, receiverAuthorizer: AUTHORIZER }, 1_100n)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @lxfoundry/stint-example-seller test kora.test.ts chain.test.ts`
Expected: FAIL: `Failed to load url ../src/kora.js` and `../src/chain.js`.

- [ ] **Step 3: Write the Kora launcher**

Create `examples/seller/src/kora.ts`:

```ts
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { address } from "@solana/kit";
import { redactUrls } from "@lxfoundry/stint-x402";

/** The Subscriptions & Allowances program (spec §10): an open may pull from an allowance. */
export const SUBSCRIPTIONS_PROGRAM_ADDRESS = address("De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44");

/** Programs every transaction may use: System, SPL Token, Associated Token Account, Compute Budget. */
export const KORA_ALLOWED_PROGRAMS = [
  "11111111111111111111111111111111",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  "ComputeBudget111111111111111111111111111111",
] as const;

export interface KoraConfigInput {
  readonly allowedPrograms: readonly string[];
  readonly allowedTokens: readonly string[];
  readonly maxAllowedLamports: number;
}

const list = (values: readonly string[]) => `[${values.map((value) => `"${value}"`).join(", ")}]`;

const SPL_TOKEN_POLICY_KEYS = [
  "allow_transfer",
  "allow_burn",
  "allow_close_account",
  "allow_approve",
  "allow_revoke",
  "allow_set_authority",
  "allow_mint_to",
  "allow_initialize_mint",
  "allow_initialize_account",
  "allow_initialize_multisig",
  "allow_freeze_account",
  "allow_thaw_account",
];

/**
 * Kora 2.0.5's `kora.toml`: free pricing with the `Mock` price source, so Kora asks no outside service for prices;
 * Lighthouse off (spec §6.2); a fee-payer policy that forbids every action but paying fees, each flag written out. In
 * Kora 2.0.5, once a section exists, all of its keys are required.
 */
export function renderKoraConfig(input: KoraConfigInput): string {
  if (input.allowedTokens.length === 0) throw new Error("Kora needs at least one allowed token");
  return [
    "[kora]",
    "rate_limit = 100",
    "",
    "[kora.auth]",
    "",
    "[kora.lighthouse]",
    "enabled = false",
    "",
    "[kora.enabled_methods]",
    "liveness = true",
    "estimate_transaction_fee = true",
    "get_supported_tokens = true",
    "get_payer_signer = true",
    "sign_transaction = true",
    "sign_and_send_transaction = false",
    "transfer_transaction = false",
    "get_blockhash = true",
    "get_config = true",
    "",
    "[validation]",
    `max_allowed_lamports = ${input.maxAllowedLamports}`,
    "max_signatures = 10",
    'price_source = "Mock"',
    "allow_durable_transactions = false",
    `allowed_programs = ${list(input.allowedPrograms)}`,
    `allowed_tokens = ${list(input.allowedTokens)}`,
    "allowed_spl_paid_tokens = []",
    "disallowed_accounts = []",
    "",
    "[validation.price]",
    'type = "free"',
    "",
    "[validation.fee_payer_policy.system]",
    "allow_transfer = false",
    "allow_assign = false",
    "allow_create_account = false",
    "allow_allocate = false",
    "",
    "[validation.fee_payer_policy.spl_token]",
    ...SPL_TOKEN_POLICY_KEYS.map((key) => `${key} = false`),
    "",
    "[validation.fee_payer_policy.token_2022]",
    ...SPL_TOKEN_POLICY_KEYS.map((key) => `${key} = false`),
    "",
  ].join("\n");
}

/** One memory signer whose key comes from `KORA_PRIVATE_KEY`, a JSON array of 64 bytes. */
export function renderSignersConfig(): string {
  return ["[signer_pool]", 'strategy = "round_robin"', "", "[[signers]]", 'name = "fee_payer"', 'type = "memory"', 'private_key_env = "KORA_PRIVATE_KEY"', ""].join("\n");
}

export interface KoraOptions {
  readonly rpcUrl: string;
  readonly config: KoraConfigInput;
  readonly feePayerSecretKey: Uint8Array;
  readonly apiKey: string;
  /** The `kora` binary: `KORA_BIN`, or `kora` on the PATH. */
  readonly binary?: string;
  /** Where Kora's working directory is made. Default: the system's temporary directory. */
  readonly workDir?: string;
}

export interface KoraProcess {
  readonly url: string;
  readonly apiKey: string;
  /** Settles when Kora exits, with its exit code (`null` when a signal ended it): whoever started it can watch it. */
  readonly exit: Promise<number | null>;
  /** The latest `KORA_LOG_TAIL` characters Kora printed, every URL cut to its scheme and host. */
  logs(): string;
  stop(): Promise<void>;
}

/** How much of Kora's output is kept: the latest 64 KiB, for a process that may run for weeks. */
export const KORA_LOG_TAIL = 64 * 1024;

/** `current` and `chunk` together, cut to their last `limit` characters. */
export function appendTail(current: string, chunk: string, limit = KORA_LOG_TAIL): string {
  const next = current + chunk;
  return next.length > limit ? next.slice(next.length - limit) : next;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

/**
 * Runs Kora in a fresh working directory: Kora reads a `.env` from its working directory, so a clean one keeps anything
 * else out. Its key reaches it only through its environment. Kora 2.0.5 has no bind option: it listens on every
 * interface at `port`, and refuses any request without `apiKey` but `GET /liveness`; where only declared ports are
 * public, as on Fly.io, nothing outside the machine reaches it. Ready once `GET /liveness` answers.
 */
export async function startKora(options: KoraOptions): Promise<KoraProcess> {
  const directory = mkdtempSync(join(options.workDir ?? tmpdir(), "stint-kora-"));
  const cleanUp = () => rmSync(directory, { recursive: true, force: true });
  const binary = options.binary ?? process.env.KORA_BIN ?? "kora";
  let stop: (() => Promise<void>) | undefined;
  try {
    writeFileSync(join(directory, "kora.toml"), renderKoraConfig(options.config));
    writeFileSync(join(directory, "signers.toml"), renderSignersConfig());
    const port = await freePort();
    const child = spawn(
      binary,
      ["--config", "kora.toml", "--rpc-url", options.rpcUrl, "rpc", "start", "--signers-config", "signers.toml", "--port", String(port)],
      {
        cwd: directory,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? directory,
          KORA_PRIVATE_KEY: JSON.stringify(Array.from(options.feePayerSecretKey)),
          KORA_API_KEY: options.apiKey,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    child.stdout.on("data", (chunk) => (output = appendTail(output, String(chunk))));
    child.stderr.on("data", (chunk) => (output = appendTail(output, String(chunk))));
    let exited = false;
    let spawnError: Error | undefined;
    const exit = new Promise<number | null>((resolve) => {
      child.once("exit", (code) => ((exited = true), resolve(code)));
      // A binary that cannot be started emits "error" and never "exit".
      child.once("error", (error) => ((spawnError = error), (exited = true), resolve(null)));
    });
    const url = `http://127.0.0.1:${port}`;
    stop = async () => {
      if (!exited) {
        child.kill("SIGINT"); // Kora 2.0.5 shuts down on Ctrl-C only.
        let timer: NodeJS.Timeout | undefined;
        const late = new Promise<"late">((resolve) => {
          timer = setTimeout(() => resolve("late"), 5_000);
        });
        try {
          if ((await Promise.race([exit, late])) === "late") child.kill("SIGKILL");
        } finally {
          clearTimeout(timer);
        }
        await exit;
      }
      cleanUp();
    };
    const deadline = Date.now() + 30_000;
    let delay = 50;
    while (Date.now() < deadline) {
      if (spawnError) throw new Error(`Could not start Kora (${binary}): ${spawnError.message}`);
      // Kora quotes the RPC URL in its errors, and the URL can carry a key.
      if (exited) throw new Error(`Kora exited during startup:\n${redactUrls(output)}`);
      try {
        const response = await fetch(`${url}/liveness`);
        if (response.ok) return { url, apiKey: options.apiKey, exit, logs: () => redactUrls(output), stop };
      } catch {
        // Not listening yet.
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, 1_000);
    }
    throw new Error(`Kora was not ready within 30 s:\n${redactUrls(output)}`);
  } catch (error) {
    await stop?.();
    cleanUp();
    throw error;
  }
}
```

- [ ] **Step 4: Write the chain set-up**

Create `examples/seller/src/chain.ts`:

```ts
import { getTransferSolInstruction } from "@solana-program/system";
import { getCreateAssociatedTokenIdempotentInstructionAsync } from "@solana-program/token";
import {
  appendTransactionMessageInstructions,
  createTransactionMessage,
  fetchEncodedAccount,
  getBase58Decoder,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type Base58EncodedBytes,
  type Instruction,
  type KeyPairSigner,
  type Rpc,
  type Signature,
  type SolanaRpcApi,
} from "@solana/kit";
import {
  CloseKind,
  SESSION_DISCRIMINATOR,
  STINT_PROGRAM_ADDRESS,
  eventAccounts,
  fetchMaybeSession,
  getCloseInstruction,
  getSessionDecoder,
  getSessionSize,
  paidUntil,
  type Session,
} from "@lxfoundry/stint-program-client";
import { associatedTokenAddress, redactUrls } from "@lxfoundry/stint-x402";
import { fetchSysvarClock } from "@solana/sysvars";

/** Devnet's genesis hash: the network identifier `solana:EtWT…` is its first 32 characters (spec §5.1). */
export const DEVNET_GENESIS_HASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
/** Where a session account stores `rent_payer` (`programs/stint/src/state.rs`; the sweeper filters on it too). */
const RENT_PAYER_OFFSET = 178n;

const json = (value: unknown) => JSON.stringify(value, (_, inner) => (typeof inner === "bigint" ? inner.toString() : inner));

/** Refuses to go on unless the RPC is devnet's: nothing this process sends may reach another network. */
export async function assertDevnet(rpc: Rpc<SolanaRpcApi>): Promise<void> {
  const genesis = await rpc.getGenesisHash().send();
  if (genesis !== DEVNET_GENESIS_HASH) throw new Error(`The RPC reports genesis hash ${genesis}, which is not devnet's: refusing to start`);
}

export async function assertProgramDeployed(rpc: Rpc<SolanaRpcApi>): Promise<void> {
  const account = await rpc.getAccountInfo(STINT_PROGRAM_ADDRESS, { encoding: "base64" }).send();
  if (!account.value?.executable) throw new Error(`The Stint program ${STINT_PROGRAM_ADDRESS} is not deployed on this network`);
}

/** Builds, signs and sends a version 0 transaction (spec §3.5), then waits for `confirmed`; throws if it failed. */
export async function sendInstructions(
  rpc: Rpc<SolanaRpcApi>,
  feePayer: KeyPairSigner,
  instructions: readonly Instruction[],
  pollMs = 400,
  timeoutMs = 30_000,
): Promise<Signature> {
  const { value: lifetime } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(lifetime, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  const transaction = await signTransactionMessageWithSigners(message);
  const signature = getSignatureFromTransaction(transaction);
  await rpc.sendTransaction(getBase64EncodedWireTransaction(transaction), { encoding: "base64", preflightCommitment: "confirmed" }).send();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { value } = await rpc.getSignatureStatuses([signature]).send();
    const status = value[0];
    if (status?.err) throw new Error(`Transaction ${signature} failed: ${json(status.err)}`);
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") return signature;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error(`Transaction ${signature} was not confirmed within ${timeoutMs} ms`);
}

/** What brings `balance` up to `target`: nothing when it holds as much or more. */
export const lamportsToSend = (balance: bigint, target: bigint): bigint => (balance < target ? target - balance : 0n);

/**
 * What the funding key holds on top of what it sends at a start: the rent of the seller's token account (2,039,280
 * lamports) and of the token accounts the clean-up may create, and the start-up's fees.
 */
export const FUNDING_MARGIN_LAMPORTS = 10_000_000n;

/**
 * What the funding key must hold for a start: what it owes the stack's keys and the margin, whenever it has anything to
 * pay, the seller's missing token account included; nothing when it has nothing to pay.
 */
export const fundingNeeded = (owed: bigint, needsAccount: boolean): bigint =>
  owed > 0n || needsAccount ? owed + FUNDING_MARGIN_LAMPORTS : 0n;

/** Tops `to` up to `target` lamports from `from`, which pays the fee. Returns what it sent. */
export async function topUpSol(rpc: Rpc<SolanaRpcApi>, from: KeyPairSigner, to: Address, target: bigint): Promise<bigint> {
  const { value: balance } = await rpc.getBalance(to, { commitment: "confirmed" }).send();
  const amount = lamportsToSend(balance, target);
  if (amount > 0n) await sendInstructions(rpc, from, [getTransferSolInstruction({ source: from, destination: to, amount })]);
  return amount;
}

/** The owner's associated token account for `mint`, created by `payer` if it does not exist yet. */
export async function ensureTokenAccount(rpc: Rpc<SolanaRpcApi>, payer: KeyPairSigner, owner: Address, mint: Address): Promise<Address> {
  const account = await associatedTokenAddress(owner, mint);
  if ((await fetchEncodedAccount(rpc, account, { commitment: "confirmed" })).exists) return account;
  await sendInstructions(rpc, payer, [await getCreateAssociatedTokenIdempotentInstructionAsync({ payer, owner, mint })]);
  return account;
}

export interface ListedSession {
  readonly address: Address;
  readonly stored: Session;
}

/**
 * The sessions a start-up closes: those this deployment opened (its rent payer) for its gate (its receiver authorizer)
 * whose paid time has not run out. The receiver authorizer may close them before `paid_until` (spec §4.3); from then on
 * the sweeper closes them, as it closes any expired session naming the facilitator's rent payer (spec §6.4).
 */
export function closableAtStart(
  sessions: readonly ListedSession[],
  keys: { readonly rentPayer: Address; readonly receiverAuthorizer: Address },
  nowSeconds: bigint,
): Address[] {
  return sessions
    .filter(({ stored }) => stored.rentPayer === keys.rentPayer && stored.receiverAuthorizer === keys.receiverAuthorizer && paidUntil(stored) > nowSeconds)
    .map(({ address }) => address);
}

/** The program's sessions whose rent `rentPayer` paid. */
export async function listSessionsOf(rpc: Rpc<SolanaRpcApi>, rentPayer: Address): Promise<ListedSession[]> {
  const accounts = await rpc
    .getProgramAccounts(STINT_PROGRAM_ADDRESS, {
      commitment: "confirmed",
      encoding: "base64",
      filters: [
        { dataSize: BigInt(getSessionSize()) },
        { memcmp: { offset: 0n, bytes: getBase58Decoder().decode(SESSION_DISCRIMINATOR) as Base58EncodedBytes, encoding: "base58" } },
        { memcmp: { offset: RENT_PAYER_OFFSET, bytes: rentPayer as string as Base58EncodedBytes, encoding: "base58" } },
      ],
    })
    .send();
  const decoder = getSessionDecoder();
  const base64 = getBase64Encoder();
  return accounts.map(({ pubkey, account }) => ({ address: pubkey, stored: decoder.decode(base64.encode(account.data[0])) }));
}

export interface CleanUpReport {
  readonly closed: Address[];
  readonly failed: { readonly session: Address; readonly error: string }[];
}

/** The chain's clock, in Unix seconds, from the Clock sysvar: the program decides by it, not by this machine's. */
async function chainNow(rpc: Rpc<SolanaRpcApi>): Promise<bigint> {
  return (await fetchSysvarClock(rpc, { commitment: "confirmed" })).unixTimestamp;
}

/**
 * Closes the sessions an earlier process left open (`closableAtStart`, on the chain's clock), each with a `Standard`
 * close signed by the receiver authorizer, its fee paid by the funding key: the seller is paid for the time used, the
 * buyer refunded the rest. Each is read again on `rpc` first, since `scanRpc` may be another node. Before `paid_until`
 * the close needs the buyer's refund account, and it always needs the receiver's: the same transaction first creates
 * both if they are gone, paid by the funding key, so nothing is half done (a transaction is atomic). A close that fails
 * is reported, and the session is left to the sweeper at its paid time. Never throws for one session.
 */
export async function closeLeftSessions(
  rpc: Rpc<SolanaRpcApi>,
  scanRpc: Rpc<SolanaRpcApi>,
  funding: KeyPairSigner,
  keys: { readonly rentPayer: Address; readonly receiverAuthorizer: KeyPairSigner },
): Promise<CleanUpReport> {
  const mine = { rentPayer: keys.rentPayer, receiverAuthorizer: keys.receiverAuthorizer.address };
  const report: { closed: Address[]; failed: { session: Address; error: string }[] } = { closed: [], failed: [] };
  for (const session of closableAtStart(await listSessionsOf(scanRpc, keys.rentPayer), mine, await chainNow(rpc))) {
    try {
      const current = await fetchMaybeSession(rpc, session, { commitment: "confirmed" });
      // Read just before the close is built: a session read as paid for that lands after `paid_until` only creates the
      // refund account for nothing, but one read as expired is the sweeper's.
      if (!current.exists || closableAtStart([{ address: session, stored: current.data }], mine, await chainNow(rpc)).length === 0) continue;
      const stored = current.data;
      await sendInstructions(rpc, funding, [
        await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: funding, owner: stored.receiver, mint: stored.mint }),
        await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: funding, owner: stored.refundOwner, mint: stored.mint }),
        getCloseInstruction({
          closer: keys.receiverAuthorizer,
          session,
          vault: await associatedTokenAddress(session, stored.mint),
          receiverToken: await associatedTokenAddress(stored.receiver, stored.mint),
          refundTo: await associatedTokenAddress(stored.refundOwner, stored.mint),
          rentPayer: stored.rentPayer,
          ...(await eventAccounts()),
          kind: CloseKind.Standard,
        }),
      ]);
      report.closed.push(session);
    } catch (error) {
      report.failed.push({ session, error: redactUrls(error instanceof Error ? error.message : String(error)) });
    }
  }
  return report;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @lxfoundry/stint-example-seller test && pnpm --filter @lxfoundry/stint-example-seller typecheck`
Expected: PASS, 21 tests; no type error. The Kora tests leave nothing under the system's temporary directory: their
working directories go under `examples/seller/.cache/`.

- [ ] **Step 6: Commit**

```bash
git add examples/seller/src/kora.ts examples/seller/src/chain.ts examples/seller/test/kora.test.ts examples/seller/test/chain.test.ts
git commit -m "Add the example seller's Kora launcher and chain set-up" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The seller's composition and entry point

`startSeller` does what `startDevnetStack` and `startServices` do for one gate (`e2e/src/targets/devnet.ts:122-166`,
`e2e/src/targets/services.ts:121-224`): devnet and program checks, funding, the clean-up, then Kora (behind its API key),
the facilitator with its sweeper on 127.0.0.1, and the stream with its gate on `$HOST:$PORT` at the public origin. It
watches Kora: if Kora exits, the seller's `failed` settles and the entry point exits non-zero.

**Files:**
- Create: `examples/seller/src/seller.ts`, `examples/seller/src/main.ts`, `examples/seller/src/index.ts`
- Test: `examples/seller/test/seller.test.ts`

**Interfaces:**
- Consumes: Tasks 1 to 3; `startFacilitator(config: FacilitatorConfig): Promise<RunningFacilitator>`
  (`apps/facilitator/src/server.ts:13-43, 58`; `host` defaults to 127.0.0.1, `sweeper: { intervalMs, scanRpcUrl }`),
  `createFacilitatorClient(url, apiKey)` and `createRpcChain(rpc, subscriptions)` (`@lxfoundry/stint-gate`), `startStream`
  and `StreamConfig` (`@lxfoundry/stint-example-stream`), `SOLANA_DEVNET`, `USDC_DEVNET`, `redactUrls`, `Terms`,
  `RetryOptions` (`@lxfoundry/stint-x402`).
- Produces: `SELLER_TERMS: Terms`, `SELLER_DURATIONS`, `IDLE_CLOSE_SECONDS = 60`, `SWEEPER_INTERVAL_MS = 10_000`,
  `STACK_LAMPORTS = 50_000_000n`, `type Log = (entry: Record<string, unknown>) => void`, `jsonLog: Log`,
  `sellerGateSettings(keys: { seller: Address; receiverAuthorizer: KeyPairSigner })`,
  `interface RunningSeller { url: string; origin: string; keys: SellerKeys; failed: Promise<string>; stop(): Promise<void> }`
  (`failed` settles, with why, if Kora exits while the seller runs), `startSeller(config: SellerConfig, log?: Log):
  Promise<RunningSeller>`; the command `tsx src/main.ts [keys]`, which exits non-zero when `failed` settles, so that
  the platform restarts the process.

- [ ] **Step 1: Write the failing test**

Create `examples/seller/test/seller.test.ts`:

```ts
import { generateKeyPairSigner } from "@solana/kit";
import { startStream, type RunningStream } from "@lxfoundry/stint-example-stream";
import type { FacilitatorClient, GateChain } from "@lxfoundry/stint-gate";
import { HEADERS, SOLANA_DEVNET, decodePaymentRequiredHeader, readElapsedRequirements } from "@lxfoundry/stint-x402";
import { afterEach, describe, expect, it } from "vitest";
import { IDLE_CLOSE_SECONDS, SELLER_TERMS, sellerGateSettings } from "../src/seller.js";

const PROGRAM = "5iCYPqLjCWw5KzQTU6NBUhR2hxg5SWGmS1ctUn3qESvr";

async function fakes(): Promise<{ facilitator: FacilitatorClient; chain: GateChain }> {
  const [feePayer, rentPayer] = await Promise.all([generateKeyPairSigner(), generateKeyPairSigner()]);
  return {
    facilitator: {
      supported: async () => ({
        kinds: [
          {
            x402Version: 2,
            scheme: "elapsed",
            network: SOLANA_DEVNET,
            extra: { feePayer: feePayer.address, rentPayer: rentPayer.address, programId: PROGRAM, closeUrl: "http://127.0.0.1:9/close" },
          },
        ],
        extensions: [],
        signers: {},
      }),
      verify: async () => {
        throw new Error("no payment in this test");
      },
      settle: async () => {
        throw new Error("no payment in this test");
      },
    },
    chain: {
      latestBlockhash: async () => ({ blockhash: "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N", lastValidBlockHeight: 100n }),
      readSession: async () => undefined,
      closedEvent: async () => undefined,
    },
  };
}

describe("the seller's offer", () => {
  let stream: RunningStream | undefined;
  afterEach(async () => {
    await stream?.stop();
    stream = undefined;
  });

  it("is 100 s at 0.001 USDC a second, from 5 s to 300 s, at the public origin, with a 60 s idle close", async () => {
    const seller = (await generateKeyPairSigner()).address;
    const receiverAuthorizer = await generateKeyPairSigner();
    stream = await startStream({
      rpcWsUrl: "ws://127.0.0.1:9",
      origin: "https://seller.example",
      gate: { ...sellerGateSettings({ seller, receiverAuthorizer }), ...(await fakes()) },
    });

    const response = await fetch(`${stream.url}/sessions`, { method: "POST" });
    expect(response.status).toBe(402);
    const required = decodePaymentRequiredHeader(response.headers.get(HEADERS.paymentRequired)!);
    expect(required.resource?.url).toBe("https://seller.example/sessions");
    expect(required.accepts).toHaveLength(1);
    const offer = readElapsedRequirements(required.accepts[0]);
    expect(offer).toMatchObject({ amount: "100000", payTo: seller, maxTimeoutSeconds: 30 });
    expect(offer?.extra).toMatchObject({
      action: "open",
      rate: "1000",
      seconds: 100,
      minSeconds: 5,
      maxSeconds: 300,
      receiverAuthorizer: receiverAuthorizer.address,
      idleCloseSeconds: IDLE_CLOSE_SECONDS,
    });
    expect(SELLER_TERMS).toEqual({ rate: 1_000n, minSeconds: 5, maxSeconds: 300 });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @lxfoundry/stint-example-seller test seller.test.ts`
Expected: FAIL: `Failed to load url ../src/seller.js`.

- [ ] **Step 3: Write the composition**

Create `examples/seller/src/seller.ts`:

```ts
import { randomUUID } from "node:crypto";
import {
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  fetchEncodedAccount,
  type Address,
  type KeyPairSigner,
  type Rpc,
  type SolanaRpcApi,
} from "@solana/kit";
import { startStream, type StreamConfig } from "@lxfoundry/stint-example-stream";
import { startFacilitator } from "@lxfoundry/stint-facilitator";
import { createFacilitatorClient, createRpcChain } from "@lxfoundry/stint-gate";
import { STINT_PROGRAM_ADDRESS } from "@lxfoundry/stint-program-client";
import { SOLANA_DEVNET, USDC_DEVNET, associatedTokenAddress, redactUrls, type RetryOptions, type Terms } from "@lxfoundry/stint-x402";
import { assertDevnet, assertProgramDeployed, closeLeftSessions, ensureTokenAccount, fundingNeeded, lamportsToSend, topUpSol } from "./chain.js";
import type { SellerConfig } from "./config.js";
import { deriveSellerKeys, type SellerKeys } from "./keys.js";
import { KORA_ALLOWED_PROGRAMS, SUBSCRIPTIONS_PROGRAM_ADDRESS, startKora } from "./kora.js";

/** 1000 base units of devnet USDC a second (0.001 USDC/s), from 5 s to 300 s. */
export const SELLER_TERMS: Terms = { rate: 1_000n, minSeconds: 5, maxSeconds: 300 };
/** What a request that names no duration is offered. */
export const SELLER_DURATIONS = [100] as const;
/** A session nobody connects to for this long is closed by the gate (spec §7.5). */
export const IDLE_CLOSE_SECONDS = 60;
/** Between the sweeper's listings of the program's sessions; within a public endpoint's rate limits. */
export const SWEEPER_INTERVAL_MS = 10_000;
/** What Kora's fee payer and the rent payer are topped up to at each start: 0.05 SOL. */
export const STACK_LAMPORTS = 50_000_000n;
/** A public node can lag: reads of what a transaction just did are tried for up to 10 s. */
const READ_RETRY: RetryOptions = { attempts: 20, delayMs: 500 };
/** Devnet's blockhashes last about a minute: an offer may not outlast its own (spec §5.1). */
const MAX_TIMEOUT_SECONDS = 30;

export type Log = (entry: Record<string, unknown>) => void;

/** One JSON line per entry on stdout, every URL cut to its scheme and host: an RPC URL can carry an API key. */
export const jsonLog: Log = (entry) => console.log(redactUrls(JSON.stringify({ at: new Date().toISOString(), ...entry })));

/** The gate's settings but its facilitator, its chain and its log: the offer this example sells. */
export function sellerGateSettings(keys: { readonly seller: Address; readonly receiverAuthorizer: KeyPairSigner }): Omit<StreamConfig["gate"], "facilitator" | "chain" | "log"> {
  return {
    network: SOLANA_DEVNET,
    asset: USDC_DEVNET,
    payTo: keys.seller,
    receiverAuthorizer: keys.receiverAuthorizer,
    terms: SELLER_TERMS,
    durations: SELLER_DURATIONS,
    idleCloseSeconds: IDLE_CLOSE_SECONDS,
    maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
    readRetry: READ_RETRY,
  };
}

export interface RunningSeller {
  /** Where the stream listens. */
  readonly url: string;
  /** Where buyers reach it. */
  readonly origin: string;
  readonly keys: SellerKeys;
  /**
   * Settles, with why, if Kora exits while the seller runs: payments and closes then fail, so whoever runs the seller
   * stops it and starts it again (the entry point exits non-zero, and Fly.io restarts the machine).
   */
  readonly failed: Promise<string>;
  /** Stops the stream and its gate, the facilitator and its sweeper, then Kora. */
  stop(): Promise<void>;
}

/**
 * Tops Kora's fee payer and the rent payer up from the funding key, and creates the seller's USDC account. The funding
 * key's balance is checked first whenever it has anything to pay, the seller's missing token account included, so that
 * a short key is named with what it needs rather than found by a failed transaction.
 */
async function fundStack(rpc: Rpc<SolanaRpcApi>, keys: SellerKeys): Promise<void> {
  const funding = keys.funding.signer;
  const balanceOf = async (owner: Address) => (await rpc.getBalance(owner, { commitment: "confirmed" }).send()).value;
  const owed =
    lamportsToSend(await balanceOf(keys.koraFeePayer.signer.address), STACK_LAMPORTS) +
    lamportsToSend(await balanceOf(keys.rentPayer.signer.address), STACK_LAMPORTS);
  const sellerUsdc = await associatedTokenAddress(keys.seller.signer.address, USDC_DEVNET.mint);
  const needsAccount = !(await fetchEncodedAccount(rpc, sellerUsdc, { commitment: "confirmed" })).exists;
  const needed = fundingNeeded(owed, needsAccount);
  const held = await balanceOf(funding.address);
  if (held < needed) {
    throw new Error(`The funding key ${funding.address} holds ${held} lamports and needs ${needed}: send it devnet SOL`);
  }
  await topUpSol(rpc, funding, keys.koraFeePayer.signer.address, STACK_LAMPORTS);
  await topUpSol(rpc, funding, keys.rentPayer.signer.address, STACK_LAMPORTS);
  await ensureTokenAccount(rpc, funding, keys.seller.signer.address, USDC_DEVNET.mint);
}

/**
 * The example seller (spec §6, §7, §8): Kora behind its API key, the facilitator with its sweeper on 127.0.0.1, and
 * the stream with its gate on `config.host:config.port`, announcing `config.publicOrigin`. It starts only on devnet,
 * with the program deployed, once its keys hold their SOL and the sessions an earlier process left open are closed.
 */
export async function startSeller(config: SellerConfig, log: Log = jsonLog): Promise<RunningSeller> {
  const rpc = createSolanaRpc(config.rpcUrl);
  const scanRpc = config.scanRpcUrl ? createSolanaRpc(config.scanRpcUrl) : rpc;
  const keys = await deriveSellerKeys(config.seed);
  await assertDevnet(rpc);
  // The scan endpoint decides which sessions the start-up closes: it must be devnet's too.
  if (scanRpc !== rpc) await assertDevnet(scanRpc);
  await assertProgramDeployed(rpc);
  await fundStack(rpc, keys);
  const cleaned = await closeLeftSessions(rpc, scanRpc, keys.funding.signer, {
    rentPayer: keys.rentPayer.signer.address,
    receiverAuthorizer: keys.receiverAuthorizer.signer,
  });
  log({ event: "start_clean_up", closed: cleaned.closed, failed: cleaned.failed });

  // Filled as each service starts, the last started first: the stops run in that order.
  const stops: (() => Promise<void>)[] = [];
  const stop = async (): Promise<void> => {
    for (const next of stops.splice(0)) {
      try {
        await next();
      } catch (error) {
        log({ event: "stop_error", error: error instanceof Error ? error.message : String(error) });
      }
    }
  };
  try {
    const kora = await startKora({
      rpcUrl: config.rpcUrl,
      config: {
        allowedPrograms: [...KORA_ALLOWED_PROGRAMS, STINT_PROGRAM_ADDRESS, SUBSCRIPTIONS_PROGRAM_ADDRESS],
        allowedTokens: [USDC_DEVNET.mint],
        maxAllowedLamports: 1_000_000,
      },
      feePayerSecretKey: keys.koraFeePayer.secretKey,
      apiKey: randomUUID(),
    });
    let stopping = false;
    stops.unshift(async () => {
      stopping = true;
      await kora.stop();
    });
    // Kora's exit is the seller's failure, unless the seller is stopping it.
    const failed = kora.exit.then(async (code) => {
      if (stopping) return new Promise<string>(() => {});
      const reason = `Kora exited (status ${code ?? "none: a signal ended it"})`;
      log({ event: "kora_exited", code, output: kora.logs() });
      return reason;
    });
    const facilitatorApiKey = randomUUID();
    const facilitator = await startFacilitator({
      rpcUrl: config.rpcUrl,
      network: SOLANA_DEVNET,
      kora: { url: kora.url, apiKey: kora.apiKey },
      rentPayerSecretKey: keys.rentPayer.secretKey,
      apiKeys: [facilitatorApiKey],
      readRetry: READ_RETRY,
      sweeper: { intervalMs: SWEEPER_INTERVAL_MS, scanRpcUrl: config.scanRpcUrl },
      log,
    });
    stops.unshift(() => facilitator.stop());
    const stream = await startStream({
      host: config.host,
      port: config.port,
      origin: config.publicOrigin,
      rpcWsUrl: config.wsUrl,
      gate: {
        ...sellerGateSettings({ seller: keys.seller.signer.address, receiverAuthorizer: keys.receiverAuthorizer.signer }),
        facilitator: createFacilitatorClient(facilitator.url, facilitatorApiKey),
        // The gate follows each session's account over the node's WebSocket (spec §7.3).
        chain: createRpcChain(rpc, createSolanaRpcSubscriptions(config.wsUrl)),
        log,
      },
    });
    stops.unshift(() => stream.stop());
    log({ event: "ready", url: stream.url, origin: config.publicOrigin, seller: keys.seller.signer.address });
    return { url: stream.url, origin: config.publicOrigin, keys, failed, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
```

- [ ] **Step 4: Write the entry point and the package's exports**

Create `examples/seller/src/main.ts`:

```ts
import { redactUrls } from "@lxfoundry/stint-x402";
import { SellerConfigError, loadSeed, loadSellerConfig } from "./config.js";
import { deriveSellerKeys, describeKeys } from "./keys.js";
import { startSeller } from "./seller.js";

/**
 * `tsx src/main.ts keys` prints the deployment's addresses from `STINT_SELLER_SEED` alone, with no network; with no
 * argument, it starts the seller and stops it on SIGINT or SIGTERM, with status 0. If Kora exits while it runs, it
 * stops the rest and exits with status 1, so that the platform starts it again.
 */
async function main(): Promise<void> {
  if (process.argv[2] === "keys") {
    process.stdout.write(`${describeKeys(await deriveSellerKeys(loadSeed(process.env)))}\n`);
    return;
  }
  const seller = await startSeller(loadSellerConfig(process.env));
  let stopping = false;
  const stop = (status: number) => {
    if (stopping) return;
    stopping = true;
    seller.stop().then(
      () => process.exit(status),
      () => process.exit(1),
    );
  };
  process.once("SIGINT", () => stop(0));
  process.once("SIGTERM", () => stop(0));
  void seller.failed.then((reason) => {
    console.error(reason);
    stop(1);
  });
}

main().catch((error: unknown) => {
  console.error(error instanceof SellerConfigError ? error.message : redactUrls(error instanceof Error ? (error.stack ?? error.message) : String(error)));
  process.exit(1);
});
```

Create `examples/seller/src/index.ts`:

```ts
export { SellerConfigError, loadSeed, loadSellerConfig, type SellerConfig } from "./config.js";
export { KEY_INDEX, deriveSellerKey, deriveSellerKeys, describeKeys, type SellerKey, type SellerKeys } from "./keys.js";
export { IDLE_CLOSE_SECONDS, SELLER_DURATIONS, SELLER_TERMS, jsonLog, sellerGateSettings, startSeller, type Log, type RunningSeller } from "./seller.js";
```

- [ ] **Step 5: Run the tests and the keys command**

Run: `pnpm --filter @lxfoundry/stint-example-seller test && pnpm --filter @lxfoundry/stint-example-seller typecheck`
Expected: PASS, 22 tests; no type error.

Run: `STINT_SELLER_SEED=$(printf 'ab%.0s' $(seq 32)) pnpm --filter @lxfoundry/stint-example-seller start keys`
Expected: five lines, each a base58 address, two spaces and a role, the first `… funding key: send it devnet SOL; it
gives the next two theirs`. No network request is made.

Run: `pnpm --filter @lxfoundry/stint-example-seller start`
Expected: exit 1, with `Invalid configuration:` and the three "is required" lines on stderr.

- [ ] **Step 6: Commit**

```bash
git add examples/seller/src/seller.ts examples/seller/src/main.ts examples/seller/src/index.ts examples/seller/test/seller.test.ts
git commit -m "Compose Kora, the facilitator and the example stream into the example seller" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: The seller's image, its Fly.io app and its guide

**Files:**
- Create: `examples/seller/Dockerfile`, `examples/seller/Dockerfile.dockerignore`, `examples/seller/fly.toml`,
  `examples/seller/README.md`

**Interfaces:**
- Consumes: CI's Kora install (`.github/workflows/ci.yml`, steps "System packages" and "Anchor and Kora":
  `cargo install kora-cli --version "$KORA_VERSION" --locked` after `build-essential pkg-config libudev-dev llvm
  libclang-dev protobuf-compiler libssl-dev`); Task 4's `tsx src/main.ts`.
- Produces: an image that runs `node_modules/.bin/tsx examples/seller/src/main.ts` as the `node` user, listening on
  8080; the Fly.io app `stint-demo` with one always-on machine.

- [ ] **Step 1: Write the Dockerfile and its ignore file**

Create `examples/seller/Dockerfile`:

```dockerfile
# syntax=docker/dockerfile:1
# The example seller, built from the repository root:
#   docker build -f examples/seller/Dockerfile .
# Kora is built from source, as continuous integration installs it; the workspace runs from source with tsx.

FROM rust:1.99.1-bookworm AS kora
RUN apt-get update \
  && apt-get install -y --no-install-recommends pkg-config libudev-dev llvm libclang-dev protobuf-compiler libssl-dev \
  && rm -rf /var/lib/apt/lists/*
RUN cargo install kora-cli --version 2.0.5 --locked

FROM node:24.22.0-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates libssl3 libudev1 \
  && rm -rf /var/lib/apt/lists/*
COPY --from=kora /usr/local/cargo/bin/kora /usr/local/bin/kora
# Fails the build if Kora needs a library this image lacks.
RUN ! ldd /usr/local/bin/kora | grep -q "not found"
RUN npm install -g pnpm@12.14.0
WORKDIR /app
# Every workspace project is copied, so that the lockfile's importers are all there; only the seller's graph is installed.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages packages
COPY apps apps
COPY examples examples
COPY conformance conformance
COPY e2e e2e
# The seller and what it depends on, with the root's development dependencies (tsx among them); not the end-to-end
# harness, its native Surfpool, or the other examples' dependencies.
RUN pnpm install --frozen-lockfile --filter "@lxfoundry/stint-example-seller..." \
  && test -x node_modules/.bin/tsx
ENV HOST=0.0.0.0 PORT=8080
EXPOSE 8080
USER node
CMD ["node_modules/.bin/tsx", "examples/seller/src/main.ts"]
```

Create `examples/seller/Dockerfile.dockerignore`:

```gitignore
# Read by BuildKit next to the Dockerfile, and by `fly deploy --ignorefile`. The build context is the repository root.
.git
**/node_modules
**/dist
**/.cache
target
programs
docs
brand
e2e/report
.env
.env.*
**/*keypair*.json
**/*.pem
```

- [ ] **Step 2: Write the Fly.io configuration**

Create `examples/seller/fly.toml`:

```toml
# The example seller as one always-on machine. The gate keeps sessions in memory, so the app runs one machine,
# which Fly.io neither stops when idle nor starts a second of.
# Deploy from the repository root (examples/seller/README.md):
#   fly deploy . --config examples/seller/fly.toml --dockerfile examples/seller/Dockerfile --ignorefile examples/seller/Dockerfile.dockerignore
# The Dockerfile and the ignore file are named on the command line, not in a [build] section: Fly.io's reference does
# not say what [build] paths are relative to, and the build context must be the repository root.
app = "stint-demo"
primary_region = "lhr"
# The seller stops the stream, the facilitator, then Kora, which is given 5 s after SIGINT: more than Fly.io's 5 s
# default between the stop signal and the kill.
kill_signal = "SIGINT"
kill_timeout = 20

[deploy]
  # One machine replaced by its successor. Not bluegreen or canary: those run two machines at once, two processes on
  # one seed, each closing the other's sessions at its start-up.
  strategy = "rolling"

[env]
  HOST = "0.0.0.0"
  PORT = "8080"
  PUBLIC_ORIGIN = "https://stint-demo.lxfoundry.ai"

[http_service]
  internal_port = 8080
  force_https = true
  auto_stop_machines = "off"
  auto_start_machines = false
  min_machines_running = 1

  [[http_service.checks]]
    # The start-up funds the keys and closes the sessions an earlier machine left before the stream listens.
    grace_period = "90s"
    interval = "15s"
    timeout = "5s"
    method = "GET"
    path = "/health"

[[vm]]
  memory = "512mb"
  cpu_kind = "shared"
  cpus = 1
```

- [ ] **Step 3: Write the guide**

The guide is `examples/seller/README.md`, and that file is the source of truth for its text: the plan does not copy it,
so that the two cannot differ. It states:

- what the process runs and what it offers (1000 base units a second, 5 s to 300 s, 100 s by default, the 60 s idle
  close);
- the variables (`STINT_SELLER_SEED`, `STINT_SELLER_RPC_URL`, `STINT_SELLER_WS_URL`, `STINT_SELLER_SCAN_RPC_URL`,
  `PORT`, `HOST`, `PUBLIC_ORIGIN`, `KORA_BIN`);
- the five keys, the seed made for the deployment alone and the funding key's margin;
- how to run it locally on a seed of its own;
- the steps to deploy on Fly.io, in which the seed and the RPC URL reach `fly` on its standard input and never a
  command line;
- how it behaves in operation (restarts, the closes at start-up, the facilitator that is not public, Kora's exit and
  the restart policy, the signals, the RPC URL visible to `ps`).

- [ ] **Step 4: Build the image locally (optional: needs Docker)**

Run: `docker build -f examples/seller/Dockerfile -t stint-example-seller .`
Expected: the build ends with `naming to docker.io/library/stint-example-seller`; the `ldd` step passes.

Run: `docker run --rm --env-file <(printf 'STINT_SELLER_SEED=%s\nSTINT_SELLER_RPC_URL=https://api.devnet.solana.com\nPUBLIC_ORIGIN=http://127.0.0.1:8080\n' "$(cat ~/.config/stint/seller-seed-local)") -p 8080:8080 stint-example-seller`
Expected: JSON lines ending with `{"event":"ready",…}`; in another shell, `curl -s http://127.0.0.1:8080/health`
answers `{"ok":true}`. Stop it with Ctrl-C: the process stops the stream, the facilitator and Kora, and exits 0. It
runs on the local seed, never the deployment's (the README says why).

- [ ] **Step 5: Commit**

```bash
git add examples/seller/Dockerfile examples/seller/Dockerfile.dockerignore examples/seller/fly.toml examples/seller/README.md
git commit -m "Add the example seller's image, its Fly.io configuration and its guide" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: The demo package, its shared state and the panel's model

The server and the panel share one state type, and the panel's logic stays out of the DOM so that it can be tested.
The server uses the same functions to refuse an action the panel would not offer.

**Files:**
- Create: `examples/claude-demo/package.json`, `examples/claude-demo/tsconfig.json`, `examples/claude-demo/app/tsconfig.json`
- Create: `examples/claude-demo/src/state.ts`, `examples/claude-demo/app/model.ts`
- Test: `examples/claude-demo/test/model.test.ts`
- Modify: `pnpm-lock.yaml` (by `pnpm install`)

**Interfaces:**
- Consumes: `TOP_UP_MARGIN_SECONDS = 10` (`packages/x402/src/constants.ts:24`), which the server copies into the state
  (the panel's bundle imports nothing from the scheme package).
- Produces:
  - from `src/state.ts`: `LAUNCH_SECONDS = 100`, `TOP_UP_SECONDS = 100`, `LAUNCH_AMOUNT = "100000"`,
    `FAUCET_URL = "https://faucet.circle.com/"`, `PANEL_URI = "ui://stint-demo/panel.html"`,
    `TOOL = { demo: "stint_demo", state: "stint_demo_state", launch: "stint_demo_launch", topUp: "stint_demo_top_up", close: "stint_demo_close" }`,
    `type ToolName`, `type DemoAction = "launch" | "top-up" | "close"`, `type SessionPhase`, `interface ExchangeRow`,
    `interface DemoLinks`, `interface DemoSession`, `interface DemoWallet`, `interface DemoState`;
  - from `app/model.ts`: `formatUsdc(baseUnits: string): string`, `skewOf(serverNowMs, localNowMs): number`,
    `secondsLeft(session, nowMs): number`, `capsule(session, nowMs): { used: number; paid: number }` (shares of
    `maxSeconds`), `topUpRefusal(session, nowMs): string | undefined`, `closeRefusal(session, nowMs): string | undefined`,
    `canLaunch(state): boolean`, `headline(state, nowMs): string`.

- [ ] **Step 1: Create the package**

Create `examples/claude-demo/package.json`:

```json
{
  "name": "@lxfoundry/stint-claude-demo",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "typecheck": "tsc -p tsconfig.json && tsc -p app/tsconfig.json",
    "test": "vitest run",
    "build": "tsx scripts/build.ts",
    "mcpb": "tsx scripts/pack.ts",
    "dev": "tsx src/dev.ts"
  },
  "dependencies": {
    "@lxfoundry/stint-client": "workspace:*",
    "@lxfoundry/stint-x402": "workspace:*",
    "@modelcontextprotocol/client": "2.4.0",
    "@modelcontextprotocol/core": "2.4.0",
    "@modelcontextprotocol/ext-apps": "2.0.4",
    "@modelcontextprotocol/server": "2.4.0",
    "@solana/kit": "8.5.0",
    "zod": "4.6.7"
  },
  "devDependencies": {
    "@anthropic-ai/mcpb": "2.1.2",
    "esbuild": "0.28.2"
  }
}
```

Create `examples/claude-demo/tsconfig.json` (the server, its scripts and the tests, with Node's types):

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src", "test", "scripts"]
}
```

Create `examples/claude-demo/app/tsconfig.json` (the panel, with the DOM's types and not Node's):

```json
{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": { "lib": ["es2023", "dom"], "types": [] },
  "include": ["."]
}
```

Run: `pnpm install`
Expected: `pnpm-lock.yaml` gains the importer `examples/claude-demo`, `@modelcontextprotocol/ext-apps@2.0.4` (with its
dependency `@standard-schema/spec`) and `@anthropic-ai/mcpb@2.1.2` with its dependencies; `esbuild@0.28.2`, `zod@4.6.7`
and the `@modelcontextprotocol/*@2.4.0` packages are those already in the lockfile. No peer-dependency warning names
`@modelcontextprotocol/ext-apps`. esbuild's install script stays off (`allowBuilds: esbuild: false`): its JavaScript
API finds its binary through the `@esbuild/linux-x64` package.

- [ ] **Step 2: Write the shared state**

Create `examples/claude-demo/src/state.ts`:

```ts
/**
 * The demo's state, as the server keeps it and the panel draws it, and the constants both use. This module imports
 * nothing: the panel's bundle includes it. Amounts are base-unit decimal strings; times are Unix seconds, except
 * `DemoState.now` and each row's `at`, in milliseconds.
 */

/** How long a launch buys, and how long a top-up adds. */
export const LAUNCH_SECONDS = 100;
export const TOP_UP_SECONDS = 100;
/** What a launch needs in the wallet, in base units: 100 s at the example seller's 1000 base units a second. */
export const LAUNCH_AMOUNT = "100000";
/** Circle's faucet, which gives devnet USDC for Solana Devnet. */
export const FAUCET_URL = "https://faucet.circle.com/";
/** The panel, as an MCP App resource. */
export const PANEL_URI = "ui://stint-demo/panel.html";

export const TOOL = {
  demo: "stint_demo",
  state: "stint_demo_state",
  launch: "stint_demo_launch",
  topUp: "stint_demo_top_up",
  close: "stint_demo_close",
} as const;
export type ToolName = (typeof TOOL)[keyof typeof TOOL];

export type DemoAction = "launch" | "top-up" | "close";

/**
 * `closed`: the buyer closed it through this server. `expired`: it ended at or after its `paidUntil`, and the seller was
 * paid the whole deposit. `ended`: another party closed it before its end, such as the gate's idle close (`4410`).
 */
export type SessionPhase = "none" | "opening" | "open" | "closing" | "closed" | "expired" | "ended";

/** One line of the x402 exchange between the client and the gate (spec §5). */
export interface ExchangeRow {
  readonly kind: "request" | "payment-required" | "payment" | "settled" | "error";
  readonly at: number;
  readonly label: string;
  readonly detail?: string;
  readonly link?: string;
}

/** Explorer pages, on devnet. */
export interface DemoLinks {
  readonly session?: string;
  readonly open?: string;
  readonly topUps: readonly string[];
  readonly close?: string;
  readonly seller?: string;
}

export interface DemoSession {
  readonly state: SessionPhase;
  readonly sessionId?: string;
  readonly startedAt?: number;
  readonly paidUntil?: number;
  /** When it was closed, or ended: the capsule stops there. */
  readonly endedAt?: number;
  readonly deposited?: string;
  readonly rate?: string;
  readonly maxSeconds?: number;
  /** A top-up is refused this close to the end, on the facilitator's clock (spec §5.4). */
  readonly topUpMarginSeconds: number;
  readonly paid?: string;
  readonly refunded?: string;
  /** The stream connection's close code, once it has closed (spec §7.4). */
  readonly closeCode?: number;
  /** Account messages the stream has sent. */
  readonly frames: number;
  readonly links: DemoLinks;
}

export interface DemoWallet {
  readonly address: string;
  /** Its USDC, in base units, as last read; absent until a read succeeds. */
  readonly usdc?: string;
  readonly checkedAt?: number;
}

export interface DemoState {
  readonly wallet: DemoWallet;
  readonly gateUrl: string;
  readonly faucetUrl: string;
  /** The latest session. */
  readonly session: DemoSession;
  /** The rows of the action under way, and those of the last one that ended. */
  readonly exchange: {
    readonly current: readonly ExchangeRow[];
    readonly last?: { readonly action: DemoAction; readonly rows: readonly ExchangeRow[] };
  };
  /** The server's clock, in milliseconds: the panel corrects its own by it. */
  readonly now: number;
  readonly busy?: DemoAction;
  /** Why the last action failed, whoever started it. Cleared when the next one starts. */
  readonly error?: { readonly action: DemoAction; readonly message: string; readonly at: number };
}
```

- [ ] **Step 3: Write the failing test**

Create `examples/claude-demo/test/model.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { canLaunch, capsule, closeRefusal, formatUsdc, headline, secondsLeft, skewOf, topUpRefusal } from "../app/model.js";
import { FAUCET_URL, type DemoAction, type DemoSession, type DemoState } from "../src/state.js";

/** A 100 s session from 1,000 to 1,100, at 1000 base units a second, in a seller's 300 s at most. */
const running = (fields: Partial<DemoSession> = {}): DemoSession => ({
  state: "open",
  sessionId: "S",
  startedAt: 1_000,
  paidUntil: 1_100,
  deposited: "100000",
  rate: "1000",
  maxSeconds: 300,
  topUpMarginSeconds: 10,
  frames: 0,
  links: { topUps: [] },
  ...fields,
});
const none: DemoSession = { state: "none", topUpMarginSeconds: 10, frames: 0, links: { topUps: [] } };
const stateOf = (session: DemoSession, usdc?: string, busy?: DemoAction): DemoState => ({
  wallet: { address: "A", ...(usdc === undefined ? {} : { usdc }) },
  gateUrl: "https://gate.example",
  faucetUrl: FAUCET_URL,
  session,
  exchange: { current: [] },
  now: 0,
  ...(busy ? { busy } : {}),
});

describe("amounts", () => {
  it("shows USDC with at least three decimals, and no trailing zero beyond them", () => {
    expect(formatUsdc("100000")).toBe("0.100 USDC");
    expect(formatUsdc("1000")).toBe("0.001 USDC");
    expect(formatUsdc("0")).toBe("0.000 USDC");
    expect(formatUsdc("100")).toBe("0.0001 USDC");
    expect(formatUsdc("1500000")).toBe("1.500 USDC");
    expect(formatUsdc("1234567")).toBe("1.234567 USDC");
    expect(formatUsdc("12000000")).toBe("12.000 USDC");
    expect(formatUsdc("-5")).toBe("? USDC");
  });
});

describe("the time left", () => {
  it("counts whole seconds to paidUntil, never below zero", () => {
    expect(secondsLeft(running(), 1_090_000)).toBe(10);
    expect(secondsLeft(running(), 1_090_100)).toBe(10);
    expect(secondsLeft(running(), 1_100_500)).toBe(0);
    expect(secondsLeft(none, 0)).toBe(0);
  });

  it("corrects the panel's clock by the server's", () => {
    expect(skewOf(10_500, 10_000)).toBe(500);
    expect(skewOf(9_000, 10_000)).toBe(-1_000);
  });
});

describe("the capsule", () => {
  it("draws the paid time and the time used as shares of the longest session", () => {
    expect(capsule(running(), 1_050_000)).toEqual({ used: 50 / 300, paid: 100 / 300 });
    expect(capsule(running({ paidUntil: 1_200, deposited: "200000" }), 1_050_000)).toEqual({ used: 50 / 300, paid: 200 / 300 });
    expect(capsule(running(), 990_000)).toEqual({ used: 0, paid: 100 / 300 });
  });

  it("stops at the close, is full once the session expired, and is empty with no session", () => {
    expect(capsule(running({ state: "closed", endedAt: 1_030 }), 1_090_000)).toEqual({ used: 30 / 300, paid: 100 / 300 });
    expect(capsule(running({ state: "expired" }), 1_500_000)).toEqual({ used: 100 / 300, paid: 100 / 300 });
    expect(capsule(none, 0)).toEqual({ used: 0, paid: 0 });
  });
});

describe("what the panel offers", () => {
  it("offers a top-up until the margin before the end, and within the longest session", () => {
    expect(topUpRefusal(running(), 1_086_000)).toBeUndefined();
    expect(topUpRefusal(running(), 1_087_000)).toBe("Too close to the end: a top-up must start more than 13 s before it");
    expect(topUpRefusal(running({ paidUntil: 1_300, deposited: "300000" }), 1_100_000)).toBe(
      "A session runs at most 300 s: this one has no room for 100 s more",
    );
    expect(topUpRefusal(running({ paidUntil: 1_200, deposited: "200000" }), 1_100_000)).toBeUndefined();
    expect(topUpRefusal(running({ state: "closed" }), 1_050_000)).toBe("The session is closed: launch a new one");
  });

  it("offers a close until the paid time is over", () => {
    expect(closeRefusal(running(), 1_099_000)).toBeUndefined();
    expect(closeRefusal(running(), 1_100_000)).toBe("The paid time is over: the gate is closing the session");
    expect(closeRefusal(none, 0)).toBe("No session is running: launch one first");
  });

  it("offers a launch from 0.1 USDC, when no session runs and nothing is under way", () => {
    expect(canLaunch(stateOf(none, "100000"))).toBe(true);
    expect(canLaunch(stateOf(none, "99999"))).toBe(false);
    expect(canLaunch(stateOf(none))).toBe(false);
    expect(canLaunch(stateOf(running(), "100000"))).toBe(false);
    expect(canLaunch(stateOf(running({ state: "expired" }), "100000"))).toBe(true);
    expect(canLaunch(stateOf(none, "100000", "launch"))).toBe(false);
  });
});

describe("the headline", () => {
  it("says what the session is doing", () => {
    expect(headline(stateOf(none), 0)).toBe("Checking the wallet…");
    expect(headline(stateOf(none, "0"), 0)).toBe("Fund the wallet with 0.100 USDC to start");
    expect(headline(stateOf(none, "100000"), 0)).toBe("Ready: launch a 100 s session");
    expect(headline(stateOf(running({ state: "opening" })), 0)).toBe("Opening a session…");
    expect(headline(stateOf(running()), 1_040_000)).toBe("Running: 60 s of paid time left");
    expect(headline(stateOf(running()), 1_100_000)).toBe("Paid time over: the gate is closing");
    expect(headline(stateOf(running({ state: "closing" })), 0)).toBe("Closing the session…");
    expect(headline(stateOf(running({ state: "closed", paid: "12000", refunded: "88000" })), 0)).toBe(
      "Closed: paid 0.012 USDC, refunded 0.088 USDC",
    );
    expect(headline(stateOf(running({ state: "expired", paid: "100000" })), 0)).toBe("Expired: the seller was paid 0.100 USDC");
    expect(headline(stateOf(running({ state: "ended", paid: "61000", refunded: "39000" })), 0)).toBe(
      "Ended by the seller before its paid time: paid 0.061 USDC, refunded 0.039 USDC",
    );
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `pnpm --filter @lxfoundry/stint-claude-demo test model.test.ts`
Expected: FAIL: `Failed to load url ../app/model.js`.

- [ ] **Step 5: Write the model**

Create `examples/claude-demo/app/model.ts`:

```ts
import { LAUNCH_AMOUNT, LAUNCH_SECONDS, TOP_UP_SECONDS, type DemoSession, type DemoState } from "../src/state.js";

/** The panel's logic, without the DOM: the server refuses with the same words what the panel does not offer. */

const USDC_DECIMALS = 6;
const RUNNING: ReadonlySet<DemoSession["state"]> = new Set(["opening", "open", "closing"]);

/** `"100000"` → `"0.100 USDC"`: at least three decimals, and no trailing zero beyond them. */
export function formatUsdc(baseUnits: string): string {
  if (!/^\d+$/.test(baseUnits)) return "? USDC";
  const value = BigInt(baseUnits);
  const scale = 10n ** BigInt(USDC_DECIMALS);
  const fraction = (value % scale).toString().padStart(USDC_DECIMALS, "0").replace(/0+$/, "").padEnd(3, "0");
  return `${value / scale}.${fraction} USDC`;
}

/** What to add to the panel's clock to read the server's, from a state the server stamped `serverNowMs`. */
export const skewOf = (serverNowMs: number, localNowMs: number): number => serverNowMs - localNowMs;

/** Whole seconds to `paidUntil` at `nowMs` (the server's clock), never below zero. */
export function secondsLeft(session: DemoSession, nowMs: number): number {
  if (session.paidUntil === undefined) return 0;
  return Math.max(0, Math.ceil(session.paidUntil - nowMs / 1000));
}

/**
 * The capsule (`brand/README.md`): the paid time and the time used, as shares of the longest session the seller allows,
 * so that a top-up moves the capsule's end out. The time used stops at `endedAt`, and fills the capsule once expired.
 */
export function capsule(session: DemoSession, nowMs: number): { used: number; paid: number } {
  const { startedAt, paidUntil, maxSeconds } = session;
  if (startedAt === undefined || paidUntil === undefined || !maxSeconds) return { used: 0, paid: 0 };
  const paidSeconds = Math.max(0, paidUntil - startedAt);
  const at = session.state === "expired" ? paidUntil : (session.endedAt ?? nowMs / 1000);
  const usedSeconds = Math.min(paidSeconds, Math.max(0, at - startedAt));
  return { used: Math.min(1, usedSeconds / maxSeconds), paid: Math.min(1, paidSeconds / maxSeconds) };
}

function notRunning(session: DemoSession): string {
  switch (session.state) {
    case "opening":
      return "The session is still opening";
    case "closing":
      return "The session is closing";
    case "closed":
      return "The session is closed: launch a new one";
    case "expired":
      return "The session has expired: its paid time ran out";
    case "ended":
      return "The seller ended the session";
    default:
      return "No session is running: launch one first";
  }
}

/**
 * Why a top-up is not offered now, or undefined when it is: only an open session, more than the facilitator's margin
 * plus 3 s before its end (spec §5.4), and only while `maxSeconds` leaves room for `TOP_UP_SECONDS` more (spec §5.2).
 */
export function topUpRefusal(session: DemoSession, nowMs: number): string | undefined {
  if (session.state !== "open" || session.paidUntil === undefined) return notRunning(session);
  const margin = session.topUpMarginSeconds + 3;
  if (session.paidUntil - nowMs / 1000 <= margin) return `Too close to the end: a top-up must start more than ${margin} s before it`;
  if (session.deposited !== undefined && session.rate !== undefined && session.maxSeconds !== undefined) {
    const paidSeconds = Number(BigInt(session.deposited) / BigInt(session.rate));
    if (paidSeconds + TOP_UP_SECONDS > session.maxSeconds) {
      return `A session runs at most ${session.maxSeconds} s: this one has no room for ${TOP_UP_SECONDS} s more`;
    }
  }
  return undefined;
}

/** Why "Close now" is not offered, or undefined when it is: from `paidUntil` on, the gate closes the session itself. */
export function closeRefusal(session: DemoSession, nowMs: number): string | undefined {
  if (session.state !== "open" || session.paidUntil === undefined) return notRunning(session);
  if (nowMs >= session.paidUntil * 1000) return "The paid time is over: the gate is closing the session";
  return undefined;
}

/** A launch is offered when no session runs, nothing is under way, and the wallet holds `LAUNCH_AMOUNT`. */
export function canLaunch(state: DemoState): boolean {
  const usdc = state.wallet.usdc;
  return !RUNNING.has(state.session.state) && !state.busy && usdc !== undefined && BigInt(usdc) >= BigInt(LAUNCH_AMOUNT);
}

/** One line on what the session is doing. */
export function headline(state: DemoState, nowMs: number): string {
  const session = state.session;
  const amounts =
    session.paid !== undefined && session.refunded !== undefined ? `paid ${formatUsdc(session.paid)}, refunded ${formatUsdc(session.refunded)}` : undefined;
  switch (session.state) {
    case "none": {
      const usdc = state.wallet.usdc;
      if (usdc === undefined) return "Checking the wallet…";
      return BigInt(usdc) < BigInt(LAUNCH_AMOUNT) ? `Fund the wallet with ${formatUsdc(LAUNCH_AMOUNT)} to start` : `Ready: launch a ${LAUNCH_SECONDS} s session`;
    }
    case "opening":
      return "Opening a session…";
    case "open":
      return session.paidUntil !== undefined && nowMs < session.paidUntil * 1000
        ? `Running: ${secondsLeft(session, nowMs)} s of paid time left`
        : "Paid time over: the gate is closing";
    case "closing":
      return "Closing the session…";
    case "closed":
      return amounts ? `Closed: ${amounts}` : "Closed";
    case "expired":
      return `Expired: the seller was paid ${formatUsdc(session.paid ?? session.deposited ?? "0")}`;
    case "ended":
      return amounts ? `Ended by the seller before its paid time: ${amounts}` : "Ended by the seller before its paid time";
  }
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm --filter @lxfoundry/stint-claude-demo test && pnpm --filter @lxfoundry/stint-claude-demo typecheck`
Expected: PASS, 9 tests; no type error in either type check.

- [ ] **Step 7: Commit**

```bash
git add examples/claude-demo/package.json examples/claude-demo/tsconfig.json examples/claude-demo/app/tsconfig.json examples/claude-demo/src/state.ts examples/claude-demo/app/model.ts examples/claude-demo/test/model.test.ts pnpm-lock.yaml
git commit -m "Add the Claude Desktop example's shared state and panel model" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: The demo's configuration and the agent's wallet

**Files:**
- Create: `examples/claude-demo/src/config.ts`, `examples/claude-demo/src/wallet.ts`
- Test: `examples/claude-demo/test/config.test.ts`, `examples/claude-demo/test/wallet.test.ts`

**Interfaces:**
- Consumes: `Policy` (`packages/client/src/policy.ts:11-31`; `programs` defaults to the Stint program),
  `SOLANA_DEVNET`, `SOLANA_MAINNET`, `USDC_DEVNET` (`packages/x402/src/constants.ts:7-11`), the key-file checks of
  `packages/mcp/src/config.ts:64-90` (64 bytes; a message that never quotes the file).
- Produces:
  - from `src/config.ts` (the budget is 2.000 USDC an hour, deviation 15):
    `DEFAULT_GATE_URL = "https://stint-demo.lxfoundry.ai"`, `DEFAULT_RPC_URL = "https://api.devnet.solana.com"`,
    `DEMO_DIR = "stint-demo"`, `DEMO_POLICY: Policy`,
    `interface DemoConfig { home: string; dir: string; gateUrl: string; rpcUrl: string; policy: Policy }` (`dir` is
    `join(home, DEMO_DIR)`: the folder that holds `agent.json` and `owner.json`),
    `class ConfigError extends Error { problems }`, `loadConfig(env): DemoConfig`;
  - from `src/wallet.ts`: `WALLET_FILE = "agent.json"`, `class WalletError`, `interface Wallet { signer: KeyPairSigner; path: string; created: boolean }`,
    `allowsDevnetOnly(policy: Pick<Policy, "networks">): boolean`, `loadOrCreateWallet(dir, policy): Promise<Wallet>`
    (`dir` is `DemoConfig.dir`).

- [ ] **Step 1: Write the failing tests**

Create `examples/claude-demo/test/config.test.ts`:

```ts
import { SOLANA_DEVNET, USDC_DEVNET } from "@lxfoundry/stint-x402";
import { describe, expect, it } from "vitest";
import { ConfigError, DEFAULT_GATE_URL, DEFAULT_RPC_URL, DEMO_POLICY, loadConfig } from "../src/config.js";

function problemsOf(env: Record<string, string>): string[] {
  try {
    loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return [...error.problems];
    throw error;
  }
  throw new Error("expected a configuration error");
}

describe("the demo's configuration", () => {
  it("needs only the folder, keeps its files in a stint-demo folder inside it, and takes the example gate and devnet's public node by default", () => {
    expect(loadConfig({ STINT_DEMO_HOME: "/home/someone" })).toEqual({
      home: "/home/someone",
      dir: "/home/someone/stint-demo",
      gateUrl: DEFAULT_GATE_URL,
      rpcUrl: DEFAULT_RPC_URL,
      policy: DEMO_POLICY,
    });
  });

  it("takes another gate, without its trailing slash, and another node; an empty value is the default", () => {
    expect(
      loadConfig({ STINT_DEMO_HOME: "/h", STINT_DEMO_GATE_URL: "http://127.0.0.1:8080/", STINT_DEMO_RPC_URL: "https://devnet.example/?api-key=k" }),
    ).toMatchObject({ gateUrl: "http://127.0.0.1:8080", rpcUrl: "https://devnet.example/?api-key=k" });
    expect(loadConfig({ STINT_DEMO_HOME: "/h", STINT_DEMO_GATE_URL: "" }).gateUrl).toBe(DEFAULT_GATE_URL);
  });

  it("refuses a missing or relative folder, and URLs it cannot use, quoting no URL", () => {
    expect(problemsOf({})).toEqual(["STINT_DEMO_HOME is required: the folder that holds the agent's wallet"]);
    expect(problemsOf({ STINT_DEMO_HOME: "stint-demo", STINT_DEMO_GATE_URL: "https://user:pw@gate.example", STINT_DEMO_RPC_URL: "ws://devnet.example" })).toEqual([
      'STINT_DEMO_HOME must be an absolute path, got "stint-demo"',
      "STINT_DEMO_GATE_URL must be an http or https URL, with no credentials, query or fragment",
      "STINT_DEMO_RPC_URL must be an http or https URL, with no credentials",
    ]);
  });

  it("spends within the demo's limits, on devnet, in devnet USDC", () => {
    expect(DEMO_POLICY).toEqual({
      networks: [SOLANA_DEVNET],
      assets: [USDC_DEVNET],
      maxRate: 1_000n,
      maxPerSession: 300_000n,
      budget: { amount: 2_000_000n, periodSeconds: 3_600 },
    });
  });
});
```

Create `examples/claude-demo/test/wallet.test.ts`:

```ts
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { SOLANA_DEVNET, SOLANA_MAINNET } from "@lxfoundry/stint-x402";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WALLET_FILE, WalletError, allowsDevnetOnly, loadOrCreateWallet } from "../src/wallet.js";

// Under the package, in a git-ignored directory: `/tmp` can be emptied at any time.
const scratch = fileURLToPath(new URL("../.cache/", import.meta.url));
const DEVNET = { networks: [SOLANA_DEVNET] };

/** Whether this file system keeps a file's mode: a Windows drive mounted in WSL may not. */
function keepsModes(directory: string): boolean {
  const probe = join(directory, "mode-probe");
  writeFileSync(probe, "", { mode: 0o600 });
  const kept = (statSync(probe).mode & 0o777) === 0o600;
  rmSync(probe);
  return kept;
}

describe("the agent's wallet", () => {
  let home: string;
  beforeEach(() => {
    mkdirSync(scratch, { recursive: true });
    home = mkdtempSync(join(scratch, "wallet-"));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("creates its folder and a Solana CLI keypair file once, readable by its owner only, and loads it from then on", async () => {
    const dir = join(home, "stint-demo");
    const created = await loadOrCreateWallet(dir, DEVNET);
    expect(created).toMatchObject({ created: true, path: join(dir, WALLET_FILE) });
    const bytes = JSON.parse(readFileSync(created.path, "utf8")) as number[];
    expect(bytes).toHaveLength(64);
    expect((await createKeyPairSignerFromBytes(Uint8Array.from(bytes))).address).toBe(created.signer.address);
    if (keepsModes(scratch)) expect(statSync(created.path).mode & 0o777).toBe(0o600);
    const loaded = await loadOrCreateWallet(dir, DEVNET);
    expect(loaded).toMatchObject({ created: false, path: created.path });
    expect(loaded.signer.address).toBe(created.signer.address);
  });

  it("makes one key when two copies start at once", async () => {
    const [first, second] = await Promise.all([loadOrCreateWallet(home, DEVNET), loadOrCreateWallet(home, DEVNET)]);
    expect(first.signer.address).toBe(second.signer.address);
    expect([first.created, second.created].sort()).toEqual([false, true]);
  });

  it("never overwrites a file that is not a key, and quotes none of it", async () => {
    const path = join(home, WALLET_FILE);
    writeFileSync(path, "[1, 2, 3] secret words");
    const error = await loadOrCreateWallet(home, DEVNET).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(WalletError);
    expect((error as Error).message).not.toMatch(/secret words/);
    expect(readFileSync(path, "utf8")).toBe("[1, 2, 3] secret words");
  });

  it("makes no key for a policy that allows a network other than devnet", async () => {
    expect(allowsDevnetOnly({})).toBe(true);
    expect(allowsDevnetOnly({ networks: [SOLANA_DEVNET, SOLANA_MAINNET] })).toBe(false);
    expect(allowsDevnetOnly({ networks: [] })).toBe(false);
    await expect(loadOrCreateWallet(home, { networks: [SOLANA_MAINNET] })).rejects.toThrow(/none is made/);
    expect(() => readFileSync(join(home, WALLET_FILE))).toThrow();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @lxfoundry/stint-claude-demo test config.test.ts wallet.test.ts`
Expected: FAIL: `Failed to load url ../src/config.js` and `../src/wallet.js`.

- [ ] **Step 3: Write the configuration**

Create `examples/claude-demo/src/config.ts`:

```ts
import { isAbsolute, join } from "node:path";
import type { Policy } from "@lxfoundry/stint-client";
import { SOLANA_DEVNET, USDC_DEVNET } from "@lxfoundry/stint-x402";

/** The example seller deployment's gate (`examples/seller`). */
export const DEFAULT_GATE_URL = "https://stint-demo.lxfoundry.ai";
/** Where the balance and a session's close are read: devnet's public node. */
export const DEFAULT_RPC_URL = "https://api.devnet.solana.com";
/** The folder inside `STINT_DEMO_HOME` that holds the demo's files, so that a home folder given as is stays tidy. */
export const DEMO_DIR = "stint-demo";

/**
 * The limits every action passes (spec §9.2): the example seller's rate, a session of the 100 s an open buys and two
 * top-ups of 100 s each, and 2.000 USDC an hour across sessions; devnet and devnet USDC only, and the Stint program
 * (the default).
 */
export const DEMO_POLICY: Policy = {
  networks: [SOLANA_DEVNET],
  assets: [USDC_DEVNET],
  maxRate: 1_000n,
  maxPerSession: 300_000n,
  budget: { amount: 2_000_000n, periodSeconds: 3_600 },
};

export interface DemoConfig {
  /** `STINT_DEMO_HOME`, as given. */
  readonly home: string;
  /** `home/stint-demo`: the folder that holds `agent.json` and `owner.json`, created at start if it is missing. */
  readonly dir: string;
  readonly gateUrl: string;
  readonly rpcUrl: string;
  readonly policy: Policy;
}

export class ConfigError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Invalid configuration:\n${problems.map((problem) => `- ${problem}`).join("\n")}`);
    this.name = "ConfigError";
  }
}

/** An http or https URL with no credentials, or undefined. Never quoted in a message: it can carry an API key. */
function httpUrl(value: string): URL | undefined {
  if (!URL.canParse(value)) return undefined;
  const url = new URL(value);
  return (url.protocol === "http:" || url.protocol === "https:") && url.username === "" && url.password === "" ? url : undefined;
}

/** The demo's configuration from environment variables (`examples/claude-demo/README.md`). An empty value is a default. */
export function loadConfig(env: Readonly<Record<string, string | undefined>>): DemoConfig {
  const problems: string[] = [];
  const text = (name: string) => env[name]?.trim() || undefined;
  const home = text("STINT_DEMO_HOME");
  if (!home) problems.push("STINT_DEMO_HOME is required: the folder that holds the agent's wallet");
  else if (!isAbsolute(home)) problems.push(`STINT_DEMO_HOME must be an absolute path, got "${home}"`);
  const gate = httpUrl(text("STINT_DEMO_GATE_URL") ?? DEFAULT_GATE_URL);
  const gateOk = gate !== undefined && gate.search === "" && gate.hash === "";
  if (!gateOk) problems.push("STINT_DEMO_GATE_URL must be an http or https URL, with no credentials, query or fragment");
  const rpcUrl = text("STINT_DEMO_RPC_URL") ?? DEFAULT_RPC_URL;
  if (!httpUrl(rpcUrl)) problems.push("STINT_DEMO_RPC_URL must be an http or https URL, with no credentials");
  if (problems.length > 0 || !home || !gate || !gateOk) throw new ConfigError(problems);
  return { home, dir: join(home, DEMO_DIR), gateUrl: `${gate.origin}${gate.pathname.replace(/\/+$/, "")}`, rpcUrl, policy: DEMO_POLICY };
}
```

- [ ] **Step 4: Write the wallet**

Create `examples/claude-demo/src/wallet.ts`:

```ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createKeyPairSignerFromBytes, createKeyPairSignerFromPrivateKeyBytes, getAddressEncoder, type KeyPairSigner } from "@solana/kit";
import type { Policy } from "@lxfoundry/stint-client";
import { SOLANA_DEVNET } from "@lxfoundry/stint-x402";

/** The agent's key, in the `stint-demo` folder of `STINT_DEMO_HOME`: a Solana CLI keypair file, a JSON array of 64 bytes. */
export const WALLET_FILE = "agent.json";
/** A copy that finds the file another has just created reads it a few times while it may be half written. */
const READ_ATTEMPTS = 5;
const READ_DELAY_MS = 100;

export class WalletError extends Error {
  override name = "WalletError";
}

export interface Wallet {
  readonly signer: KeyPairSigner;
  readonly path: string;
  readonly created: boolean;
}

/** Whether `policy` allows devnet and nothing else (the client's default is devnet). */
export function allowsDevnetOnly(policy: Pick<Policy, "networks">): boolean {
  const networks = policy.networks ?? [SOLANA_DEVNET];
  return networks.length > 0 && networks.every((network) => network === SOLANA_DEVNET);
}

/** Nothing from the file reaches a message: a parser's error quotes the text it was given. */
async function readWallet(path: string): Promise<KeyPairSigner> {
  let bytes: unknown;
  try {
    bytes = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new WalletError(`${path} cannot be read, or is not JSON`);
  }
  if (!Array.isArray(bytes) || bytes.length !== 64 || !bytes.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)) {
    throw new WalletError(`${path} does not hold a keypair: a JSON array of 64 bytes`);
  }
  try {
    return await createKeyPairSignerFromBytes(Uint8Array.from(bytes as number[]));
  } catch {
    throw new WalletError(`${path} does not hold a keypair: its public half is not its private half's`);
  }
}

async function readWhenWritten(path: string): Promise<KeyPairSigner> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await readWallet(path);
    } catch (error) {
      if (attempt >= READ_ATTEMPTS) throw error;
      await new Promise((resolve) => setTimeout(resolve, READ_DELAY_MS));
    }
  }
}

/**
 * The agent's key at `dir/agent.json` (`dir` is `STINT_DEMO_HOME/stint-demo`), the folder created if it is missing. A
 * file that is there is used, and never overwritten, even one that is not a key: that is an error. With none, a fresh
 * key is written, readable by its owner only, and only for a policy that allows devnet alone. Two copies that start at
 * once make one key: the second finds the first's file.
 */
export async function loadOrCreateWallet(dir: string, policy: Pick<Policy, "networks">): Promise<Wallet> {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, WALLET_FILE);
  if (existsSync(path)) return { signer: await readWallet(path), path, created: false };
  if (!allowsDevnetOnly(policy)) {
    throw new WalletError(`There is no key at ${path}, and none is made for a policy that allows a network other than devnet`);
  }
  const privateKey = crypto.getRandomValues(new Uint8Array(32));
  const signer = await createKeyPairSignerFromPrivateKeyBytes(privateKey);
  const bytes = [...privateKey, ...getAddressEncoder().encode(signer.address)];
  try {
    writeFileSync(path, JSON.stringify(bytes), { mode: 0o600, flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return { signer: await readWhenWritten(path), path, created: false };
  }
  return { signer, path, created: true };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @lxfoundry/stint-claude-demo test && pnpm --filter @lxfoundry/stint-claude-demo typecheck`
Expected: PASS, 17 tests; no type error.

- [ ] **Step 6: Commit**

```bash
git add examples/claude-demo/src/config.ts examples/claude-demo/src/wallet.ts examples/claude-demo/test/config.test.ts examples/claude-demo/test/wallet.test.ts
git commit -m "Add the Claude Desktop example's configuration and agent wallet" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Explorer links and the x402 exchange recorder

No product code changes, and the client calls the global `fetch` when it sends a request (`offersFrom` and `send`,
`packages/client/src/client.ts:291-307`), so the owner wraps `globalThis.fetch` before it makes the client and records
the requests to the gate's two paid routes only. Everything else passes through untouched, the same `Response` object
included.

**Files:**
- Create: `examples/claude-demo/src/links.ts`, `examples/claude-demo/src/exchange.ts`
- Create: `examples/claude-demo/test/fixtures.ts` (shared test values, not a test file)
- Test: `examples/claude-demo/test/links.test.ts`, `examples/claude-demo/test/exchange.test.ts`

**Interfaces:**
- Consumes: `HEADERS` (`packages/x402/src/constants.ts:14-18`), `decodePaymentRequiredHeader`, `decodePaymentResponseHeader`
  (its `transaction`), `decodePaymentSignatureHeader` (`packages/x402/src/wire.ts:4-11`, from `@x402/core/http`),
  `readElapsedRequirements` (`packages/x402/src/offer.ts:100`), `buildOpenOffer`/`buildTopUpOffer` for the tests
  (`offer.ts:59-67`); `isAddress`, `isSignature` (`@solana/kit`); `formatUsdc` (Task 6). The gate answers an open with
  `201` and a top-up with `200`, each with `PAYMENT-RESPONSE` (`packages/gate/src/gate.ts:617`, `705`).
- Produces:
  - from `src/links.ts`: `explorerTx(signature: string): string | undefined`, `explorerAddress(address: string): string | undefined`;
  - from `src/exchange.ts`: `type GateAction = "open" | "topUp"`,
    `interface ExchangeSink { row(row: ExchangeRow): void; offer(action: GateAction, entry: ElapsedRequirements): void; settled(action: GateAction, transaction: string): void }`,
    `shortened(text: string): string`, `gateRouteOf(gateUrl, method, url): { action: GateAction; path: string } | undefined`,
    `recordExchanges(gateUrl: string, sink: ExchangeSink, base: typeof fetch, clock?: () => number): typeof fetch`;
  - from `test/fixtures.ts`: `PROGRAM`, `GATE`, `SELLER`, `FEE_PAYER`, `RENT_PAYER`, `RECEIVER_AUTHORIZER`, `SESSION`,
    `AGENT_USDC`, `signatureOf(fill)`, `offer(action)`.

- [ ] **Step 1: Write the shared test values**

Create `examples/claude-demo/test/fixtures.ts`:

```ts
import { getBase58Decoder, type Address } from "@solana/kit";
import { SOLANA_DEVNET, USDC_DEVNET, buildOpenOffer, buildTopUpOffer, type ElapsedRequirements } from "@lxfoundry/stint-x402";

export const PROGRAM = "5iCYPqLjCWw5KzQTU6NBUhR2hxg5SWGmS1ctUn3qESvr";
export const GATE = "https://gate.example";
// Valid addresses that stand in for the seller, the facilitator's keys, a session and the agent's USDC account.
export const SELLER = "SysvarRent111111111111111111111111111111111" as Address;
export const FEE_PAYER = "SysvarC1ock11111111111111111111111111111111" as Address;
export const RENT_PAYER = "SysvarEpochSchedu1e111111111111111111111111" as Address;
export const RECEIVER_AUTHORIZER = "Stake11111111111111111111111111111111111111" as Address;
export const SESSION = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDyLb" as Address;
export const AGENT_USDC = "So11111111111111111111111111111111111111112";

/** A transaction signature: 64 bytes of `fill`, in base58. */
export const signatureOf = (fill: number): string => getBase58Decoder().decode(new Uint8Array(64).fill(fill));

/** The example seller's 100 s entry, as its gate builds it: an open, or a top-up of `SESSION`. */
export function offer(action: "open" | "topUp"): ElapsedRequirements {
  const input = {
    network: SOLANA_DEVNET,
    asset: USDC_DEVNET.mint,
    payTo: SELLER,
    receiverAuthorizer: RECEIVER_AUTHORIZER,
    terms: { rate: 1_000n, minSeconds: 5, maxSeconds: 300 },
    seconds: 100,
    facilitator: { feePayer: FEE_PAYER, rentPayer: RENT_PAYER, programId: PROGRAM, closeUrl: "http://127.0.0.1:9/close" },
    lifetime: { blockhash: "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N", lastValidBlockHeight: 100n },
    maxTimeoutSeconds: 30,
    idleCloseSeconds: 60,
    closeOnOutage: true,
  };
  return action === "open" ? buildOpenOffer(input) : buildTopUpOffer({ ...input, session: SESSION });
}
```

- [ ] **Step 2: Write the failing tests**

Create `examples/claude-demo/test/links.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { explorerAddress, explorerTx } from "../src/links.js";
import { SELLER, signatureOf } from "./fixtures.js";

describe("Explorer links", () => {
  it("link a transaction and an address on devnet", () => {
    const signature = signatureOf(7);
    expect(explorerTx(signature)).toBe(`https://explorer.solana.com/tx/${signature}?cluster=devnet`);
    expect(explorerAddress(SELLER)).toBe(`https://explorer.solana.com/address/${SELLER}?cluster=devnet`);
  });

  it("link nothing that is not base58 of the right length", () => {
    for (const bad of ["", "abc", "0OIl".repeat(16), `${signatureOf(7)}?x=1`, "javascript:alert(1)", `${SELLER}/../x`]) {
      expect(explorerTx(bad)).toBeUndefined();
      expect(explorerAddress(bad)).toBeUndefined();
    }
  });
});
```

Create `examples/claude-demo/test/exchange.test.ts`:

```ts
import {
  HEADERS,
  SOLANA_DEVNET,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
  encodePaymentSignatureHeader,
  type ElapsedRequirements,
  type PaymentRequired,
} from "@lxfoundry/stint-x402";
import { describe, expect, it } from "vitest";
import { gateRouteOf, recordExchanges, shortened, type ExchangeSink, type GateAction } from "../src/exchange.js";
import type { ExchangeRow } from "../src/state.js";
import { GATE, SELLER, SESSION, offer, signatureOf } from "./fixtures.js";

type Fetch = typeof globalThis.fetch;

/** A `fetch` that answers with `answers` in order, recording each request's URL, and fails once they run out. */
function fakeFetch(answers: Response[]): { fetch: Fetch; urls: string[] } {
  const urls: string[] = [];
  const fetch = (async (input: string | URL | Request) => {
    urls.push(String(input));
    const next = answers.shift();
    if (!next) throw new TypeError("fetch failed");
    return next;
  }) as Fetch;
  return { fetch, urls };
}

function recorder(): { sink: ExchangeSink; rows: ExchangeRow[]; offers: [GateAction, ElapsedRequirements][]; settled: [GateAction, string][] } {
  const rows: ExchangeRow[] = [];
  const offers: [GateAction, ElapsedRequirements][] = [];
  const settled: [GateAction, string][] = [];
  return {
    sink: {
      row: (row) => void rows.push(row),
      offer: (action, entry) => void offers.push([action, entry]),
      settled: (action, transaction) => void settled.push([action, transaction]),
    },
    rows,
    offers,
    settled,
  };
}

const paymentRequired = (entry: ElapsedRequirements, error?: string): Response => {
  const body: PaymentRequired = { x402Version: 2, ...(error ? { error } : {}), resource: { url: `${GATE}/sessions` }, accepts: [entry] };
  return new Response(JSON.stringify(body), { status: 402, headers: { [HEADERS.paymentRequired]: encodePaymentRequiredHeader(body) } });
};
const settledWith = (status: 200 | 201, transaction: string): Response =>
  new Response("{}", {
    status,
    headers: { [HEADERS.paymentResponse]: encodePaymentResponseHeader({ success: true, transaction, network: SOLANA_DEVNET }) },
  });
const signed = (entry: ElapsedRequirements): string =>
  encodePaymentSignatureHeader({
    x402Version: 2,
    resource: { url: `${GATE}/sessions` },
    accepted: entry,
    payload: { type: "open", transaction: "AQ==", session: SESSION },
  });

describe("the gate's paid routes", () => {
  it("are an open and a top-up, posted to the gate's own origin", () => {
    expect(gateRouteOf(GATE, "POST", `${GATE}/sessions?seconds=100`)).toEqual({ action: "open", path: "/sessions?seconds=100" });
    expect(gateRouteOf(GATE, "POST", `${GATE}/sessions/${SESSION}/top-up?seconds=100`)).toEqual({
      action: "topUp",
      path: `/sessions/${SESSION}/top-up?seconds=100`,
    });
    expect(gateRouteOf(GATE, "GET", `${GATE}/sessions/${SESSION}`)).toBeUndefined();
    expect(gateRouteOf(GATE, "POST", `${GATE}/sessions/${SESSION}/close`)).toBeUndefined();
    expect(gateRouteOf(GATE, "POST", "https://api.devnet.solana.com/sessions")).toBeUndefined();
  });
});

describe("the exchange recorder", () => {
  it("records an open: the request, the 402 and its terms, the payment, and the settled transaction", async () => {
    const { sink, rows, offers, settled } = recorder();
    const entry = offer("open");
    const transaction = signatureOf(7);
    const fetch = recordExchanges(GATE, sink, fakeFetch([paymentRequired(entry), settledWith(201, transaction)]).fetch, () => 1_000);

    await fetch(`${GATE}/sessions?seconds=100`, { method: "POST" });
    await fetch(`${GATE}/sessions?seconds=100`, { method: "POST", headers: { [HEADERS.paymentSignature]: signed(entry) } });

    expect(rows).toEqual([
      { kind: "request", at: 1_000, label: "POST /sessions?seconds=100" },
      {
        kind: "payment-required",
        at: 1_000,
        label: "402 Payment Required",
        detail: `elapsed · 0.001 USDC/s · 100 s · min 5 s · max 300 s · seller ${shortened(SELLER)}`,
        link: `https://explorer.solana.com/address/${SELLER}?cluster=devnet`,
      },
      { kind: "payment", at: 1_000, label: "PAYMENT-SIGNATURE", detail: "one transaction: 0.100 USDC → vault + open" },
      {
        kind: "settled",
        at: 1_000,
        label: "201 Created",
        detail: `transaction ${shortened(transaction)}`,
        link: `https://explorer.solana.com/tx/${transaction}?cluster=devnet`,
      },
    ]);
    expect(offers).toEqual([["open", entry]]);
    expect(settled).toEqual([["open", transaction]]);
  });

  it("records a top-up's 402 and its 200", async () => {
    const { sink, rows, settled } = recorder();
    const entry = offer("topUp");
    const transaction = signatureOf(8);
    const fetch = recordExchanges(GATE, sink, fakeFetch([paymentRequired(entry), settledWith(200, transaction)]).fetch);
    const url = `${GATE}/sessions/${SESSION}/top-up?seconds=100`;

    await fetch(url, { method: "POST" });
    await fetch(url, { method: "POST", headers: { [HEADERS.paymentSignature]: signed(entry) } });

    expect(rows.map((row) => row.label)).toEqual([`POST /sessions/${SESSION}/top-up?seconds=100`, "402 Payment Required", "PAYMENT-SIGNATURE", "200 OK"]);
    expect(rows[2]?.detail).toBe("one transaction: 0.100 USDC → vault + top-up");
    expect(settled).toEqual([["topUp", transaction]]);
  });

  it("passes every other request through untouched, and records nothing", async () => {
    const { sink, rows } = recorder();
    const answers = [new Response("a"), new Response("b"), new Response("c")];
    const first = answers[0];
    const base = fakeFetch(answers);
    const fetch = recordExchanges(GATE, sink, base.fetch);

    expect(await fetch(`${GATE}/sessions/${SESSION}`)).toBe(first);
    await fetch(`${GATE}/sessions/${SESSION}/close`, { method: "POST" });
    await fetch("https://api.devnet.solana.com", { method: "POST", body: "{}" });

    expect(rows).toEqual([]);
    expect(base.urls).toEqual([`${GATE}/sessions/${SESSION}`, `${GATE}/sessions/${SESSION}/close`, "https://api.devnet.solana.com"]);
  });

  it("records a refused payment with the gate's reason, and a gate that cannot be reached", async () => {
    const { sink, rows } = recorder();
    const entry = offer("open");
    const fetch = recordExchanges(GATE, sink, fakeFetch([paymentRequired(entry, "insufficient_funds")]).fetch, () => 5);

    await fetch(`${GATE}/sessions?seconds=100`, { method: "POST", headers: { [HEADERS.paymentSignature]: signed(entry) } });
    await expect(fetch(`${GATE}/sessions?seconds=100`, { method: "POST" })).rejects.toThrow("fetch failed");

    expect(rows).toEqual([
      { kind: "payment", at: 5, label: "PAYMENT-SIGNATURE", detail: "one transaction: 0.100 USDC → vault + open" },
      { kind: "error", at: 5, label: "402 Payment Required", detail: "insufficient_funds" },
      { kind: "request", at: 5, label: "POST /sessions?seconds=100" },
      { kind: "error", at: 5, label: "No answer from the gate", detail: "fetch failed" },
    ]);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm --filter @lxfoundry/stint-claude-demo test links.test.ts exchange.test.ts`
Expected: FAIL: `Failed to load url ../src/links.js` and `../src/exchange.js`.

- [ ] **Step 4: Write the links**

Create `examples/claude-demo/src/links.ts`:

```ts
import { isAddress, isSignature } from "@solana/kit";

const EXPLORER = "https://explorer.solana.com";

/** The transaction's page on devnet's Explorer, for a valid base58 signature only. */
export const explorerTx = (signature: string): string | undefined =>
  isSignature(signature) ? `${EXPLORER}/tx/${signature}?cluster=devnet` : undefined;

/** The account's page on devnet's Explorer, for a valid base58 address only. */
export const explorerAddress = (address: string): string | undefined =>
  isAddress(address) ? `${EXPLORER}/address/${address}?cluster=devnet` : undefined;
```

- [ ] **Step 5: Write the recorder**

Create `examples/claude-demo/src/exchange.ts`:

```ts
import {
  HEADERS,
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  decodePaymentSignatureHeader,
  readElapsedRequirements,
  type ElapsedRequirements,
} from "@lxfoundry/stint-x402";
import { formatUsdc } from "../app/model.js";
import { explorerAddress, explorerTx } from "./links.js";
import type { ExchangeRow } from "./state.js";

/** The gate's two paid routes (spec §7.1): an open, `POST /sessions`, and a top-up, `POST /sessions/:id/top-up`. */
export type GateAction = "open" | "topUp";

/** Where the recorder reports. */
export interface ExchangeSink {
  row(row: ExchangeRow): void;
  /** The entry of a 402 for the request's action: the terms the payment that follows is for. */
  offer(action: GateAction, entry: ElapsedRequirements): void;
  /** A payment the gate settled, with the signature of its transaction (`PAYMENT-RESPONSE`). */
  settled(action: GateAction, transaction: string): void;
}

type Fetch = typeof globalThis.fetch;

const STATUS_TEXT: Readonly<Record<number, string>> = {
  200: "OK",
  201: "Created",
  202: "Accepted",
  400: "Bad Request",
  401: "Unauthorized",
  402: "Payment Required",
  404: "Not Found",
  409: "Conflict",
  500: "Internal Server Error",
  502: "Bad Gateway",
};
const statusLine = (response: Response): string => `${response.status} ${STATUS_TEXT[response.status] ?? response.statusText}`.trim();
const TOP_UP_PATH = /^\/sessions\/[1-9A-HJ-NP-Za-km-z]{32,44}\/top-up$/;

/** `ABCD…WXYZ`: an address or a signature, short enough for a row. */
export const shortened = (text: string): string => (text.length > 12 ? `${text.slice(0, 4)}…${text.slice(-4)}` : text);

/** Which paid route of the gate at `gateUrl` a request is, or undefined for anything else. */
export function gateRouteOf(gateUrl: string, method: string, url: string): { readonly action: GateAction; readonly path: string } | undefined {
  if (method !== "POST" || !URL.canParse(url)) return undefined;
  const gate = new URL(gateUrl);
  const target = new URL(url);
  const prefix = gate.pathname.replace(/\/+$/, "");
  if (target.origin !== gate.origin || !target.pathname.startsWith(`${prefix}/`)) return undefined;
  const rest = target.pathname.slice(prefix.length);
  const path = `${target.pathname}${target.search}`;
  if (rest === "/sessions") return { action: "open", path };
  if (TOP_UP_PATH.test(rest)) return { action: "topUp", path };
  return undefined;
}

function requestOf(input: Parameters<Fetch>[0], init: RequestInit | undefined): { url: string; method: string; headers: Headers } {
  if (input instanceof Request) {
    return { url: input.url, method: (init?.method ?? input.method).toUpperCase(), headers: new Headers(init?.headers ?? input.headers) };
  }
  return { url: input instanceof URL ? input.href : input, method: (init?.method ?? "GET").toUpperCase(), headers: new Headers(init?.headers) };
}

function describeOffer(entry: ElapsedRequirements): string {
  const { extra } = entry;
  return `${entry.scheme} · ${formatUsdc(extra.rate)}/s · ${extra.seconds} s · min ${extra.minSeconds} s · max ${extra.maxSeconds} s · seller ${shortened(entry.payTo)}`;
}

/** The row of a request that carries `PAYMENT-SIGNATURE`: one transaction that funds the vault and opens or tops up. */
function paymentRow(action: GateAction, header: string, at: number): ExchangeRow {
  let amount: string | undefined;
  try {
    amount = readElapsedRequirements(decodePaymentSignatureHeader(header).accepted)?.amount;
  } catch {
    amount = undefined;
  }
  const into = action === "open" ? "vault + open" : "vault + top-up";
  return { kind: "payment", at, label: "PAYMENT-SIGNATURE", detail: `one transaction: ${amount === undefined ? "the deposit" : formatUsdc(amount)} → ${into}` };
}

async function excerpt(response: Response): Promise<string> {
  try {
    return (await response.clone().text()).slice(0, 200);
  } catch {
    return "";
  }
}

/**
 * A `fetch` that records, through `sink`, the x402 exchanges with the gate at `gateUrl` (spec §5): for each POST to
 * its paid routes, the request line or the payment it carries, then the 402 and its terms, the settled transaction,
 * or the refusal. Every other request goes to `base` untouched, and every answer, recorded or not, is returned as `base`
 * gave it: recording reads only headers and clones, and never fails a request.
 */
export function recordExchanges(gateUrl: string, sink: ExchangeSink, base: Fetch, clock: () => number = Date.now): Fetch {
  async function note(action: GateAction, paid: boolean, response: Response): Promise<void> {
    const at = clock();
    if (!paid && response.status === 402) {
      const header = response.headers.get(HEADERS.paymentRequired);
      const required = header === null ? undefined : decodePaymentRequiredHeader(header);
      const entry = required?.accepts.map(readElapsedRequirements).find((candidate) => candidate?.extra.action === action);
      if (entry) {
        sink.offer(action, entry);
        sink.row({ kind: "payment-required", at, label: statusLine(response), detail: describeOffer(entry), link: explorerAddress(entry.payTo) });
      } else {
        sink.row({ kind: "error", at, label: statusLine(response), detail: required?.error ?? "no offer for this request" });
      }
      return;
    }
    if (paid && (response.status === 200 || response.status === 201)) {
      const header = response.headers.get(HEADERS.paymentResponse);
      const transaction = header === null ? undefined : decodePaymentResponseHeader(header).transaction;
      if (transaction) sink.settled(action, transaction);
      sink.row({
        kind: "settled",
        at,
        label: statusLine(response),
        ...(transaction ? { detail: `transaction ${shortened(transaction)}`, link: explorerTx(transaction) } : {}),
      });
      return;
    }
    const refused = paid && response.status === 402 ? response.headers.get(HEADERS.paymentRequired) : null;
    const detail = refused === null ? await excerpt(response) : (decodePaymentRequiredHeader(refused).error ?? "payment refused");
    sink.row({ kind: "error", at, label: statusLine(response), detail });
  }

  return async (input, init) => {
    const request = requestOf(input, init);
    const route = gateRouteOf(gateUrl, request.method, request.url);
    if (!route) return base(input, init);
    const signature = request.headers.get(HEADERS.paymentSignature);
    sink.row(signature === null ? { kind: "request", at: clock(), label: `POST ${route.path}` } : paymentRow(route.action, signature, clock()));
    let response: Response;
    try {
      response = await base(input, init);
    } catch (error) {
      sink.row({ kind: "error", at: clock(), label: "No answer from the gate", detail: error instanceof Error ? error.message : String(error) });
      throw error;
    }
    await note(route.action, signature !== null, response).catch(() => undefined);
    return response;
  };
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm --filter @lxfoundry/stint-claude-demo test && pnpm --filter @lxfoundry/stint-claude-demo typecheck`
Expected: PASS, 24 tests; no type error.

- [ ] **Step 7: Commit**

```bash
git add examples/claude-demo/src/links.ts examples/claude-demo/src/exchange.ts examples/claude-demo/test/fixtures.ts examples/claude-demo/test/links.test.ts examples/claude-demo/test/exchange.test.ts
git commit -m "Record the x402 exchanges of the Claude Desktop example's client" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: One copy owns the demo's state

Claude Desktop (4.4212 on Windows, measured) starts two copies of a local MCP server, whether it is configured by
file or installed as a `.mcpb`. The panel's calls reach one; the model's ordinary tool calls reach the other; the tool
that mounts the panel ran in either. One copy must hold the wallet, the client and the session: the first to create
`owner.json` in the wallet's folder. The other forwards each call to it over HTTP on 127.0.0.1, with a Bearer token, and
takes over if it goes. A forwarder repeats a call by itself only when the owner surely ran nothing (the connection was
refused, or the owner answered `401`, `404` or `409`) or when the tool only reads; a launch, top-up or close whose
outcome it cannot know is never sent again: running it twice could pay twice (deviation 16).

**Files:**
- Create: `examples/claude-demo/src/owner.ts`
- Test: `examples/claude-demo/test/owner.test.ts`

**Interfaces:**
- Consumes: `readJson(request, limitBytes)`, `sendJson(response, status, body)`, `HttpError`
  (`packages/x402/src/http.ts:3-34`); `CallToolResult` (`@modelcontextprotocol/server`).
- Produces: `OWNER_FILE = "owner.json"`, `type CallHandler = (name: string, args: Record<string, unknown>) => Promise<CallToolResult>`,
  `interface OwnerRecord { pid: number; port: number; token: string }`,
  `interface RouterOptions { dir: string; becomeOwner: () => Promise<CallHandler>; readOnly?: ReadonlySet<string>; log?: (line: string) => void }`
  (`dir` is created if it is missing; `readOnly` names the tools a forwarder may ask again for when their outcome is
  unknown; any other call whose outcome is unknown is answered with a tool error that says so),
  `interface Router { readonly call: CallHandler; role(): "owner" | "forwarder"; close(): Promise<void> }`,
  `createRouter(options): Promise<Router>`. The endpoint: `GET /ping` → `200 { ok: true, pid }`; `POST /call`
  `{ name, arguments }` → `200` and the handler's `CallToolResult`; `401` without the token; `409` from a copy that is
  not the owner; a body above 64 KiB → `413`.

- [ ] **Step 1: Write the failing test**

Create `examples/claude-demo/test/owner.test.ts`:

```ts
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OWNER_FILE, createRouter, type CallHandler, type Router } from "../src/owner.js";

const scratch = fileURLToPath(new URL("../.cache/", import.meta.url));

/** A handler that answers with who it is, and what it was asked. */
const answering =
  (who: string): CallHandler =>
  async (name, args) => ({ content: [{ type: "text", text: who }], structuredContent: { who, name, args } });

/** A port that nothing listens on any more. */
const deadPort = () =>
  new Promise<number>((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });

describe("which copy owns the demo's state", () => {
  let home: string;
  const routers: Router[] = [];
  beforeEach(() => {
    mkdirSync(scratch, { recursive: true });
    home = mkdtempSync(join(scratch, "owner-"));
  });
  afterEach(async () => {
    for (const router of routers.splice(0)) await router.close();
    rmSync(home, { recursive: true, force: true });
  });
  const start = async (who: string): Promise<Router> => {
    const router = await createRouter({ dir: home, becomeOwner: async () => answering(who) });
    routers.push(router);
    return router;
  };
  const READ_ONLY = new Set(["stint_demo", "stint_demo_state"]);
  /**
   * An owner whose handler goes away in the middle of a call (it closes its own endpoint, which drops the connection
   * before any answer), and a forwarder; `calls` records which copy ran what.
   */
  async function ownerThatGoesAway(): Promise<{ second: Router; calls: string[] }> {
    const calls: string[] = [];
    let first: Router | undefined;
    first = await createRouter({
      dir: home,
      readOnly: READ_ONLY,
      becomeOwner: async () => async (name) => {
        calls.push(`first ${name}`);
        await first!.close();
        return answering("first")(name, {});
      },
    });
    routers.push(first);
    const second = await createRouter({
      dir: home,
      readOnly: READ_ONLY,
      becomeOwner: async () => async (name, args) => {
        calls.push(`second ${name}`);
        return answering("second")(name, args);
      },
    });
    routers.push(second);
    return { second, calls };
  }
  const record = () => JSON.parse(readFileSync(join(home, OWNER_FILE), "utf8")) as { pid: number; port: number; token: string };

  it("makes the first copy the owner and the second a forwarder, whose calls the owner answers", async () => {
    const first = await start("first");
    const second = await start("second");
    expect([first.role(), second.role()]).toEqual(["owner", "forwarder"]);
    expect(record()).toMatchObject({ pid: process.pid });
    const result = await second.call("stint_demo_state", { refreshBalance: true });
    expect(result.structuredContent).toEqual({ who: "first", name: "stint_demo_state", args: { refreshBalance: true } });
  });

  it("takes over an owner.json that names a copy no longer running", async () => {
    writeFileSync(join(home, OWNER_FILE), JSON.stringify({ pid: 1, port: await deadPort(), token: "a".repeat(64) }));
    expect((await start("new")).role()).toBe("owner");
    expect(record().token).not.toBe("a".repeat(64));
  });

  it("takes over an owner.json that cannot be read, once it has had time to be written", async () => {
    writeFileSync(join(home, OWNER_FILE), "{");
    expect((await start("new")).role()).toBe("owner");
  });

  it("refuses a call or a ping without the owner's token", async () => {
    await start("owner");
    const { port, token } = record();
    const call = (authorization?: string) =>
      fetch(`http://127.0.0.1:${port}/call`, {
        method: "POST",
        headers: authorization ? { authorization } : {},
        body: JSON.stringify({ name: "stint_demo_state", arguments: {} }),
      });
    expect((await call()).status).toBe(401);
    expect((await call(`Bearer ${"b".repeat(64)}`)).status).toBe(401);
    expect((await fetch(`http://127.0.0.1:${port}/ping`)).status).toBe(401);
    expect((await fetch(`http://127.0.0.1:${port}/ping`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(200);
    expect((await call(`Bearer ${token}`)).status).toBe(200);
  });

  it("lets a forwarder become the owner, with a state of its own, once the owner has gone", async () => {
    const first = await start("first");
    const second = await start("second");
    await first.close();
    expect(existsSync(join(home, OWNER_FILE))).toBe(false);
    const result = await second.call("stint_demo_state", {});
    expect(result.structuredContent).toMatchObject({ who: "second" });
    expect(second.role()).toBe("owner");
  });

  it("removes its owner.json when the owner cannot start", async () => {
    await expect(
      createRouter({
        dir: home,
        becomeOwner: async () => {
          throw new Error("no wallet");
        },
      }),
    ).rejects.toThrow("no wallet");
    expect(existsSync(join(home, OWNER_FILE))).toBe(false);
  });

  it("creates the folder it is given when it is missing", async () => {
    const dir = join(home, "not", "yet");
    const router = await createRouter({ dir, becomeOwner: async () => answering("new") });
    routers.push(router);
    expect(router.role()).toBe("owner");
    expect(existsSync(join(dir, OWNER_FILE))).toBe(true);
  });

  it("never runs again an action whose owner went away during it, and says so", async () => {
    const { second, calls } = await ownerThatGoesAway();
    const result = await second.call("stint_demo_launch", {});
    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0]!.text).toMatch(/went away during stint_demo_launch: it may or may not have happened/);
    expect(calls).toEqual(["first stint_demo_launch"]);
    expect(second.role()).toBe("owner");
  });

  it("asks its own state again for a read whose owner went away during it", async () => {
    const { second, calls } = await ownerThatGoesAway();
    const result = await second.call("stint_demo_state", {});
    expect(result.structuredContent).toMatchObject({ who: "second", name: "stint_demo_state" });
    expect(calls).toEqual(["first stint_demo_state", "second stint_demo_state"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @lxfoundry/stint-claude-demo test owner.test.ts`
Expected: FAIL: `Failed to load url ../src/owner.js`.

- [ ] **Step 3: Write the election, the endpoint and the forwarding**

Create `examples/claude-demo/src/owner.ts`:

```ts
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { HttpError, readJson, sendJson } from "@lxfoundry/stint-x402";

/** In the wallet's folder: which copy of the server holds the demo's state, and how to reach it. */
export const OWNER_FILE = "owner.json";
const PING_TIMEOUT_MS = 1_000;
/** A copy that finds `owner.json` unreadable reads it again after this: the copy that created it may not have written it. */
const REREAD_DELAY_MS = 250;
const MAX_BODY_BYTES = 64 * 1024;

export type CallHandler = (name: string, args: Record<string, unknown>) => Promise<CallToolResult>;

export interface OwnerRecord {
  readonly pid: number;
  readonly port: number;
  /** 32 random bytes, hexadecimal: the Bearer token of the owner's endpoint. */
  readonly token: string;
}

export interface RouterOptions {
  /** The folder `owner.json` is created in (the wallet's), itself created if it is missing. */
  readonly dir: string;
  /** Builds the handler that holds the state, once this copy is the owner. Called once per election this copy wins. */
  readonly becomeOwner: () => Promise<CallHandler>;
  /**
   * The tools that only read: a forwarder asks again for one whose owner went away during it. Any other tool is never
   * sent twice once it may have run. Default: none.
   */
  readonly readOnly?: ReadonlySet<string>;
  readonly log?: (line: string) => void;
}

/** The `code`s of the causes `fetch` fails with when it cannot connect: the request was never sent. */
const CONNECT_FAILURES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "UND_ERR_CONNECT_TIMEOUT"]);
/** The answers with which an endpoint refuses a call before it runs any tool: bad token, no such route, not the owner. */
const REFUSED_BEFORE_RUNNING = new Set([401, 404, 409]);

/** A forwarded call that failed. `ran` is false when the owner surely ran nothing, and undefined when no one can tell. */
class ForwardError extends Error {
  constructor(
    message: string,
    readonly ran: false | undefined,
  ) {
    super(message);
    this.name = "ForwardError";
  }
}

const describe = (error: unknown): string =>
  error instanceof Error ? `${error.message}${error.cause instanceof Error ? `: ${error.cause.message}` : ""}` : String(error);

export interface Router {
  /** Serves a tool call: here when this copy owns the state, through the owner's endpoint otherwise. */
  readonly call: CallHandler;
  role(): "owner" | "forwarder";
  /** Stops this copy's endpoint. The owner then removes `owner.json`, if the file still names it. */
  close(): Promise<void>;
}

type Read = OwnerRecord | "missing" | "unreadable";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const digest = (text: string) => createHash("sha256").update(text, "utf8").digest();
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isOwnerRecord = (value: unknown): value is OwnerRecord =>
  isRecord(value) && Number.isInteger(value.pid) && Number.isInteger(value.port) && typeof value.token === "string" && /^[0-9a-f]{64}$/.test(value.token);

interface Endpoint {
  readonly port: number;
  readonly token: string;
  close(): Promise<void>;
}

/**
 * `GET /ping` and `POST /call`, on 127.0.0.1 only, each with this copy's Bearer token, compared in constant time over
 * SHA-256 digests. `/call` waits for the owner's handler while it is being built, and answers `409` without one.
 */
async function startEndpoint(handler: () => Promise<CallHandler> | undefined): Promise<Endpoint> {
  const token = randomBytes(32).toString("hex");
  const expected = digest(`Bearer ${token}`);
  const authorized = (request: IncomingMessage) => timingSafeEqual(digest(request.headers.authorization ?? ""), expected);

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!authorized(request)) return sendJson(response, 401, { error: "unauthorized" });
    if (request.method === "GET" && request.url === "/ping") return sendJson(response, 200, { ok: true, pid: process.pid });
    if (request.method !== "POST" || request.url !== "/call") return sendJson(response, 404, { error: "not_found" });
    const pending = handler();
    if (!pending) return sendJson(response, 409, { error: "not_owner" });
    const body = await readJson(request, MAX_BODY_BYTES);
    if (!isRecord(body) || typeof body.name !== "string" || (body.arguments !== undefined && !isRecord(body.arguments))) {
      return sendJson(response, 400, { error: "invalid_call" });
    }
    const call = await pending;
    sendJson(response, 200, await call(body.name, (body.arguments as Record<string, unknown> | undefined) ?? {}));
  }

  const server = createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      if (response.headersSent) return void response.end();
      if (error instanceof HttpError) sendJson(response, error.status, { error: error.code });
      else sendJson(response, 500, { error: "internal" });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    port: (server.address() as AddressInfo).port,
    token,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** Creates `path` with `record`, or returns false if it exists: the first copy to create it is the owner. */
function tryCreate(path: string, record: OwnerRecord): boolean {
  let fd: number;
  try {
    fd = openSync(path, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  try {
    writeSync(fd, JSON.stringify(record));
  } finally {
    closeSync(fd);
  }
  return true;
}

function readOnce(path: string): Read {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isOwnerRecord(value) ? value : "unreadable";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable";
  }
}

async function readRecord(path: string): Promise<Read> {
  const first = readOnce(path);
  if (first !== "unreadable") return first;
  await sleep(REREAD_DELAY_MS);
  return readOnce(path);
}

async function ping(record: OwnerRecord): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${record.port}/ping`, {
      headers: { authorization: `Bearer ${record.token}` },
      signal: AbortSignal.timeout(PING_TIMEOUT_MS),
    });
    await response.body?.cancel();
    return response.status === 200;
  } catch {
    return false;
  }
}

const sameRead = (a: Read, b: Read) => (typeof a === "object" && typeof b === "object" ? a.token === b.token : a === b);

/** Removes `path` if it still holds what was read: a newer owner's file stays. */
function removeStale(path: string, seen: Read): void {
  if (!sameRead(readOnce(path), seen)) return;
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/**
 * Elects the copy that holds the state (one `owner.json` per wallet folder) and routes every call to it. A copy starts
 * its endpoint, then tries to create `owner.json` naming it. If the file exists and its copy answers `/ping`, this copy
 * forwards; if not (a dead copy, a stale or unreadable file), it removes the file and tries once more. A forwarder whose
 * owner cannot be reached elects again, once per call, and may become the owner, with a state of its own. It then sends
 * the call again only if the owner surely ran nothing, or if the tool only reads; otherwise it answers with a tool error.
 */
export async function createRouter(options: RouterOptions): Promise<Router> {
  // Before anything else: `openSync(…, "wx")` cannot create a file in a folder that does not exist.
  mkdirSync(options.dir, { recursive: true });
  const path = join(options.dir, OWNER_FILE);
  const log = options.log ?? (() => {});
  const readOnly = options.readOnly ?? new Set<string>();
  let role: "owner" | "forwarder" = "forwarder";
  let endpoint: Endpoint | undefined;
  let peer: OwnerRecord | undefined;
  let handler: Promise<CallHandler> | undefined;
  let electing: Promise<void> | undefined;

  const removeOurs = (token: string) => {
    const now = readOnce(path);
    if (typeof now === "object" && now.pid === process.pid && now.token === token) removeStale(path, now);
  };

  async function elect(): Promise<void> {
    for (let attempt = 1; attempt <= 2; attempt++) {
      const mine = await startEndpoint(() => handler);
      if (tryCreate(path, { pid: process.pid, port: mine.port, token: mine.token })) {
        endpoint = mine;
        role = "owner";
        peer = undefined;
        handler = options.becomeOwner();
        try {
          await handler;
        } catch (error) {
          handler = undefined;
          role = "forwarder";
          endpoint = undefined;
          await mine.close();
          removeOurs(mine.token);
          throw error;
        }
        return;
      }
      await mine.close();
      const seen = await readRecord(path);
      if (typeof seen === "object" && (await ping(seen))) {
        role = "forwarder";
        peer = seen;
        return;
      }
      if (seen !== "missing") {
        log(`${path} names no copy that answers: taking it over`);
        removeStale(path, seen);
      }
    }
    throw new Error(`Could not settle which copy of the server holds the demo's state (${path})`);
  }

  const reelect = (): Promise<void> =>
    (electing ??= elect().finally(() => {
      electing = undefined;
    }));

  /**
   * Sends the call to the owner. A failure says whether the owner surely ran nothing (it could not be reached, or it
   * refused the call first) or whether no one can tell (the connection dropped once the call was sent, or the answer
   * was not one), which a reused connection to an owner that has just gone can also give.
   */
  async function forward(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    const target = peer;
    if (!target) throw new ForwardError("no owner to forward to", false);
    let response: Response;
    try {
      response = await fetch(`http://127.0.0.1:${target.port}/call`, {
        method: "POST",
        headers: { authorization: `Bearer ${target.token}`, "content-type": "application/json" },
        body: JSON.stringify({ name, arguments: args }),
      });
    } catch (error) {
      const code = String(((error as Error).cause as { code?: unknown } | undefined)?.code);
      throw new ForwardError(`the owner copy cannot be reached (${describe(error)})`, CONNECT_FAILURES.has(code) ? false : undefined);
    }
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new ForwardError(`the owner copy answered ${response.status}`, REFUSED_BEFORE_RUNNING.has(response.status) ? false : undefined);
    }
    try {
      return (await response.json()) as CallToolResult;
    } catch (error) {
      throw new ForwardError(`the owner copy's answer was cut short (${describe(error)})`, undefined);
    }
  }

  const call: CallHandler = async (name, args) => {
    if (role === "owner" && handler) return (await handler)(name, args);
    try {
      return await forward(name, args);
    } catch (error) {
      if (!(error instanceof ForwardError)) throw error;
      log(`${error.message}: electing again`);
      await reelect();
      // A launch, top-up or close may have run before the owner went: sent again, it could pay twice.
      if (error.ran === undefined && !readOnly.has(name)) {
        const text = `The copy of the server that held the demo's state went away during ${name}: it may or may not have happened. Check the panel before trying again.`;
        return { isError: true, content: [{ type: "text", text }] };
      }
      if (role === "owner" && handler) return (await handler)(name, args);
      return forward(name, args);
    }
  };

  await reelect();
  return {
    call,
    role: () => role,
    async close() {
      const mine = endpoint;
      endpoint = undefined;
      await mine?.close();
      if (role === "owner" && mine) removeOurs(mine.token);
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @lxfoundry/stint-claude-demo test && pnpm --filter @lxfoundry/stint-claude-demo typecheck`
Expected: PASS, 33 tests; no type error.

- [ ] **Step 5: Commit**

```bash
git add examples/claude-demo/src/owner.ts examples/claude-demo/test/owner.test.ts
git commit -m "Elect one copy of the Claude Desktop example to hold its state, and forward the other's calls to it" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: The session, as the owner keeps it

The owner's state and its three actions, over the client's shared session tools (`createSessionTools`,
`packages/client/src/tools.ts:122-354`), so that every payment passes the client's policy checks. The session's end is
followed at each state read: the stream connection's close code, then the close found on the chain.

**Files:**
- Create: `examples/claude-demo/src/chain.ts`, `examples/claude-demo/src/demo.ts`
- Test: `examples/claude-demo/test/demo.test.ts`

**Interfaces:**
- Consumes: `SessionTools` and its tools' inputs and outputs (`packages/client/src/tools.ts:15-91`: `stint_open_session`
  returns `{ sessionId, paidUntil, cost, remainingBudget }`, `stint_top_up` `{ paidUntil, cost }`, `stint_close_session`
  `{ paid?, refunded?, transaction }`; `stint_send` connects first if needed; `stint_receive` with `timeoutSeconds: 0`
  returns what is queued; `closeCode(id)`; `closeAll()` skips sessions the gate ended with `4402` or `4410`);
  `findClose(rpc, session)` (`packages/x402/src/chain.ts:58-93`: `{ signature, event }`, the `ClosedEvent`'s `at`,
  `paidUntil`, `claimed`, `owed`, `redirected`, `refunded`); `associatedTokenAddress`, `USDC_DEVNET`,
  `TOP_UP_MARGIN_SECONDS` (`@lxfoundry/stint-x402`); `ExchangeSink`, `GateAction`, `explorerTx`, `explorerAddress`
  (Task 8); `topUpRefusal`, `closeRefusal`, `formatUsdc` (Task 6). The stream's subscribe message is
  `{"op": "subscribe", "accounts": [...]}` and its account messages `{"type": "account", …}` (spec §8,
  `examples/solana-stream/src/adapter.ts:16-32, 55-64`).
- Produces:
  - from `src/chain.ts`: `interface FoundClose { signature: string; at: number; paidUntil: number; paid: string; refunded: string }`,
    `interface DemoChain { usdcAccount: string; usdcBalance(): Promise<bigint>; findClose(session: string): Promise<FoundClose | undefined> }`,
    `createRpcDemoChain(rpcUrl: string, owner: Address): Promise<DemoChain>`;
  - from `src/demo.ts`: `class DemoError`, `CLOSE_LOOKUP_EVERY_MS = 4_000`, `RESUBSCRIBE_EVERY_MS = 15_000`,
    `interface DemoOptions { address; gateUrl; tools: SessionTools; chain: DemoChain; now?; log? }`,
    `interface Demo { sink: ExchangeSink; state(options?: { refreshBalance?: boolean }): Promise<DemoState>; launch(): Promise<DemoState>; topUp(): Promise<DemoState>; close(): Promise<DemoState>; shutdown(): Promise<CloseAllOutput> }`,
    `createDemo(options): Demo`. An action that fails throws, and the state then carries `error`. An action that
    recorded no exchange rows (a close, a top-up refused before the gate) leaves `exchange.last` as it was. The balance
    is read again after each action and when a session's close is first found.

- [ ] **Step 1: Write the failing test**

Create `examples/claude-demo/test/demo.test.ts`:

```ts
import type {
  CloseAllOutput,
  CloseInput,
  CloseOutput,
  OpenInput,
  OpenOutput,
  ReceiveInput,
  ReceiveOutput,
  SendInput,
  SessionTools,
  StatusInput,
  StatusOutput,
  Tool,
  TopUpInput,
  TopUpOutput,
} from "@lxfoundry/stint-client";
import { describe, expect, it } from "vitest";
import type { DemoChain, FoundClose } from "../src/chain.js";
import { createDemo, type Demo } from "../src/demo.js";
import { explorerAddress, explorerTx } from "../src/links.js";
import { AGENT_USDC, SELLER, SESSION, offer, signatureOf } from "./fixtures.js";

const START_MS = 1_800_000_000_000;
const OPEN_TX = signatureOf(1);
const TOP_UP_TX = signatureOf(2);
const CLOSE_TX = signatureOf(3);

const tool = <I, O>(name: string, run: (input: I) => Promise<O>): Tool<I, O> => ({ name, description: name, inputSchema: {}, run });

/** A demo over fake session tools, whose open reports to the sink as the recorder would, and over a fake chain. */
function setup(options: { balance?: bigint } = {}) {
  let clock = START_MS;
  let paidUntil = 0;
  const sent: unknown[] = [];
  const inbox: unknown[] = [];
  const closeCodes = new Map<string, number>();
  const closes = new Map<string, FoundClose>();
  const counts = { open: 0, topUp: 0, close: 0, closeAll: 0 };
  let demo: Demo | undefined;
  const sink = () => demo!.sink;
  const tools: SessionTools = {
    tools: {
      stint_open_session: tool<OpenInput, OpenOutput>("stint_open_session", async () => {
        counts.open++;
        sink().row({ kind: "request", at: clock, label: "POST /sessions?seconds=100" });
        sink().offer("open", offer("open"));
        sink().settled("open", OPEN_TX);
        paidUntil = Math.floor(clock / 1000) + 100;
        return { sessionId: SESSION, paidUntil, cost: "100000", remainingBudget: "500000" };
      }),
      stint_session_status: tool<StatusInput, StatusOutput>("stint_session_status", async () => {
        throw new Error("not used by the demo");
      }),
      stint_top_up: tool<TopUpInput, TopUpOutput>("stint_top_up", async () => {
        counts.topUp++;
        sink().settled("topUp", TOP_UP_TX);
        paidUntil += 100;
        return { paidUntil, cost: "100000" };
      }),
      stint_send: tool<SendInput, { ok: true }>("stint_send", async (input) => {
        sent.push(input.message);
        return { ok: true };
      }),
      stint_receive: tool<ReceiveInput, ReceiveOutput>("stint_receive", async () => {
        const messages = inbox.splice(0);
        return { messages, timedOut: messages.length === 0 };
      }),
      stint_close_session: tool<CloseInput, CloseOutput>("stint_close_session", async () => {
        counts.close++;
        return { paid: "12000", refunded: "88000", transaction: CLOSE_TX };
      }),
    },
    closeCode: (sessionId) => closeCodes.get(sessionId),
    closeAll: async (): Promise<CloseAllOutput> => {
      counts.closeAll++;
      return { closed: [SESSION], failed: [] };
    },
  };
  let balance = options.balance ?? 1_000_000n;
  const chain: DemoChain = {
    usdcAccount: AGENT_USDC,
    usdcBalance: async () => balance,
    findClose: async (session) => closes.get(session),
  };
  demo = createDemo({ address: "AgentWallet", gateUrl: "https://gate.example", tools, chain, now: () => clock });
  return {
    demo,
    sent,
    inbox,
    closeCodes,
    closes,
    counts,
    advance: (ms: number) => void (clock += ms),
    setBalance: (value: bigint) => void (balance = value),
    paidUntil: () => paidUntil,
  };
}

describe("the demo's session", () => {
  it("launches a 100 s session, with its terms and links, and subscribes to the agent's own USDC account", async () => {
    const t = setup();
    const state = await t.demo.launch();
    expect(state.session).toMatchObject({
      state: "open",
      sessionId: SESSION,
      paidUntil: t.paidUntil(),
      startedAt: t.paidUntil() - 100,
      deposited: "100000",
      rate: "1000",
      maxSeconds: 300,
      topUpMarginSeconds: 10,
      frames: 0,
    });
    expect(state.session.links).toEqual({ session: explorerAddress(SESSION), open: explorerTx(OPEN_TX), topUps: [], seller: explorerAddress(SELLER) });
    expect(t.sent).toEqual([{ op: "subscribe", accounts: [AGENT_USDC] }]);
    expect(state.busy).toBeUndefined();
    expect(state.exchange).toEqual({ current: [], last: { action: "launch", rows: [{ kind: "request", at: START_MS, label: "POST /sessions?seconds=100" }] } });
    expect(state.wallet).toMatchObject({ address: "AgentWallet", usdc: "1000000" });
  });

  it("refuses a launch the wallet cannot pay for, and a second one while a session runs", async () => {
    const poor = setup({ balance: 99_999n });
    await expect(poor.demo.launch()).rejects.toThrow(/needs 0\.100 USDC/);
    expect(poor.counts.open).toBe(0);
    expect((await poor.demo.state()).error).toMatchObject({ action: "launch" });
    const t = setup();
    await t.demo.launch();
    await expect(t.demo.launch()).rejects.toThrow(/already running/);
    expect(t.counts.open).toBe(1);
  });

  it("closes the session now, with what was paid and refunded, and the close's link", async () => {
    const t = setup();
    await t.demo.launch();
    t.advance(12_000);
    const state = await t.demo.close();
    expect(state.session).toMatchObject({ state: "closed", paid: "12000", refunded: "88000", endedAt: Math.floor(START_MS / 1000) + 12 });
    expect(state.session.links.close).toBe(explorerTx(CLOSE_TX));
    // A close sends no paid request to the gate: the panel keeps showing the launch's exchange.
    expect(state.exchange.last?.action).toBe("launch");
    await expect(t.demo.close()).rejects.toThrow(/is closed/);
    expect(t.counts.close).toBe(1);
    expect((await t.demo.state()).exchange.last?.action).toBe("launch");
  });

  it("tops up by 100 s, and refuses past the longest session and near the end of the paid time", async () => {
    const t = setup();
    await t.demo.launch();
    let state = await t.demo.topUp();
    expect(state.session).toMatchObject({ paidUntil: t.paidUntil(), deposited: "200000" });
    expect(state.session.links.topUps).toEqual([explorerTx(TOP_UP_TX)]);
    state = await t.demo.topUp();
    expect(state.session.deposited).toBe("300000");
    await expect(t.demo.topUp()).rejects.toThrow(/at most 300 s/);
    const late = setup();
    await late.demo.launch();
    late.advance(87_000);
    await expect(late.demo.topUp()).rejects.toThrow(/Too close to the end/);
    expect(late.counts.topUp).toBe(0);
    expect((await late.demo.state()).exchange.last?.action).toBe("launch");
  });

  it("counts the stream's account messages at each state read (optional)", async () => {
    const t = setup();
    await t.demo.launch();
    t.inbox.push({ type: "account", address: AGENT_USDC }, { type: "error", code: "subscription_failed" }, { type: "account", address: AGENT_USDC });
    expect((await t.demo.state()).session.frames).toBe(2);
  });

  it("sends the subscription again while the session runs, at most every 15 s", async () => {
    const t = setup();
    await t.demo.launch();
    await t.demo.state();
    expect(t.sent).toHaveLength(1);
    t.advance(15_000);
    await t.demo.state();
    expect(t.sent).toHaveLength(2);
  });

  it("follows a session to its expiry: the gate closing it, then the seller paid in full, with the close's link", async () => {
    const t = setup();
    await t.demo.launch();
    t.advance(100_000);
    expect((await t.demo.state()).session.state).toBe("open");
    t.closes.set(SESSION, { signature: CLOSE_TX, at: t.paidUntil() + 1, paidUntil: t.paidUntil(), paid: "100000", refunded: "0" });
    t.advance(4_000);
    const state = await t.demo.state();
    expect(state.session).toMatchObject({ state: "expired", paid: "100000", refunded: "0" });
    expect(state.session.links.close).toBe(explorerTx(CLOSE_TX));
  });

  it("marks a session the gate dropped with 4410 as ended, with the close found on the chain and the refund in the balance", async () => {
    const t = setup();
    await t.demo.launch();
    t.advance(61_000);
    t.closeCodes.set(SESSION, 4410);
    t.closes.set(SESSION, { signature: CLOSE_TX, at: t.paidUntil() - 39, paidUntil: t.paidUntil(), paid: "61000", refunded: "39000" });
    t.setBalance(939_000n);
    const state = await t.demo.state();
    expect(state.session).toMatchObject({ state: "ended", closeCode: 4410, paid: "61000", refunded: "39000" });
    expect(state.wallet.usdc).toBe("939000");
  });

  it("closes a running session at shutdown, opens none after, and leaves alone one whose paid time is over", async () => {
    const t = setup();
    await t.demo.launch();
    expect(await t.demo.shutdown()).toEqual({ closed: [SESSION], failed: [] });
    await expect(t.demo.launch()).rejects.toThrow(/shutting down/);
    const over = setup();
    await over.demo.launch();
    over.advance(100_000);
    expect(await over.demo.shutdown()).toEqual({ closed: [], failed: [] });
    expect(over.counts.closeAll).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @lxfoundry/stint-claude-demo test demo.test.ts`
Expected: FAIL: `Failed to load url ../src/demo.js`.

- [ ] **Step 3: Write the chain reads**

Create `examples/claude-demo/src/chain.ts`:

```ts
import { address, createSolanaRpc, type Address } from "@solana/kit";
import { USDC_DEVNET, associatedTokenAddress, findClose } from "@lxfoundry/stint-x402";

/** A session's close found on the chain, from its `Closed` event (spec §4.4). */
export interface FoundClose {
  readonly signature: string;
  /** Unix seconds, on the chain's clock. */
  readonly at: number;
  readonly paidUntil: number;
  /** All the seller was paid for the session: claimed, owed and redirected. */
  readonly paid: string;
  readonly refunded: string;
}

/** What the demo reads from the chain itself; everything else goes through the gate. */
export interface DemoChain {
  /** The agent's USDC account, which the stream watches. */
  readonly usdcAccount: string;
  /** Its balance in base units; 0 while the account does not exist. */
  usdcBalance(): Promise<bigint>;
  findClose(session: string): Promise<FoundClose | undefined>;
}

export async function createRpcDemoChain(rpcUrl: string, owner: Address): Promise<DemoChain> {
  const rpc = createSolanaRpc(rpcUrl);
  const usdcAccount = await associatedTokenAddress(owner, USDC_DEVNET.mint);
  return {
    usdcAccount,
    async usdcBalance() {
      const { value } = await rpc.getAccountInfo(usdcAccount, { commitment: "confirmed", encoding: "base64" }).send();
      if (value === null) return 0n;
      const balance = await rpc.getTokenAccountBalance(usdcAccount, { commitment: "confirmed" }).send();
      return BigInt(balance.value.amount);
    },
    async findClose(session) {
      const found = await findClose(rpc, address(session));
      if (!found) return undefined;
      const { event } = found;
      return {
        signature: found.signature,
        at: Number(event.at),
        paidUntil: Number(event.paidUntil),
        paid: (event.claimed + event.owed + event.redirected).toString(),
        refunded: event.refunded.toString(),
      };
    },
  };
}
```

- [ ] **Step 4: Write the session logic**

Create `examples/claude-demo/src/demo.ts`:

```ts
import type { CloseAllOutput, OpenOutput, SessionTools } from "@lxfoundry/stint-client";
import { TOP_UP_MARGIN_SECONDS, type ElapsedRequirements } from "@lxfoundry/stint-x402";
import { closeRefusal, formatUsdc, topUpRefusal } from "../app/model.js";
import type { DemoChain, FoundClose } from "./chain.js";
import type { ExchangeSink, GateAction } from "./exchange.js";
import { explorerAddress, explorerTx } from "./links.js";
import { FAUCET_URL, LAUNCH_AMOUNT, LAUNCH_SECONDS, TOP_UP_SECONDS, type DemoAction, type DemoSession, type DemoState, type ExchangeRow } from "./state.js";

export class DemoError extends Error {
  override name = "DemoError";
}

export interface DemoOptions {
  /** The agent's wallet. */
  readonly address: string;
  readonly gateUrl: string;
  readonly tools: SessionTools;
  readonly chain: DemoChain;
  /** Milliseconds. Default `Date.now`. */
  readonly now?: () => number;
  readonly log?: (line: string) => void;
}

export interface Demo {
  /** Where the exchange recorder reports. */
  readonly sink: ExchangeSink;
  /** The state, after following the session: frames, the connection's close code, the close on the chain. */
  state(options?: { readonly refreshBalance?: boolean }): Promise<DemoState>;
  launch(): Promise<DemoState>;
  topUp(): Promise<DemoState>;
  close(): Promise<DemoState>;
  /** Closes the session if one runs and is still paid for; nothing opens afterwards. */
  shutdown(): Promise<CloseAllOutput>;
}

/** How often, at most, the chain is asked for a session's close while one is awaited. */
export const CLOSE_LOOKUP_EVERY_MS = 4_000;
/** How often, at most, the stream subscription is sent again while a session runs. */
export const RESUBSCRIBE_EVERY_MS = 15_000;
const REASON = "The Stint demo: watch the agent's own USDC account on the example stream";

type Mutable<T> = { -readonly [Key in keyof T]: T[Key] };
type Links = Mutable<Omit<DemoSession["links"], "topUps">> & { topUps: string[] };
type Session = Mutable<Omit<DemoSession, "links">> & { links: Links };

const RUNNING: ReadonlySet<DemoSession["state"]> = new Set(["opening", "open", "closing"]);
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const isAccountMessage = (value: unknown) => typeof value === "object" && value !== null && (value as { type?: unknown }).type === "account";
const seconds = (ms: number) => Math.floor(ms / 1000);

/** The owner's state and its actions (the panel's buttons and the model's tools alike), one session at a time. */
export function createDemo(options: DemoOptions): Demo {
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => {});
  const { tools, chain } = options;
  const blank = (): Session => ({ state: "none", topUpMarginSeconds: TOP_UP_MARGIN_SECONDS, frames: 0, links: { topUps: [] } });

  let wallet: { usdc?: string; checkedAt?: number } = {};
  let session = blank();
  let current: ExchangeRow[] = [];
  let last: { action: DemoAction; rows: ExchangeRow[] } | undefined;
  let busy: DemoAction | undefined;
  let failure: { action: DemoAction; message: string; at: number } | undefined;
  let openOffer: ElapsedRequirements | undefined;
  const settled: Partial<Record<GateAction, string>> = {};
  let lastLookup = -Infinity;
  let lastSubscribe = -Infinity;
  let following: Promise<void> | undefined;
  let leaving = false;

  const sink: ExchangeSink = {
    row: (row) => void current.push(row),
    offer: (action, entry) => {
      if (action === "open") openOffer = entry;
    },
    settled: (action, transaction) => {
      settled[action] = transaction;
    },
  };

  async function refreshBalance(): Promise<void> {
    try {
      wallet = { usdc: (await chain.usdcBalance()).toString(), checkedAt: now() };
    } catch (error) {
      log(`reading the wallet's balance failed: ${message(error)}`);
    }
  }

  function snapshot(): DemoState {
    return {
      wallet: { address: options.address, ...wallet },
      gateUrl: options.gateUrl,
      faucetUrl: FAUCET_URL,
      session: { ...session, links: { ...session.links, topUps: [...session.links.topUps] } },
      exchange: { current: [...current], ...(last ? { last: { action: last.action, rows: [...last.rows] } } : {}) },
      now: now(),
      ...(busy ? { busy } : {}),
      ...(failure ? { error: failure } : {}),
    };
  }

  /**
   * One action at a time. Its rows, if it had any, become the last exchange: a close, or a top-up refused before it
   * reached the gate, leaves the panel showing the exchange before it. The balance is read again, however it ends.
   */
  async function run(action: DemoAction, work: () => Promise<void>): Promise<DemoState> {
    if (busy) throw new DemoError(`A ${busy} is already under way`);
    busy = action;
    current = [];
    failure = undefined;
    try {
      await work();
    } catch (error) {
      failure = { action, message: message(error), at: now() };
      throw error;
    } finally {
      if (current.length > 0) last = { action, rows: current };
      current = [];
      busy = undefined;
      await refreshBalance();
    }
    return snapshot();
  }

  /**
   * Sends the stream subscription to the agent's own USDC account: frames arrive when its money moves. Sent again at
   * most every `RESUBSCRIBE_EVERY_MS`, while more than 3 s are paid for: the stream ignores an account a connection
   * already watches, and `stint_send` opens the connection again if it dropped.
   */
  async function subscribe(force: boolean): Promise<void> {
    const id = session.sessionId;
    if (session.state !== "open" || !id || session.paidUntil === undefined) return;
    if (!force && now() - lastSubscribe < RESUBSCRIBE_EVERY_MS) return;
    if (now() >= (session.paidUntil - 3) * 1000) return;
    lastSubscribe = now();
    try {
      await tools.tools.stint_send.run({ sessionId: id, message: { op: "subscribe", accounts: [chain.usdcAccount] } });
    } catch (error) {
      log(`the stream subscription failed: ${message(error)}`);
    }
  }

  /**
   * Looks the session's close up on the chain (optional: without it, the session's address link lists the close), at
   * most every `CLOSE_LOOKUP_EVERY_MS` unless `force`. The close decides: `expired` at or after its `paid_until`;
   * `ended` before, unless this server closed it. A close found moves the agent's money, so the balance is read again.
   */
  async function lookUpClose(force: boolean): Promise<void> {
    const id = session.sessionId;
    if (!id || session.links.close) return;
    if (!force && now() - lastLookup < CLOSE_LOOKUP_EVERY_MS) return;
    lastLookup = now();
    let found: FoundClose | undefined;
    try {
      found = await chain.findClose(id);
    } catch (error) {
      log(`looking up the close of ${id} failed: ${message(error)}`);
      return;
    }
    if (!found || session.sessionId !== id) return;
    session.links.close = explorerTx(found.signature);
    session.paid = found.paid;
    session.refunded = found.refunded;
    session.endedAt = found.at;
    if (found.at >= found.paidUntil) session.state = "expired";
    else if (session.state !== "closed") session.state = "ended";
    await refreshBalance();
  }

  /** Follows the session at a state read: frames (optional), the connection's close code, then the close on the chain. */
  async function follow(): Promise<void> {
    const id = session.sessionId;
    if (!id) return;
    if (RUNNING.has(session.state)) {
      try {
        const { messages } = await tools.tools.stint_receive.run({ sessionId: id, max: 100, timeoutSeconds: 0 });
        session.frames += messages.filter(isAccountMessage).length;
      } catch {
        // Nothing queued to count.
      }
    }
    if (session.state !== "open") {
      if ((session.state === "expired" || session.state === "ended") && !session.links.close) await lookUpClose(false);
      return;
    }
    const code = tools.closeCode(id);
    if (code !== undefined) session.closeCode = code;
    if (code === 4410) {
      session.state = "ended";
      session.endedAt ??= seconds(now());
      return lookUpClose(true);
    }
    if (code === 4402) {
      session.state = "expired";
      session.endedAt = session.paidUntil;
      session.paid ??= session.deposited;
      session.refunded ??= "0";
      return lookUpClose(true);
    }
    if (session.paidUntil !== undefined && now() >= session.paidUntil * 1000) return lookUpClose(false);
    await subscribe(false);
  }

  async function launch(): Promise<void> {
    if (leaving) throw new DemoError("The demo is shutting down: no session can be opened");
    if (RUNNING.has(session.state)) throw new DemoError("A session is already running: top it up, close it, or let it end");
    await refreshBalance();
    if (wallet.usdc !== undefined && BigInt(wallet.usdc) < BigInt(LAUNCH_AMOUNT)) {
      throw new DemoError(
        `The wallet holds ${formatUsdc(wallet.usdc)} and a launch needs ${formatUsdc(LAUNCH_AMOUNT)}: get devnet USDC for ${options.address} at ${FAUCET_URL}`,
      );
    }
    openOffer = undefined;
    delete settled.open;
    session = { ...blank(), state: "opening" };
    let opened: OpenOutput;
    try {
      opened = await tools.tools.stint_open_session.run({ url: options.gateUrl, seconds: LAUNCH_SECONDS, reason: REASON });
    } catch (error) {
      session = blank();
      throw error;
    }
    const rate = openOffer ? BigInt(openOffer.extra.rate) : undefined;
    session = {
      ...blank(),
      state: "open",
      sessionId: opened.sessionId,
      paidUntil: opened.paidUntil,
      deposited: opened.cost,
      ...(rate === undefined ? {} : { startedAt: opened.paidUntil - Number(BigInt(opened.cost) / rate), rate: rate.toString() }),
      ...(openOffer ? { maxSeconds: openOffer.extra.maxSeconds } : {}),
      links: {
        session: explorerAddress(opened.sessionId),
        open: settled.open === undefined ? undefined : explorerTx(settled.open),
        topUps: [],
        seller: openOffer ? explorerAddress(openOffer.payTo) : undefined,
      },
    };
    await subscribe(true);
  }

  async function topUp(): Promise<void> {
    const refusal = topUpRefusal(session, now());
    if (refusal) throw new DemoError(refusal);
    delete settled.topUp;
    const receipt = await tools.tools.stint_top_up.run({ sessionId: session.sessionId!, seconds: TOP_UP_SECONDS });
    session.paidUntil = Math.max(session.paidUntil ?? 0, receipt.paidUntil);
    session.deposited = (BigInt(session.deposited ?? "0") + BigInt(receipt.cost)).toString();
    const link = settled.topUp === undefined ? undefined : explorerTx(settled.topUp);
    if (link) session.links.topUps.push(link);
  }

  async function close(): Promise<void> {
    const refusal = closeRefusal(session, now());
    if (refusal) throw new DemoError(refusal);
    const id = session.sessionId!;
    session.state = "closing";
    try {
      const receipt = await tools.tools.stint_close_session.run({ sessionId: id });
      session.state = "closed";
      session.endedAt = seconds(now());
      if (receipt.paid !== undefined) session.paid = receipt.paid;
      if (receipt.refunded !== undefined) session.refunded = receipt.refunded;
      session.links.close = explorerTx(receipt.transaction);
    } catch (error) {
      if (session.state === "closing") session.state = "open";
      // The session may have ended meanwhile, closed by the gate or another party: the chain says.
      await lookUpClose(true);
      throw error;
    }
  }

  return {
    sink,
    async state(request = {}) {
      if (request.refreshBalance || wallet.checkedAt === undefined) await refreshBalance();
      following ??= follow().finally(() => {
        following = undefined;
      });
      await following;
      return snapshot();
    },
    launch: () => run("launch", launch),
    topUp: () => run("top-up", topUp),
    close: () => run("close", close),
    async shutdown() {
      leaving = true;
      const paidFor = session.paidUntil === undefined || now() < session.paidUntil * 1000;
      if (!RUNNING.has(session.state) || !paidFor) return { closed: [], failed: [] };
      return tools.closeAll();
    },
  };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @lxfoundry/stint-claude-demo test && pnpm --filter @lxfoundry/stint-claude-demo typecheck`
Expected: PASS, 42 tests; no type error.

- [ ] **Step 6: Commit**

```bash
git add examples/claude-demo/src/chain.ts examples/claude-demo/src/demo.ts examples/claude-demo/test/demo.test.ts
git commit -m "Keep the Claude Desktop example's session state over the client's session tools" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: The tools, and the MCP server that declares the panel

Both copies register the same tools and the same resource, so either can serve anything; what a tool does is the
owner's handler's (Task 9's router decides where it runs). The server declares the MCP Apps extension itself.

**Files:**
- Create: `examples/claude-demo/src/tools.ts`, `examples/claude-demo/src/server.ts`
- Test: `examples/claude-demo/test/tools.test.ts`, `examples/claude-demo/test/server.test.ts`

**Interfaces:**
- Consumes: `McpServer` (`@modelcontextprotocol/server` 2.4.0: `new McpServer(info, { capabilities, instructions })`,
  `registerTool(name, { description, inputSchema, _meta }, cb)`; `ServerCapabilities.extensions` is a record of JSON
  objects); `registerAppTool`, `registerAppResource`, `RESOURCE_MIME_TYPE` (`"text/html;profile=mcp-app"`) and
  `EXTENSION_ID` (`"io.modelcontextprotocol/ui"`) from `@modelcontextprotocol/ext-apps/server` 2.0.4; `zod` 4.6.7;
  `Demo` (Task 10), `CallHandler` (Task 9), `TOOL`, `PANEL_URI`, `LAUNCH_SECONDS`, `TOP_UP_SECONDS` (Task 6). The
  patterns of `packages/mcp/src/server.ts:11-21` and `packages/mcp/test/server.test.ts:34-48` (`InMemoryTransport`).
- Produces:
  - from `src/tools.ts`: `TOOL_DESCRIPTIONS: Readonly<Record<ToolName, string>>`, `INSTRUCTIONS: string`,
    `stateResult(state: DemoState): CallToolResult`, `errorResult(message: string, state: DemoState): CallToolResult`,
    `createCallHandler(demo: Demo, log: (line: string) => void): CallHandler` (one log line per call,
    `<name> ok|error in <ms> ms`, but none for a `stint_demo_state` that succeeds: deviation 20);
  - from `src/server.ts`: `SERVER_INFO = { name: "stint-claude-demo", version: "0.1.0" }`,
    `createDemoServer(options: { html: string; call: CallHandler }): McpServer`.

- [ ] **Step 1: Write the failing tests**

Create `examples/claude-demo/test/tools.test.ts`:

```ts
import type { CloseAllOutput } from "@lxfoundry/stint-client";
import { describe, expect, it } from "vitest";
import type { Demo } from "../src/demo.js";
import { FAUCET_URL, TOOL, type DemoState } from "../src/state.js";
import { createCallHandler } from "../src/tools.js";

const STATE: DemoState = {
  wallet: { address: "AgentWallet", usdc: "100000", checkedAt: 1 },
  gateUrl: "https://gate.example",
  faucetUrl: FAUCET_URL,
  session: { state: "none", topUpMarginSeconds: 10, frames: 0, links: { topUps: [] } },
  exchange: { current: [] },
  now: 1,
};

function fakeDemo(overrides: Partial<Demo> = {}): { demo: Demo; reads: unknown[] } {
  const reads: unknown[] = [];
  const demo: Demo = {
    sink: { row: () => {}, offer: () => {}, settled: () => {} },
    state: async (options) => {
      reads.push(options ?? {});
      return STATE;
    },
    launch: async () => STATE,
    topUp: async () => STATE,
    close: async () => STATE,
    shutdown: async (): Promise<CloseAllOutput> => ({ closed: [], failed: [] }),
    ...overrides,
  };
  return { demo, reads };
}
const text = (result: { content?: unknown }) => (result.content as { text: string }[])[0]!.text;

describe("the owner's tool handler", () => {
  it("answers each tool with the state, as JSON text and as structured content", async () => {
    const call = createCallHandler(fakeDemo().demo, () => {});
    for (const name of Object.values(TOOL)) {
      const result = await call(name, {});
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toEqual(STATE);
      expect(JSON.parse(text(result))).toEqual(STATE);
    }
  });

  it("reads the balance again when the panel asks", async () => {
    const { demo, reads } = fakeDemo();
    const call = createCallHandler(demo, () => {});
    await call(TOOL.state, { refreshBalance: true });
    await call(TOOL.demo, {});
    expect(reads).toEqual([{ refreshBalance: true }, {}]);
  });

  it("answers a failure as a tool error with its message and the state", async () => {
    const { demo } = fakeDemo({
      launch: async () => {
        throw new Error("Policy refuses the offer: rate 2000 exceeds maxRate 1000");
      },
    });
    const result = await createCallHandler(demo, () => {})(TOOL.launch, {});
    expect(result.isError).toBe(true);
    expect(text(result)).toBe("Policy refuses the offer: rate 2000 exceeds maxRate 1000");
    expect(result.structuredContent).toEqual(STATE);
  });

  it("logs one line per call, but none for a state read that succeeds: the panel reads the state every 2 s", async () => {
    const lines: string[] = [];
    const { demo } = fakeDemo({
      launch: async () => {
        throw new Error("Policy refuses the offer");
      },
      state: async (options) => {
        if (options?.refreshBalance) throw new Error("rpc down");
        return STATE;
      },
    });
    const call = createCallHandler(demo, (line) => lines.push(line));
    await call(TOOL.launch, {});
    await call(TOOL.state, {});
    await call(TOOL.state, { refreshBalance: true });
    await call(TOOL.demo, {});
    expect(lines.map((line) => line.replace(/\d+ ms$/, "N ms"))).toEqual([
      "stint_demo_launch error in N ms",
      "stint_demo_state error in N ms",
      "stint_demo ok in N ms",
    ]);
  });

  it("answers an unknown tool as an error", async () => {
    const result = await createCallHandler(fakeDemo().demo, () => {})("stint_other", {});
    expect(result.isError).toBe(true);
    expect(text(result)).toBe("Unknown tool stint_other");
  });
});
```

Create `examples/claude-demo/test/server.test.ts`:

```ts
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";
import type { CallHandler } from "../src/owner.js";
import { createDemoServer } from "../src/server.js";
import { PANEL_URI, TOOL } from "../src/state.js";

const HTML = "<!doctype html><title>panel</title>";

describe("the demo's MCP server", () => {
  let client: Client | undefined;
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const call: CallHandler = async (name, args) => {
    calls.push({ name, args });
    return { content: [{ type: "text", text: name }], structuredContent: { name } };
  };
  afterEach(async () => {
    await client?.close();
    client = undefined;
    calls.length = 0;
  });

  async function connect(): Promise<Client> {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await createDemoServer({ html: HTML, call }).connect(serverTransport);
    client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(clientTransport);
    return client;
  }

  it("declares the MCP Apps extension, and tells the model how the panel and the tools share one session", async () => {
    const c = await connect();
    expect(c.getServerCapabilities()?.extensions).toEqual({ "io.modelcontextprotocol/ui": {} });
    expect(c.getInstructions()).toMatch(/stint_demo shows the panel/);
    expect(c.getInstructions()).toMatch(/stint_demo_launch, stint_demo_top_up and stint_demo_close/);
    expect(c.getInstructions()).toMatch(/do not poll for it/);
  });

  it("lists the five tools, each with who may call it, and the panel the first one shows", async () => {
    const { tools } = await (await connect()).listTools();
    const meta = Object.fromEntries(tools.map((tool) => [tool.name, tool._meta]));
    expect(Object.keys(meta).sort()).toEqual(Object.values(TOOL).sort());
    expect(meta[TOOL.demo]).toMatchObject({ ui: { resourceUri: PANEL_URI }, "ui/resourceUri": PANEL_URI });
    expect(meta[TOOL.state]).toEqual({ ui: { visibility: ["app"] } });
    for (const name of [TOOL.launch, TOOL.topUp, TOOL.close]) expect(meta[name]).toEqual({ ui: { visibility: ["model", "app"] } });
  });

  it("serves the panel as an MCP App resource", async () => {
    const c = await connect();
    const { resources } = await c.listResources();
    expect(resources.map((resource) => resource.uri)).toContain(PANEL_URI);
    const { contents } = await c.readResource({ uri: PANEL_URI });
    expect(contents).toHaveLength(1);
    expect(contents[0]).toMatchObject({ uri: PANEL_URI, mimeType: "text/html;profile=mcp-app", text: HTML });
  });

  it("hands every call to the handler, with its arguments", async () => {
    const c = await connect();
    const result = await c.callTool({ name: TOOL.state, arguments: { refreshBalance: true } });
    await c.callTool({ name: TOOL.launch, arguments: {} });
    await c.callTool({ name: TOOL.demo, arguments: {} });
    expect(result.structuredContent).toEqual({ name: TOOL.state });
    expect(calls).toEqual([
      { name: TOOL.state, args: { refreshBalance: true } },
      { name: TOOL.launch, args: {} },
      { name: TOOL.demo, args: {} },
    ]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @lxfoundry/stint-claude-demo test tools.test.ts server.test.ts`
Expected: FAIL: `Failed to load url ../src/tools.js` and `../src/server.js`.

- [ ] **Step 3: Write the tools**

Create `examples/claude-demo/src/tools.ts`:

```ts
import type { CallToolResult } from "@modelcontextprotocol/server";
import type { Demo } from "./demo.js";
import type { CallHandler } from "./owner.js";
import { LAUNCH_SECONDS, TOOL, TOP_UP_SECONDS, type DemoState, type ToolName } from "./state.js";

export const TOOL_DESCRIPTIONS: Readonly<Record<ToolName, string>> = {
  [TOOL.demo]:
    "Shows the Stint demo panel and returns the demo's state. Call it when the person asks to start, open or see the Stint demo.",
  [TOOL.state]:
    "The demo's state, for the panel: the agent's wallet, the session, the x402 exchange. Set refreshBalance to read the wallet's USDC again.",
  [TOOL.launch]: `Opens a ${LAUNCH_SECONDS} s Stint session at the demo's gate: pays 0.100 devnet USDC over x402 into the session's escrow, then watches the agent's own USDC account on the stream. The panel shows it.`,
  [TOOL.topUp]: `Buys ${TOP_UP_SECONDS} s more on the running session, before its paid time runs out. What is not used is still refunded at the close.`,
  [TOOL.close]: "Closes the running session now: the seller is paid for the time used, and the rest of the deposit is refunded.",
};

/** What the model is told about the server (MCP `instructions`). */
export const INSTRUCTIONS = [
  "This server shows a Stint session in a panel: an agent rents time on a live Solana account stream, pays in devnet USDC over x402, and gets back what it does not use.",
  `${TOOL.demo} shows the panel: call it when the person asks to start or see the Stint demo.`,
  `The panel's buttons and the tools ${TOOL.launch}, ${TOOL.topUp} and ${TOOL.close} act on the same session, so a result saying that a session is already running, is closed or has ended may mean that the person used the panel: say what the result says.`,
  "The panel shows the time left as it runs: do not poll for it.",
].join(" ");

export function stateResult(state: DemoState): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(state) }], structuredContent: state as unknown as Record<string, unknown> };
}

export function errorResult(message: string, state: DemoState): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }], structuredContent: state as unknown as Record<string, unknown> };
}

/**
 * The owner's handler for every tool: the result carries the state whatever happened, so the panel can draw it, and a
 * failure is a tool error with its message, so a policy refusal is readable. One line per call goes to `log`, but for a
 * state read that succeeds: the panel makes one every 2 s.
 */
export function createCallHandler(demo: Demo, log: (line: string) => void): CallHandler {
  async function answer(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    switch (name) {
      case TOOL.demo:
        return stateResult(await demo.state());
      case TOOL.state:
        return stateResult(await demo.state({ refreshBalance: args.refreshBalance === true }));
      case TOOL.launch:
        return stateResult(await demo.launch());
      case TOOL.topUp:
        return stateResult(await demo.topUp());
      case TOOL.close:
        return stateResult(await demo.close());
      default:
        return errorResult(`Unknown tool ${name}`, await demo.state());
    }
  }
  return async (name, args) => {
    const started = Date.now();
    let result: CallToolResult;
    try {
      result = await answer(name, args);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // The state is read again for the panel; if that fails too, the error goes alone.
      const state = await demo.state().catch(() => undefined);
      result = state ? errorResult(message, state) : { isError: true, content: [{ type: "text", text: message }] };
    }
    if (result.isError || name !== TOOL.state) log(`${name} ${result.isError ? "error" : "ok"} in ${Date.now() - started} ms`);
    return result;
  };
}
```

- [ ] **Step 4: Write the server**

Create `examples/claude-demo/src/server.ts`:

```ts
import { McpServer } from "@modelcontextprotocol/server";
import { EXTENSION_ID, RESOURCE_MIME_TYPE, registerAppResource, registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import * as z from "zod";
import type { CallHandler } from "./owner.js";
import { PANEL_URI, TOOL } from "./state.js";
import { INSTRUCTIONS, TOOL_DESCRIPTIONS } from "./tools.js";

export const SERVER_INFO = { name: "stint-claude-demo", version: "0.1.0" } as const;

/**
 * The MCP server. `serveStdio` may call its factory more than once (a protocol probe), so this holds no state: every
 * call goes to `call`. `stint_demo` shows the panel; `stint_demo_state` is for the panel only; the three actions are
 * for the model and the panel alike.
 */
export function createDemoServer(options: { readonly html: string; readonly call: CallHandler }): McpServer {
  const server = new McpServer(SERVER_INFO, { capabilities: { extensions: { [EXTENSION_ID]: {} } }, instructions: INSTRUCTIONS });
  registerAppTool(server, TOOL.demo, { description: TOOL_DESCRIPTIONS[TOOL.demo], _meta: { ui: { resourceUri: PANEL_URI } } }, async () =>
    options.call(TOOL.demo, {}),
  );
  registerAppResource(server, "Stint demo panel", PANEL_URI, { description: "The Stint demo's panel: the wallet, the session, the x402 exchange" }, async () => ({
    contents: [{ uri: PANEL_URI, mimeType: RESOURCE_MIME_TYPE, text: options.html }],
  }));
  server.registerTool(
    TOOL.state,
    {
      description: TOOL_DESCRIPTIONS[TOOL.state],
      inputSchema: z.object({ refreshBalance: z.boolean().optional() }),
      _meta: { ui: { visibility: ["app"] } },
    },
    async (args) => options.call(TOOL.state, args),
  );
  for (const name of [TOOL.launch, TOOL.topUp, TOOL.close]) {
    server.registerTool(
      name,
      { description: TOOL_DESCRIPTIONS[name], inputSchema: z.object({}), _meta: { ui: { visibility: ["model", "app"] } } },
      async () => options.call(name, {}),
    );
  }
  return server;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @lxfoundry/stint-claude-demo test && pnpm --filter @lxfoundry/stint-claude-demo typecheck`
Expected: PASS, 51 tests; no type error. If `ui/resourceUri` is missing from `stint_demo`'s `_meta`, the installed
`registerAppTool` no longer writes the legacy key: drop that key from the assertion, and say so in the pull request.

- [ ] **Step 6: Commit**

```bash
git add examples/claude-demo/src/tools.ts examples/claude-demo/src/server.ts examples/claude-demo/test/tools.test.ts examples/claude-demo/test/server.test.ts
git commit -m "Serve the Claude Desktop example's tools and panel resource over MCP" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: The panel

One HTML file, its script inlined: the host loads it as the `ui://stint-demo/panel.html` resource, in a sandboxed
frame, and talks to it through `App` from `@modelcontextprotocol/ext-apps`. The colours are the brand's
(`brand/README.md`: Ink `#111318`, Paper `#F4F5F2`, Signal `#2ED18B`, Deep `#0B6B45`, Slate `#5E636C`, Mist
`#A9AEB6`), under the host's own CSS variables when it sets them. The capsule: solid is the time used, outline the
time left; a closed session has a Signal outline, with its used part drawn in the text colour; an expired one is fully
solid. Signal is never text on a light background. At most two primary buttons show at a time: Launch with Refresh, or
Top up with Close now.

**Files:**
- Create: `examples/claude-demo/app/panel.html`, `examples/claude-demo/app/panel.ts`, `examples/claude-demo/scripts/panel.ts`
- Test: `examples/claude-demo/test/panel.test.ts`

**Interfaces:**
- Consumes: from `@modelcontextprotocol/ext-apps/app-with-deps` 2.0.4: `new App({ name, version })`; the setters
  `ontoolinput`, `ontoolresult` (`params.structuredContent`), `onhostcontextchanged` (optional), set before `await app.connect()`
  (no transport); `app.callServerTool({ name, arguments })` → `{ structuredContent, isError, content }`;
  `app.openLink({ url })` → `{ isError? }` (the host asks the person to confirm); `app.updateModelContext({ content })`;
  `app.getHostContext()`; `applyDocumentTheme(theme)`, `applyHostStyleVariables(variables)`, `applyHostFonts(css)`.
  Task 6's model and state. esbuild 0.28.2's `build({ write: false })`.
- Produces: `buildPanelHtml(): Promise<string>` from `scripts/panel.ts` (the panel bundled for the browser, IIFE,
  `es2022`, minified, and inlined in place of `<!-- PANEL_SCRIPT -->`, with every `</script` escaped).

- [ ] **Step 1: Write the failing test**

Create `examples/claude-demo/test/panel.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PLACEHOLDER, buildPanelHtml } from "../scripts/panel.js";

describe("the panel's HTML", () => {
  it("writes data as text only", () => {
    const source = readFileSync(fileURLToPath(new URL("../app/panel.ts", import.meta.url)), "utf8");
    expect(source).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  });

  it("is one file, its script inlined where the placeholder was, with no early end of the script", async () => {
    const html = await buildPanelHtml();
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).not.toContain(PLACEHOLDER);
    const start = html.indexOf("<script>");
    const end = html.lastIndexOf("</script>");
    expect(start).toBeGreaterThan(html.indexOf('id="links"'));
    expect(html.slice(start + "<script>".length, end)).not.toMatch(/<\/script/i);
    for (const id of ["address", "balance", "launch", "refresh", "top-up", "close", "rows", "links", "error"]) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(html.length).toBeLessThan(2_000_000);
  }, 60_000);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @lxfoundry/stint-claude-demo test panel.test.ts`
Expected: FAIL: `Failed to load url ../scripts/panel.js`.

- [ ] **Step 3: Write the page**

Create `examples/claude-demo/app/panel.html`:

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Stint demo</title>
<style>
  :root {
    --ink: #111318; --paper: #f4f5f2; --signal: #2ed18b; --deep: #0b6b45; --slate: #5e636c; --mist: #a9aeb6;
    --bg: var(--color-background-primary, var(--paper));
    --fg: var(--color-text-primary, var(--ink));
    --muted: var(--color-text-secondary, var(--slate));
    --accent-text: var(--deep);
    --used: var(--ink);
    --line: var(--color-border-primary, color-mix(in srgb, var(--mist) 45%, var(--paper)));
    --radius: var(--border-radius-md, 8px);
    --sans: var(--font-sans, system-ui, sans-serif);
    --mono: var(--font-mono, ui-monospace, monospace);
    color-scheme: light dark;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --bg: var(--color-background-primary, var(--ink)); --fg: var(--color-text-primary, var(--paper));
      --muted: var(--color-text-secondary, var(--mist)); --accent-text: var(--signal); --used: var(--signal);
      --line: var(--color-border-primary, color-mix(in srgb, var(--slate) 45%, var(--ink)));
    }
  }
  :root[data-theme="dark"] {
    --bg: var(--color-background-primary, var(--ink)); --fg: var(--color-text-primary, var(--paper));
    --muted: var(--color-text-secondary, var(--mist)); --accent-text: var(--signal); --used: var(--signal);
    --line: var(--color-border-primary, color-mix(in srgb, var(--slate) 45%, var(--ink)));
  }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 16px; background: var(--bg); color: var(--fg); font: 14px/1.45 var(--sans); }
  section { padding: 12px 0; border-top: 1px solid var(--line); }
  section:first-of-type { border-top: 0; padding-top: 0; }
  h1 { font-size: 14px; font-weight: 600; margin: 0 0 8px; }
  .label, .reason, #notice { color: var(--muted); font-size: 12px; }
  code, .mono { font-family: var(--mono); font-size: 12px; overflow-wrap: anywhere; }
  .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin: 4px 0; }
  button { font: inherit; border-radius: var(--radius); padding: 6px 12px; cursor: pointer; border: 1px solid var(--line); background: transparent; color: var(--fg); }
  button.primary { background: var(--fg); color: var(--bg); border-color: var(--fg); }
  button.link { border: 0; padding: 0; background: none; color: var(--accent-text); text-decoration: underline; }
  button:disabled { opacity: 0.45; cursor: default; }
  #headline { font-size: 16px; font-weight: 600; margin: 0 0 8px; }
  #track { height: 16px; margin: 8px 0; }
  #paid { height: 16px; width: 0; border: 2px solid var(--used); border-radius: 999px; overflow: hidden; transition: width 0.3s; }
  #used { height: 100%; width: 0; background: var(--used); }
  #track[data-state="closed"] #paid { border-color: var(--signal); background: color-mix(in srgb, var(--signal) 30%, transparent); }
  ol, ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
  #rows li { display: grid; gap: 2px; padding: 6px 8px; border: 1px solid var(--line); border-radius: var(--radius); }
  #rows li[data-kind="error"] { border-style: dashed; }
  #rows li[data-kind="settled"] strong { color: var(--accent-text); }
  #error { font-weight: 600; margin: 4px 0; }
  p { margin: 4px 0; }
</style>
</head>
<body>
<section>
  <h1>Agent wallet <span class="label">on Solana devnet</span></h1>
  <div class="row"><code id="address"></code><button id="copy" type="button">Copy</button></div>
  <div class="row"><span class="label">USDC</span><strong id="balance" class="mono"></strong><span id="needs" class="reason" hidden></span></div>
  <div class="row" id="fund" hidden>
    <button id="faucet" class="link" type="button">Get devnet USDC at Circle's faucet</button>
    <span class="reason">choose Solana Devnet and paste the address, then Refresh</span>
  </div>
</section>
<section>
  <div id="headline"></div>
  <div id="track"><div id="paid"><div id="used"></div></div></div>
  <div class="row"><span id="time-left" class="mono"></span><span id="frames" class="label"></span></div>
  <div class="row">
    <button id="launch" class="primary" type="button">Launch</button>
    <button id="refresh" type="button">Refresh</button>
    <button id="top-up" class="primary" type="button">Top up +100 s</button>
    <button id="close" class="primary" type="button">Close now</button>
  </div>
  <p id="top-up-reason" class="reason"></p>
  <p id="error" role="alert"></p>
  <p id="notice"></p>
</section>
<section>
  <h1>x402 exchange</h1>
  <ol id="rows"></ol>
</section>
<section>
  <h1>On Solana Explorer</h1>
  <ul id="links"></ul>
</section>
<!-- PANEL_SCRIPT -->
</body>
</html>
```

- [ ] **Step 4: Write the panel's script**

Create `examples/claude-demo/app/panel.ts`:

```ts
import { App, applyDocumentTheme, applyHostFonts, applyHostStyleVariables } from "@modelcontextprotocol/ext-apps/app-with-deps";
import { FAUCET_URL, LAUNCH_AMOUNT, TOOL, type DemoAction, type DemoState, type ExchangeRow, type ToolName } from "../src/state.js";
import { canLaunch, capsule, closeRefusal, formatUsdc, headline, secondsLeft, skewOf, topUpRefusal } from "./model.js";

/** The parts of the host's context the panel uses (optional: the host's theme). */
interface HostLook {
  readonly theme?: Parameters<typeof applyDocumentTheme>[0];
  readonly styles?: { readonly variables?: Parameters<typeof applyHostStyleVariables>[0]; readonly css?: { readonly fonts?: string } };
}
type ToolAnswer = Awaited<ReturnType<App["callServerTool"]>>;

const POLL_MS = 2_000;
const BUSY_POLL_MS = 500;
const REDRAW_MS = 250;

const app = new App({ name: "Stint demo", version: "0.1.0" });
let state: DemoState | undefined;
let skew = 0;
let acting: DemoAction | undefined;
let actionError: string | undefined;
let pollTimer: ReturnType<typeof setTimeout> | undefined;
let rowsKey = "";
let linksKey = "";

function element<T extends HTMLElement = HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`The panel has no #${id}`);
  return found as T;
}

function isDemoState(value: unknown): value is DemoState {
  return typeof value === "object" && value !== null && "wallet" in value && "session" in value && typeof (value as { now?: unknown }).now === "number";
}

/** Takes a state the server sent, and corrects the panel's clock by the server's. */
function accept(value: unknown): void {
  if (!isDemoState(value)) return;
  state = value;
  skew = skewOf(value.now, Date.now());
  render();
}

/** The host's theme, colours and fonts (optional). */
function applyHost(look: HostLook): void {
  if (look.theme) applyDocumentTheme(look.theme);
  if (look.styles?.variables) applyHostStyleVariables(look.styles.variables);
  if (look.styles?.css?.fonts) applyHostFonts(look.styles.css.fonts);
}

// Set before `connect`: the host may send the tool's input and result as soon as the panel is connected.
app.ontoolinput = () => {};
app.ontoolresult = (params) => accept(params.structuredContent);
// The host's theme (optional).
app.onhostcontextchanged = (context) => applyHost(context as HostLook);

function textOf(answer: ToolAnswer): string {
  for (const block of answer.content ?? []) if (block.type === "text") return block.text;
  return "The tool failed";
}

async function callTool(name: ToolName, args: Record<string, unknown> = {}): Promise<ToolAnswer> {
  const answer = await app.callServerTool({ name, arguments: args });
  accept(answer.structuredContent);
  return answer;
}

function schedulePoll(delayMs: number): void {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(() => void poll(), delayMs);
}

/** Reads the state every 2 s, and every 0.5 s while an action runs (optional: rows fill in as the exchange goes). */
async function poll(): Promise<void> {
  try {
    await callTool(TOOL.state);
  } catch {
    // The next read tries again.
  }
  schedulePoll(acting || state?.busy ? BUSY_POLL_MS : POLL_MS);
}

/** Tells the model what the panel did (optional), so that the chat knows the session's state. */
async function tellModel(): Promise<void> {
  if (!state) return;
  const id = state.session.sessionId;
  const text = `Stint demo panel: ${headline(state, Date.now() + skew)}${id ? ` (session ${id})` : ""}.`;
  try {
    await app.updateModelContext({ content: [{ type: "text", text }] });
  } catch {
    // A host that does not take model context still shows the panel.
  }
}

async function act(action: DemoAction, name: ToolName): Promise<void> {
  if (acting) return;
  acting = action;
  actionError = undefined;
  render();
  schedulePoll(BUSY_POLL_MS);
  try {
    const answer = await callTool(name);
    if (answer.isError) actionError = textOf(answer);
    else void tellModel();
  } catch (error) {
    actionError = error instanceof Error ? error.message : String(error);
  } finally {
    acting = undefined;
    render();
  }
}

async function refresh(): Promise<void> {
  try {
    await callTool(TOOL.state, { refreshBalance: true });
  } catch (error) {
    actionError = error instanceof Error ? error.message : String(error);
    render();
  }
}

/** Opens a link through the host, which asks the person first; if it will not, the address is shown to copy. */
async function openLink(url: string): Promise<void> {
  const notice = element("notice");
  notice.textContent = "";
  try {
    const answer = await app.openLink({ url });
    if (answer.isError) notice.textContent = `Open this address yourself: ${url}`;
  } catch {
    notice.textContent = `Open this address yourself: ${url}`;
  }
}

/** Copies the wallet's address (optional); a frame that may not write the clipboard selects it instead. */
async function copyAddress(): Promise<void> {
  if (!state) return;
  const notice = element("notice");
  try {
    await navigator.clipboard.writeText(state.wallet.address);
    notice.textContent = "Address copied";
  } catch {
    getSelection()?.selectAllChildren(element("address"));
    notice.textContent = "The address is selected: copy it with Ctrl+C or Cmd+C";
  }
}

function show(id: string, visible: boolean, enabled: boolean): void {
  const button = element<HTMLButtonElement>(id);
  button.hidden = !visible;
  button.disabled = !enabled;
}

function linkButton(label: string, url: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "link";
  button.textContent = label;
  button.addEventListener("click", () => void openLink(url));
  return button;
}

/** Rebuilt only when they change, so that a redraw every 250 ms leaves the buttons alone. */
function renderRows(rows: readonly ExchangeRow[]): void {
  const key = JSON.stringify(rows);
  if (key === rowsKey) return;
  rowsKey = key;
  element("rows").replaceChildren(
    ...rows.map((row) => {
      const item = document.createElement("li");
      item.dataset.kind = row.kind;
      const label = document.createElement("strong");
      label.textContent = row.label;
      item.append(label);
      if (row.detail) {
        const detail = document.createElement("span");
        detail.className = "mono";
        detail.textContent = row.detail;
        item.append(detail);
      }
      if (row.link) item.append(linkButton("View on Explorer", row.link));
      return item;
    }),
  );
}

function renderLinks(session: DemoState["session"]): void {
  const { links } = session;
  const entries: [string, string | undefined][] = [
    ["Session account", links.session],
    ["Open transaction", links.open],
    ...links.topUps.map((link, index): [string, string] => [`Top-up ${index + 1}`, link]),
    ["Close transaction", links.close],
    ["Seller", links.seller],
  ];
  const present = entries.filter((entry): entry is [string, string] => entry[1] !== undefined);
  const key = JSON.stringify(present);
  if (key === linksKey) return;
  linksKey = key;
  element("links").replaceChildren(
    ...present.map(([label, url]) => {
      const item = document.createElement("li");
      item.append(linkButton(label, url));
      return item;
    }),
  );
}

/** Draws the state at the server's time: text through `textContent`, sizes through the CSSOM, nothing else. */
function render(): void {
  if (!state) return;
  const nowMs = Date.now() + skew;
  const session = state.session;
  const usdc = state.wallet.usdc;
  element("address").textContent = state.wallet.address;
  element("balance").textContent = usdc === undefined ? "checking…" : formatUsdc(usdc);
  const short = usdc !== undefined && BigInt(usdc) < BigInt(LAUNCH_AMOUNT);
  element("needs").hidden = !short;
  element("fund").hidden = !short;
  element("headline").textContent = headline(state, nowMs);
  const { used, paid } = capsule(session, nowMs);
  element("track").dataset.state = session.state;
  element("paid").style.width = `${paid * 100}%`;
  element("used").style.width = paid > 0 ? `${(used / paid) * 100}%` : "0";
  element("time-left").textContent = session.state === "open" ? `${secondsLeft(session, nowMs)} s of paid time left` : "";
  // The stream's message count (optional).
  element("frames").textContent = session.sessionId ? `${session.frames} stream ${session.frames === 1 ? "message" : "messages"}` : "";
  const busy = acting ?? state.busy;
  const running = session.state === "opening" || session.state === "open" || session.state === "closing";
  const topUpReason = topUpRefusal(session, nowMs);
  show("launch", !running, canLaunch(state) && !busy);
  show("refresh", !running, !busy);
  show("top-up", session.state === "open", !busy && !topUpReason);
  show("close", session.state === "open", !busy && !closeRefusal(session, nowMs));
  element("top-up-reason").textContent = session.state === "open" ? (topUpReason ?? "") : "";
  renderRows(busy ? state.exchange.current : (state.exchange.last?.rows ?? []));
  renderLinks(session);
  element("error").textContent = actionError ?? state.error?.message ?? "";
}

async function main(): Promise<void> {
  element("needs").textContent = `needs ${formatUsdc(LAUNCH_AMOUNT)}`;
  element("launch").addEventListener("click", () => void act("launch", TOOL.launch));
  element("top-up").addEventListener("click", () => void act("top-up", TOOL.topUp));
  element("close").addEventListener("click", () => void act("close", TOOL.close));
  element("refresh").addEventListener("click", () => void refresh());
  element("faucet").addEventListener("click", () => void openLink(FAUCET_URL));
  element("copy").addEventListener("click", () => void copyAddress());
  await app.connect();
  const context = app.getHostContext();
  if (context) applyHost(context as HostLook);
  schedulePoll(0);
  setInterval(render, REDRAW_MS);
}

main().catch((error: unknown) => {
  element("error").textContent = error instanceof Error ? error.message : String(error);
});
```

- [ ] **Step 5: Write the inliner**

Create `examples/claude-demo/scripts/panel.ts`:

```ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const at = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/** Where `app/panel.html` takes the panel's script. */
export const PLACEHOLDER = "<!-- PANEL_SCRIPT -->";

/** The panel as one HTML file: `app/panel.ts` bundled for the browser and inlined, so that the host makes no other request. */
export async function buildPanelHtml(): Promise<string> {
  const result = await build({
    entryPoints: [at("../app/panel.ts")],
    bundle: true,
    platform: "browser",
    format: "iife",
    target: "es2022",
    minify: true,
    write: false,
    logLevel: "warning",
  });
  // `<\/script` is the same text to the script, and does not end the element early.
  const script = result.outputFiles[0]!.text.replace(/<\/script/gi, "<\\/script");
  const template = readFileSync(at("../app/panel.html"), "utf8");
  if (!template.includes(PLACEHOLDER)) throw new Error(`app/panel.html has no ${PLACEHOLDER}`);
  // A function as the replacement, so that `$&` or `$1` in the bundle is not expanded.
  return template.replace(PLACEHOLDER, () => `<script>${script}</script>`);
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm --filter @lxfoundry/stint-claude-demo test && pnpm --filter @lxfoundry/stint-claude-demo typecheck`
Expected: PASS, 53 tests (the panel's build takes a few seconds); no type error in either type check. esbuild prints
no warning.

- [ ] **Step 7: Commit**

```bash
git add examples/claude-demo/app/panel.html examples/claude-demo/app/panel.ts examples/claude-demo/scripts/panel.ts examples/claude-demo/test/panel.test.ts
git commit -m "Add the Claude Desktop example's panel" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: The entry points, the single-file bundle and the `.mcpb`

**Files:**
- Create: `examples/claude-demo/src/main.ts`, `examples/claude-demo/src/cli.ts`, `examples/claude-demo/src/dev.ts`
- Create: `examples/claude-demo/scripts/build.ts`, `examples/claude-demo/scripts/pack.ts`, `examples/claude-demo/mcpb/manifest.json`
- Test: `examples/claude-demo/test/stdio.test.ts`, `examples/claude-demo/test/manifest.test.ts`

**Interfaces:**
- Consumes: Tasks 6 to 12; `createStintClient`, `createSessionTools` (`@lxfoundry/stint-client`); `serveStdio(factory)`
  from `@modelcontextprotocol/server/stdio` (the factory may be called more than once); the shutdown pattern of
  `packages/mcp/src/cli.ts:10-45` (stdin `end` and `close`, SIGINT and SIGTERM, a 90 s limit, `process.exit`); the
  stdio test pattern of `packages/mcp/test/stdio.test.ts` (`StdioClientTransport`, `.cache/` scratch, waiting for the
  pid to go). `mcpb` 2.1.2: `mcpb validate <manifest>`, `mcpb pack <dir> <output>`.
- Produces: `run(panelHtml: () => Promise<string>): void` from `src/main.ts`; `dist/claude-demo.cjs` (`pnpm run build`);
  `dist/stint-claude-demo.mcpb` (`pnpm run mcpb`). stderr lines start with `stint-claude-demo: `.

- [ ] **Step 1: Write the failing tests**

Create `examples/claude-demo/test/manifest.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_GATE_URL } from "../src/config.js";
import { TOOL } from "../src/state.js";

const raw = readFileSync(fileURLToPath(new URL("../mcpb/manifest.json", import.meta.url)));
const pkg = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")) as { version: string };

describe("the extension's manifest", () => {
  it("is UTF-8 without a byte-order mark, which mcpb refuses", () => {
    expect(raw[0]).toBe(0x7b);
  });

  it("runs the bundled server with Claude Desktop's Node.js, given the wallet folder and the gate", () => {
    const manifest = JSON.parse(raw.toString("utf8"));
    expect(manifest).toMatchObject({ manifest_version: "0.3", name: "stint-claude-demo", version: pkg.version });
    expect(manifest.server).toEqual({
      type: "node",
      entry_point: "server/claude-demo.cjs",
      mcp_config: {
        command: "node",
        args: ["${__dirname}/server/claude-demo.cjs"],
        env: { STINT_DEMO_HOME: "${user_config.wallet_dir}", STINT_DEMO_GATE_URL: "${user_config.gate_url}" },
      },
    });
    expect(manifest.user_config.wallet_dir).toMatchObject({ type: "directory", required: true, default: "${HOME}" });
    expect(manifest.user_config.gate_url).toMatchObject({ type: "string", default: DEFAULT_GATE_URL });
    expect(manifest.tools.map((tool: { name: string }) => tool.name).sort()).toEqual(Object.values(TOOL).sort());
    expect(manifest.compatibility).toEqual({ platforms: ["win32", "darwin", "linux"], runtimes: { node: ">=22" } });
  });
});
```

Create `examples/claude-demo/test/stdio.test.ts`:

```ts
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { PANEL_URI, TOOL } from "../src/state.js";

const cwd = fileURLToPath(new URL("..", import.meta.url));
const tsx = fileURLToPath(new URL("../../../node_modules/.bin/tsx", import.meta.url));
const bundle = fileURLToPath(new URL("../dist/claude-demo.cjs", import.meta.url));
// Under the package, in a git-ignored directory: `/tmp` can be emptied at any time.
const scratch = fileURLToPath(new URL("../.cache/", import.meta.url));

/** Nothing listens on port 9: the server reads no balance and opens no session, and nothing leaves the machine. */
const environment = (home: string): Record<string, string> => ({
  PATH: process.env.PATH ?? "",
  HOME: process.env.HOME ?? home,
  STINT_DEMO_HOME: home,
  STINT_DEMO_GATE_URL: "http://127.0.0.1:9",
  STINT_DEMO_RPC_URL: "http://127.0.0.1:9",
});

async function start(home: string) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [bundle], cwd, env: environment(home), stderr: "pipe" });
  const client = new Client({ name: "test", version: "1.0.0" });
  let stderr = "";
  await client.connect(transport);
  transport.stderr?.on("data", (chunk) => (stderr += chunk));
  return { client, pid: transport.pid!, stderr: () => stderr };
}

/** What `read()` holds once it matches `pattern`: a pipe delivers a process's stderr when it can, not when it is written. */
async function eventually(read: () => string, pattern: RegExp, timeoutMs = 10_000): Promise<RegExpExecArray> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = pattern.exec(read());
    if (found) return found;
    if (Date.now() >= deadline) throw new Error(`stderr never showed ${pattern}:\n${read()}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function exited(pid: number): Promise<boolean> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
  }
  return false;
}

describe("the bundled server on stdio", () => {
  let home: string | undefined;
  beforeAll(() => {
    execFileSync(tsx, ["scripts/build.ts"], { cwd, stdio: "pipe" });
  }, 120_000);
  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true });
    home = undefined;
  });
  const freshHome = () => {
    mkdirSync(scratch, { recursive: true });
    home = mkdtempSync(join(scratch, "stdio-"));
    return home;
  };

  it("starts on a folder that does not exist yet, serves the five tools and the panel, creates the wallet, and leaves when the client goes away", async () => {
    // STINT_DEMO_HOME itself is missing: the server creates it, and its stint-demo folder.
    const folder = join(freshHome(), "not-yet");
    const files = join(folder, "stint-demo");
    const { client, pid, stderr } = await start(folder);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(Object.values(TOOL).sort());
    const { contents } = await client.readResource({ uri: PANEL_URI });
    expect(contents[0]).toMatchObject({ mimeType: "text/html;profile=mcp-app" });
    expect(String((contents[0] as { text?: unknown }).text)).toContain('id="launch"');
    expect(existsSync(join(files, "agent.json"))).toBe(true);
    expect(existsSync(join(files, "owner.json"))).toBe(true);
    await eventually(stderr, /stint-claude-demo: created the agent's wallet [1-9A-HJ-NP-Za-km-z]{32,44}/);
    await eventually(stderr, /stint-claude-demo: this copy holds the demo's state/);

    await client.close();
    expect(await exited(pid)).toBe(true);
    expect(existsSync(join(files, "owner.json"))).toBe(false);
  }, 60_000);

  it("makes a second copy on the same folder forward its calls to the first", async () => {
    const folder = freshHome();
    const first = await start(folder);
    const second = await start(folder);
    // `stint_demo` is logged in each copy that handles it (a state read that succeeds is not).
    const result = await second.client.callTool({ name: TOOL.demo, arguments: {} });
    const address = (await eventually(first.stderr, /created the agent's wallet ([1-9A-HJ-NP-Za-km-z]{32,44})/))[1];
    expect(result.structuredContent).toMatchObject({ wallet: { address }, session: { state: "none" } });
    await eventually(second.stderr, /forwarding to the copy that holds the demo's state/);
    await eventually(second.stderr, /stint_demo forwarded/);
    await eventually(first.stderr, /stint_demo ok in \d+ ms/);

    await second.client.close();
    await first.client.close();
    expect(await exited(second.pid)).toBe(true);
    expect(await exited(first.pid)).toBe(true);
    expect(existsSync(join(folder, "stint-demo", "owner.json"))).toBe(false);
  }, 60_000);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @lxfoundry/stint-claude-demo test manifest.test.ts stdio.test.ts`
Expected: FAIL: `ENOENT … mcpb/manifest.json`, and the stdio tests' `beforeAll` fails: `Cannot find module …/scripts/build.ts`.

- [ ] **Step 3: Write the wiring and the entry points**

Create `examples/claude-demo/src/main.ts`:

```ts
import { mkdirSync } from "node:fs";
import { createSessionTools, createStintClient } from "@lxfoundry/stint-client";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createRpcDemoChain } from "./chain.js";
import { ConfigError, loadConfig } from "./config.js";
import { createDemo, type Demo } from "./demo.js";
import { recordExchanges } from "./exchange.js";
import { createRouter, type CallHandler } from "./owner.js";
import { createDemoServer } from "./server.js";
import { FAUCET_URL, TOOL } from "./state.js";
import { createCallHandler } from "./tools.js";
import { loadOrCreateWallet } from "./wallet.js";

/** The tools that only read: a forwarder may ask again for one whose owner went away during it (deviation 16). */
const READ_ONLY: ReadonlySet<string> = new Set([TOOL.demo, TOOL.state]);

/**
 * The longest the server waits to close the session on its way out. An open still in flight must finish before its
 * session can be closed, and on a slow network that takes longer than a close does.
 */
const CLOSE_LIMIT_MS = 90_000;

/** stdout carries the protocol: everything for a person goes to stderr. */
const log = (line: string) => console.error(`stint-claude-demo: ${line}`);

async function main(panelHtml: () => Promise<string>): Promise<void> {
  const config = loadConfig(process.env);
  // `STINT_DEMO_HOME/stint-demo`, and `STINT_DEMO_HOME` with it, before the election creates `owner.json` there.
  mkdirSync(config.dir, { recursive: true });
  let demo: Demo | undefined;
  const router = await createRouter({
    dir: config.dir,
    readOnly: READ_ONLY,
    log,
    // Only the copy that holds the state has a key, a client and a session; a forwarder that takes over builds its own.
    becomeOwner: async () => {
      const wallet = await loadOrCreateWallet(config.dir, config.policy);
      log(`${wallet.created ? "created the agent's wallet" : "using the agent's wallet"} ${wallet.signer.address} (${wallet.path}); devnet USDC: ${FAUCET_URL}`);
      const chain = await createRpcDemoChain(config.rpcUrl, wallet.signer.address);
      const tools = createSessionTools(createStintClient({ signer: wallet.signer, policy: config.policy }));
      const created = createDemo({ address: wallet.signer.address, gateUrl: config.gateUrl, tools, chain, log });
      // Before the client sends anything: it calls the global `fetch` at each request.
      globalThis.fetch = recordExchanges(config.gateUrl, created.sink, globalThis.fetch);
      demo = created;
      return createCallHandler(created, log);
    },
  });
  log(router.role() === "owner" ? "this copy holds the demo's state" : "forwarding to the copy that holds the demo's state");
  // One line per call in the copy that forwards it too, but for the panel's state reads (deviation 20).
  const call: CallHandler = async (name, args) => {
    if (router.role() === "forwarder" && name !== TOOL.state) log(`${name} forwarded`);
    return router.call(name, args);
  };
  const html = await panelHtml();
  serveStdio(() => createDemoServer({ html, call }));

  let leaving: Promise<void> | undefined;
  const leave = (): Promise<void> => {
    leaving ??= (async () => {
      const limit = setTimeout(() => {
        log("giving up on closing the session");
        process.exit(1);
      }, CLOSE_LIMIT_MS);
      limit.unref();
      let failed = 0;
      if (demo) {
        const outcome = await demo.shutdown();
        for (const sessionId of outcome.closed) log(`closed session ${sessionId}`);
        for (const { sessionId, error } of outcome.failed) log(`could not close session ${sessionId}: ${error}`);
        failed = outcome.failed.length;
      }
      await router.close();
      process.exit(failed === 0 ? 0 : 1);
    })();
    return leaving;
  };
  // The host going away is the end of standard input. `serveStdio` also builds and drops a connection of its own
  // while a client probes for the protocol version: that is not the end.
  process.stdin.once("end", () => void leave());
  process.stdin.once("close", () => void leave());
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => void leave());
}

/** Starts the server with the panel's HTML from `panelHtml`; a start that fails says why on stderr and exits 1. */
export function run(panelHtml: () => Promise<string>): void {
  main(panelHtml).catch((error: unknown) => {
    log(error instanceof ConfigError || error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
```

Create `examples/claude-demo/src/cli.ts`:

```ts
import { run } from "./main.js";

/** Set by `scripts/build.ts`: the panel's HTML, its script inlined. */
declare const PANEL_HTML: string;

run(async () => PANEL_HTML);
```

Create `examples/claude-demo/src/dev.ts`:

```ts
import { buildPanelHtml } from "../scripts/panel.js";
import { run } from "./main.js";

/** The server from source (`tsx src/dev.ts`), building the panel in memory at start. */
run(buildPanelHtml);
```

- [ ] **Step 4: Write the bundler, the packer and the manifest**

Create `examples/claude-demo/scripts/build.ts`:

```ts
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { buildPanelHtml } from "./panel.js";

const at = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const outfile = at("../dist/claude-demo.cjs");

/**
 * One file that runs on any Node.js from 22, with no `node_modules` and no repository: the server and every dependency,
 * the panel's HTML defined in. CommonJS, because `ws` is.
 */
await build({
  entryPoints: [at("../src/cli.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  outfile,
  define: { PANEL_HTML: JSON.stringify(await buildPanelHtml()) },
  // `ws` uses these native helpers when they are installed, and works without them.
  external: ["bufferutil", "utf-8-validate"],
  logLevel: "warning",
});
console.error(`built ${outfile}`);
```

Create `examples/claude-demo/scripts/pack.ts`:

```ts
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const at = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const bundle = at("../dist/claude-demo.cjs");
const stage = at("../dist/mcpb/");
const output = at("../dist/stint-claude-demo.mcpb");
const mcpb = at("../node_modules/.bin/mcpb");

if (!existsSync(bundle)) throw new Error(`${bundle} is missing: run the build first`);
rmSync(stage, { recursive: true, force: true });
mkdirSync(at("../dist/mcpb/server/"), { recursive: true });
copyFileSync(at("../mcpb/manifest.json"), at("../dist/mcpb/manifest.json"));
copyFileSync(bundle, at("../dist/mcpb/server/claude-demo.cjs"));
copyFileSync(at("../../../brand/icon-512.png"), at("../dist/mcpb/icon.png"));
execFileSync(mcpb, ["validate", at("../dist/mcpb/manifest.json")], { stdio: "inherit" });
execFileSync(mcpb, ["pack", stage, output], { stdio: "inherit" });
console.error(`packed ${output}`);
```

Create `examples/claude-demo/mcpb/manifest.json` (save it as UTF-8 without a byte-order mark):

```json
{
  "manifest_version": "0.3",
  "name": "stint-claude-demo",
  "display_name": "Stint demo",
  "version": "0.1.0",
  "description": "Shows a Stint session in a panel: rent 100 s of a live Solana account stream over x402 on devnet, top it up, close it early and get the rest back.",
  "author": { "name": "LX Foundry" },
  "license": "MIT",
  "icon": "icon.png",
  "server": {
    "type": "node",
    "entry_point": "server/claude-demo.cjs",
    "mcp_config": {
      "command": "node",
      "args": ["${__dirname}/server/claude-demo.cjs"],
      "env": {
        "STINT_DEMO_HOME": "${user_config.wallet_dir}",
        "STINT_DEMO_GATE_URL": "${user_config.gate_url}"
      }
    }
  },
  "tools": [
    { "name": "stint_demo", "description": "Shows the Stint demo panel" },
    { "name": "stint_demo_state", "description": "The demo's state, for the panel" },
    { "name": "stint_demo_launch", "description": "Opens a 100 s session, paid over x402" },
    { "name": "stint_demo_top_up", "description": "Buys 100 s more on the running session" },
    { "name": "stint_demo_close", "description": "Closes the session now, refunding the rest" }
  ],
  "user_config": {
    "wallet_dir": {
      "type": "directory",
      "title": "Wallet folder",
      "description": "The agent's devnet key (agent.json) is kept in a stint-demo folder inside the one you pick, made if missing.",
      "required": true,
      "default": "${HOME}"
    },
    "gate_url": {
      "type": "string",
      "title": "Gate URL",
      "description": "The seller's gate: the example seller deployment by default.",
      "required": false,
      "default": "https://stint-demo.lxfoundry.ai"
    }
  },
  "compatibility": {
    "platforms": ["win32", "darwin", "linux"],
    "runtimes": { "node": ">=22" }
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @lxfoundry/stint-claude-demo test && pnpm --filter @lxfoundry/stint-claude-demo typecheck`
Expected: PASS, 57 tests; no type error. The build in the stdio tests' `beforeAll` prints no esbuild warning; one about
`import.meta` in a CommonJS bundle means a dependency would read an empty `import.meta.url` at run time: stop and look
at which module it names before going on.

- [ ] **Step 6: Build and pack the extension**

Run: `pnpm --filter @lxfoundry/stint-claude-demo run build && ls -l examples/claude-demo/dist/claude-demo.cjs`
Expected: `built …/dist/claude-demo.cjs`, a file of about 1.5 MB.

Run: `pnpm --filter @lxfoundry/stint-claude-demo run mcpb`
Expected: `mcpb validate` reports the manifest valid, `mcpb pack` lists `manifest.json`, `icon.png` and
`server/claude-demo.cjs`, then `packed …/dist/stint-claude-demo.mcpb`. `dist/` is git-ignored: nothing to commit from
it.

Run: `STINT_DEMO_HOME="$PWD/examples/claude-demo/.cache/try" node examples/claude-demo/dist/claude-demo.cjs < /dev/null; echo "exit $?"; rm -rf examples/claude-demo/.cache/try`
Expected: on stderr, `stint-claude-demo: created the agent's wallet … (…/.cache/try/stint-demo/agent.json)` and
`… this copy holds the demo's state`, then `exit 0`: the folder did not exist and was created, standard input ended at
once, and there was no session to close.

- [ ] **Step 7: Commit**

```bash
git add examples/claude-demo/src/main.ts examples/claude-demo/src/cli.ts examples/claude-demo/src/dev.ts examples/claude-demo/scripts/build.ts examples/claude-demo/scripts/pack.ts examples/claude-demo/mcpb/manifest.json examples/claude-demo/test/manifest.test.ts examples/claude-demo/test/stdio.test.ts
git commit -m "Bundle the Claude Desktop example into one script and an MCP bundle" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: The demo's guide, and the docs that point to the examples

**Files:**
- Create: `examples/claude-demo/README.md`
- Modify: `README.md` (one section, before "Deploying to devnet")
- Modify: `docs/plans/README.md` (one paragraph, after the stage table's closing paragraph)
- Modify: `docs/specs/stint-system.md` (§3.3, two lines)

**Interfaces:**
- Consumes: everything above; nothing new in code.
- Produces: no code.

- [ ] **Step 1: Write the demo's guide**

The guide is `examples/claude-demo/README.md`, and that file is the source of truth for its text: the plan does not copy
it, so that the two cannot differ. It states:

- what the panel shows and the five tools, with their strict input schemas;
- how to build the bundle and the `.mcpb` (under WSL or on Linux), their sizes, and what runs them;
- the two install routes: the `.mcpb` in Claude Desktop, and an entry of `claude_desktop_config.json` that runs the
  bundle with Node.js, with its variables (`STINT_DEMO_HOME`, `STINT_DEMO_GATE_URL`, `STINT_DEMO_RPC_URL`);
- the agent's wallet: the file system its folder needs (hard links), the file modes on Windows and under WSL, the
  `agent.json.*.tmp` file a crash can leave, funding at Circle's faucet, and the client policy's limits;
- how it works: the two copies Claude Desktop starts and the owner's `owner.json`, forwarding and its timeouts, the
  panel's reads, the three ways a session ends, what quitting Claude Desktop does, and where the logs are.

- [ ] **Step 2: Point to the examples from the repository's README**

In `README.md`, insert before the line `## Deploying to devnet`:

```markdown
## Examples: a seller deployment, and a session in Claude Desktop

[`examples/seller`](examples/seller/README.md) runs Kora, the facilitator with its sweeper and the example stream with
its gate in one process, deployable on Fly.io as one always-on machine that sells the stream on devnet.
[`examples/claude-demo`](examples/claude-demo/README.md) is an MCP server whose panel shows a Stint session in Claude
Desktop: the agent's wallet, the x402 exchange, the paid time draining, a top-up, and an early close with its refund.

```

- [ ] **Step 3: Name the plan outside the stage table**

In `docs/plans/README.md`, after the paragraph that begins `Stages 0 to 2 come first, in that order.`, insert:

```markdown

[claude-demo.md](claude-demo.md) is not a stage: it adds an example seller deployment and an example MCP server that
shows a Stint session in Claude Desktop, and changes no component.
```

- [ ] **Step 4: Add the two directories to the layout**

In `docs/specs/stint-system.md`, section 3.3, replace:

```
examples/agent/            example agent
```

with:

```
examples/agent/            example agent
examples/seller/           example seller deployment: Kora, facilitator and stream in one process
examples/claude-demo/      example MCP server that shows a session in Claude Desktop
```

- [ ] **Step 5: Run everything**

Run: `pnpm typecheck && pnpm test`
Expected: PASS in every package, the two new ones included; no type error.

Run: `git diff --stat main -- packages apps programs conformance e2e`
Expected: no output: no component changed.

- [ ] **Step 6: Commit**

```bash
git add examples/claude-demo/README.md README.md docs/plans/README.md docs/specs/stint-system.md
git commit -m "Document the example seller deployment and the Claude Desktop example" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 15: The manual run, on devnet and in Claude Desktop

A person runs this, with a Fly.io account, a DNS zone, devnet SOL and USDC, and Claude Desktop on Windows. Record
each step's outcome (the Explorer links, what the panel showed) in the pull request.

**Files:** none.

**Interfaces:**
- Consumes: Tasks 1 to 14.
- Produces: the record of the run.

- [ ] **Step 1: Deploy the seller**

Follow `examples/seller/README.md`, "Keys" and "Deploying on Fly.io": a seed made for the deployment, the funding key
sent at least 0.5 SOL, the app created, its secrets set, `fly deploy`, the certificate, the `CNAME` with the DNS
provider's proxy off.

Run: `fly logs -a stint-demo`
Expected: `{"event":"start_clean_up","closed":[],"failed":[]}` on a first start, then `{"event":"ready",…}`.

Run: `curl -s https://stint-demo.lxfoundry.ai/health`
Expected: `{"ok":true}`.

Run: `curl -s -X POST 'https://stint-demo.lxfoundry.ai/sessions?seconds=100'`
Expected: one offer with `"amount":"100000"`, `"rate":"1000"`, `"seconds":100`, `"minSeconds":5`, `"maxSeconds":300`,
`"idleCloseSeconds":60`, and `"resource":{"url":"https://stint-demo.lxfoundry.ai/sessions"}`.

- [ ] **Step 2: Install the extension with a fresh wallet**

Build and pack it (Task 13, Step 6), copy `dist/stint-claude-demo.mcpb` to Windows and open it with Claude Desktop.
For a fresh wallet, choose a wallet folder with no `stint-demo` folder in it yet (the default, the home folder, is
fine the first time), and keep the default gate URL. In a new chat, ask: "Start the Stint demo."
Expected: Claude calls `stint_demo` and the panel mounts. It shows the agent's address, `0.000 USDC`,
`needs 0.100 USDC`, the faucet link, Launch (disabled) and Refresh. `agent.json` and `owner.json` are in the wallet
folder's new `stint-demo` folder.
The log files (`%LOCALAPPDATA%\Claude\Logs\mcp-server-*.log`) show the server's start lines: one copy says it holds
the state, the other that it forwards. The extension's copies may share one log file, so both lines can be in the same
one.

- [ ] **Step 3: Fund the wallet**

Click the faucet link (Claude Desktop asks to confirm), choose Solana Devnet, paste the address, request USDC. Back in
the panel, press Refresh.
Expected: the balance shows what the faucet sent; Launch is enabled.

- [ ] **Step 4: Launch, then close early**

Press Launch.
Expected: four rows fill in: `POST /sessions?seconds=100`; `402 Payment Required` with
`elapsed · 0.001 USDC/s · 100 s · min 5 s · max 300 s · seller …`; `PAYMENT-SIGNATURE` with
`one transaction: 0.100 USDC → vault + open`; `201 Created` with the transaction and its Explorer link. The capsule
fills as the time drains, and the time left counts down from about 100 s. On Explorer, the open transaction moves
0.1 USDC from the agent's USDC account into the session's vault, runs the Stint program's `open`, and its fee payer is
Kora's.

After about 30 s, press Close now.
Expected: `Closed: paid 0.0… USDC, refunded 0.0… USDC`, the two adding up to 0.100 USDC; the capsule stops, with
an outline in Signal and its used part in the text colour; the close link on Explorer shows the refund to the agent's
USDC account and the payment to the seller's.

- [ ] **Step 5: Top up, from the panel and from the chat**

Press Launch again. When about 60 s are left, press Top up +100 s.
Expected: four rows: `POST /sessions/<id>/top-up?seconds=100`, `402 Payment Required`, `PAYMENT-SIGNATURE` with
`one transaction: 0.100 USDC → vault + top-up`, `200 OK` with its link; the capsule's end moves out and the time left
grows by 100 s. The stream message count goes up within a few seconds: the top-up moved the agent's USDC, the account
the session watches (optional part).

Type in the chat: "top up".
Expected: Claude calls `stint_demo_top_up`, which acts on the panel's session: within 2 s the panel shows a second
top-up's rows, the session reaches 300 s, and Top up is disabled with `A session runs at most 300 s: …`. The owner's
log shows `stint_demo_top_up ok in … ms`, and, if Claude's call reached the other copy, that copy's log shows
`stint_demo_top_up forwarded`. The model's call and the panel's may reach different copies, or the same one; one state
serves both.
Then type "close it", and check that the panel shows the close.

- [ ] **Step 6: Let a session expire**

Press Launch and leave it.
Expected: at the end of the paid time, `Paid time over: the gate is closing`, then within a few seconds
`Expired: the seller was paid 0.100 USDC`, the capsule fully solid, and the close link; on Explorer, the close pays
0.1 USDC to the seller's USDC account and refunds nothing.

- [ ] **Step 7: Quit Claude Desktop during a session**

Press Launch, then, with more than 70 s left, quit Claude Desktop from its menu (not by closing the window).
Expected, either way a refund of the unused part to the agent's USDC account, on Explorer from the session's address:
- if Claude Desktop let its servers finish: the owner's log ends with `closed session <id>`, the close comes a few
  seconds after the quit, and `owner.json` is gone from the `stint-demo` folder;
- if it ended them at once: the log has no such line, `owner.json` is still there (the next start takes it over), and
  the close comes about 60 s after the quit, the gate's idle close. Record which of the two happened.

If a step fails:

| Symptom | Likely cause | What to do |
|---|---|---|
| Launch: `Expected 402 from …, got 404` or `502` | The gate URL is wrong, or the seller is down | `curl …/health`; `fly logs -a stint-demo` |
| Launch: `Policy refuses the offer: …` | The seller's terms are not the demo's (rate, network, mint, program) | Compare the 402 with the seller's terms above |
| Launch: `Policy refuses the offer: 100000 would exceed the period budget` | The hour's 2.000 USDC has been paid in (refunds do not free it) | Wait: each payment leaves the count an hour after it was made |
| A tool answers `went away during …: it may or may not have happened` | The copy that held the state ended during the action | Look at the panel, which the other copy now serves from a fresh state, and at Explorer, before acting again |
| Close now fails right after a seller deploy or restart | The new machine does not know the session (`404`); its start-up closes it, with the refund | Expected (seller README, "In operation"): each failed close looks the close up on the chain, so once the start-up's close shows, Close now's error is followed by `Ended by the seller before its paid time`; launch again |
| The balance stays `checking…` | The RPC cannot be reached from Windows | The log's `reading the wallet's balance failed: …`; set `STINT_DEMO_RPC_URL` in the plain-node route |
| The chat shows text but no panel | The host did not mount the app: the extension is off, or the result had no `_meta.ui` | The log's `stint_demo ok …` line; re-enable the extension |
| A connect token is refused (`The gate refused the connection (HTTP 401)` in the log) | `PUBLIC_ORIGIN` is not the host name the panel's gate URL names | Set the same origin in `fly.toml` and in the gate URL, and deploy again |

---

## Done when

- `pnpm typecheck` and `pnpm test` pass locally in WSL and in continuous integration, `pnpm e2e:local` still passes,
  and `git diff --stat main -- packages apps programs conformance e2e` is empty.
- The seller runs on Fly.io as one always-on machine: `/health` answers, and `POST /sessions?seconds=100` answers
  `402` with the terms of this plan at the public origin.
- In Claude Desktop on Windows, the `.mcpb` installs, creates a wallet, and Task 15's steps 2 to 7 pass, each with
  its Explorer links recorded in the pull request, together with any deviation from this plan.

## Self-review

**Coverage of the design:**

| Requirement | Task |
|---|---|
| The stream passes a public origin to its gate; tested, with no server left listening by a failing run | 1 |
| Seller: one process with Kora, the facilitator and its sweeper, the stream with its gate on `0.0.0.0:$PORT`; genesis and program checks; keys from a seed at indices 0 to 4; SOL for Kora's fee payer and the rent payer; the seller's USDC account, with the funding key's balance checked whenever it has anything to pay; the start-up clean-up on the chain's clock, creating the receiver's and the refund token accounts first; the sweeper's interval; Kora's config and policy | 2, 3, 4 |
| Kora watched: its exit stops the seller with status 1; its output kept as a 64 KiB tail; its listening address stated as measured (no bind option, API key required) | 3, 4, 5 |
| Seller configuration from the environment (seed as 64 hexadecimal characters or a 12 to 24-word phrase, RPC, WS, scan RPC, `PORT`, `HOST`, `PUBLIC_ORIGIN`), each documented; why a seed of its own; a separate seed for local runs | 2, 5 |
| Terms: 1000/s, 5 to 300 s, `durations: [100]`, idle close 60 s, devnet USDC | 4 |
| `/health` kept; Dockerfile with Kora 2.0.5 built as CI does, Node 24.22.0, pnpm 12.14.0 from npm, the seller's graph alone installed (`tsx` from the root); ignore file; `fly.toml` with the machine settings, `kill_timeout`, the rolling strategy; README with the operator's steps and the operational facts (restarts, the internal `closeUrl`, closes failing until the start-up's close shows, Kora's exit) | 1, 5 |
| Demo package, exact pins, no change to `packages/mcp` | 6 |
| Wallet folder from `STINT_DEMO_HOME`, files in its `stint-demo` folder, created before the election; `agent.json` 0600, never overwritten, devnet only; address on stderr; balance from the agent's USDC account, missing = 0, refreshed after actions, on request and when a close is found | 7, 9, 10, 13 |
| The fetch recorder: request line, statuses, decoded `PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE` on the retry, decoded `PAYMENT-RESPONSE`; everything else untouched; tested with a fake fetch | 8 |
| Explorer links from validated base58 only | 8 |
| Two copies: election by `owner.json` (`wx`, 0600, `{ pid, port, token }`) in a folder created if missing, ping with Bearer, stale take-over, `/call` Bearer-checked on 127.0.0.1 with a body cap, re-election on a connection error, no action sent twice when its outcome is unknown (reads asked again), the owner's shutdown closing sessions then removing its file; tested with two in-process instances | 9, 13 |
| Actions through `createSessionTools`; the policy's limits (2.000 USDC an hour); the state shape; `closed`, `expired`, `ended`; `findClose` for the close link; subscription to the agent's own USDC account; frames; the last exchange kept when an action has no rows | 6, 7, 10 |
| One log line per tool call in each copy that handles it, but none for a state read that succeeds | 11, 13 |
| The quit-time close stated as a best effort, with the gate's idle close as what refunds otherwise | 14, 15 |
| Tools `stint_demo` (`_meta.ui.resourceUri`), `stint_demo_state` (app only), the three actions (model and app); the UI extension declared; instructions; `InMemoryTransport` test | 11 |
| Panel: wallet, faucet link, Refresh, Launch from 0.1 USDC, live rows, the capsule from `paidUntil` corrected by the server's clock every poll and redrawn every 250 ms, Top up refused near the end and past `maxSeconds` with the reason, Close now, the end states, host CSS variables and the brand's palette only (borders mixed from Mist, Slate, Paper and Ink), at most two primary buttons, `textContent` only, polling every 2 s and 0.5 s while busy, errors inline | 6, 12 |
| The bundle (`dist/claude-demo.cjs`), the `.mcpb` (manifest 0.3, no BOM, validated then packed); a stdio test of the built bundle | 13 |
| The docs lines: README, plans README, spec §3.3 | 14 |
| The manual run: deploy, `curl`, a fresh wallet, the faucet, Launch, Close now, top-ups from the panel and the chat, an expiry, a quit | 15 |
| An end-to-end test against the local stack | Not possible without importing Surfpool: deviation 13 |

**Placeholder scan:** every code step holds the whole file or the exact text to replace; no step says "similar to";
the README steps name `<your devnet endpoint>` and `<you>`, which are the operator's own values, not missing code.

**Test counts:** seller 11 after Task 2 (config 7, keys 4), 21 after Task 3 (Kora 6, chain 4), 22 after Task 4; demo
9 after Task 6, 17 after Task 7, 24 after Task 8, 33 after Task 9 (owner 9), 42 after Task 10, 51 after Task 11 (tools
5, server 4), 53 after Task 12, 57 after Task 13 (manifest 2, stdio 2).

**Type consistency:** `CallHandler` (Task 9) is what `createCallHandler` returns (Task 11) and what `createDemoServer`
takes; `RouterOptions` has `dir` and `readOnly`, which `main.ts` fills with `DemoConfig.dir` and the two read-only
tools (Task 13); `loadOrCreateWallet` takes the same `dir` (Task 7); `ExchangeSink` and `GateAction` (Task 8) are what
`createDemo` exposes as `sink` (Task 10) and what `main.ts` passes to `recordExchanges` (Task 13);
`DemoChain.usdcAccount`, `usdcBalance`, `findClose` (Task 10) match the fake in `demo.test.ts`; `DemoState` and
`DemoSession` (Task 6) carry `endedAt` and `error`, which Tasks 10 and 12 use; `TOOL`, `PANEL_URI`, `LAUNCH_AMOUNT`
and `FAUCET_URL` come from `src/state.ts` everywhere, the manifest's tool names included (checked by
`manifest.test.ts`); `sellerGateSettings` (Task 4) returns the gate's settings without `facilitator`, `chain` and
`log`, which `startSeller` and `seller.test.ts` add; `KoraProcess.exit` (Task 3) is what `startSeller` turns into
`RunningSeller.failed` (Task 4), which `main.ts` watches; `fundingNeeded` and `FUNDING_MARGIN_LAMPORTS` live in
`chain.ts` (Task 3), and `seller.ts` no longer defines its own margin; `closeLeftSessions` takes no clock argument and
reads the Clock sysvar, as its Interfaces line says.
