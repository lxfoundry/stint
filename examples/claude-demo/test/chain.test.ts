import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { USDC_DEVNET, associatedTokenAddress } from "@lxfoundry/stint-x402";
import {
  getAddressEncoder,
  getBase58Decoder,
  getI64Encoder,
  getStructEncoder,
  getU64Encoder,
  getU8Encoder,
  type Address,
} from "@solana/kit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SessionTools } from "@lxfoundry/stint-client";
import { createRpcDemoChain } from "../src/chain.js";
import { createDemo } from "../src/demo.js";
import { PROGRAM, SELLER, SESSION, signatureOf } from "./fixtures.js";

/** Anchor's event tag and the `Closed` event's discriminator: what the program's `emit_cpi!` writes first. */
const EVENT_IX_TAG = new Uint8Array([0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d]);
const CLOSED_DISCRIMINATOR = new Uint8Array([50, 31, 87, 155, 135, 220, 195, 239]);

const closedFields = getStructEncoder([
  ["session", getAddressEncoder()],
  ["kind", getU8Encoder()],
  ["claimed", getU64Encoder()],
  ["owed", getU64Encoder()],
  ["refunded", getU64Encoder()],
  ["redirected", getU64Encoder()],
  ["closedBy", getAddressEncoder()],
  ["paidUntil", getI64Encoder()],
  ["at", getI64Encoder()],
]);

/** The inner instruction a close emits, as `getTransaction` returns it: base58 data. */
function closedEventData(session: Address): string {
  const fields = closedFields.encode({
    session,
    kind: 0,
    claimed: 10_000n,
    owed: 20_000n,
    refunded: 70_000n,
    redirected: 5n,
    closedBy: SELLER,
    paidUntil: 1_800_000_100n,
    at: 1_800_000_030n,
  });
  const data = new Uint8Array(EVENT_IX_TAG.length + CLOSED_DISCRIMINATOR.length + fields.length);
  data.set(EVENT_IX_TAG, 0);
  data.set(CLOSED_DISCRIMINATOR, EVENT_IX_TAG.length);
  data.set(fields, EVENT_IX_TAG.length + CLOSED_DISCRIMINATOR.length);
  return getBase58Decoder().decode(data);
}

const transaction = (data?: string) => ({
  slot: 1,
  blockTime: 1_800_000_030,
  version: 0,
  transaction: { message: { accountKeys: [PROGRAM], header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 0 }, instructions: [], recentBlockhash: "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N" }, signatures: [] },
  meta: {
    err: null,
    fee: 5000,
    preBalances: [],
    postBalances: [],
    logMessages: [],
    loadedAddresses: { writable: [], readonly: [] },
    innerInstructions: data === undefined ? [] : [{ index: 0, instructions: [{ programIdIndex: 0, accounts: [], data }] }],
  },
});

/** A JSON-RPC node on the loopback interface, answering from what a test sets. No network leaves the machine. */
const node = {
  token: undefined as string | undefined,
  signatures: [] as string[],
  transactions: new Map<string, ReturnType<typeof transaction>>(),
  calls: [] as string[],
  /** The node reads a request and never answers it. */
  hang: false,
};
let server: Server;
let url: string;

