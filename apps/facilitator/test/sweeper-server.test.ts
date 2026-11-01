import { generateKeyPairSync } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { generateKeyPairSigner, getBase64Decoder, type Address } from "@solana/kit";
import { STINT_PROGRAM_ADDRESS, getSessionEncoder, getSessionSize } from "@lxfoundry/stint-program-client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { startFacilitator, type RunningFacilitator, type SweeperConfig } from "../src/index.js";

const NETWORK = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU" as Address;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function until(condition: () => boolean, what: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await sleep(5);
  }
}

/** A fresh 64-byte Solana secret key: the 32-byte seed, then the public key. */
function newSecretKey(): Uint8Array {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const seed = privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
  const pub = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  return Uint8Array.from([...seed, ...pub]);
}

interface Endpoint {
  readonly url: string;
  count(method: string): number;
  stop(): Promise<void>;
}

/** A JSON-RPC node over HTTP: it answers every call from `answer`, and counts the calls by method. */
async function startEndpoint(answer: (method: string) => unknown): Promise<Endpoint> {
  const calls: string[] = [];
  const server: Server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const { id, method } = JSON.parse(body) as { id: unknown; method: string };
      calls.push(method);
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ jsonrpc: "2.0", id, result: answer(method) }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    count: (method) => calls.filter((called) => called === method).length,
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

describe("the sweeper inside startFacilitator (spec §6.4, §12.4)", () => {
  let kora: { url: string; stop: () => Promise<void> };
  // A session account that started in 1970 and ran for 30 s: every real clock says it has expired.
  let expired: { pubkey: string; account: unknown };
  const endpoints: Endpoint[] = [];
  const running: RunningFacilitator[] = [];

  beforeAll(async () => {
    const feePayer = (await generateKeyPairSigner()).address;
    const koraEndpoint = await startEndpoint(() => ({ signer_address: feePayer, payment_address: feePayer }));
    kora = koraEndpoint;
    const key = (await generateKeyPairSigner()).address;
    const data = getSessionEncoder().encode({
      version: 1,
      bump: 255,
      authority: key,
      seed: 1n,
      mint: MINT,
      receiver: key,
      receiverAuthorizer: key,
      refundOwner: key,
      rentPayer: key,
      rate: 1_000n,
      minSeconds: 5,
      maxSeconds: 120,
      startedAt: 1_000_000n,
      deposited: 30_000n,
      claimed: 0n,
    });
    expired = {
      pubkey: (await generateKeyPairSigner()).address,
      account: {
        data: [getBase64Decoder().decode(data), "base64"],
        executable: false,
        lamports: 1_000_000,
        owner: STINT_PROGRAM_ADDRESS,
        rentEpoch: 0,
        space: getSessionSize(),
      },
    };
  });

  afterAll(() => kora.stop());

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(running.splice(0).map((facilitator) => facilitator.stop()));
    await Promise.all(endpoints.splice(0).map((endpoint) => endpoint.stop()));
  });

  /** A node that lists `accounts` and holds none: reading one account finds nothing. */
  const node = async (accounts: unknown[]): Promise<Endpoint> => {
    const endpoint = await startEndpoint((method) => (method === "getAccountInfo" ? { context: { slot: 1 }, value: null } : accounts));
    endpoints.push(endpoint);
    return endpoint;
  };

  const launch = async (rpcUrl: string, sweeper?: SweeperConfig): Promise<RunningFacilitator> => {
    const facilitator = await startFacilitator({
      rpcUrl,
      network: NETWORK,
      kora: { url: kora.url, apiKey: "kora-key" },
      rentPayerSecretKey: newSecretKey(),
      apiKeys: ["seller-key"],
      sweeper,
    });
    running.push(facilitator);
    return facilitator;
  };

  it("sweeps on its interval, decides expiry on the clock it is given, and stops sweeping when it stops", async () => {
    const endpoint = await node([expired]);
    // Only the injected clock, set at the epoch, says that this session has not expired: the real one would not.
    const facilitator = await launch(endpoint.url, { intervalMs: 20, clock: () => 0 });

    await until(() => endpoint.count("getProgramAccounts") >= 3, "three sweeps");
    expect(endpoint.count("getAccountInfo")).toBe(0);

    await facilitator.stop();
    const sweeps = endpoint.count("getProgramAccounts");
    await sleep(100);
    expect(endpoint.count("getProgramAccounts")).toBe(sweeps);
  });

  it("starts no interval without a sweeper configuration, and still sweeps on demand", async () => {
    const timers = vi.spyOn(globalThis, "setInterval");
    // The default interval is 30 s: no short wait could show that a timer was started by mistake, a spy can.
    const atDefault = () => timers.mock.calls.filter((call) => call[1] === 30_000);
    const endpoint = await node([]);

    const facilitator = await launch(endpoint.url);
    expect(atDefault()).toHaveLength(0);
    // The control: a sweeper configuration without an interval starts exactly one timer, at the default.
    await launch(endpoint.url, {});
    expect(atDefault()).toHaveLength(1);

    expect(endpoint.count("getProgramAccounts")).toBe(0);
    expect(await facilitator.sweepOnce()).toEqual({ closed: [], failed: [] });
    expect(endpoint.count("getProgramAccounts")).toBe(1);
  });

  it("lists on scanRpcUrl when it is set, and reads on rpcUrl", async () => {
    const main = await node([]);
    const scan = await node([expired]);
    const facilitator = await launch(main.url, { scanRpcUrl: scan.url });

    // The real clock: the session expired in 1970, so it is read, and the main node holds nothing, so it is skipped.
    expect(await facilitator.sweepOnce()).toEqual({ closed: [], failed: [] });

    expect(scan.count("getProgramAccounts")).toBe(1);
    expect(scan.count("getAccountInfo")).toBe(0);
    expect(main.count("getProgramAccounts")).toBe(0);
    expect(main.count("getAccountInfo")).toBe(1);
  });
});
