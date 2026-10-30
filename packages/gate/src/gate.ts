import { STATUS_CODES, type IncomingMessage, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { address, isAddress, type Address } from "@solana/kit";
import {
  CloseKind,
  STINT_PROGRAM_ADDRESS,
  StintInstruction,
  dueAt,
  earnedAt,
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
  type SessionStatus,
  type TokenPurpose,
} from "@lxfoundry/stint-x402";
import { WebSocketServer, type WebSocket } from "ws";
import { CLOSE_CODES, type EndReason, type GateConfig, type SessionInfo, type Timers } from "./types.js";

export interface Gate {
  /** Serves the gate's HTTP routes; resolves false for any other request, which the host serves. */
  handleRequest(request: IncomingMessage, response: ServerResponse): Promise<boolean>;
  /** Serves `GET /sessions/:id/ws`; returns false for any other upgrade. */
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): boolean;
  /** Stops the gate's timers and drops every connection. It does not end the sessions: nothing is closed on chain. */
  close(): Promise<void>;
}

/** The two timers of a session: no connection within the grace period, and the end of the paid time. */
type TimerSlot = "idle" | "end";

interface Tracked<U> {
  readonly info: SessionInfo;
  readonly stored: Session;
  readonly upstream: U;
  readonly connections: Set<WebSocket>;
  /** The close in flight, or finished with the session ended: every close of the session shares it. */
  closing?: Promise<CloseOutcome>;
  ended: boolean;
  /** Unix seconds. Starts as `info.paidUntil`; a re-read at the end of the paid time can move it later. */
  paidUntil: bigint;
  /** Cancels each pending timer. */
  readonly pending: Partial<Record<TimerSlot, () => void>>;
  /** While forwarding is stopped: each socket's own `send`, which `resume` puts back. */
  muted?: Map<WebSocket, WebSocket["send"]>;
}

interface CloseOutcome {
  readonly status: number;
  readonly body: unknown;
  /** True once the session is over; false when the buyer, or a timer, may retry. */
  readonly ended: boolean;
}

/** What a close is for: its kind on chain, why the session ends once it is confirmed, and the code its connections get. */
interface ClosePlan {
  readonly kind: CloseKind;
  readonly reason: EndReason;
  readonly code: number;
}

/** The buyer's request. */
const BUYER_CLOSE: ClosePlan = { kind: CloseKind.Standard, reason: "closed", code: CLOSE_CODES.SESSION_CLOSED };
/** No connection came back within `idleCloseSeconds`. */
const IDLE_CLOSE: ClosePlan = { kind: CloseKind.Standard, reason: "idle", code: CLOSE_CODES.SESSION_CLOSED };
/** The paid time ran out. */
const END_CLOSE: ClosePlan = { kind: CloseKind.AtExpiry, reason: "expired", code: CLOSE_CODES.PAID_TIME_ENDED };

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
/** `GET /sessions/:id` (the status); `SESSION_PATH` holds the routes that end in `/ws` or `/close`. */
const STATUS_PATH = /^\/sessions\/([1-9A-HJ-NP-Za-km-z]{32,44})$/;
const TOKEN_SKEW_MS = 30_000;
/** The longest delay `setTimeout` takes: a longer one fires at once. */
const MAX_TIMER_MS = 2_147_483_647;

