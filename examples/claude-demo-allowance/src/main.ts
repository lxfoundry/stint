import { createNodeRpc, createSessionTools, createStintClient, type AllowanceReport, type SessionTools } from "@lxfoundry/stint-client";
import { USDC_DEVNET, redactUrls } from "@lxfoundry/stint-x402";
import type { Address, KeyPairSigner } from "@solana/kit";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createRpcDemoChain, type DemoChain } from "../../claude-demo/src/chain.js";
import { createDemo, type Demo } from "../../claude-demo/src/demo.js";
import { recordExchanges } from "../../claude-demo/src/exchange.js";
import type { OwnerSide } from "../../claude-demo/src/main.js";
import { createRouter, type CallHandler } from "../../claude-demo/src/owner.js";
import { LAUNCH_AMOUNT, TOOL } from "../../claude-demo/src/state.js";
import { createCallHandler } from "../../claude-demo/src/tools.js";
import { ensureDemoFolder, loadOrCreateWallet } from "../../claude-demo/src/wallet.js";
import { createAllowanceReader, withAllowance } from "./allowance.js";
import { loadConfig, type AllowanceConfig } from "./config.js";
import { createAllowanceServer } from "./server.js";

/** The tools that only read, by the call handler's names: a forwarder may ask again for one whose owner went away. */
export const READ_ONLY: ReadonlySet<string> = new Set([TOOL.demo, TOOL.state]);

/** As the first demo's: the longest the server waits to close the session on its way out. */
const CLOSE_LIMIT_MS = 90_000;

const PREFIX = "stint-claude-demo-allowance: ";

/** One message to stderr (stdout carries the protocol), each URL in it cut to its host and each of its lines prefixed. */
export function log(message: string): void {
  const lines = redactUrls(message).split("\n");
  process.stderr.write(`${lines.map((line) => `${PREFIX}${line}`).join("\n")}\n`);
}

/** What the owner side builds on: replaced in tests. */
export interface AllowanceDeps {
  /** The session tools: the client funded from the owner's allowance, with no node (the chain refuses what it cannot fund). */
  makeTools(signer: KeyPairSigner, config: AllowanceConfig): SessionTools;
  /** The reads of the chain for the owner's account: its balance, the stream's subscription, the wallet log. */
  makeChain(config: AllowanceConfig): Promise<DemoChain>;
  /** The reads of the allowance, on the extension's own node. */
  makeReader(agent: Address, config: AllowanceConfig): () => Promise<AllowanceReport>;
}

export const defaultDeps: AllowanceDeps = {
  makeTools: (signer, config) =>
    createSessionTools(createStintClient({ signer, policy: config.policy, allowance: { owner: config.owner, nonce: config.nonce } })),
  makeChain: (config) => createRpcDemoChain(config.rpcUrl, config.owner),
  makeReader: (agent, config) =>
    createAllowanceReader(createNodeRpc(config.rpcUrl), { owner: config.owner, agent, mint: USDC_DEVNET.mint, nonce: config.nonce }),
};

/** As the first demo's `createOwnerSide`: the owner's account as the demo's wallet, the agent's key as the signer. */
export function createOwnerSide(config: AllowanceConfig, say: (line: string) => void, deps: AllowanceDeps = defaultDeps): OwnerSide {
  const original = globalThis.fetch;
  const built: Demo[] = [];
  const states = new Map<CallHandler, Demo>();
  let leaving = false;
  return {
    becomeOwner: async () => {
      const wallet = await loadOrCreateWallet(config.dir, config.policy, { log: say });
      say(
        `${wallet.created ? "created the agent's key" : "using the agent's key"} ${wallet.signer.address} (${wallet.path}); it holds nothing: the owner ${config.owner} funds it with an allowance`,
      );
      const chain = await deps.makeChain(config);
      const tools = deps.makeTools(wallet.signer, config);
      const inner = createDemo({ address: config.owner, gateUrl: config.gateUrl, tools, chain, log: say });
      const amount = BigInt(LAUNCH_AMOUNT);
      const created = withAllowance(inner, {
        owner: config.owner,
        agent: wallet.signer.address,
        nonce: config.nonce,
        read: deps.makeReader(wallet.signer.address, config),
        amounts: { launch: amount, topUp: amount },
        log: say,
      });
      // Before the client sends anything: it calls the global `fetch` at each request.
      globalThis.fetch = recordExchanges(config.gateUrl, created.sink, original);
      built.push(created);
      if (leaving) await created.shutdown();
      const handler = createCallHandler(created, say);
      states.set(handler, created);
      return handler;
    },
    dropped(handler) {
      void (async () => {
        let demo: Demo | undefined;
        try {
          demo = states.get(await handler);
        } catch {
          return;
        }
        if (!demo) return;
        const outcome = await demo.shutdown();
        for (const sessionId of outcome.closed) say(`closed session ${sessionId} of a state this copy dropped`);
        for (const { sessionId, error } of outcome.failed) say(`could not close session ${sessionId} of a state this copy dropped: ${error}`);
      })().catch((error: unknown) => say(`closing a dropped state failed: ${error instanceof Error ? error.message : String(error)}`));
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
  const router = await createRouter({ dir: config.dir, readOnly: READ_ONLY, log, becomeOwner: side.becomeOwner, onStepDown: side.dropped });

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
  process.stdin.once("end", () => void leave());
  process.stdin.once("close", () => void leave());
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => void leave());

  // After the handlers above, as in the first demo: a signal before them would leave `owner.json` behind.
  log(router.role() === "owner" ? "this copy holds the demo's state" : "forwarding to the copy that holds the demo's state");
  const call: CallHandler = async (name, args) => {
    if (router.role() === "forwarder" && name !== TOOL.state) log(`${name} forwarded`);
    return router.call(name, args);
  };
  const html = await panelHtml();
  serveStdio(() => createAllowanceServer({ html, call, log }));
}

/** Starts the server with the panel's HTML from `panelHtml`; a start that fails says why on stderr and exits 1. */
export function run(panelHtml: () => Promise<string>): void {
  main(panelHtml).catch((error: unknown) => {
    log(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
