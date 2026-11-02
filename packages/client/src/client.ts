import {
  address,
  fetchEncodedAccount,
  getBase64Encoder,
  getSignatureFromTransaction,
  getTransactionDecoder,
  isSolanaError,
  type Address,
  type Base64EncodedWireTransaction,
  type KeyPairSigner,
  type Rpc,
  type SolanaRpcApi,
} from "@solana/kit";
import { CloseKind, STINT_PROGRAM_ADDRESS, decodeSession, type ClosedEvent, type Session } from "@lxfoundry/stint-program-client";
import {
  HEADERS,
  TransactionFailedError,
  X402_VERSION,
  buildCloseTransaction,
  buildOpenTransaction,
  buildSponsoredClose,
  buildTopUpTransaction,
  createSessionToken,
  decodePaymentRequiredHeader,
  encodePaymentSignatureHeader,
  fetchClosedEvent,
  findClose,
  readCloseInfo,
  readElapsedRequirements,
  waitForConfirmation,
  type ElapsedRequirements,
  type PaymentPayload,
  type PaymentRequired,
  type SessionStatus,
  type SponsoredCloseResponse,
  type TokenPurpose,
} from "@lxfoundry/stint-x402";
import { WebSocket } from "ws";
import { checkOffer, checkTopUp, type Policy } from "./policy.js";

export class StintError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "StintError";
  }
}

/**
 * Which step of the close fallback chain closed the session (spec §9.3): the gate's close, the facilitator's sponsored
 * close through the offer's `closeUrl`, or a close the client sent to the chain itself.
 */
export type CloseVia = "gate" | "sponsored" | "unilateral";

/** `paid` and `refunded` are absent when the amounts of a confirmed close could not be read, or a pending close was not. */
export interface CloseReceipt {
  readonly paid?: bigint;
  readonly refunded?: bigint;
  readonly transaction: string;
  readonly via: CloseVia;
}

/** What a top-up bought. */
export interface TopUpReceipt {
  /** The session's new end, in Unix seconds. */
  readonly paidUntil: number;
  /** What the top-up cost, in base units. */
  readonly cost: bigint;
}

export interface StintSession {
  readonly id: Address;
  readonly gateUrl: string;
  /** Unix seconds: the end of the paid time, moved by each top-up made through this session. */
  readonly paidUntil: number;
  readonly wsUrl: string;
  /** Everything the session holds through this client, in base units: the opening deposit and each top-up. */
  readonly cost: bigint;
  connect(): Promise<WebSocket>;
  /**
   * Buys `seconds` more paid time (spec §9.4). The gate's offer is checked against the policy and against the terms the
   * session opened with before anything is signed. A session whose paid time has run out cannot be extended.
   */
  topUp(options: { readonly seconds: number }): Promise<TopUpReceipt>;
  /** The status the gate reports from the chain (spec §7.1): estimates use the gate's clock. */
  status(): Promise<SessionStatus>;
  /**
   * Closes the session through the close fallback chain (spec §9.3), and says which step closed it. Throws when the
   * session is already closed (`404`), and when no step can close it: the session then runs to the end of its paid time,
   * and a later call tries again. Overlapping calls share one chain.
   */
  close(): Promise<CloseReceipt>;
  [Symbol.asyncDispose](): Promise<void>;
}

export interface StintClient {
  open(url: string, options?: { readonly seconds?: number }): Promise<StintSession>;
  /** What the period budget still allows. */
  remainingBudget(): bigint;
}

