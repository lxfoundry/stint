import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createSolanaRpcSubscriptions } from "@solana/kit";
import { createGate, type GateConfig } from "@lxfoundry/stint-gate";
import { sendJson } from "@lxfoundry/stint-x402";
import { createStreamAdapter } from "./adapter.js";

export interface StreamConfig {
  readonly host?: string;
  /** 0 picks a free port (spec §12.4). */
  readonly port?: number;
  /** The node's WebSocket endpoint (spec §8, §12.4). */
  readonly rpcWsUrl: string;
  /** The gate's configuration, but its origin and adapter, which the stream supplies. */
  readonly gate: Omit<GateConfig<null>, "origin" | "adapter">;
}

export interface RunningStream {
  readonly url: string;
  stop(): Promise<void>;
}

/** The example resource with its gate mounted as middleware (spec §7.6, §8). */
export async function startStream(config: StreamConfig): Promise<RunningStream> {
  const host = config.host ?? "127.0.0.1";
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port ?? 0, host, resolve);
  });
  const url = `http://${host}:${(server.address() as AddressInfo).port}`;
  const gate = createGate({
    ...config.gate,
    origin: url,
    adapter: createStreamAdapter(createSolanaRpcSubscriptions(config.rpcWsUrl)),
  });

  server.on("request", (request, response) => {
    gate
      .handleRequest(request, response)
      .then((handled) => {
        if (handled) return;
        if (request.method === "GET" && request.url === "/health") return sendJson(response, 200, { ok: true });
        sendJson(response, 404, { error: "not_found" });
      })
      .catch((error: unknown) => {
        config.gate.log?.({ event: "error", error: error instanceof Error ? error.message : String(error) });
        if (!response.headersSent) sendJson(response, 500, { error: "internal" });
      });
  });
  server.on("upgrade", (request, socket, head) => {
    if (!gate.handleUpgrade(request, socket, head)) socket.destroy();
  });

  return {
    url,
    stop: async () => {
      await gate.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