const systemTimers: Timers = {
  // Unreferenced, so a session that is still waiting does not keep a stopped host alive.
  set: (callback, delayMs) => setTimeout(callback, delayMs).unref(),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Stands in for a muted socket's `send`: the frame is dropped, and a send callback still runs, so an adapter waiting on it is not stuck. */
function discard(...args: unknown[]): void {
  const done = args.at(-1);
  if (typeof done === "function") done();
}

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
  const logError = (error: unknown) => log({ event: "error", error: error instanceof Error ? error.message : String(error) });
  const menu = config.durations ?? [config.terms.minSeconds];
  const marginMs = (config.marginSeconds ?? 2) * 1000;
  const readRetry = config.readRetry ?? { attempts: 5, delayMs: 200 };
  const timers = config.timers ?? systemTimers;
  const idleCloseSeconds = Math.max(0, Number.isFinite(config.idleCloseSeconds) ? (config.idleCloseSeconds as number) : 60);
  // At least a second, and the default for a value that is not a number: each retry is a round trip to the
  // facilitator, so a wait of 0 (or NaN, which `Math.max` passes through) would loop hot.
  const endRetrySeconds = config.endRetrySeconds ?? 2;
  const endRetryMs = (Number.isFinite(endRetrySeconds) ? Math.max(1, endRetrySeconds) : 2) * 1000;
  /** Set when the gate stops: from then on no timer is armed. */
  let stopped = false;
  const wss = new WebSocketServer({ noServer: true, maxPayload: config.maxMessageBytes ?? 64 * 1024 });
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
      idleCloseSeconds,
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

  /**
   * Runs `run` once the session clock reaches `targetMs`: the timer is set for `max(0, targetMs - sessionClock())`.
   * A slot holds one timer, and arming it again replaces the old one. A timer that fires before its target (the
   * delay is capped, and a timer can fire a moment early) sets itself again for what is left.
   */
  function arm(tracked: Tracked<U>, slot: TimerSlot, targetMs: number, run: (tracked: Tracked<U>) => Promise<void>): void {
    disarm(tracked, slot);
    if (stopped || tracked.ended) return;
    const delayMs = Math.min(Math.max(0, targetMs - sessionClock()), MAX_TIMER_MS);
    const handle = timers.set(() => {
      tracked.pending[slot] = undefined;
      if (stopped || tracked.ended) return;
      if (sessionClock() < targetMs) return arm(tracked, slot, targetMs, run);
      run(tracked).catch(logError);
    }, delayMs);
    tracked.pending[slot] = () => timers.clear(handle);
  }

  function disarm(tracked: Tracked<U>, slot: TimerSlot): void {
    tracked.pending[slot]?.();
    tracked.pending[slot] = undefined;
  }

  /** The session has `idleCloseSeconds`, from now, to get a connection. */
  function armIdle(tracked: Tracked<U>): void {
    arm(tracked, "idle", sessionClock() + idleCloseSeconds * 1000, idleClose);
  }

  /** The idle timer fired (spec §7.3): close the session. A close that fails leaves it to run to the end of its paid time. */
  async function idleClose(tracked: Tracked<U>): Promise<void> {
    try {
      await (tracked.closing ??= startClose(tracked, IDLE_CLOSE));
    } catch (error) {
      logError(error);
    }
  }

  /** The session ends when its paid time does. */
  function armEnd(tracked: Tracked<U>): void {
    arm(tracked, "end", Number(tracked.paidUntil) * 1000, expire);
  }

  /**
   * Stops forwarding: each socket's `send` drops what the adapter sends. The adapter is not asked to do anything. The idle
   * timer is cleared too: the end close decides how the session ends from here on, and `resume` arms the idle timer again.
   */
  function mute(tracked: Tracked<U>): void {
    if (tracked.muted) return;
    disarm(tracked, "idle");
    tracked.muted = new Map();
    for (const socket of tracked.connections) {
      tracked.muted.set(socket, socket.send);
      socket.send = discard as WebSocket["send"];
    }
  }

  /** The session was paid for longer: forwarding resumes, and the end timer is set for the new end of the paid time. */
  function resume(tracked: Tracked<U>, until: bigint): void {
    if (tracked.muted) for (const [socket, send] of tracked.muted) socket.send = send;
    tracked.muted = undefined;
    tracked.paidUntil = until;
    armEnd(tracked);
    // The last connection may have dropped while forwarding was stopped, and a drop then does not arm the idle timer.
    if (tracked.connections.size === 0 && !tracked.pending.idle) armIdle(tracked);
  }

  /**
   * The end timer fired (spec §7.3): forwarding stops, and the session is closed at the end of its paid time. A session
   * that is gone, whose account now holds another session, or that was paid for longer, needs no close. A close that
   * fails while the session is unchanged is tried again after `endRetrySeconds`, until the session ends or the gate
   * stops.
   */
  async function expire(tracked: Tracked<U>): Promise<void> {
    mute(tracked);
    if (await attempt(tracked)) return;
    arm(tracked, "end", sessionClock() + endRetryMs, expire);
  }

  /**
   * One pass at the end of the paid time. True when nothing is left to do: the session has ended, or it runs on. A close
   * already in flight (the buyer's, or the idle timer's) is joined without a re-read first: the re-read could race it,
   * find the account gone because that very close landed, and end the session with the wrong reason and code.
   */
  async function attempt(tracked: Tracked<U>): Promise<boolean> {
    if (!tracked.closing && (await settledByChain(tracked))) return true;
    try {
      const outcome = await (tracked.closing ??= startClose(tracked, END_CLOSE));
      if (outcome.ended) return true;
    } catch (error) {
      logError(error);
    }
    // The close failed. The chain may have changed under it: a top-up landed, or another party closed the session.
    return settledByChain(tracked);
  }

  /**
   * Re-reads the session at `confirmed`, once. True when that settles the matter: the session ended meanwhile; or its
   * account is gone or holds another session, so it ends here with 4402; or `paid_until` moved later on the same
   * session, so it runs on. A read that fails settles nothing, and neither does one that returns while a close is in
   * flight: that close ends the session, with its own reason and code.
   *
   * One read, not `readRetry`'s several: the account was read when the open settled, so finding nothing now means it has
   * closed, not that the RPC has yet to see it. An account at the address that started at another moment, or on other
   * terms, is another session opened there after a close (spec §4.1): the one tracked here is gone, and its connections
   * are not served on the newcomer's account.
   */
  async function settledByChain(tracked: Tracked<U>): Promise<boolean> {
    try {
      const stored = await upstream(() => config.chain.readSession(tracked.info.session));
      if (tracked.ended) return true;
      // A close that started during the read decides: it is the reason the account may be gone, and it ends the session.
      if (tracked.closing) return false;
      if (!stored || stored.startedAt !== tracked.stored.startedAt || !sessionMatches(stored, seller)) {
        await end(tracked, "expired", CLOSE_CODES.PAID_TIME_ENDED);
        return true;
      }
      const until = paidUntil(stored);
      if (until <= tracked.paidUntil) return false;
      resume(tracked, until);
      return true;
    } catch (error) {
      logError(error);
      return false;
    }
  }

  async function provision(session: Address, stored: Session): Promise<Tracked<U>> {
    const info: SessionInfo = { session, authority: stored.authority, paidUntil: paidUntil(stored) };
    const resource = await config.adapter.provision(info);
    const tracked: Tracked<U> = { info, stored, upstream: resource, connections: new Set(), ended: false, paidUntil: info.paidUntil, pending: {} };
    sessions.set(session, tracked);
    armIdle(tracked);
    armEnd(tracked);
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
    sendJson(response, 201, { session, paidUntil: Number(tracked.paidUntil), wsUrl: wsUrl(session) }, paymentResponse);
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
    disarm(tracked, "idle");
    disarm(tracked, "end");
    sessions.delete(tracked.info.session);
    for (const socket of tracked.connections) socket.close(code, "session closed");
    try {
      await config.adapter.teardown(tracked.info, reason);
    } catch (error) {
      // The session is over on chain whatever the resource does: a confirmed close must not become a failure.
      logError(error);
    }
  }

  async function closeSession(request: IncomingMessage, response: ServerResponse, session: Address): Promise<void> {
    const tracked = sessions.get(session);
    if (!tracked) return sendJson(response, 404, { error: "unknown_session" });
    if (!(await authenticate(bearer(request), tracked, "close"))) return sendJson(response, 401, { error: "unauthorized" });
    // Overlapping closes share one settlement and one outcome (the first assignment is synchronous).
    const outcome = await (tracked.closing ??= startClose(tracked, BUYER_CLOSE));
    sendJson(response, outcome.status, outcome.body);
  }

  function startClose(tracked: Tracked<U>, plan: ClosePlan): Promise<CloseOutcome> {
    const run = performClose(tracked, plan);
    // A failed close leaves the session open, and the buyer, or a timer, may try again.
    const reopen = () => void (tracked.closing = undefined);
    run.then((outcome) => outcome.ended || reopen(), reopen);
    return run;
  }

  async function performClose(tracked: Tracked<U>, plan: ClosePlan): Promise<CloseOutcome> {
    const session = tracked.info.session;
    const base = await offerBase();
    const transaction = await buildCloseTransaction({
      session,
      stored: tracked.stored,
      closer: config.receiverAuthorizer,
      feePayer: address(base.facilitator.feePayer),
      lifetime: base.lifetime,
      kind: plan.kind,
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
      await end(tracked, plan.reason, plan.code);
    }
    // A confirmed close is a success. Without the event the amounts are unknown, so only the transaction is returned.
    if (!event) return { status: 200, body: { transaction: settled.transaction }, ended: true };
    const body = {
      paid: (event.claimed + event.owed + event.redirected).toString(),
      refunded: event.refunded.toString(),
      transaction: settled.transaction,
    };
    return { status: 200, body, ended: true };
  }

  /**
   * The status of a session, read from the chain and public like the chain itself (spec §7.1). It
   * works for a session this gate does not track yet. A session with other terms is never served
   * (spec §4.6), so it is not this gate's to report either.
   */
  async function sessionStatus(response: ServerResponse, session: Address): Promise<void> {
    const stored = await upstream(() => config.chain.readSession(session));
    if (!stored || !sessionMatches(stored, seller)) return sendJson(response, 404, { error: "unknown_session" });
    const lifetime = await upstream(() => config.chain.latestBlockhash());
    const now = BigInt(Math.floor(sessionClock() / 1000));
    const until = paidUntil(stored);
    const due = dueAt(stored, now);
    const body: SessionStatus = {
      session,
      paidUntil: Number(until),
      startedAt: Number(stored.startedAt),
      deposited: stored.deposited.toString(),
      claimed: stored.claimed.toString(),
      rate: stored.rate.toString(),
      minSeconds: stored.minSeconds,
      maxSeconds: stored.maxSeconds,
      timeLeft: Number(until > now ? until - now : 0n),
      earned: earnedAt(stored, now).toString(),
      due: due.toString(),
      refundable: (stored.deposited - (due > stored.claimed ? due : stored.claimed)).toString(),
      blockhash: lifetime.blockhash,
      lastValidBlockHeight: lifetime.lastValidBlockHeight.toString(),
    };
    sendJson(response, 200, body);
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
    if (Number(tracked.paidUntil) * 1000 - sessionClock() <= marginMs) return refuseUpgrade(socket, 402);
    wss.handleUpgrade(request, socket, head, (ws) => {
      tracked.connections.add(ws);
      disarm(tracked, "idle");
      ws.once("close", () => {
        tracked.connections.delete(ws);
        if (tracked.connections.size === 0 && !tracked.muted) armIdle(tracked);
      });
      // A protocol violation, such as a message over the limit, is emitted as an error before the close.
      // Without a listener it would be an uncaught exception.
      ws.on("error", (error) => log({ event: "error", error: error.message }));
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
        if (request.method === "GET") {
          const found = STATUS_PATH.exec(url.pathname);
          if (!found) return false;
          const id = found[1]!;
          if (!isAddress(id)) sendJson(response, 404, { error: "unknown_session" });
          else await sessionStatus(response, id);
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
      stopped = true;
      for (const tracked of sessions.values()) {
        disarm(tracked, "idle");
        disarm(tracked, "end");
        for (const socket of tracked.connections) socket.close(1001, "gate stopping");
      }
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}
