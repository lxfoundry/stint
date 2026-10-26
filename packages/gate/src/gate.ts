import { STATUS_CODES, type IncomingMessage, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { address, isAddress, type Address } from "@solana/kit";
import {
  STINT_PROGRAM_ADDRESS,
  StintInstruction,
  identifyStintInstruction,
  paidUntil,
  parseOpenInstruction,
  type ClosedEvent,
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
  readUntilFound,
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
  /** The close in flight, or finished with the session ended: concurrent closes share it. */
  closing?: Promise<CloseOutcome>;
  ended: boolean;
}

interface CloseOutcome {
  readonly status: number;
  readonly body: unknown;
  /** True once the session is over; false when the buyer may retry. */
  readonly ended: boolean;
}

/** A failure of something the gate calls: the facilitator or the chain. Answered 502; any other error is 500. */
class UpstreamError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
  }
}

async function upstream<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw error instanceof UpstreamError ? error : new UpstreamError(error);
  }
}

/** The shape of a route; the id still has to be a real address (32 bytes), which the regex cannot say. */
const SESSION_PATH = /^\/sessions\/([1-9A-HJ-NP-Za-km-z]{32,44})\/(ws|close)$/;
const TOKEN_SKEW_MS = 30_000;

function parseUrl(request: IncomingMessage, origin: string): URL | undefined {
  try {
    return new URL(request.url ?? "/", origin);
  } catch {
    return undefined;
  }
}

