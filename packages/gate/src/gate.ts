import { STATUS_CODES, type IncomingMessage, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { address, type Address } from "@solana/kit";
import {
  STINT_PROGRAM_ADDRESS,
  StintInstruction,
  identifyStintInstruction,
  paidUntil,
  parseOpenInstruction,
  type Session,
} from "@lxfoundry/stint-program-client";
import {
  HEADERS,
  SCHEME,
  X402_VERSION,
  buildCloseRequirements,
  buildCloseTransaction,
  buildOpenOffer,
  checkOpenDuration,
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
  inspectTransaction,
  readElapsedPayload,
  readElapsedRequirements,
  sendJson,
  sessionMatches,
  verifySessionToken,
  type FacilitatorExtra,
  type OfferInput,
  type PaymentPayload,
  type PaymentRequired,
  type SellerTerms,
  type TokenPurpose,
} from "@lxfoundry/stint-x402";
import { WebSocketServer, type WebSocket } from "ws";
import type { EndReason, GateConfig, SessionInfo } from "./types.js";

export interface Gate {
  /** Serves the gate's HTTP routes; resolves false for any other request, which the host serves. */
  handleRequest(request: IncomingMessage, response: ServerResponse): Promise<boolean>;
  /** Serves `GET /sessions/:id/ws`; returns false for any other upgrade. */
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): boolean;
  /** Drops every connection. */
  close(): Promise<void>;
}

interface Tracked<U> {
  readonly info: SessionInfo;
  readonly stored: Session;
  readonly upstream: U;
  readonly connections: Set<WebSocket>;
}

const SESSION_PATH = /^\/sessions\/([1-9A-HJ-NP-Za-km-z]{32,44})\/(ws|close)$/;
const TOKEN_SKEW_MS = 30_000;