export interface ClientOptions {
  readonly signer: KeyPairSigner;
  readonly policy: Policy;
  /** Milliseconds; runs the period budget. Default `Date.now`. */
  readonly now?: () => number;
  /** Milliseconds between reads of the gate's status while its close is pending (spec §9.3). Default 1,000. */
  readonly closePollMs?: number;
  /**
   * Milliseconds after which a read of the close fallback chain that has no answer is given up (spec §9.3): the gate's
   * status, `GET closeUrl`, and the client's reads of its own node, `rpc`. Default 10,000. A whole number from 1 to
   * 2,147,483,647.
   */
  readonly requestTimeoutMs?: number;
  /**
   * Milliseconds after which a request of the close fallback chain that sends a close and has no answer is given up
   * (spec §9.3); that close may still land. It covers the gate's close, `POST closeUrl`, and the client's own close
   * through `rpc`, from its sending to its confirmation. Default 60,000: longer than the facilitator's wait for a close to
   * confirm before it answers (30 s by default). A whole number from 1 to 2,147,483,647.
   */
  readonly closeRequestTimeoutMs?: number;
  /**
   * A node, for the last step of the close fallback chain: a close the client sends to the chain itself, its fee paid by
   * the signer, which must hold SOL for it (spec §9.1, §9.3). With one, the client checks with its own read of the
   * session account a gate's or a facilitator's word that the session is closed. Without one, a session that neither the
   * gate nor the facilitator can close runs to the end of its paid time. The client's requests to it have the same time
   * limits as its other requests (`requestTimeoutMs`, `closeRequestTimeoutMs`), whatever the node's transport does.
   */
  readonly rpc?: Rpc<SolanaRpcApi>;
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const describeBody = (body: unknown) => (typeof body === "string" ? body : JSON.stringify(body));

/** An error's message, with its cause's: `fetch` reports a host that cannot be reached as "fetch failed", and why in its cause. */
const describeError = (error: unknown): string =>
  error instanceof Error ? `${error.message}${error.cause instanceof Error ? `: ${error.cause.message}` : ""}` : String(error);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const DEFAULT_CLOSE_WAIT_SECONDS = 180;
const DEFAULT_CLOSE_POLL_MS = 1_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_CLOSE_REQUEST_TIMEOUT_MS = 60_000;
/**
 * The fee of a transaction with one signature. A fee payer may not drop below the rent-exempt minimum, so a signer must
 * hold this on top of it to send a close of its own.
 */
const SIGNATURE_FEE_LAMPORTS = 5_000n;
/** How the `Closed` event of the client's own close is read while the node does not return the transaction yet. */
const EVENT_READ_RETRY = { attempts: 5, delayMs: 200 };

/**
 * The session at `session`, read at `confirmed`, or undefined if no account of the program is there: anyone can send
 * lamports to the address of a closed session (S12), which leaves a wallet there, not a session. The read is given up
 * when `limit.abortSignal` fires.
 */
async function readOwnSession(rpc: Rpc<SolanaRpcApi>, session: Address, limit: { readonly abortSignal: AbortSignal }): Promise<Session | undefined> {
  const account = await fetchEncodedAccount(rpc, session, { commitment: "confirmed", ...limit });
  if (!account.exists || account.programAddress !== STINT_PROGRAM_ADDRESS) return undefined;
  return decodeSession(account).data;
}

/**
 * What `promise` gives, or undefined if it has not settled within `ms`: for the scheme package's helpers, which make
 * several requests to the node and take no abort signal. A request still running then is left to finish, unread.
 */
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

/** The signature of a base64 wire transaction: its fee payer's, which the chain knows the transaction by. */
const signatureOf = (wire: string): string => getSignatureFromTransaction(getTransactionDecoder().decode(getBase64Encoder().encode(wire)));

/**
 * Whether the node answered with a JSON-RPC error, which `@solana/kit` reports as a `SolanaError` carrying the error's
 * own code, negative in JSON-RPC: a transaction refused so was not taken. Any other failure of a request (no answer in
 * time, a connection that drops, an HTTP error) leaves open whether the node took it.
 */
const refusedByNode = (error: unknown): boolean => isSolanaError(error) && error.context.__code < 0;

/** A close's amounts as a receipt reports them, from its `Closed` event: `paid` is all the receiver was paid for the session. */
const amountsOf = (event: ClosedEvent) => ({ paid: event.claimed + event.owed + event.redirected, refunded: event.refunded });

/** The longest delay Node's timers keep: `AbortSignal.timeout` takes up to 2^32 - 1, but fires at once past this. */
const MAX_TIME_LIMIT_MS = 2_147_483_647;

/** A time limit as `AbortSignal.timeout` keeps it, whole milliseconds up to `MAX_TIME_LIMIT_MS`, checked when the client is created. */
function timeLimitMs(name: string, value: number | undefined, fallback: number): number {
  const ms = value ?? fallback;
  if (!Number.isInteger(ms) || ms < 1 || ms > MAX_TIME_LIMIT_MS) {
    throw new RangeError(`${name} must be a whole number of milliseconds from 1 to ${MAX_TIME_LIMIT_MS}: got ${ms}`);
  }
  return ms;
}

/** Whether a request was given up at its time limit (`AbortSignal.timeout`), rather than refused. */
const timedOut = (error: unknown) => error instanceof Error && error.name === "TimeoutError";

/** The receipt of a close whose answer reports it: the gate's `200`, or the facilitator's successful sponsored close. */
function receiptFrom(body: unknown, via: CloseVia): CloseReceipt {
  const answer = body as { paid?: string; refunded?: string; transaction: string };
  return {
    ...(answer.paid === undefined ? {} : { paid: BigInt(answer.paid) }),
    ...(answer.refunded === undefined ? {} : { refunded: BigInt(answer.refunded) }),
    transaction: answer.transaction,
    via,
  };
}

/**
 * What one step of the close fallback chain came to (spec §9.3). `pending`, on a step that did not close the session, is
 * a close it sent that may still land; `unanswered`, a close it sent whose request had no answer, which may land too.
 */
type CloseStep =
  | { readonly kind: "closed"; readonly receipt: CloseReceipt }
  /** A check found the session closed. */
  | { readonly kind: "gone"; readonly reason: string; readonly pending?: CloseReceipt }
  /** The step did not close the session. */
  | { readonly kind: "next"; readonly reason: string; readonly pending?: CloseReceipt; readonly unanswered?: true };

/** The buyer's runtime (spec §9.4). It needs only a signer: no SOL and no node access (spec §9.1). */
export function createStintClient(options: ClientOptions): StintClient {
  const now = options.now ?? Date.now;
  const closePollMs = options.closePollMs ?? DEFAULT_CLOSE_POLL_MS;
  const requestTimeoutMs = timeLimitMs("requestTimeoutMs", options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
  const closeRequestTimeoutMs = timeLimitMs("closeRequestTimeoutMs", options.closeRequestTimeoutMs, DEFAULT_CLOSE_REQUEST_TIMEOUT_MS);
  /** A read of the client's node, given up after `requestTimeoutMs`: the default transport of `@solana/kit` never gives up. */
  const readLimit = () => ({ abortSignal: AbortSignal.timeout(requestTimeoutMs) });
  const ledger: { readonly at: number; readonly amount: bigint }[] = [];
  const locked = () => {
    const since = now() - options.policy.budget.periodSeconds * 1000;
    return ledger.filter((entry) => entry.at > since).reduce((sum, entry) => sum + entry.amount, 0n);
  };

  /**
   * Locks `amount` in the period budget, and returns what unlocks it. It is called in the same synchronous step as the
   * policy check, so that concurrent payments cannot both pass against the same locked amount. Once signed, a payment may
   * land whatever the answer, so the amount stays locked unless the gate refused the payment before settlement.
   */
  function reserve(amount: bigint): () => void {
    const entry = { at: now(), amount };
    ledger.push(entry);
    return () => {
      const index = ledger.indexOf(entry);
      if (index >= 0) ledger.splice(index, 1);
    };
  }

  /** The offers the gate answers a first request with: a 402 (spec §5.1). */
  async function offersFrom(endpoint: string): Promise<PaymentRequired> {
    const first = await fetch(endpoint, { method: "POST" });
    if (first.status !== 402) {
      const body = await readBody(first);
      throw new StintError(`Expected 402 from ${endpoint}, got ${first.status}: ${describeBody(body)}`, first.status, body);
    }
    const header = first.headers.get(HEADERS.paymentRequired);
    const required = (header ? decodePaymentRequiredHeader(header) : await first.json()) as PaymentRequired;
    if (required.x402Version !== X402_VERSION) throw new StintError(`x402Version ${required.x402Version} is not supported`);
    return required;
  }

  /** Sends a payment, its `PAYMENT-SIGNATURE` header already encoded, and returns the gate's answer. */
  async function send(endpoint: string, signature: string): Promise<{ status: number; body: unknown }> {
    const response = await fetch(endpoint, { method: "POST", headers: { [HEADERS.paymentSignature]: signature } });
    return { status: response.status, body: await readBody(response) };
  }

  function sessionFrom(
    gateUrl: string,
    opened: { session: string; paidUntil: number; wsUrl: string },
    offer: ElapsedRequirements,
    deposit: bigint,
  ): StintSession {
    const audience = new URL(gateUrl).origin;
    const token = (purpose: TokenPurpose) => createSessionToken(options.signer, { session: opened.session, audience, purpose });
    let closed = false;
    let paidUntil = opened.paidUntil;
    let cost = deposit;
    /** The close fallback chain in flight: overlapping calls of `close()` share it. */
    let closing: Promise<CloseReceipt> | undefined;
    const closeWaitSeconds = options.policy.closeWaitSeconds ?? DEFAULT_CLOSE_WAIT_SECONDS;

    /**
     * The close fallback chain (spec §9.3): the gate's close, then the facilitator's sponsored close through the offer's
     * `closeUrl`, then a close the client sends to the chain itself. A step that finds the session closed ends the chain,
     * since a close from an earlier step can land late: a close that an earlier step passed on is then the receipt. With
     * an `rpc`, the gate's or the facilitator's word that the session is closed is checked with the client's own read
     * (`stillOpen`): the chain goes on only if the chain still shows the session. When no step closes the session, it runs
     * to the end of its paid time.
     */
    async function closeWithFallbacks(): Promise<CloseReceipt> {
      const passed: string[] = [];
      const pending: CloseReceipt[] = [];
      let unanswered = 0;
      for (const step of [closeThroughGate, closeThroughFacilitator, closeOnChain]) {
        const outcome = await step();
        if (outcome.kind === "closed") return outcome.receipt;
        if (outcome.pending) pending.push(outcome.pending);
        if (outcome.kind === "gone" && (step === closeOnChain || !(await stillOpen()))) return alreadyClosed(pending);
        if (outcome.kind === "next" && outcome.unanswered) unanswered += 1;
        passed.push(outcome.reason);
      }
      throw notClosed(passed, pending, unanswered);
    }

    /**
     * Whether the client's own read still finds the session (spec §9.3), to check a gate's or a facilitator's word that it
     * is closed. False without an `rpc`, and when the read fails or has no answer within `requestTimeoutMs`: the seller's
     * word then stands.
     */
    async function stillOpen(): Promise<boolean> {
      if (!options.rpc) return false;
      return readOwnSession(options.rpc, address(opened.session), readLimit()).then(
        (stored) => stored !== undefined,
        () => false,
      );
    }

    /**
     * The session is closed. A close passed on by an earlier step is the receipt: with the client's `rpc`, the one the
     * chain shows landed (`findClose`), with its amounts; without it, while the chain shows no close yet, or when the
     * lookup cannot be read within `requestTimeoutMs`, the latest, without amounts. With none passed on, or when the close
     * that landed is none of them, another party closed the session: that is reported, and the session counts as closed.
     */
    async function alreadyClosed(pending: readonly CloseReceipt[]): Promise<CloseReceipt> {
      let mine = pending.at(-1);
      if (options.rpc && mine) {
        const landed = await within(findClose(options.rpc, address(opened.session)), requestTimeoutMs).catch(() => undefined);
        if (landed) {
          const match = pending.find((close) => close.transaction === landed.signature);
          mine = match && { ...match, ...amountsOf(landed.event) };
        }
      }
      if (mine) return mine;
      closed = true;
      throw new StintError("The session is already closed", 404);
    }

    /**
     * No step closed the session: why each was passed over, the closes sent that may still land (`pending`, named, and
     * `unanswered` more, whose requests had no answer), and what that costs.
     */
    function notClosed(passed: readonly string[], pending: readonly CloseReceipt[], unanswered: number): StintError {
      const sent = pending.map((close) => `${close.transaction} (${close.via})`).join(", ");
      const named = pending.length === 0 ? "" : pending.length === 1 ? ` A close sent may still land: ${sent}.` : ` Closes sent may still land: ${sent}.`;
      const mayLand = pending.length + unanswered;
      const lands = mayLand === 0 ? "" : mayLand === 1 ? "that close lands or " : "one of those closes lands or ";
      return new StintError(
        `The session could not be closed: ${passed.join("; ")}.${named} ` +
          `It runs to the end of its paid time, which is charged in full, unless ${lands}a later close succeeds`,
      );
    }

    /**
     * Step 1: the gate's close. `200` is the receipt, and a `202` is waited for. Any other answer moves the chain on, as
     * does a gate that cannot be reached or does not answer within `closeRequestTimeoutMs`: a `404` (it does not track the
     * session, as after a restart), a `5xx`, a `401` (a token it refuses, say from a skewed clock), and a refusal of the
     * close itself, such as `409`, which the later steps judge for themselves.
     */
    async function closeThroughGate(): Promise<CloseStep> {
      const authorization = `Bearer ${await token("close")}`;
      let status: number;
      let body: unknown;
      try {
        const response = await fetch(`${gateUrl}/sessions/${opened.session}/close`, {
          method: "POST",
          headers: { authorization },
          signal: AbortSignal.timeout(closeRequestTimeoutMs),
        });
        status = response.status;
        body = await readBody(response);
      } catch (error) {
        if (timedOut(error)) {
          return { kind: "next", reason: `the gate did not answer its close within ${closeRequestTimeoutMs} ms, and that close may still land`, unanswered: true };
        }
        return { kind: "next", reason: `the gate cannot be reached (${describeError(error)})` };
      }
      if (status === 200) return { kind: "closed", receipt: receiptFrom(body, "gate") };
      if (status === 202) return awaitGateClose(body);
      return { kind: "next", reason: `the gate answered ${status}: ${describeBody(body)}` };
    }

    /**
     * The gate's close is pending (`202`): its status is read every `closePollMs` until it answers `404 unknown_session`,
     * for at most `closeWaitSeconds`. That answer means the session is closed, and the pending close is the receipt,
     * without amounts; another `404`, such as a proxy's, is not the gate's word and is waited out. Past the wait the chain
     * moves on, passing the pending close on, and the next step first checks that the session is still open.
     */
    async function awaitGateClose(body: unknown): Promise<CloseStep> {
      const transaction = (body as { transaction?: unknown } | null)?.transaction;
      const still = typeof transaction === "string" ? { pending: { transaction, via: "gate" as const } } : {};
      const deadline = Date.now() + closeWaitSeconds * 1000;
      for (;;) {
        try {
          const response = await fetch(`${gateUrl}/sessions/${opened.session}`, { signal: AbortSignal.timeout(requestTimeoutMs) });
          const answer = await readBody(response);
          if (response.status === 404 && (answer as { error?: unknown } | null)?.error === "unknown_session") {
            return { kind: "gone", reason: "the gate's status finds no session", ...still };
          }
        } catch {
          // A gate that cannot be reached now may answer at the next read.
        }
        if (Date.now() >= deadline) {
          return { kind: "next", reason: `the gate's close stayed pending for ${closeWaitSeconds} s`, ...still };
        }
        await sleep(closePollMs);
      }
    }

    /**
     * Step 2: the facilitator's sponsored close (spec §6.1, §9.3). `GET closeUrl?session=` says whether the session is
     * still open (`404 unknown_session`: it is closed) and gives the fee payer, a blockhash and the session's fields. The
     * client builds the close from them, signs it as the session's authority, and posts it. Any failure moves the chain on:
     * the facilitator cannot be reached or does not answer in time, answers something else, or does not close it.
     */
    async function closeThroughFacilitator(): Promise<CloseStep> {
      const closeUrl = offer.extra.closeUrl;
      try {
        const lookup = await fetch(`${closeUrl}?session=${opened.session}`, { signal: AbortSignal.timeout(requestTimeoutMs) });
        const found = await readBody(lookup);
        if (lookup.status === 404 && (found as { error?: unknown } | null)?.error === "unknown_session") {
          return { kind: "gone", reason: "GET closeUrl finds no session" };
        }
        const info = lookup.status === 200 ? readCloseInfo(found) : undefined;
        if (!info) return { kind: "next", reason: `GET closeUrl answered ${lookup.status}: ${describeBody(found)}` };
        // Refuses a body that describes another session or program, or names this signer as the fee payer (spec S14).
        const transaction = await buildSponsoredClose(info, { session: address(opened.session), closer: options.signer });
        let posted: Response;
        let answer: SponsoredCloseResponse;
        try {
          posted = await fetch(closeUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ transaction }),
            signal: AbortSignal.timeout(closeRequestTimeoutMs),
          });
          // The time limit runs on while the answer is read: an answer started and never finished is no answer.
          answer = (await readBody(posted)) as SponsoredCloseResponse;
        } catch (error) {
          if (!timedOut(error)) throw error;
          const reason = `the facilitator did not answer its close within ${closeRequestTimeoutMs} ms, and that close may still land`;
          return { kind: "next", reason, unanswered: true };
        }
        if (posted.status === 200 && answer.success) return { kind: "closed", receipt: receiptFrom(answer, "sponsored") };
        const reason = `the facilitator did not close it (HTTP ${posted.status}: ${describeBody(answer)})`;
        // A close the facilitator sent and could not confirm may still land: if a later check finds the session closed, it is the receipt.
        const unconfirmed = posted.status === 200 && !answer.success && answer.errorReason === "settlement_pending";
        return { kind: "next", reason, ...(unconfirmed ? { pending: { transaction: answer.transaction, via: "sponsored" as const } } : {}) };
      } catch (error) {
        return { kind: "next", reason: `the facilitator's sponsored close failed (${describeError(error)})` };
      }
    }