beforeAll(async () => {
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const { id, method, params } = JSON.parse(Buffer.concat(chunks).toString()) as { id: unknown; method: string; params: unknown[] };
      node.calls.push(method);
      if (node.hang) return;
      const context = { slot: 1 };
      let result: unknown;
      if (method === "getAccountInfo") {
        result = { context, value: node.token === undefined ? null : { data: ["", "base64"], executable: false, lamports: 2_039_280, owner: PROGRAM, rentEpoch: 0, space: 165 } };
      } else if (method === "getTokenAccountBalance") {
        result = { context, value: { amount: node.token, decimals: 6, uiAmount: 0, uiAmountString: "0" } };
      } else if (method === "getSignaturesForAddress") {
        result = node.signatures.map((signature) => ({ signature, slot: 1, err: null, memo: null, blockTime: 1_800_000_030, confirmationStatus: "confirmed" }));
      } else if (method === "getTransaction") {
        result = node.transactions.get(params[0] as string) ?? null;
      }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.closeAllConnections();
  return new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("the demo's reads from the chain", () => {
  it("watches the owner's USDC account, and reads its balance in base units, 0 while it does not exist", async () => {
    const chain = await createRpcDemoChain(url, SELLER);
    expect(chain.usdcAccount).toBe(await associatedTokenAddress(SELLER, USDC_DEVNET.mint));
    node.token = undefined;
    node.calls = [];
    expect(await chain.usdcBalance()).toBe(0n);
    expect(node.calls).toEqual(["getAccountInfo"]);
    node.token = "18446744073709551615";
    expect(await chain.usdcBalance()).toBe(18_446_744_073_709_551_615n);
  });

  it("finds nothing for a session that has no close", async () => {
    const chain = await createRpcDemoChain(url, SELLER);
    node.signatures = [];
    expect(await chain.findClose(SESSION)).toBeUndefined();
    const opening = signatureOf(1);
    node.signatures = [opening];
    node.transactions.set(opening, transaction());
    expect(await chain.findClose(SESSION)).toBeUndefined();
  });

  it("reads a close from its Closed event: all the seller was paid, what was refunded, when, and the signature", async () => {
    const chain = await createRpcDemoChain(url, SELLER);
    const close = signatureOf(3);
    node.signatures = [close, signatureOf(1)];
    node.transactions.set(close, transaction(closedEventData(SESSION)));
    expect(await chain.findClose(SESSION)).toEqual({
      signature: close,
      at: 1_800_000_030,
      paidUntil: 1_800_000_100,
      // claimed 10000 + owed 20000 + redirected 5
      paid: "30005",
      refunded: "70000",
    });
  });

  it("ignores a close of another session, and reads a transaction that holds no close once", async () => {
    const chain = await createRpcDemoChain(url, SELLER);
    const other = signatureOf(4);
    node.signatures = [other];
    node.transactions.set(other, transaction(closedEventData(SELLER)));
    node.calls = [];
    expect(await chain.findClose(SESSION)).toBeUndefined();
    expect(await chain.findClose(SESSION)).toBeUndefined();
    expect(node.calls.filter((method) => method === "getTransaction")).toHaveLength(1);
    expect(node.calls.filter((method) => method === "getSignaturesForAddress")).toHaveLength(2);
  });
});

describe("a node that does not answer", () => {
  it("has each request given up at its time limit, and answers again once the node does", async () => {
    const chain = await createRpcDemoChain(url, SELLER, { requestTimeoutMs: 50 });
    node.hang = true;
    await expect(chain.usdcBalance()).rejects.toMatchObject({ name: "TimeoutError" });
    await expect(chain.findClose(SESSION)).rejects.toMatchObject({ name: "TimeoutError" });
    node.hang = false;
    node.token = "7";
    node.signatures = [];
    expect(await chain.usdcBalance()).toBe(7n);
    expect(await chain.findClose(SESSION)).toBeUndefined();
  });

  it("is logged by the demo, which still answers the state read, and read again at the next one", async () => {
    const chain = await createRpcDemoChain(url, SELLER, { requestTimeoutMs: 50 });
    const logs: string[] = [];
    const tools = { tools: {}, closeCode: () => undefined, closeAll: async () => ({ closed: [], failed: [] }) } as unknown as SessionTools;
    const demo = createDemo({ address: SELLER, gateUrl: "https://gate.example", tools, chain, log: (line) => void logs.push(line) });
    node.hang = true;
    expect((await demo.state()).wallet).toEqual({ address: SELLER });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/^reading the wallet's balance failed: /);
    expect(logs[0]).not.toContain(url);
    node.hang = false;
    node.token = "7";
    expect((await demo.state()).wallet).toMatchObject({ address: SELLER, usdc: "7" });
    expect(logs).toHaveLength(1);
  });
});
