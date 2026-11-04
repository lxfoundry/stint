import { createSessionTools, createStintClient, type CloseAllOutput, type Policy, type SessionTools } from "@lxfoundry/stint-client";
import { redactUrls } from "@lxfoundry/stint-x402";
import type { KeyPairSigner } from "@solana/kit";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createRpcDemoChain } from "./chain.js";
import { loadConfig, type DemoConfig } from "./config.js";
import { createDemo, type Demo } from "./demo.js";
import { recordExchanges } from "./exchange.js";
import { createRouter, type CallHandler } from "./owner.js";
import { createDemoServer } from "./server.js";
import { FAUCET_URL, TOOL } from "./state.js";
import { createCallHandler } from "./tools.js";
import { ensureDemoFolder, loadOrCreateWallet } from "./wallet.js";

/** The tools that only read: a forwarder may ask again for one whose owner went away during it. */
export const READ_ONLY: ReadonlySet<string> = new Set([TOOL.demo, TOOL.state]);

/**
 * The longest the server waits to close the session on its way out. An open still in flight must finish before its
 * session can be closed, and on a slow network that takes longer than a close does.
 */
const CLOSE_LIMIT_MS = 90_000;

const PREFIX = "stint-claude-demo: ";

/** One message to stderr (stdout carries the protocol), each URL in it cut to its host and each of its lines prefixed. */
export function log(message: string): void {
  const lines = redactUrls(message).split("\n");
  process.stderr.write(`${lines.map((line) => `${PREFIX}${line}`).join("\n")}\n`);
}

/** The session tools of one owner state: its own client, with the demo's key and policy. */
export type MakeTools = (signer: KeyPairSigner, policy: Policy) => SessionTools;
const defaultTools: MakeTools = (signer, policy) => createSessionTools(createStintClient({ signer, policy }));

export interface OwnerSide {
  /** What the router calls each time this copy wins the election: loads the key, builds a state, and returns its handler. */
  becomeOwner(): Promise<CallHandler>;
  /** Closes the session of every state this copy has built; nothing opens afterwards, in any of them. */
  shutdown(): Promise<CloseAllOutput>;
}

/**
 * What a copy does only as the owner, kept outside the protocol server (`serveStdio` may build that more than once per
 * process). The router calls `becomeOwner` each time the copy wins the election, which can be more than once: a copy that
 * finds `owner.json` naming another steps down, drops its state, and may win again with a new one.
 *
 * Two things outlive a state. The recorder is installed on the `fetch` the process had at the start, so a second state's
 * recorder replaces the first's and never wraps it (the client calls the global `fetch`, so only one recorder can be
 * current). And the session of a dropped state stays open until it is closed, so every state is kept for `shutdown`.
 */
export function createOwnerSide(config: DemoConfig, say: (line: string) => void, makeTools: MakeTools = defaultTools): OwnerSide {
  const original = globalThis.fetch;
  const built: Demo[] = [];
  let leaving = false;
  return {
    becomeOwner: async () => {
      // Only here, and only after the election: a copy that forwards never reads or creates `agent.json`.
      const wallet = await loadOrCreateWallet(config.dir, config.policy, { log: say });
      say(`${wallet.created ? "created the agent's wallet" : "using the agent's wallet"} ${wallet.signer.address} (${wallet.path}); devnet USDC: ${FAUCET_URL}`);
      const chain = await createRpcDemoChain(config.rpcUrl, wallet.signer.address);
      const tools = makeTools(wallet.signer, config.policy);
      const created = createDemo({ address: wallet.signer.address, gateUrl: config.gateUrl, tools, chain, log: say });
      // Before the client sends anything: it calls the global `fetch` at each request.
      globalThis.fetch = recordExchanges(config.gateUrl, created.sink, original);
      built.push(created);
      // A state built while the copy is on its way out (a call that reached the router before it closed) opens nothing.
      if (leaving) await created.shutdown();
      return createCallHandler(created, say);
    },
    async shutdown() {
      leaving = true;
      const outcomes = await Promise.all(built.map((demo) => demo.shutdown()));
      return { closed: outcomes.flatMap((outcome) => outcome.closed), failed: outcomes.flatMap((outcome) => outcome.failed) };
    },
  };
}

async function main(panelHtml: () => Promise<string>): Promise<void> {
  const config = loadConfig(process.env);
  ensureDemoFolder(config.dir, log);
  const side = createOwnerSide(config, log);
  const router = await createRouter({ dir: config.dir, readOnly: READ_ONLY, log, becomeOwner: side.becomeOwner });
  log(router.role() === "owner" ? "this copy holds the demo's state" : "forwarding to the copy that holds the demo's state");
  // One line per call in a copy that forwards it too, but for the panel's state reads, which come every 2 s.
  const call: CallHandler = async (name, args) => {
    if (router.role() === "forwarder" && name !== TOOL.state) log(`${name} forwarded`);
    return router.call(name, args);
  };
  const html = await panelHtml();
  // The factory holds no state (`serveStdio` may call it more than once): every call goes to the router.
  serveStdio(() => createDemoServer({ html, call, log }));

  /**
   * On the way out the sessions of every state this copy built are closed first (the owner's, and those of states it
   * dropped), then the router, which takes `owner.json` away only if it still names this copy. A copy that only
   * forwards has no session: it closes its router and leaves. If the host kills the process instead, the gate closes
   * an idle session itself and refunds the rest.
   */
  let leaving: Promise<void> | undefined;
  const leave = (): Promise<void> => {
    leaving ??= (async () => {
      const limit = setTimeout(() => {
        log("giving up on closing the session");
        process.exit(1);
      }, CLOSE_LIMIT_MS);
      limit.unref();
      let failed = 0;
      try {
        const outcome = await side.shutdown();
        for (const sessionId of outcome.closed) log(`closed session ${sessionId}`);
        for (const { sessionId, error } of outcome.failed) log(`could not close session ${sessionId}: ${error}`);
        failed = outcome.failed.length;
        await router.close();
      } catch (error) {
        log(`leaving failed: ${error instanceof Error ? error.message : String(error)}`);
        failed++;
      }
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
    log(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