    /**
     * Step 3: a close of the client's own, sent with its `rpc`, its fee paid by the signer (spec §9.1, §9.3). The session
     * account is read first: no session of the program at the address means it is closed, which ends the chain. The
     * signer must hold the fee on top of a rent-exempt balance. The close is a `Standard` close by the authority, built
     * from the stored fields, and nothing else. Each read is given up after `requestTimeoutMs`, which moves the chain on
     * before anything is sent; the send and the wait for its confirmation, after `closeRequestTimeoutMs` together.
     *
     * The close is named by its signature, the fee payer's, known before the send. One the node refuses with an error
     * answer was not taken: the close failed. One that does not confirm moves the chain on; one still pending is passed
     * on, and so is one the node may have taken whose sending or confirmation cannot be read in time, since it may still
     * land. A confirmed close is the receipt even when its `Closed` event cannot be read: it then has no amounts.
     */
    async function closeOnChain(): Promise<CloseStep> {
      const rpc = options.rpc;
      if (!rpc) return { kind: "next", reason: "the client has no rpc to send a close of its own" };
      /** A close the node may have taken. */
      let signature: string | undefined;
      try {
        const stored = await readOwnSession(rpc, address(opened.session), readLimit());
        if (!stored) return { kind: "gone", reason: "the chain holds no session at its address" };
        const { value: lamports } = await rpc.getBalance(options.signer.address, { commitment: "confirmed" }).send(readLimit());
        const needed = SIGNATURE_FEE_LAMPORTS + (await rpc.getMinimumBalanceForRentExemption(0n, { commitment: "confirmed" }).send(readLimit()));
        if (lamports < needed) {
          return {
            kind: "next",
            reason: `the signer holds ${lamports} lamports, less than the fee of a close of its own on top of a rent-exempt balance (${needed})`,
          };
        }
        const { value: lifetime } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send(readLimit());
        const transaction = await buildCloseTransaction({
          session: address(opened.session),
          stored,
          closer: options.signer,
          // The signer pays the fee: the one signature covers both roles.
          feePayer: options.signer.address,
          lifetime,
          kind: CloseKind.Standard,
        });
        // The send and the wait for its confirmation share one time limit.
        const giveUpAt = Date.now() + closeRequestTimeoutMs;
        signature = signatureOf(transaction);
        try {
          await rpc
            .sendTransaction(transaction as Base64EncodedWireTransaction, { encoding: "base64", preflightCommitment: "confirmed" })
            .send({ abortSignal: AbortSignal.timeout(closeRequestTimeoutMs) });
        } catch (error) {
          // An error answer: the node refused the close without taking it, so it cannot land.
          if (refusedByNode(error)) return { kind: "next", reason: `the client's own close failed (${describeError(error)})` };
          throw error;
        }
        const confirmation =
          (await within(waitForConfirmation(rpc, signature, lifetime.blockhash), giveUpAt - Date.now())) ?? `not confirmed within ${closeRequestTimeoutMs} ms`;
        if (confirmation !== "confirmed") {
          const still = confirmation === "expired" ? {} : { pending: { transaction: signature, via: "unilateral" as const } };
          return { kind: "next", reason: `the client's own close ${signature} is ${confirmation}`, ...still };
        }
        const event = await within(fetchClosedEvent(rpc, signature, EVENT_READ_RETRY), requestTimeoutMs).catch(() => undefined);
        return { kind: "closed", receipt: { ...(event ? amountsOf(event) : {}), transaction: signature, via: "unilateral" } };
      } catch (error) {
        // A close the node may have taken, and that did not fail on the chain, may still land: its signature is passed on.
        if (signature && !(error instanceof TransactionFailedError)) {
          const reason = `the client's own close ${signature} was sent, but its confirmation could not be read (${describeError(error)})`;
          return { kind: "next", reason, pending: { transaction: signature, via: "unilateral" } };
        }
        if (timedOut(error)) return { kind: "next", reason: `the client sent no close of its own: its node did not answer within ${requestTimeoutMs} ms` };
        return { kind: "next", reason: `the client's own close failed (${describeError(error)})` };
      }
    }

