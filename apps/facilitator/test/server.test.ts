import { createHash, generateKeyPairSync } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { address, generateKeyPairSigner } from "@solana/kit";
import { STINT_PROGRAM_ADDRESS } from "@lxfoundry/stint-program-client";
import { buildOpenOffer, buildOpenTransaction, type SupportedResponse } from "@lxfoundry/stint-x402";
import { createMemoryStore, type SettlementRecord, type SettlementStore } from "../src/records.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFacilitator, type RunningFacilitator } from "../src/index.js";

/** A fresh 64-byte Solana secret key: the 32-byte seed, then the public key. */
function newSecretKey(): Uint8Array {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const seed = privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
  const pub = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  return Uint8Array.from([...seed, ...pub]);
}

/** Answers Kora's `getPayerSigner` only: enough for the routes that never reach the chain. */
async function startFakeKora(feePayer: string): Promise<{ url: string; server: Server }> {
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const { id } = JSON.parse(body) as { id: number };
      response.end(JSON.stringify({ jsonrpc: "2.0", id, result: { signer_address: feePayer, payment_address: feePayer } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server };
}

describe("facilitator HTTP interface (spec §6.1)", () => {
  let kora: { url: string; server: Server };
  let facilitator: RunningFacilitator;
  let feePayer: string;

  beforeAll(async () => {
    feePayer = (await generateKeyPairSigner()).address;
    kora = await startFakeKora(feePayer);
    facilitator = await startFacilitator({
      rpcUrl: "http://127.0.0.1:9",
      network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
      kora: { url: kora.url, apiKey: "kora-key" },
      rentPayerSecretKey: newSecretKey(),
      apiKeys: ["seller-key"],
    });
  });

  afterAll(async () => {
    await facilitator?.stop();
    kora?.server.close();
  });

  const post = (path: string, body: unknown, apiKey?: string) =>
    fetch(`${facilitator.url}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });

  it("answers its health check", async () => {
    expect(await (await fetch(`${facilitator.url}/health`)).json()).toEqual({ ok: true });
  });

  it("lists elapsed in /supported, with its fee payer, rent payer, program and closeUrl", async () => {
    const supported = (await (await fetch(`${facilitator.url}/supported`)).json()) as SupportedResponse;
    expect(supported.kinds).toEqual([
      {
        x402Version: 2,
        scheme: "elapsed",
        network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
        extra: {
          feePayer,
          rentPayer: facilitator.rentPayer,
          programId: STINT_PROGRAM_ADDRESS,
          closeUrl: `${facilitator.url}/close`,
        },
      },
    ]);
  });

  it("requires an API key on /verify and /settle", async () => {
    for (const path of ["/verify", "/settle"]) {
      expect((await post(path, {})).status).toBe(401);
      expect((await post(path, {}, "wrong")).status).toBe(401);
      expect((await post(path, {}, "seller")).status).toBe(401);
      expect((await post(path, {}, "seller-key-2")).status).toBe(401);
    }
  });

  it("refuses a body that is not JSON", async () => {
    const response = await post("/verify", "{", "seller-key");
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_json" });
  });

  it("refuses x402 version 1 before reading anything else", async () => {
    const response = await post(
      "/verify",
      { x402Version: 2, paymentPayload: { x402Version: 1 }, paymentRequirements: {} },
      "seller-key",
    );
    expect(await response.json()).toMatchObject({ isValid: false, invalidReason: "invalid_x402_version" });
  });

  it("serves /close without an API key: 404 for a session that is not an address, a refusal for a body without a transaction", async () => {
    const lookup = await fetch(`${facilitator.closeUrl}?session=not-an-address`);
    expect(lookup.status).toBe(404);
    expect(await lookup.json()).toEqual({ error: "unknown_session" });

    const empty = await post("/close", {});
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({
      success: false,
      errorReason: "invalid_payload",
      errorMessage: "the body carries no transaction",
      transaction: "",
    });

    const garbled = await post("/close", "{");
    expect(garbled.status).toBe(400);
    expect(await garbled.json()).toEqual({ error: "invalid_json" });
  });

  it("answers 404 elsewhere", async () => {
    expect((await fetch(`${facilitator.url}/nowhere`)).status).toBe(404);
  });

  it("hands the settlement store the API key's SHA-256, never the key", async () => {
    const claims: SettlementRecord[] = [];
    const memory = createMemoryStore();
    const store: SettlementStore = { ...memory, claim: async (record) => (claims.push(record), memory.claim(record)) };
    const keyed = await startFacilitator({
      rpcUrl: "http://127.0.0.1:9",
      network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
      kora: { url: kora.url, apiKey: "kora-key" },
      rentPayerSecretKey: newSecretKey(),
      apiKeys: ["seller-key"],
      settlementStore: store,
    });
    try {
      const offer = buildOpenOffer({
        network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
        asset: address("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"),
        payTo: (await generateKeyPairSigner()).address,
        receiverAuthorizer: (await generateKeyPairSigner()).address,
        terms: { rate: 1_000n, minSeconds: 5, maxSeconds: 120 },
        seconds: 30,
        facilitator: { feePayer, rentPayer: keyed.rentPayer, programId: STINT_PROGRAM_ADDRESS, closeUrl: keyed.closeUrl },
        lifetime: { blockhash: "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N", lastValidBlockHeight: 1_234n },
        maxTimeoutSeconds: 60,
        idleCloseSeconds: 10,
        closeOnOutage: true,
      });
      const built = await buildOpenTransaction({ requirements: offer, authority: await generateKeyPairSigner(), decimals: 6 });
      const paymentPayload = { x402Version: 2, accepted: offer, payload: { type: "open", transaction: built.transaction, session: built.session } };
      // The node cannot be reached, so the settlement fails once it has claimed the message.
      const response = await fetch(`${keyed.url}/settle`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer seller-key" },
        body: JSON.stringify({ x402Version: 2, paymentPayload, paymentRequirements: offer }),
      });
      expect(response.status).toBe(500);
      expect(claims.map((claim) => claim.apiKey)).toEqual([createHash("sha256").update("seller-key", "utf8").digest("hex")]);
      // Released when the settlement failed, before anything was submitted.
      expect(await store.list()).toEqual([]);
    } finally {
      await keyed.stop();
    }
  });
});
