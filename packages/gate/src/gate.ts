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
  buildTopUpOffer,
  checkOpenDuration,
  checkTopUpDuration,
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
  type ElapsedRequirements,
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
  /** Stops the gate's timers and subscriptions, and drops every connection. It does not end the sessions: nothing is closed on chain. */
  close(): Promise<void>;
}

/** The two timers of a session: no connection within the grace period, and the end of the paid time. */
type TimerSlot = "idle" | "end";

interface Tracked<U> {
  /** What the resource is handed. Its `paidUntil` follows the session's, so a connection attached after a top-up gets the new end. */
  info: SessionInfo;
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
  /** Ends the subscription to the session's account, when the chain offers one. */
  unwatch?: () => void;
  /** While forwarding is stopped: each socket's own `send` and `emit`, which `resume` puts back. */
  muted?: Map<WebSocket, { send: WebSocket["send"]; emit: WebSocket["emit"] }>;
  /** Set when the end timer first fires at the current `paidUntil`: `since` on the session clock (ms), `delayMs` the wait last armed for a retry. `resume` clears it. */
  endRetry?: { since: number; delayMs: number };
  /** The lookup of a close by another party, once one has started (spec §7.3): a second notification joins it. */
  endingElsewhere?: Promise<void>;
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
const SESSION_PATH = /^\/sessions\/([1-9A-HJ-NP-Za-km-z]{32,44})\/(ws|close|top-up)$/;
/** `GET /sessions/:id` (the status); `SESSION_PATH` holds the routes that end in `/ws`, `/close` or `/top-up`. */
const STATUS_PATH = /^\/sessions\/([1-9A-HJ-NP-Za-km-z]{32,44})$/;
const TOKEN_SKEW_MS = 30_000;
/** A failed end close is retried after `endRetrySeconds` for this long after the end timer first fired; after that each wait doubles. */
const END_RETRY_STEADY_MS = 30_000;
/** The longest wait between two end closes once the waits double, unless `endRetrySeconds` is longer. */
const END_RETRY_MAX_MS = 60_000;
/**
 * The longest the lookup of a close by another party takes, looks included, whatever `readRetry` allows (spec §7.3): the
 * connections are muted by then, and the session clock decides their close code without the event.
 */
const CLOSE_LOOKUP_MS = 2_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** What `promise` gives, or undefined if it has not settled within `ms`: the caller goes on without it. */
async function within<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), Math.max(0, ms));
  });
  try {
    return await Promise.race([promise, late]);
  } finally {
    clearTimeout(timer);
  }
}
/** The longest delay `setTimeout` takes: a longer one fires at once. */
const MAX_TIMER_MS = 2_147_483_647;

