import { createSessionTools, createStintClient } from "@lxfoundry/stint-client";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { ConfigError, loadConfig } from "./config.js";
import { createMcpServer } from "./server.js";

/**
 * The longest the server waits to close sessions on its way out. An open still in flight must finish before its
 * session can be closed, and on a slow network that takes longer than a close does.
 */
const CLOSE_LIMIT_MS = 90_000;

/**
 * The stdio entry point (spec §9.6). stdout is the protocol channel, so everything written for a
 * person goes to stderr. When the host goes away, or a signal arrives, every session still open is
 * closed first: the unused part of each deposit comes back to the buyer.
 */
async function main(): Promise<void> {
  const config = await loadConfig(process.env);
  const client = createStintClient({ signer: config.signer, policy: config.policy });
  const { tools, closeAll } = createSessionTools(client);

  let leaving: Promise<void> | undefined;
  const leave = (): Promise<void> => {
    leaving ??= (async () => {
      const limit = setTimeout(() => {
        console.error("stint-mcp: giving up on closing sessions");
        process.exit(1);
      }, CLOSE_LIMIT_MS);
      limit.unref();
      const outcome = await closeAll();
      for (const sessionId of outcome.closed) console.error(`stint-mcp: closed session ${sessionId}`);
      for (const { sessionId, error } of outcome.failed) console.error(`stint-mcp: could not close session ${sessionId}: ${error}`);
      process.exit(outcome.failed.length === 0 ? 0 : 1);
    })();
    return leaving;
  };

  serveStdio(() => createMcpServer(tools));
  // The host going away is the end of standard input. The protocol connection's own close is not that:
  // `serveStdio` also builds and drops a connection of its own while a client probes for the protocol version.
  process.stdin.once("end", () => void leave());
  process.stdin.once("close", () => void leave());
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => void leave());
  console.error(`stint-mcp: serving ${Object.keys(tools).length} tools on stdio as ${config.signer.address}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof ConfigError ? error.message : error);
  process.exit(1);
});
