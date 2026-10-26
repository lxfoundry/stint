import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { generateKeyPairSigner, type Address, type KeyPairSigner } from "@solana/kit";
import { CloseKind, type ClosedEvent, type Session } from "@lxfoundry/stint-program-client";
import {
  USDC_DEVNET,
  buildOpenTransaction,
  createSessionToken,
  decodePaymentRequiredHeader,
  encodePaymentSignatureHeader,
  inspectTransaction,
  readElapsedPayload,
  type PaymentPayload,
  type PaymentRequired,
  type SettleResponse,
  type VerifyResponse,
} from "@lxfoundry/stint-x402";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { createGate, type EndReason, type Gate, type GateChain, type SessionInfo } from "../src/index.js";

const NOW_MS = 1_800_000_000_000;

interface Harness {
  readonly url: string;
  readonly gate: Gate;
  readonly server: Server;
  readonly buyer: KeyPairSigner;
  readonly authorizer: KeyPairSigner;
  readonly calls: { verify: PaymentPayload[]; settle: PaymentPayload[]; provision: SessionInfo[]; attach: SessionInfo[]; teardown: EndReason[] };
  verifyAnswer: VerifyResponse;
  settleAnswer: (payload: PaymentPayload) => SettleResponse;
  sessions: Map<Address, Session>;
}

