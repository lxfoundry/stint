import { generateKeyPairSync } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { generateKeyPairSigner } from "@solana/kit";
import { STINT_PROGRAM_ADDRESS } from "@lxfoundry/stint-program-client";
import type { SupportedResponse } from "@lxfoundry/stint-x402";
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

  it("answers 404 elsewhere", async () => {
    expect((await fetch(`${facilitator.url}/nowhere`)).status).toBe(404);
  });
});