const systemTimers: Timers = {
  // Unreferenced, so a session that is still waiting does not keep a stopped host alive.
  set: (callback, delayMs) => setTimeout(callback, delayMs).unref(),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Stands in for a muted socket's `send`: the frame is dropped, and a send callback still runs, without an error, so an
 * adapter waiting on it is not stuck. It runs on a later turn of the event loop, as `ws`'s never runs before `send`
 * returns: an adapter that sends its next frame from the callback would otherwise recurse here without end when its
 * source has no end, and the end close could not run. `setImmediate` and not `process.nextTick`, which would still
 * starve I/O and timers.
 */
function discard(...args: unknown[]): void {
  const done = args.at(-1);
  if (typeof done === "function") setImmediate(done as () => void);
}

/**
 * Stands in for a muted socket's `emit`: `ws` delivers a frame the buyer sent by emitting `"message"`, and here that
 * reaches no listener (the frame is dropped, not queued). Every other event, such as `"close"`, `"error"`, `"ping"` and
 * `"pong"`, goes to the socket's own `emit` unchanged.
 */
function withholdMessages(emit: WebSocket["emit"]): WebSocket["emit"] {
  return function (this: WebSocket, event: string | symbol, ...args: unknown[]): boolean {
    return event === "message" ? false : emit.call(this, event, ...args);
  } as WebSocket["emit"];
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

  /** True when the account still holds the tracked session: the same `started_at`, on terms this gate offers (spec §4.1). */
  const sameSession = (tracked: Tracked<U>, stored: Session | undefined): stored is Session =>
    !!stored && stored.startedAt === tracked.stored.startedAt && sessionMatches(stored, seller);

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

  /** A 402 listing `accepts` for the payment at `resource` (spec §5.1), in the body and in the `PAYMENT-REQUIRED` header. */
  function sendPaymentRequired(response: ServerResponse, resource: string, accepts: readonly ElapsedRequirements[], error?: string): void {
    const body: PaymentRequired = {
      x402Version: X402_VERSION,
      ...(error === undefined ? {} : { error }),
      resource: { url: resource },
      accepts: [...accepts],
    };
    sendJson(response, 402, body, { [HEADERS.paymentRequired]: encodePaymentRequiredHeader(body) });
  }

  /** A 402 offering a new session, one entry per duration. */
  async function paymentRequired(response: ServerResponse, durations: readonly number[], error?: string): Promise<void> {
    const base = await offerBase();
    sendPaymentRequired(response, `${config.origin}/sessions`, durations.map((seconds) => buildOpenOffer({ ...base, seconds })), error);
  }

  /**
   * The facilitator answered `already_processed` (spec §5.4): the chain has processed the payment's message and the
   * facilitator holds no record of it, so the payment may have landed. That is not a refusal: `503`, never `402`, which
   * would tell the client that nothing was charged (spec §7.1).
   */
  function mayHaveLanded(response: ServerResponse, body: Record<string, unknown> = {}, headers?: Record<string, string>): void {
    sendJson(response, 503, { error: "already_processed", ...body }, headers);
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
   * Stops forwarding, both ways: each socket's `send` drops what the adapter sends, and its `emit` withholds the buyer's
   * frames from the socket's `message` listeners, dropped and not queued. Control frames and every other event, the
   * buyer's own close included, go through. The adapter is not asked to do anything. The idle timer is cleared too: the
   * end close decides how the session ends from here on, and `resume` arms the idle timer again.
   */
  function mute(tracked: Tracked<U>): void {
    if (tracked.muted) return;
    disarm(tracked, "idle");
    tracked.muted = new Map();
    for (const socket of tracked.connections) {
      const { send, emit } = socket;
      tracked.muted.set(socket, { send, emit });
      socket.send = discard as WebSocket["send"];
      socket.emit = withholdMessages(emit);
    }
  }

  /**
   * The session was paid for longer: the end timer is set for the new end of the paid time, which the resource's
   * `SessionInfo` carries from then on. Nothing else changes: an idle timer whose close failed is not armed again, since a
   * failed close leaves the session to run to the end of its paid time.
   */
  function extend(tracked: Tracked<U>, until: bigint): void {
    tracked.endRetry = undefined;
    tracked.paidUntil = until;
    tracked.info = { ...tracked.info, paidUntil: until };
    armEnd(tracked);
  }

  /** The session was paid for longer while forwarding was stopped: forwarding resumes in both directions, and the session is extended. */
  function resume(tracked: Tracked<U>, until: bigint): void {
    if (tracked.muted) {
      for (const [socket, original] of tracked.muted) {
        socket.send = original.send;
        socket.emit = original.emit;
      }
    }
    tracked.muted = undefined;
    extend(tracked, until);
    // The last connection may have dropped while forwarding was stopped, and a drop then does not arm the idle timer.
    if (tracked.connections.size === 0 && !tracked.pending.idle) armIdle(tracked);
  }

  /**
   * The end timer fired (spec §7.3): forwarding stops, and the session is closed at the end of its paid time. A session
   * that is gone, whose account now holds another session, or that was paid for longer, needs no close. A close that
   * fails while the session is unchanged is tried again, until the session ends or the gate stops: after
   * `endRetrySeconds` for the first 30 s since the timer first fired at this `paidUntil` (a `NotExpired` from a chain
   * clock that lags clears within that), then after twice the previous wait each time, up to 60 s (or `endRetrySeconds`,
   * if that is longer), so a failure that does not clear by itself costs one settlement a minute and not one every few
   * seconds. `resume` starts the short waits again. A top-up through this gate can resume the session while a pass runs
   * (its settlement was in flight when the timer fired): the pass then arms nothing, since the end timer is set already.
   */
  async function expire(tracked: Tracked<U>): Promise<void> {
    mute(tracked);
    const retry = (tracked.endRetry ??= { since: sessionClock(), delayMs: endRetryMs });
    if (await attempt(tracked)) return;
    // `resume` clears `endRetry`: the session runs on to its new end, for which the end timer is set.
    if (tracked.endRetry !== retry) return;
    if (sessionClock() - retry.since >= END_RETRY_STEADY_MS) retry.delayMs = Math.min(retry.delayMs * 2, Math.max(END_RETRY_MAX_MS, endRetryMs));
    arm(tracked, "end", sessionClock() + retry.delayMs, expire);
  }

  /**
   * One pass at the end of the paid time. True when nothing is left to do: the session has ended, or it runs on. A close
   * already in flight (the buyer's, or the idle timer's) is joined without a re-read first: the re-read could race it,
   * find the account gone because that very close landed, and end the session with the wrong reason and code.
   */
  async function attempt(tracked: Tracked<U>): Promise<boolean> {
    if (!tracked.closing && (await settledByChain(tracked))) return true;
    // The account's subscription (or the route) resumed the session during the re-read: there is nothing to close.
    if (!tracked.muted) return true;
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
   * Re-reads the session at `confirmed`, once. True when that settles the matter: the session ended meanwhile; or another
   * party closed it, and its close is being looked up (`endClosedElsewhere`), which ends the session whatever the read
   * found, and even if the read failed; or its account is gone or holds another session, so it ends here with 4402; or
   * `paid_until` moved later on the same session, so it runs on. A read that fails settles nothing otherwise, and neither
   * does one that returns while a close is in flight: that close ends the session, with its own reason and code.
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
      // The lookup of another party's close ends the session, with the code its Closed event gives: a node that lags may
      // still show the account, with a later `paid_until`, and an account gone here is that close, not the end timer's.
      if (tracked.endingElsewhere) return true;
      // A close that started during the read decides: it is the reason the account may be gone, and it ends the session.
      if (tracked.closing) return false;
      if (!sameSession(tracked, stored)) {
        await end(tracked, "expired", CLOSE_CODES.PAID_TIME_ENDED);
        return true;
      }
      const until = paidUntil(stored);
      if (until <= tracked.paidUntil) return false;
      resume(tracked, until);
      return true;
    } catch (error) {
      logError(error);
      // The lookup of another party's close ends the session: an end-timer pass sends no close and arms no retry.
      return tracked.endingElsewhere !== undefined;
    }
  }

  /**
   * Follows the session's account (spec §7.3), when the chain can: a later `paid_until` on the same session, a top-up this
   * gate did not settle, moves the end timer at once and resumes forwarding if the end timer has fired. An account that is
   * gone, or that holds another session, means the session was closed: `closedElsewhere` decides how it ends. A
   * subscription that fails, or cannot start, is logged and not replaced: the end timer's re-read still finds a later
   * `paid_until`, or the account gone. A gate that has stopped starts none, since nothing would end it.
   */
  function follow(tracked: Tracked<U>): void {
    if (stopped || !config.chain.watchSession) return;
    const session = tracked.info.session;
    const failed = (error: unknown) => log({ event: "subscription_error", session, error: error instanceof Error ? error.message : String(error) });
    try {
      tracked.unwatch = config.chain.watchSession(
        session,
        (stored) => {
          if (sameSession(tracked, stored)) paidLonger(tracked, paidUntil(stored));
          else closedElsewhere(tracked);
        },
        failed,
      );
    } catch (error) {
      failed(error);
    }
  }

  /**
   * The session's account is gone, or holds another session (spec §7.3, "Account closed by another party"). A close of the
   * gate's own in flight decides first: it may be what closed the account, and once confirmed it ends the session with its
   * own reason and code; if it does not confirm (it fails, or is still pending), this runs again. Otherwise the session
   * ends here, with no close (`endClosedElsewhere`). A second notification while that runs joins it.
   */
  function closedElsewhere(tracked: Tracked<U>): void {
    if (tracked.ended) return;
    const closing = tracked.closing;
    if (closing) {
      // Runs after `startClose`'s own handler, which has cleared `closing` by then if the close failed.
      const again = () => closedElsewhere(tracked);
      void closing.then((outcome) => outcome.ended || again(), again);
      return;
    }
    tracked.endingElsewhere ??= endClosedElsewhere(tracked).catch(logError);
  }

  /**
   * Ends a session that another party closed. Forwarding stops at once: the session is over on chain, whatever the lookup
   * finds. From then on a new connection, a close or a top-up is answered `404` (`endingElsewhere` is set), a top-up that
   * confirms does not resume forwarding, an end-timer pass already running leaves the session to this (`settledByChain`),
   * and the end timer is disarmed, since there is nothing left to settle. The close is looked up (`lookUpClose`). The
   * connections get `4402` if the close came at or after its `paid_until`, since the paid time ran out whoever closed it,
   * and `4410` before; without the close, the session clock is compared with the last `paid_until` the gate saw. The
   * session ends whatever the lookup did, and before anything is logged: with its end timer disarmed, nothing else would
   * end it.
   */
  async function endClosedElsewhere(tracked: Tracked<U>): Promise<void> {
    mute(tracked);
    disarm(tracked, "end");
    const session = tracked.info.session;
    let event: ClosedEvent | undefined;
    try {
      if (config.chain.lastClose) event = await lookUpClose(session, config.chain.lastClose.bind(config.chain));
    } catch (error) {
      logError(error);
    } finally {
      if (!tracked.ended) {
        const ranOut = event ? event.at >= event.paidUntil : BigInt(Math.floor(sessionClock() / 1000)) >= tracked.paidUntil;
        await end(tracked, "closedElsewhere", ranOut ? CLOSE_CODES.PAID_TIME_ENDED : CLOSE_CODES.SESSION_CLOSED);
        log({ event: "closed_elsewhere", session, found: event !== undefined });
      }
    }
  }

  /**
   * The `Closed` event of a close by another party (spec §7.3), or undefined if none shows. The node's list of the
   * address's transactions can lag the account notification, so the look is repeated every `readRetry.delayMs`, within
   * `readRetry.attempts`, for `CLOSE_LOOKUP_MS` at most, looks included: a look still running then is given up. The looks
   * share one `notCloses`, so a transaction read and found to hold no close is not read again. A look that fails ends the
   * lookup. The bound is kept on a monotonic clock (`performance.now`), which a change of the system clock does not move.
   */
  async function lookUpClose(
    session: Address,
    lastClose: (session: Address, notCloses: Set<string>) => Promise<ClosedEvent | undefined>,
  ): Promise<ClosedEvent | undefined> {
    const deadline = performance.now() + CLOSE_LOOKUP_MS;
    const notCloses = new Set<string>();
    for (let look = 1; ; look++) {
      const event = await within(upstream(() => lastClose(session, notCloses)), deadline - performance.now());
      if (event || look >= readRetry.attempts || performance.now() + readRetry.delayMs >= deadline) return event;
      await sleep(readRetry.delayMs);
    }
  }

  async function provision(session: Address, stored: Session): Promise<Tracked<U>> {
    const info: SessionInfo = { session, authority: stored.authority, paidUntil: paidUntil(stored) };
    const resource = await config.adapter.provision(info);
    const tracked: Tracked<U> = { info, stored, upstream: resource, connections: new Set(), ended: false, paidUntil: info.paidUntil, pending: {} };
    sessions.set(session, tracked);
    armIdle(tracked);
    armEnd(tracked);
    // After the timers: the session ends by itself whatever becomes of its subscription.
    follow(tracked);
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
    if (!verified.isValid) {
      if (verified.invalidReason === "already_processed") return mayHaveLanded(response, { session });
      return paymentRequired(response, durations, verified.invalidReason ?? "invalid_payload");
    }
    const settled = await upstream(() => config.facilitator.settle(payload, requirements));
    const paymentResponse = { [HEADERS.paymentResponse]: encodePaymentResponseHeader(settled) };
    log({ event: "open", session, success: settled.success, reason: settled.errorReason });
    if (!settled.success) {
      if (settled.errorReason === "settlement_pending") {
        return sendJson(response, 202, { session, transaction: settled.transaction }, paymentResponse);
      }
      if (settled.errorReason === "already_processed") return mayHaveLanded(response, { session }, paymentResponse);
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

  /**
   * The session is paid until `until`, if that is later than the end the gate knows: forwarding goes on if the end timer has
   * fired, and otherwise only the end moves. A session that has ended stays ended.
   */
  function paidLonger(tracked: Tracked<U>, until: bigint): void {
    // A session that another party closed stays over: a top-up that confirms while its close is looked up resumes nothing.
    if (tracked.ended || tracked.endingElsewhere || until <= tracked.paidUntil) return;
    if (tracked.muted) resume(tracked, until);
    else extend(tracked, until);
  }

  /**
   * `POST /sessions/:id/top-up` (spec §7.1): a 402 listing top-up offers, then the payment. Only a session this gate tracks
   * can be topped up. Once its end timer has fired, the session cannot be extended (spec §4.3): the answer is a 402 with
   * `session_expired` and offers for a new session, as a connect gets then. The durations that fit come from the chain,
   * since a top-up made elsewhere may have moved the deposit (spec §5.2). A request that carries a payment has its
   * duration checked only against 1 to `maxSeconds` (a `400` outside), not against the deposit read now: a payment sent
   * again after its transaction landed is answered from the facilitator's record, and is already in that deposit, and
   * the facilitator refuses a new one that does not fit (`invalid_amount`). The offers, a refusal's included, are the
   * durations the request names (its `seconds`, or else the menu's) that fit the deposit; a refusal with none to offer
   * is a `400 invalid_duration` with the deposit's bounds, as the request for offers gets then.
   *
   * Once the top-up settles, the new end is the `paid_until` of the session as it stands after the settlement's
   * transaction, read from a node that shows that transaction (`readSessionAfter`), and asked again within `readRetry`
   * while it does not (spec §7.3). It is not the deposit read before the payment plus the amount: a payment settled again
   * after it landed, answered from the facilitator's record, is already in that deposit. The end timer moves there if it
   * is later (`paidLonger`), and the `200` answers the later of it and the end the gate knows. If the read finds the
   * account gone, or holding another session, the answer is `404` and no timer moves; if the node still does not show the
   * transaction after the re-reads, it is `502`, and the subscription, or the end timer's re-read, finds the later end.
   * A chain without `readSessionAfter` reads the session with `readSession` once the settlement has succeeded instead,
   * and the end comes from that read, with the same `404`: a node that does not show the transaction yet can only find an
   * earlier end, which credits too little and never too much, and the subscription, or the end timer's re-read, finds
   * the later one.
   */
  async function topUp(request: IncomingMessage, response: ServerResponse, url: URL, session: Address): Promise<void> {
    const tracked = sessions.get(session);
    // A session that another party closed is over on chain while the gate looks its close up (spec §7.3).
    if (!tracked || tracked.ended || tracked.endingElsewhere) return sendJson(response, 404, { error: "unknown_session" });
    if (tracked.muted) return paymentRequired(response, menu, "session_expired");
    const stored = await upstream(() => config.chain.readSession(session));
    if (!sameSession(tracked, stored)) {
      return sendJson(response, 404, { error: "unknown_session" });
    }
    const header = request.headers[HEADERS.paymentSignature.toLowerCase()];
    // With a payment, the duration is checked here only against the bounds that hold whatever the deposit, those of an
    // empty one: a payment sent again after its transaction landed is answered from the facilitator's record, and its
    // deposit is already in the one read now. The facilitator refuses a new one that does not fit (`invalid_amount`).
    const deposited = typeof header === "string" ? 0n : stored.deposited;
    const fits = (deposit: bigint) => (seconds: number) => checkTopUpDuration(config.terms, deposit, seconds).ok;
    const requested = url.searchParams.get("seconds");
    const durations = requested === null ? menu.filter(fits(deposited)) : [Number(requested)];
    // When no duration of the menu fits, the 400 states the bounds, so that the buyer can ask for one that does.
    const checks =
      durations.length === 0
        ? [checkTopUpDuration(config.terms, deposited, 0)]
        : durations.map((seconds) => checkTopUpDuration(config.terms, deposited, seconds));
    for (const check of checks) {
      if (!check.ok) return sendJson(response, 400, { error: "invalid_duration", minSeconds: check.minSeconds, maxSeconds: check.maxSeconds });
    }

    const resource = `${config.origin}/sessions/${session}/top-up`;
    // Whether a payment comes or not, the offers are the durations that fit the deposit read now.
    const offered = durations.filter(fits(stored.deposited));
    const offers = async () => {
      const base = await offerBase();
      return offered.map((seconds) => buildTopUpOffer({ ...base, seconds, session }));
    };
    // A refusal because the session has run out offers a new session; any other offers the top-up again.
    const refusal = async (reason: string): Promise<void> => {
      if (reason === "session_expired") return paymentRequired(response, menu, reason);
      // Nothing fits the deposit read now, so nothing can be offered: answered as the request for offers is, with the
      // deposit's bounds (0 s never fits, so the check states them). Nothing has settled.
      const bounds = checkTopUpDuration(config.terms, stored.deposited, 0);
      if (offered.length === 0 && !bounds.ok) {
        return sendJson(response, 400, { error: "invalid_duration", minSeconds: bounds.minSeconds, maxSeconds: bounds.maxSeconds });
      }
      sendPaymentRequired(response, resource, await offers(), reason);
    };

    if (typeof header !== "string") return sendPaymentRequired(response, resource, await offers());
    let payload: PaymentPayload;
    try {
      payload = decodePaymentSignatureHeader(header);
    } catch {
      return refusal("invalid_payload");
    }
    const accepted = readElapsedRequirements(payload.accepted);
    if (!accepted || accepted.extra.action !== "topUp" || accepted.extra.session !== session || !durations.includes(accepted.extra.seconds)) {
      return refusal("invalid_payment_requirements");
    }
    // The requirements as this gate issues them, with the advisory fields of the entry the client accepted (spec §5.5).
    const requirements = buildTopUpOffer({
      ...(await offerBase({
        blockhash: accepted.extra.recentBlockhash,
        lastValidBlockHeight: BigInt(accepted.extra.lastValidBlockHeight),
      })),
      maxTimeoutSeconds: accepted.maxTimeoutSeconds,
      seconds: accepted.extra.seconds,
      session,
    });

    const verified = await upstream(() => config.facilitator.verify(payload, requirements));
    if (!verified.isValid) {
      if (verified.invalidReason === "already_processed") return mayHaveLanded(response);
      return refusal(verified.invalidReason ?? "invalid_payload");
    }
    const settled = await upstream(() => config.facilitator.settle(payload, requirements));
    const paymentResponse = { [HEADERS.paymentResponse]: encodePaymentResponseHeader(settled) };
    log({ event: "topUp", session, success: settled.success, reason: settled.errorReason });
    if (!settled.success) {
      // A pending top-up needs nothing more here: if it lands, its later end is found as one this gate did not settle is.
      if (settled.errorReason === "settlement_pending") return sendJson(response, 202, { transaction: settled.transaction }, paymentResponse);
      if (settled.errorReason === "already_processed") return mayHaveLanded(response, {}, paymentResponse);
      return refusal(settled.errorReason ?? "simulation_failed");
    }
    let after: Session | undefined;
    const readSessionAfter = config.chain.readSessionAfter?.bind(config.chain);
    if (readSessionAfter) {
      const read = await readUntilFound(() => upstream(() => readSessionAfter(session, settled.transaction)), readRetry);
      // What the top-up did to the account is not known yet: the subscription, or the end timer's re-read, finds the
      // later end, as for a top-up this gate did not settle.
      if (!read) throw new UpstreamError(new Error(`the chain does not show the top-up's transaction ${settled.transaction} yet`));
      after = read.stored;
    } else {
      // Read once the settlement has succeeded, from a node that may not show its transaction yet: such a read can only
      // lag, so it can only find an earlier end, and the subscription, or the end timer's re-read, finds the later one.
      after = await upstream(() => config.chain.readSession(session));
    }
    // Closed after the top-up landed, by whichever party: answered as an open whose account is gone is, and nothing
    // more. The session ends as it would have without this top-up: by the gate's own close, if that is what closed
    // it, or else through the subscription or the end timer.
    if (!sameSession(tracked, after)) return sendJson(response, 404, { error: "unknown_session" });
    const until = paidUntil(after);
    paidLonger(tracked, until);
    // The session may already run later than `until`: the subscription, or the end timer, found a later end meanwhile.
    sendJson(response, 200, { paidUntil: Number(until > tracked.paidUntil ? until : tracked.paidUntil) }, paymentResponse);
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
    tracked.unwatch?.();
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
    // The session may have ended while the token was checked, or another party may have closed it (spec §7.3).
    if (tracked.ended || tracked.endingElsewhere) return sendJson(response, 404, { error: "unknown_session" });
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
    // The session may have ended while the token was checked, or another party may have closed it (spec §7.3).
    if (tracked.ended || tracked.endingElsewhere) return refuseUpgrade(socket, 404);
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
        if (request.method === "POST" && (match?.[2] === "close" || match?.[2] === "top-up")) {
          const id = match[1]!;
          if (!isAddress(id)) sendJson(response, 404, { error: "unknown_session" });
          else if (match[2] === "close") await closeSession(request, response, id);
          else await topUp(request, response, url, id);
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
        tracked.unwatch?.();
        for (const socket of tracked.connections) socket.close(1001, "gate stopping");
      }
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}