async function startHarness(): Promise<Harness> {
  const buyer = await generateKeyPairSigner();
  const authorizer = await generateKeyPairSigner();
  const seller = await generateKeyPairSigner();
  const feePayer = (await generateKeyPairSigner()).address;
  const rentPayer = (await generateKeyPairSigner()).address;
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const harness = {
    url,
    server,
    buyer,
    authorizer,
    calls: { verify: [], settle: [], provision: [], attach: [], teardown: [] },
    verifyAnswer: { isValid: true },
    settleAnswer: () => ({ success: true, transaction: "sig", network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" }),
    sessions: new Map<Address, Session>(),
  } as unknown as Harness;

  const chain: GateChain = {
    latestBlockhash: async () => ({ blockhash: "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N", lastValidBlockHeight: 100n }),
    readSession: async (session) => harness.sessions.get(session),
    closedEvent: async () =>
      ({ claimed: 0n, owed: 8_000n, refunded: 22_000n, redirected: 0n, kind: CloseKind.Standard }) as ClosedEvent,
  };
  const gate = createGate({
    origin: url,
    network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
    asset: USDC_DEVNET,
    payTo: seller.address,
    receiverAuthorizer: authorizer,
    terms: { rate: 1_000n, minSeconds: 5, maxSeconds: 120 },
    durations: [30, 60],
    idleCloseSeconds: 10,
    facilitator: {
      supported: async () => ({
        kinds: [
          {
            x402Version: 2,
            scheme: "elapsed",
            network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
            extra: { feePayer, rentPayer, programId: "5iCYPqLjCWw5KzQTU6NBUhR2hxg5SWGmS1ctUn3qESvr", closeUrl: "http://f/close" },
          },
        ],
        extensions: [],
        signers: {},
      }),
      verify: async (payload) => (harness.calls.verify.push(payload), harness.verifyAnswer),
      settle: async (payload) => (harness.calls.settle.push(payload), harness.settleAnswer(payload)),
    },
    chain,
    adapter: {
      provision: async (info) => void harness.calls.provision.push(info),
      attach: (info, socket) => {
        harness.calls.attach.push(info);
        socket.send(JSON.stringify({ type: "hello" }));
      },
      teardown: async (_, reason) => void harness.calls.teardown.push(reason),
    },
    tokenClock: () => NOW_MS,
    sessionClock: () => NOW_MS,
  });
  server.on("request", (req, res) => {
    void gate.handleRequest(req, res).then((handled) => {
      if (!handled) res.writeHead(404).end();
    });
  });
  server.on("upgrade", (req, socket, head) => {
    if (!gate.handleUpgrade(req, socket, head)) socket.destroy();
  });
  return Object.assign(harness, { gate });
}

describe("gate", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await startHarness();
  });

  afterEach(async () => {
    await h.gate.close();
    h.server.closeAllConnections();
    await new Promise((resolve) => h.server.close(resolve));
  });

  async function offers(seconds?: number): Promise<{ status: number; body: PaymentRequired; header: string | null }> {
    const response = await fetch(`${h.url}/sessions${seconds === undefined ? "" : `?seconds=${seconds}`}`, { method: "POST" });
    return { status: response.status, body: (await response.json()) as PaymentRequired, header: response.headers.get("payment-required") };
  }

  /** Pays for the first offer and records the session on the fake chain as the program would. */
  async function open(): Promise<{ session: Address; status: number; body: Record<string, unknown> }> {
    const { body: required } = await offers(30);
    const offer = required.accepts[0]!;
    const built = await buildOpenTransaction({ requirements: offer as never, authority: h.buyer, decimals: 6 });
    h.sessions.set(built.session, {
      authority: h.buyer.address,
      mint: USDC_DEVNET.mint,
      receiver: offer.payTo as Address,
      receiverAuthorizer: h.authorizer.address,
      refundOwner: h.buyer.address,
      rentPayer: offer.extra.rentPayer as Address,
      rate: 1_000n,
      minSeconds: 5,
      maxSeconds: 120,
      startedAt: BigInt(NOW_MS / 1000),
      deposited: 30_000n,
      claimed: 0n,
    } as Session);
    const payload: PaymentPayload = {
      x402Version: 2,
      resource: required.resource,
      accepted: offer,
      payload: { type: "open", transaction: built.transaction, session: built.session },
    };
    const response = await fetch(`${h.url}/sessions?seconds=30`, {
      method: "POST",
      headers: { "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(payload) },
    });
    return { session: built.session, status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  const token = (session: Address, purpose: "connect" | "close", audience = h.url) =>
    createSessionToken(h.buyer, { session, audience, purpose }, { nowMs: NOW_MS });

  function connect(session: Address, bearer?: string, query?: string): Promise<{ status?: number; socket?: WebSocket }> {
    const url = `${h.url.replace("http", "ws")}/sessions/${session}/ws${query ? `?token=${query}` : ""}`;
    const socket = new WebSocket(url, bearer ? { headers: { authorization: `Bearer ${bearer}` } } : {});
    return new Promise((resolve) => {
      socket.once("open", () => resolve({ socket }));
      socket.once("unexpected-response", (_, response) => resolve({ status: response.statusCode }));
    });
  }

  it("answers 402 with one entry per menu duration, in the body and the header", async () => {
    const { status, body, header } = await offers();
    expect(status).toBe(402);
    expect(body.accepts.map((entry) => [entry.extra.seconds, entry.amount])).toEqual([
      [30, "30000"],
      [60, "60000"],
    ]);
    expect(decodePaymentRequiredHeader(header!)).toEqual(body);
  });

  it("answers 400 invalid_duration, with the bounds, outside minSeconds..maxSeconds", async () => {
    const response = await fetch(`${h.url}/sessions?seconds=3`, { method: "POST" });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_duration", minSeconds: 5, maxSeconds: 120 });
  });

  it("opens a session the facilitator settles: 201, and provision once", async () => {
    const { session, status, body } = await open();
    expect(status).toBe(201);
    expect(body).toEqual({
      session,
      paidUntil: NOW_MS / 1000 + 30,
      wsUrl: `${h.url.replace("http", "ws")}/sessions/${session}/ws`,
    });
    expect(h.calls.provision).toHaveLength(1);
    expect(h.calls.verify).toHaveLength(1);
    expect(h.calls.settle).toHaveLength(1);
  });

  it("answers 402 with the facilitator's reason when verification fails, and settles nothing", async () => {
    h.verifyAnswer = { isValid: false, invalidReason: "invalid_amount" };
    const { status, body } = await open();
    expect(status).toBe(402);
    expect(body.error).toBe("invalid_amount");
    expect(h.calls.settle).toHaveLength(0);
  });

  it("accepts a connection with a connect token, in the header or the URL, and attaches it", async () => {
    const { session } = await open();
    const viaHeader = await connect(session, await token(session, "connect"));
    expect(viaHeader.socket).toBeDefined();
    const viaQuery = await connect(session, undefined, await token(session, "connect"));
    expect(viaQuery.socket).toBeDefined();
    expect(h.calls.attach).toHaveLength(2);
    viaHeader.socket!.close();
    viaQuery.socket!.close();
  });

  it("refuses connections before the upgrade: 401 without, with a wrong or a replayed token; 404 unknown", async () => {
    const { session } = await open();
    expect((await connect(session)).status).toBe(401);
    expect((await connect(session, await token(session, "close"))).status).toBe(401);
    expect((await connect(session, await token(session, "connect", "http://elsewhere"))).status).toBe(401);
    const once = await token(session, "connect");
    (await connect(session, once)).socket!.close();
    expect((await connect(session, once)).status).toBe(401);
    expect((await connect(h.buyer.address, await token(h.buyer.address, "connect"))).status).toBe(404);
  });

  it("closes on the buyer's request: settles a close signed by the receiver authorizer, then drops connections with 4410", async () => {
    const { session } = await open();
    const { socket } = await connect(session, await token(session, "connect"));
    const closed = new Promise<number>((resolve) => socket!.once("close", (code) => resolve(code)));

    const response = await fetch(`${h.url}/sessions/${session}/close`, {
      method: "POST",
      headers: { authorization: `Bearer ${await token(session, "close")}` },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ paid: "8000", refunded: "22000", transaction: "sig" });
    expect(await closed).toBe(4410);
    expect(h.calls.teardown).toEqual(["closed"]);

    const closePayload = h.calls.settle.at(-1)!;
    expect(closePayload.accepted.extra).toMatchObject({ action: "close", session });
    expect(closePayload.accepted.amount).toBe("0");
    const tx = inspectTransaction(readElapsedPayload(closePayload)!.transaction)!;
    expect([...tx.signed]).toEqual([h.authorizer.address]);
  });

  it("refuses a close without a close token", async () => {
    const { session } = await open();
    const response = await fetch(`${h.url}/sessions/${session}/close`, {
      method: "POST",
      headers: { authorization: `Bearer ${await token(session, "connect")}` },
    });
    expect(response.status).toBe(401);
  });
});