/** The gate (spec §7), as middleware: it hands the resource a verified `SessionInfo` (spec §7.6). */
export function createGate<U>(config: GateConfig<U>): Gate {
  const tokenClock = config.tokenClock ?? Date.now;
  const sessionClock = config.sessionClock ?? Date.now;
  const log = config.log ?? (() => {});
  const menu = config.durations ?? [config.terms.minSeconds];
  const marginMs = (config.marginSeconds ?? 2) * 1000;
  const wss = new WebSocketServer({ noServer: true });
  const sessions = new Map<Address, Tracked<U>>();
  /** `jti` → when it may be forgotten (ms on the token clock). */
  const seenTokens = new Map<string, number>();
  let facilitatorExtra: FacilitatorExtra | undefined;

  const seller: SellerTerms = {
    programId: STINT_PROGRAM_ADDRESS,
    asset: config.asset.mint,
    payTo: config.payTo,
    receiverAuthorizer: config.receiverAuthorizer.address,
    terms: config.terms,
  };
  const wsUrl = (session: Address) => `${config.origin.replace(/^http/, "ws")}/sessions/${session}/ws`;

  /** `feePayer`, `rentPayer`, `programId` and `closeUrl` are copied from `/supported` (spec §5.1). */
  async function fromFacilitator(): Promise<FacilitatorExtra> {
    if (facilitatorExtra) return facilitatorExtra;
    const supported = await config.facilitator.supported();
    const kind = supported.kinds.find(
      (entry) => entry.x402Version === X402_VERSION && entry.scheme === SCHEME && entry.network === config.network,
    );
    const extra = (kind?.extra ?? {}) as Partial<Record<keyof FacilitatorExtra, unknown>>;
    const { feePayer, rentPayer, programId, closeUrl } = extra;
    if (typeof feePayer !== "string" || typeof rentPayer !== "string" || typeof closeUrl !== "string" || typeof programId !== "string" || programId !== STINT_PROGRAM_ADDRESS) {
      throw new Error(`The facilitator does not support ${SCHEME} for this program on ${config.network}`);
    }
    facilitatorExtra = { feePayer, rentPayer, programId, closeUrl };
    return facilitatorExtra;
  }

  async function offerBase(lifetime?: OfferInput["lifetime"]): Promise<Omit<OfferInput, "seconds">> {
    return {
      network: config.network,
      asset: config.asset.mint,
      payTo: config.payTo,
      receiverAuthorizer: config.receiverAuthorizer.address,
      terms: config.terms,
      facilitator: await fromFacilitator(),
      lifetime: lifetime ?? (await config.chain.latestBlockhash()),
      maxTimeoutSeconds: config.maxTimeoutSeconds ?? 60,
      idleCloseSeconds: config.idleCloseSeconds ?? 60,
      closeOnOutage: config.closeOnOutage ?? true,
    };
  }

  async function paymentRequired(response: ServerResponse, durations: readonly number[], error?: string): Promise<void> {
    const base = await offerBase();
    const body: PaymentRequired = {
      x402Version: X402_VERSION,
      ...(error === undefined ? {} : { error }),
      resource: { url: `${config.origin}/sessions` },
      accepts: durations.map((seconds) => buildOpenOffer({ ...base, seconds })),
    };
    sendJson(response, 402, body, { [HEADERS.paymentRequired]: encodePaymentRequiredHeader(body) });
  }

  /** The session the payload's `stint.open` creates, read from the transaction itself. */
  function sessionOpenedBy(payload: PaymentPayload): Address | undefined {
    const elapsed = readElapsedPayload(payload);
    const tx = elapsed?.type === "open" ? inspectTransaction(elapsed.transaction) : undefined;
    for (const ix of tx?.instructions ?? []) {
      if (ix.programAddress !== STINT_PROGRAM_ADDRESS || !ix.accounts || !ix.data) continue;
      try {
        if (identifyStintInstruction(ix.data) !== StintInstruction.Open) continue;
        return parseOpenInstruction(ix as Parameters<typeof parseOpenInstruction>[0]).accounts.session.address;
      } catch {
        return undefined;
      }
    }
    return undefined;
  }

  async function open(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    const requested = url.searchParams.get("seconds");
    const durations = requested === null ? menu : [Number(requested)];
    for (const seconds of durations) {
      const check = checkOpenDuration(config.terms, seconds);
      if (!check.ok) return sendJson(response, 400, { error: "invalid_duration", minSeconds: check.minSeconds, maxSeconds: check.maxSeconds });
    }

    const header = request.headers[HEADERS.paymentSignature.toLowerCase()];
    if (typeof header !== "string") return paymentRequired(response, durations);
    let payload: PaymentPayload;
    try {
      payload = decodePaymentSignatureHeader(header);
    } catch {
      return paymentRequired(response, durations, "invalid_payload");
    }
    const accepted = readElapsedRequirements(payload.accepted);
    if (!accepted || accepted.extra.action !== "open" || !durations.includes(accepted.extra.seconds)) {
      return paymentRequired(response, durations, "invalid_payment_requirements");
    }
    const session = sessionOpenedBy(payload);
    if (!session) return paymentRequired(response, durations, "invalid_payload");

    // The requirements as this gate issues them: its own terms, with the advisory fields of the
    // entry the client accepted, which only a fresh offer changes (spec §5.5, "Idempotency").
    const requirements = buildOpenOffer({
      ...(await offerBase({
        blockhash: accepted.extra.recentBlockhash,
        lastValidBlockHeight: BigInt(accepted.extra.lastValidBlockHeight),
      })),
      maxTimeoutSeconds: accepted.maxTimeoutSeconds,
      seconds: accepted.extra.seconds,
    });

    const verified = await config.facilitator.verify(payload, requirements);
    if (!verified.isValid) return paymentRequired(response, durations, verified.invalidReason ?? "invalid_payload");
    const settled = await config.facilitator.settle(payload, requirements);
    const paymentResponse = { [HEADERS.paymentResponse]: encodePaymentResponseHeader(settled) };
    log({ event: "open", session, success: settled.success, reason: settled.errorReason });
    if (!settled.success) {
      if (settled.errorReason === "settlement_pending") {
        return sendJson(response, 202, { session, transaction: settled.transaction }, paymentResponse);
      }
      return paymentRequired(response, durations, settled.errorReason ?? "simulation_failed");
    }

    const stored = await config.chain.readSession(session);
    if (!stored) return sendJson(response, 404, { error: "unknown_session" });
    let tracked = sessions.get(session);
    if (!tracked) {
      const info: SessionInfo = { session, authority: stored.authority, paidUntil: paidUntil(stored) };
      tracked = { info, stored, upstream: await config.adapter.provision(info), connections: new Set() };
      sessions.set(session, tracked);
    }
    sendJson(response, 201, { session, paidUntil: Number(tracked.info.paidUntil), wsUrl: wsUrl(session) }, paymentResponse);
  }

  /** Checks 1 to 3 of spec §7.2. Check 4 holds for every tracked session: it opened with this gate's terms. */
  async function authenticate(token: string | undefined, tracked: Tracked<U>, purpose: TokenPurpose): Promise<boolean> {
    if (!token) return false;
    const now = tokenClock();
    const check = await verifySessionToken(token, {
      authority: tracked.stored.authority,
      session: tracked.info.session,
      audience: config.origin,
      purpose,
      nowMs: now,
    });
    if (!check.ok) return false;
    for (const [jti, forgetAt] of seenTokens) if (forgetAt < now) seenTokens.delete(jti);
    if (seenTokens.has(check.claims.jti)) return false;
    seenTokens.set(check.claims.jti, check.claims.exp * 1000 + TOKEN_SKEW_MS);
    return true;
  }

  const bearer = (request: IncomingMessage) => {
    const value = request.headers.authorization;
    return value?.startsWith("Bearer ") ? value.slice("Bearer ".length) : undefined;
  };

  async function end(tracked: Tracked<U>, reason: EndReason, code: number): Promise<void> {
    sessions.delete(tracked.info.session);
    for (const socket of tracked.connections) socket.close(code, "session closed");
    await config.adapter.teardown(tracked.info, reason);
  }

  async function closeSession(request: IncomingMessage, response: ServerResponse, session: Address): Promise<void> {
    const tracked = sessions.get(session);
    if (!tracked) return sendJson(response, 404, { error: "unknown_session" });
    if (!(await authenticate(bearer(request), tracked, "close"))) return sendJson(response, 401, { error: "unauthorized" });

    const base = await offerBase();
    const transaction = await buildCloseTransaction({
      session,
      stored: tracked.stored,
      closer: config.receiverAuthorizer,
      feePayer: address(base.facilitator.feePayer),
      lifetime: base.lifetime,
    });
    const requirements = buildCloseRequirements({ ...base, session });
    const payload: PaymentPayload = {
      x402Version: X402_VERSION,
      resource: { url: `${config.origin}/sessions/${session}/close` },
      accepted: requirements,
      payload: { type: "close", transaction },
    };
    const settled = await config.facilitator.settle(payload, requirements);
    log({ event: "close", session, success: settled.success, reason: settled.errorReason });
    if (!settled.success) {
      if (settled.errorReason === "settlement_pending") return sendJson(response, 202, { transaction: settled.transaction });
      return sendJson(response, 502, { error: settled.errorReason ?? "settlement_failed", message: settled.errorMessage });
    }
    const event = await config.chain.closedEvent(settled.transaction);
    // The close is confirmed: connections are dropped only now (spec §7.3).
    await end(tracked, "closed", 4410);
    if (!event) return sendJson(response, 502, { error: "no_closed_event", transaction: settled.transaction });
    sendJson(response, 200, {
      paid: (event.claimed + event.owed + event.redirected).toString(),
      refunded: event.refunded.toString(),
      transaction: settled.transaction,
    });
  }

  function refuseUpgrade(socket: Duplex, status: number): void {
    socket.end(`HTTP/1.1 ${status} ${STATUS_CODES[status]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  }

  async function connect(request: IncomingMessage, socket: Duplex, head: Buffer, url: URL, session: Address): Promise<void> {
    const tracked = sessions.get(session);
    if (!tracked) return refuseUpgrade(socket, 404);
    const token = bearer(request) ?? url.searchParams.get("token") ?? undefined;
    if (!(await authenticate(token, tracked, "connect"))) return refuseUpgrade(socket, 401);
    if (!sessionMatches(tracked.stored, seller)) return refuseUpgrade(socket, 403);
    if (Number(tracked.info.paidUntil) * 1000 - sessionClock() <= marginMs) return refuseUpgrade(socket, 402);
    wss.handleUpgrade(request, socket, head, (ws) => {
      tracked.connections.add(ws);
      ws.once("close", () => tracked.connections.delete(ws));
      config.adapter.attach(tracked.info, ws, tracked.upstream);
    });
  }

  return {
    async handleRequest(request, response) {
      const url = new URL(request.url ?? "/", config.origin);
      if (request.method === "POST" && url.pathname === "/sessions") {
        await open(request, response, url);
        return true;
      }
      const match = SESSION_PATH.exec(url.pathname);
      if (request.method === "POST" && match?.[2] === "close") {
        await closeSession(request, response, address(match[1]!));
        return true;
      }
      return false;
    },
    handleUpgrade(request, socket, head) {
      const url = new URL(request.url ?? "/", config.origin);
      const match = SESSION_PATH.exec(url.pathname);
      if (match?.[2] !== "ws") return false;
      connect(request, socket, head, url, address(match[1]!)).catch((error: unknown) => {
        log({ event: "error", error: error instanceof Error ? error.message : String(error) });
        refuseUpgrade(socket, 500);
      });
      return true;
    },
    async close() {
      for (const tracked of sessions.values()) for (const socket of tracked.connections) socket.close(1001, "gate stopping");
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}