    const session: StintSession = {
      id: address(opened.session),
      gateUrl,
      get paidUntil() {
        return paidUntil;
      },
      wsUrl: opened.wsUrl,
      get cost() {
        return cost;
      },
      async connect() {
        const socket = new WebSocket(opened.wsUrl, { headers: { authorization: `Bearer ${await token("connect")}` } });
        await new Promise<void>((resolve, reject) => {
          socket.once("open", () => resolve());
          socket.once("unexpected-response", (_, response) =>
            reject(new StintError(`The gate refused the connection (HTTP ${response.statusCode})`, response.statusCode)),
          );
          socket.once("error", reject);
        });
        return socket;
      },
      async topUp({ seconds }) {
        if (closed) throw new StintError("The session is closed");
        const endpoint = `${gateUrl}/sessions/${opened.session}/top-up?seconds=${seconds}`;
        const required = await offersFrom(endpoint);
        // The entry is echoed exactly as received: the object decoded from the gate's response.
        const entry = required.accepts
          .map(readElapsedRequirements)
          .find((candidate) => candidate?.extra.action === "topUp" && candidate.extra.seconds === seconds);
        // Once its end timer has fired, the gate answers with offers for a new session only, and says why.
        if (!entry) {
          const expired = required.error === "session_expired";
          throw new StintError(expired ? "The session's paid time has run out: it cannot be extended" : `No top-up offer for ${seconds} s`, 402, required);
        }
        const check = checkTopUp(options.policy, entry, seconds, {
          opened: offer,
          session: session.id,
          sessionTotal: cost,
          locked: locked(),
          signer: options.signer.address,
        });
        if (!check.ok) throw new StintError(`Policy refuses the top-up: ${check.reason}`);
        // Reserved in the same synchronous step as the check, against the period budget and maxPerSession alike.
        const release = reserve(check.amount);
        cost += check.amount;
        const undo = () => {
          release();
          cost -= check.amount;
        };
        let signature: string;
        try {
          const transaction = await buildTopUpTransaction({ requirements: entry, authority: options.signer, decimals: check.decimals });
          const payload: PaymentPayload = {
            x402Version: X402_VERSION,
            resource: required.resource,
            accepted: entry,
            payload: { type: "topUp", transaction },
          };
          signature = encodePaymentSignatureHeader(payload);
        } catch (error) {
          undo(); // nothing was sent
          throw error;
        }
        const answer = await send(endpoint, signature);
        // Refused before settlement, so nothing was charged: the route answers 404 before it looks at a payment.
        if (answer.status === 400 || answer.status === 402 || answer.status === 404) {
          undo();
          throw new StintError(`The gate refused the top-up: ${describeBody(answer.body)}`, answer.status, answer.body);
        }
        if (answer.status !== 200) {
          throw new StintError(`The top-up is not confirmed (HTTP ${answer.status}); the payment may still land`, answer.status, answer.body);
        }
        const toppedUp = answer.body as { paidUntil: number };
        paidUntil = Math.max(paidUntil, toppedUp.paidUntil);
        return { paidUntil: toppedUp.paidUntil, cost: check.amount };
      },
      async status() {
        const response = await fetch(`${gateUrl}/sessions/${opened.session}`);
        const body = await readBody(response);
        if (response.status === 404) throw new StintError("The session is closed, or was never opened", 404, body);
        if (response.status !== 200) throw new StintError(`Status failed (HTTP ${response.status}): ${describeBody(body)}`, response.status, body);
        return body as SessionStatus;
      },
      async close() {
        // Overlapping calls share one chain: two chains would each send a close, and only one can land.
        closing ??= closeWithFallbacks().finally(() => {
          closing = undefined;
        });
        const receipt = await closing;
        closed = true;
        return receipt;
      },
      async [Symbol.asyncDispose]() {
        if (!closed) await session.close();
      },
    };
    return session;
  }

  return {
    remainingBudget: () => options.policy.budget.amount - locked(),

    async open(url, { seconds } = {}) {
      const gateUrl = url.replace(/\/+$/, "");
      const endpoint = `${gateUrl}/sessions${seconds === undefined ? "" : `?seconds=${seconds}`}`;
      const required = await offersFrom(endpoint);

      // The entry is echoed exactly as received: the object decoded from the gate's response.
      const offer = required.accepts
        .map(readElapsedRequirements)
        .find((entry) => entry?.extra.action === "open" && (seconds === undefined || entry.extra.seconds === seconds));
      if (!offer) throw new StintError(`No elapsed offer${seconds === undefined ? "" : ` for ${seconds} s`}`);
      const check = checkOffer(options.policy, offer, seconds ?? offer.extra.seconds, locked(), options.signer.address);
      if (!check.ok) throw new StintError(`Policy refuses the offer: ${check.reason}`);

      // Reserved in the same synchronous step as the check, so that concurrent opens cannot both pass against the same
      // locked amount.
      const release = reserve(check.amount);
      let built: Awaited<ReturnType<typeof buildOpenTransaction>>;
      let signature: string;
      try {
        built = await buildOpenTransaction({ requirements: offer, authority: options.signer, decimals: check.decimals });
        const payload: PaymentPayload = {
          x402Version: X402_VERSION,
          resource: required.resource,
          accepted: offer,
          payload: { type: "open", transaction: built.transaction, session: built.session },
        };
        signature = encodePaymentSignatureHeader(payload);
      } catch (error) {
        release(); // nothing was sent
        throw error;
      }
      const answer = await send(endpoint, signature);
      if (answer.status === 402 || answer.status === 400) {
        release(); // refused before settlement: nothing was charged
        throw new StintError(`The gate refused the payment: ${describeBody(answer.body)}`, answer.status, answer.body);
      }
      if (answer.status !== 201) {
        throw new StintError(`The open is not confirmed (HTTP ${answer.status}); the payment may still land`, answer.status, answer.body);
      }
      const opened = answer.body as { session: string; paidUntil: number; wsUrl: string };
      if (opened.session !== built.session) throw new StintError("The gate reported another session", 201, answer.body);
      return sessionFrom(gateUrl, opened, offer, check.amount);
    },
  };
}
