import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { address, createKeyPairSignerFromBytes, createSolanaRpc, type Address } from "@solana/kit";
import { STINT_PROGRAM_ADDRESS } from "@lxfoundry/stint-program-client";
import { HttpError, SCHEME, X402_VERSION, readJson, sendJson, type Network, type SupportedResponse } from "@lxfoundry/stint-x402";
import { createKoraClient } from "./kora.js";
import { settlePayment } from "./settle.js";
import { verifyPayment, type FacilitatorContext } from "./verify.js";

export interface FacilitatorConfig {
  readonly host?: string;
  /** 0 picks a free port (spec §12.4). */
  readonly port?: number;
  readonly rpcUrl: string;
  readonly network: string;
  readonly kora: { readonly url: string; readonly apiKey: string };
  /** The rent payer's 64-byte secret key (spec §6.3). */
  readonly rentPayerSecretKey: Uint8Array;
  /** One per resource server; required on `/verify` and `/settle` (spec §6.5). */
  readonly apiKeys: readonly string[];
  readonly confirmTimeoutMs?: number;
  readonly log?: (entry: Record<string, unknown>) => void;
}

export interface RunningFacilitator {
  readonly url: string;
  readonly closeUrl: string;
  readonly feePayer: Address;
  readonly rentPayer: Address;
  stop(): Promise<void>;
}

const digest = (key: string) => createHash("sha256").update(key, "utf8").digest();

/**
 * Whether `presented` is one of the configured keys. Compared in constant time over SHA-256
 * digests, which have one length whatever the keys', and against every key without stopping early.
 */
function isKnownKey(presented: string, configured: readonly Buffer[]): boolean {
  const candidate = digest(presented);
  let found = false;
  for (const key of configured) found = timingSafeEqual(candidate, key) || found;
  return found;
}

export async function startFacilitator(config: FacilitatorConfig): Promise<RunningFacilitator> {
  const kora = createKoraClient(config.kora.url, config.kora.apiKey);
  const feePayer = address((await kora.getPayerSigner()).signer_address);
  const rentPayer = await createKeyPairSignerFromBytes(config.rentPayerSecretKey);
  const log = config.log ?? (() => {});
  const apiKeys = config.apiKeys.map(digest);
  const ctx: FacilitatorContext = {
    rpc: createSolanaRpc(config.rpcUrl),
    network: config.network,
    keys: { feePayer, rentPayer: rentPayer.address },
    rentPayer,
    kora,
    confirmTimeoutMs: config.confirmTimeoutMs ?? 30_000,
  };
  const host = config.host ?? "127.0.0.1";
  let url = "";

  const supported = (): SupportedResponse => ({
    kinds: [
      {
        x402Version: X402_VERSION,
        scheme: SCHEME,
        network: config.network as Network,
        extra: { feePayer, rentPayer: rentPayer.address, programId: STINT_PROGRAM_ADDRESS, closeUrl: `${url}/close` },
      },
    ],
    extensions: [],
    signers: { "solana:*": [feePayer] },
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = new URL(request.url ?? "/", "http://facilitator").pathname;
    if (request.method === "GET" && path === "/health") return sendJson(response, 200, { ok: true });
    if (request.method === "GET" && path === "/supported") return sendJson(response, 200, supported());
    if (request.method === "POST" && (path === "/verify" || path === "/settle")) {
      const key = request.headers.authorization?.replace(/^Bearer /, "");
      if (!key || !isKnownKey(key, apiKeys)) return sendJson(response, 401, { error: "unauthorized" });
      const body = await readJson(request);
      const { paymentPayload, paymentRequirements } = (body ?? {}) as Record<string, unknown>;
      if (path === "/verify") {
        const verified = await verifyPayment(ctx, paymentPayload, paymentRequirements);
        log({ event: "verify", ok: verified.ok, ...(verified.ok ? {} : { reason: verified.reason }) });
        return sendJson(
          response,
          200,
          verified.ok
            ? { isValid: true, payer: verified.payer }
            : { isValid: false, invalidReason: verified.reason, invalidMessage: verified.message },
        );
      }
      const settled = await settlePayment(ctx, paymentPayload, (paymentRequirements ?? {}) as { amount?: unknown });
      log({ event: "settle", success: settled.success, reason: settled.errorReason, transaction: settled.transaction });
      return sendJson(response, 200, settled);
    }
    sendJson(response, 404, { error: "not_found" });
  }

  const server = createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      if (error instanceof HttpError) return sendJson(response, error.status, { error: error.code });
      log({ event: "error", error: error instanceof Error ? error.message : String(error) });
      if (!response.headersSent) sendJson(response, 500, { error: "internal" });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port ?? 0, host, resolve);
  });
  url = `http://${host}:${(server.address() as AddressInfo).port}`;

  return {
    url,
    closeUrl: `${url}/close`,
    feePayer,
    rentPayer: rentPayer.address,
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