/** The gate (spec §7), as middleware: it hands the resource a verified `SessionInfo` (spec §7.6). */
export function createGate<U>(config: GateConfig<U>): Gate {
  const tokenClock = config.tokenClock ?? Date.now;
  const sessionClock = config.sessionClock ?? Date.now;
  const log = config.log ?? (() => {});
  const menu = config.durations ?? [config.terms.minSeconds];
  const marginMs = (config.marginSeconds ?? 2) * 1000;
  const readRetry = config.readRetry ?? { attempts: 5, delayMs: 200 };
  const wss = new WebSocketServer({ noServer: true });
  const sessions = new Map<Address, Tracked<U>>();
  /** Sessions being provisioned, so a retried open waits for the first instead of provisioning again. */
  const provisioning = new Map<Address, Promise<Tracked<U>>>();
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
  const fromFacilitator = (): Promise<FacilitatorExtra> => upstream(loadFacilitatorExtra);

  async function loadFacilitatorExtra(): Promise<FacilitatorExtra> {
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
      lifetime: lifetime ?? (await upstream(() => config.chain.latestBlockhash())),
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

  async function provision(session: Address, stored: Session): Promise<Tracked<U>> {
    const info: SessionInfo = { session, authority: stored.authority, paidUntil: paidUntil(stored) };
    const resource = await config.adapter.provision(info);
    const tracked: Tracked<U> = { info, stored, upstream: resource, connections: new Set(), ended: false };
    sessions.set(session, tracked);
    return tracked;
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

    const verified = await upstream(() => config.facilitator.verify(payload, requirements));
    if (!verified.isValid) return paymentRequired(response, durations, verified.invalidReason ?? "invalid_payload");
    const settled = await upstream(() => config.facilitator.settle(payload, requirements));
    const paymentResponse = { [HEADERS.paymentResponse]: encodePaymentResponseHeader(settled) };
    log({ event: "open", session, success: settled.success, reason: settled.errorReason });
    if (!settled.success) {
      if (settled.errorReason === "settlement_pending") {
        return sendJson(response, 202, { session, transaction: settled.transaction }, paymentResponse);
      }
      return paymentRequired(response, durations, settled.errorReason ?? "simulation_failed");
    }

    // The node may not return the account yet right after the open confirmed.
    const stored = await readUntilFound(() => upstream(() => config.chain.readSession(session)), readRetry);
    if (!stored) return sendJson(response, 404, { error: "unknown_session" });
    let tracked = sessions.get(session);
    if (!tracked) {
      // No `await` between the lookup and the registration: a retried open joins this provisioning.
      let pending = provisioning.get(session);
      if (!pending) {
        pending = provision(session, stored);
        provisioning.set(session, pending);
        const done = () => void provisioning.delete(session);
        pending.then(done, done);
      }
      tracked = await pending;
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

  /** Ends a session once: its `teardown` runs at most one time, whatever ends it. */
  async function end(tracked: Tracked<U>, reason: EndReason, code: number): Promise<void> {
    if (tracked.ended) return;
    tracked.ended = true;
    sessions.delete(tracked.info.session);
    for (const socket of tracked.connections) socket.close(code, "session closed");
    await config.adapter.teardown(tracked.info, reason);
  }

  async function closeSession(request: IncomingMessage, response: ServerResponse, session: Address): Promise<void> {
    const tracked = sessions.get(session);
    if (!tracked) return sendJson(response, 404, { error: "unknown_session" });
    if (!(await authenticate(bearer(request), tracked, "close"))) return sendJson(response, 401, { error: "unauthorized" });
    // Overlapping closes share one settlement and one outcome (the first assignment is synchronous).
    const outcome = await (tracked.closing ??= startClose(tracked));
    sendJson(response, outcome.status, outcome.body);
  }

  function startClose(tracked: Tracked<U>): Promise<CloseOutcome> {
    const run = performClose(tracked);
    // A failed close leaves the session open, and the buyer may try again.
    const reopen = () => void (tracked.closing = undefined);
    run.then((outcome) => outcome.ended || reopen(), reopen);
    return run;
  }

  async function performClose(tracked: Tracked<U>): Promise<CloseOutcome> {
    const session = tracked.info.session;
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
    const settled = await upstream(() => config.facilitator.settle(payload, requirements));
    log({ event: "close", session, success: settled.success, reason: settled.errorReason });
    if (!settled.success) {
      if (settled.errorReason === "settlement_pending") return { status: 202, body: { transaction: settled.transaction }, ended: false };
      const body = { error: settled.errorReason ?? "settlement_failed", message: settled.errorMessage };
      return { status: 502, body, ended: false };
    }
    // The close is confirmed: connections are dropped only now (spec §7.3), and whether or not
    // the Closed event can be read, because the session is over on chain.
    let event: ClosedEvent | undefined;
    try {
      event = await readUntilFound(() => upstream(() => config.chain.closedEvent(settled.transaction)), readRetry);
    } catch (error) {
      log({ event: "error", error: error instanceof Error ? error.message : String(error) });
    } finally {
      await end(tracked, "closed", 4410);
    }
    if (!event) return { status: 502, body: { error: "no_closed_event", transaction: settled.transaction }, ended: true };
    const body = {
      paid: (event.claimed + event.owed + event.redirected).toString(),
      refunded: event.refunded.toString(),
      transaction: settled.transaction,
    };
    return { status: 200, body, ended: true };
  }

  function refuseUpgrade(socket: Duplex, status: number): void {
    socket.end(`HTTP/1.1 ${status} ${STATUS_CODES[status]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  }

  async function connect(request: IncomingMessage, socket: Duplex, head: Buffer, url: URL, session: Address): Promise<void> {
    const tracked = sessions.get(session);
    if (!tracked) return refuseUpgrade(socket, 404);
    const token = bearer(request) ?? url.searchParams.get("token") ?? undefined;
    if (!(await authenticate(token, tracked, "connect"))) return refuseUpgrade(socket, 401);
    // The session may have ended while the token was checked.
    if (tracked.ended) return refuseUpgrade(socket, 404);
    if (!sessionMatches(tracked.stored, seller)) return refuseUpgrade(socket, 403);
    if (Number(tracked.info.paidUntil) * 1000 - sessionClock() <= marginMs) return refuseUpgrade(socket, 402);
    wss.handleUpgrade(request, socket, head, (ws) => {
      tracked.connections.add(ws);
      ws.once("close", () => tracked.connections.delete(ws));
      config.adapter.attach(tracked.info, ws, tracked.upstream);
    });
  }

  return {
    /** Never rejects: a failure is logged and answered, 502 for the facilitator or the chain, 500 otherwise. */
    async handleRequest(request, response) {
      const url = parseUrl(request, config.origin);
      if (!url) return false;
      try {
        if (request.method === "POST" && url.pathname === "/sessions") {
          await open(request, response, url);
          return true;
        }
        const match = SESSION_PATH.exec(url.pathname);
        if (request.method === "POST" && match?.[2] === "close") {
          const id = match[1]!;
          if (!isAddress(id)) sendJson(response, 404, { error: "unknown_session" });
          else await closeSession(request, response, id);
          return true;
        }
        return false;
      } catch (error) {
        log({ event: "error", error: error instanceof Error ? error.message : String(error) });
        if (response.headersSent) response.end();
        else if (error instanceof UpstreamError) sendJson(response, 502, { error: "upstream_error", message: error.message });
        else sendJson(response, 500, { error: "internal" });
        return true;
      }
    },
    handleUpgrade(request, socket, head) {
      const url = parseUrl(request, config.origin);
      const match = url && SESSION_PATH.exec(url.pathname);
      if (!url || match?.[2] !== "ws") return false;
      // Node removes its own `error` listener from an upgrade socket, so a reset while the token
      // is checked would otherwise be an unhandled `error` event.
      socket.on("error", (error) => {
        log({ event: "socket_error", error: error.message });
        socket.destroy();
      });
      const id = match[1]!;
      if (!isAddress(id)) {
        refuseUpgrade(socket, 404);
        return true;
      }
      connect(request, socket, head, url, id).catch((error: unknown) => {
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
