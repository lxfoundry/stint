import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { generateKeyPairSigner, type Address, type KeyPairSigner } from "@solana/kit";
import { CloseKind, type ClosedEvent, type Session } from "@lxfoundry/stint-program-client";
import {
  USDC_DEVNET,
  buildOpenTransaction,
  createSessionToken,
  encodePaymentSignatureHeader,
  readElapsedPayload,
  type PaymentPayload,
  type PaymentRequired,
  type SettleResponse,
  type VerifyResponse,
} from "@lxfoundry/stint-x402";
import { WebSocket } from "ws";
import { createGate, type EndReason, type Gate, type GateChain, type GateConfig, type SessionInfo, type Timers } from "../src/index.js";

export const NOW_MS = 1_800_000_000_000;

/** The gate's session clock, in milliseconds. Tests move it. */
export interface FakeClock {
  now: number;
}

export interface FakeTimer {
  readonly callback: () => void;
  readonly delayMs: number;
  /** On the session clock: when the timer was set, plus its delay. */
  readonly dueMs: number;
  cleared: boolean;
  fired: boolean;
}

/** Timers that run only when a test fires them. */
export class FakeTimers implements Timers {
  readonly all: FakeTimer[] = [];
  readonly clock: FakeClock;

  constructor(clock: FakeClock) {
    this.clock = clock;
  }

  set(callback: () => void, delayMs: number): FakeTimer {
    const timer: FakeTimer = { callback, delayMs, dueMs: this.clock.now + delayMs, cleared: false, fired: false };
    this.all.push(timer);
    return timer;
  }

  clear(handle: unknown): void {
    (handle as FakeTimer).cleared = true;
  }

  /** The timers that have neither been cleared nor fired. */
  get pending(): FakeTimer[] {
    return this.all.filter((timer) => !timer.cleared && !timer.fired);
  }

  /** Runs a pending timer as a real one would run: by then the clock has reached the time it was due, unless `advance` is false. */
  fire(timer: FakeTimer, options: { advance?: boolean } = {}): void {
    if (timer.cleared || timer.fired) throw new Error("The timer is not pending");
    timer.fired = true;
    if (options.advance !== false) this.clock.now = Math.max(this.clock.now, timer.dueMs);
    timer.callback();
  }
}

export interface Harness {
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
  fail: { supported: boolean; settleClose: boolean; closedEvent: boolean; provision: boolean; teardown: boolean };
  hold: { provision?: Promise<void>; settleClose?: Promise<void>; readSession?: Promise<void> };
  /** Runs inside the fake facilitator's close, after `hold` and before `fail`: a test changes the chain here. */
  onSettleClose?: () => void;
  /** How many reads the fake chain answers with nothing before the real answer, and the reads made. */
  missing: { session: number; closedEvent: number };
  reads: { session: number; closedEvent: number };
  /** Rejections that escaped `handleRequest`: the gate must contain its own errors. */
  escaped: unknown[];
  /** The gate's session clock and its timers: the timers run only when a test fires them. */
  readonly clock: FakeClock;
  readonly timers: FakeTimers;
  /** The gate's side of each accepted connection, in order, as the adapter received it. */
  readonly attached: WebSocket[];
  /** What the gate logged. */
  readonly logs: Record<string, unknown>[];
}

export async function startHarness(timings: Pick<GateConfig, "idleCloseSeconds" | "endRetrySeconds"> = {}): Promise<Harness> {
  const buyer = await generateKeyPairSigner();
  const authorizer = await generateKeyPairSigner();
  const seller = await generateKeyPairSigner();
  const feePayer = (await generateKeyPairSigner()).address;
  const rentPayer = (await generateKeyPairSigner()).address;
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const clock: FakeClock = { now: NOW_MS };

  const harness = {
    url,
    server,
    buyer,
    authorizer,
    calls: { verify: [], settle: [], provision: [], attach: [], teardown: [] },
    verifyAnswer: { isValid: true },
    settleAnswer: () => ({ success: true, transaction: "sig", network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" }),
    sessions: new Map<Address, Session>(),
    fail: { supported: false, settleClose: false, closedEvent: false, provision: false, teardown: false },
    hold: {},
    missing: { session: 0, closedEvent: 0 },
    reads: { session: 0, closedEvent: 0 },
    escaped: [],
    clock,
    timers: new FakeTimers(clock),
    attached: [],
    logs: [],
  } as unknown as Harness;

  const chain: GateChain = {
    latestBlockhash: async () => ({ blockhash: "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N", lastValidBlockHeight: 100n }),
    // A held read is counted when it starts and answers with the chain as it is when it is released.
    readSession: async (session) => {
      const missing = harness.reads.session++ < harness.missing.session;
      await harness.hold.readSession;
      return missing ? undefined : harness.sessions.get(session);
    },
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
    endRetrySeconds: 3,
    ...timings,
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
          harness.onSettleClose?.();
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
        harness.attached.push(socket);
        socket.send(JSON.stringify({ type: "hello" }));
      },
      teardown: async (_, reason) => {
        harness.calls.teardown.push(reason);
        if (harness.fail.teardown) throw new Error("teardown broke");
      },
    },
    tokenClock: () => NOW_MS,
    sessionClock: () => clock.now,
    timers: harness.timers,
    readRetry: { attempts: 3, delayMs: 5 },
    log: (entry) => void harness.logs.push(entry),
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

/** The requests and connections the tests make, against whichever harness `get` returns. */
export function helpers(get: () => Harness) {
  async function offers(seconds?: number): Promise<{ status: number; body: PaymentRequired; header: string | null }> {
    const response = await fetch(`${get().url}/sessions${seconds === undefined ? "" : `?seconds=${seconds}`}`, { method: "POST" });
    return { status: response.status, body: (await response.json()) as PaymentRequired, header: response.headers.get("payment-required") };
  }

  /** Pays for the first offer and records the session on the fake chain as the program would. */
  async function open(): Promise<{ session: Address; status: number; body: Record<string, unknown> }> {
    const { session, payload } = await prepareOpen();
    return { session, ...(await send(payload)) };
  }

  async function send(payload: PaymentPayload): Promise<{ status: number; body: Record<string, unknown> }> {
    const response = await fetch(`${get().url}/sessions?seconds=30`, {
      method: "POST",
      headers: { "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(payload) },
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  async function prepareOpen(): Promise<{ session: Address; payload: PaymentPayload }> {
    const h = get();
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
    fetch(`${get().url}/sessions/${session}/close`, {
      method: "POST",
      headers: { authorization: `Bearer ${await token(session, "close")}` },
    });

  /** Lets requests already in flight reach the gate's guards. */
  const settleDown = () => new Promise((resolve) => setTimeout(resolve, 100));

  const token = (session: Address, purpose: "connect" | "close", audience = get().url) =>
    createSessionToken(get().buyer, { session, audience, purpose }, { nowMs: NOW_MS });

  function connect(session: Address, bearer?: string, query?: string): Promise<{ status?: number; socket?: WebSocket }> {
    const url = `${get().url.replace("http", "ws")}/sessions/${session}/ws${query ? `?token=${query}` : ""}`;
    const socket = new WebSocket(url, bearer ? { headers: { authorization: `Bearer ${bearer}` } } : {});
    return new Promise((resolve) => {
      socket.once("open", () => resolve({ socket }));
      socket.once("unexpected-response", (_, response) => resolve({ status: response.statusCode }));
    });
  }

  return { offers, open, send, prepareOpen, closeWith, settleDown, token, connect };
}
