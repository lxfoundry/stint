import { createServer, type Server } from "node:http";
import { connect as netConnect, type AddressInfo, type Socket } from "node:net";
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
  /** Faults and pauses a test switches on. */
  fail: { supported: boolean; settleClose: boolean; closedEvent: boolean; provision: boolean };
  hold: { provision?: Promise<void>; settleClose?: Promise<void> };
  /** How many reads the fake chain answers with nothing before the real answer, and the reads made. */
  missing: { session: number; closedEvent: number };
  reads: { session: number; closedEvent: number };
  /** Rejections that escaped `handleRequest`: the gate must contain its own errors. */
  escaped: unknown[];
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
    fail: { supported: false, settleClose: false, closedEvent: false, provision: false },
    hold: {},
    missing: { session: 0, closedEvent: 0 },
    reads: { session: 0, closedEvent: 0 },
    escaped: [],
  } as unknown as Harness;

  const chain: GateChain = {
    latestBlockhash: async () => ({ blockhash: "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N", lastValidBlockHeight: 100n }),
    readSession: async (session) => (harness.reads.session++ < harness.missing.session ? undefined : harness.sessions.get(session)),
    closedEvent: async () => {
      if (harness.fail.closedEvent) throw new Error("rpc down");
      if (harness.reads.closedEvent++ < harness.missing.closedEvent) return undefined;
      return { claimed: 0n, owed: 8_000n, refunded: 22_000n, redirected: 0n, kind: CloseKind.Standard } as ClosedEvent;
    },
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
      supported: async () => {
        if (harness.fail.supported) throw new Error("facilitator down");
        return {
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
        };
      },
      verify: async (payload) => (harness.calls.verify.push(payload), harness.verifyAnswer),
      settle: async (payload) => {
        harness.calls.settle.push(payload);
        if (readElapsedPayload(payload)?.type === "close") {
          await harness.hold.settleClose;
          if (harness.fail.settleClose) throw new Error("facilitator down");
        }
        return harness.settleAnswer(payload);
      },
    },
    chain,
    adapter: {
      provision: async (info) => {
        harness.calls.provision.push(info);
        await harness.hold.provision;
        if (harness.fail.provision) throw new Error("adapter broke");
      },
      attach: (info, socket) => {
        harness.calls.attach.push(info);
        socket.send(JSON.stringify({ type: "hello" }));
      },
      teardown: async (_, reason) => void harness.calls.teardown.push(reason),
    },
    tokenClock: () => NOW_MS,
    sessionClock: () => NOW_MS,
    readRetry: { attempts: 3, delayMs: 5 },
  });
  server.on("request", (req, res) => {
    gate.handleRequest(req, res).then(
      (handled) => {
        if (!handled) res.writeHead(404).end();
      },
      (error: unknown) => {
        harness.escaped.push(error);
        res.writeHead(500).end();
      },
    );
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
    expect(h.escaped).toEqual([]);
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
    const { session, payload } = await prepareOpen();
    return { session, ...(await send(payload)) };
  }

  async function send(payload: PaymentPayload): Promise<{ status: number; body: Record<string, unknown> }> {
    const response = await fetch(`${h.url}/sessions?seconds=30`, {
      method: "POST",
      headers: { "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(payload) },
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  async function prepareOpen(): Promise<{ session: Address; payload: PaymentPayload }> {
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
    return { session: built.session, payload };
  }

  const closeWith = async (session: Address) =>
    fetch(`${h.url}/sessions/${session}/close`, {
      method: "POST",
      headers: { authorization: `Bearer ${await token(session, "close")}` },
    });

  /** Lets requests already in flight reach the gate's guards. */
  const settleDown = () => new Promise((resolve) => setTimeout(resolve, 100));

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

  describe("hostile and failing inputs", () => {
    // Base58, 44 characters, but not 32 bytes: it matches the route shape and is no address.
    const malformed = "z".repeat(44) as Address;

    it("answers 404 for a malformed session id on both routes, and keeps serving", async () => {
      const close = await fetch(`${h.url}/sessions/${malformed}/close`, { method: "POST" });
      expect(close.status).toBe(404);
      expect(await close.json()).toEqual({ error: "unknown_session" });
      expect((await connect(malformed, await token(h.buyer.address, "connect"))).status).toBe(404);
      expect((await offers()).status).toBe(402);
    });

    it("answers 502 upstream_error when the facilitator is down, and recovers", async () => {
      h.fail.supported = true;
      const down = await fetch(`${h.url}/sessions`, { method: "POST" });
      expect(down.status).toBe(502);
      expect(await down.json()).toMatchObject({ error: "upstream_error", message: "facilitator down" });
      h.fail.supported = false;
      expect((await offers()).status).toBe(402);
    });

    it("answers 500 internal when the resource's own code throws", async () => {
      h.fail.provision = true;
      const { status, body } = await open();
      expect(status).toBe(500);
      expect(body).toEqual({ error: "internal" });
    });

    it("answers 502 when the close cannot be settled, keeps the session, and lets the buyer retry", async () => {
      const { session } = await open();
      h.fail.settleClose = true;
      const failed = await closeWith(session);
      expect(failed.status).toBe(502);
      expect(await failed.json()).toMatchObject({ error: "upstream_error" });
      expect(h.calls.teardown).toEqual([]);

      h.fail.settleClose = false;
      expect((await closeWith(session)).status).toBe(200);
      expect(h.calls.teardown).toEqual(["closed"]);
    });

    it("ends the session even when the Closed event cannot be read", async () => {
      const { session } = await open();
      const { socket } = await connect(session, await token(session, "connect"));
      const closed = new Promise<number>((resolve) => socket!.once("close", (code) => resolve(code)));
      h.fail.closedEvent = true;
      const response = await closeWith(session);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ transaction: "sig" });
      expect(await closed).toBe(4410);
      expect(h.calls.teardown).toEqual(["closed"]);
      expect((await connect(session, await token(session, "connect"))).status).toBe(404);
    });

    it("re-reads the session after a settled open while the node does not return it yet", async () => {
      h.missing.session = 2;
      const { status } = await open();
      expect(status).toBe(201);
      expect(h.reads.session).toBe(3);
      expect(h.calls.provision).toHaveLength(1);
    });

    it("answers 404 when the session is still not there after the re-reads, and provisions nothing", async () => {
      h.missing.session = Number.POSITIVE_INFINITY;
      const { status, body } = await open();
      expect(status).toBe(404);
      expect(body).toEqual({ error: "unknown_session" });
      expect(h.reads.session).toBe(3);
      expect(h.calls.provision).toHaveLength(0);
    });

    it("answers 202 with the session and the transaction when the open's settlement is pending", async () => {
      h.settleAnswer = () => ({ success: false, errorReason: "settlement_pending", transaction: "sig", network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" });
      const { session, status, body } = await open();
      expect(status).toBe(202);
      expect(body).toEqual({ session, transaction: "sig" });
      expect(h.calls.provision).toHaveLength(0);
    });

    it("re-reads the Closed event after a confirmed close while the node does not return it yet", async () => {
      const { session } = await open();
      h.missing.closedEvent = 2;
      const response = await closeWith(session);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ paid: "8000", refunded: "22000", transaction: "sig" });
      expect(h.reads.closedEvent).toBe(3);
    });

    it("ends the session when the Closed event is still missing after the re-reads", async () => {
      const { session } = await open();
      h.missing.closedEvent = Number.POSITIVE_INFINITY;
      const response = await closeWith(session);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ transaction: "sig" });
      expect(h.calls.teardown).toEqual(["closed"]);
    });

    it("provisions once when an open is retried while provisioning", async () => {
      const { session, payload } = await prepareOpen();
      let release!: () => void;
      h.hold.provision = new Promise<void>((resolve) => (release = resolve));
      const first = send(payload);
      await settleDown();
      const retry = send(payload);
      await settleDown();
      release();
      const [a, b] = await Promise.all([first, retry]);
      expect([a.status, b.status]).toEqual([201, 201]);
      expect(a.body).toEqual(b.body);
      expect(a.body.session).toBe(session);
      expect(h.calls.provision).toHaveLength(1);
    });

    it("tears down once when closes overlap, and answers both with the one outcome", async () => {
      const { session } = await open();
      let release!: () => void;
      h.hold.settleClose = new Promise<void>((resolve) => (release = resolve));
      const first = closeWith(session);
      await settleDown();
      const second = closeWith(session);
      await settleDown();
      release();
      const [a, b] = await Promise.all([first, second]);
      expect([a.status, b.status]).toEqual([200, 200]);
      expect(await a.json()).toEqual(await b.json());
      expect(h.calls.teardown).toEqual(["closed"]);
      expect(h.calls.settle.filter((p) => readElapsedPayload(p)?.type === "close")).toHaveLength(1);
    });

    it("survives a client that resets the connection while its token is checked", async () => {
      const { session } = await open();
      const bearer = await token(session, "connect");
      const { port } = h.server.address() as AddressInfo;
      for (let i = 0; i < 5; i++) {
        const raw = connectRaw(port, session, bearer);
        await new Promise((resolve) => raw.once("connect", resolve));
        await new Promise((resolve) => setTimeout(resolve, 2));
        raw.resetAndDestroy();
      }
      await settleDown();
      expect((await offers()).status).toBe(402);
    });
  });
});

function connectRaw(port: number, session: string, bearer: string): Socket {
  const socket = netConnect(port, "127.0.0.1");
  socket.on("error", () => {});
  socket.write(
    [
      `GET /sessions/${session}/ws HTTP/1.1`,
      `Host: 127.0.0.1:${port}`,
      "Connection: Upgrade",
      "Upgrade: websocket",
      "Sec-WebSocket-Version: 13",
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
      `Authorization: Bearer ${bearer}`,
      "",
      "",
    ].join("\r\n"),
  );
  return socket;
}
