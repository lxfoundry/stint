import { address, type Address, type KeyPairSigner } from "@solana/kit";
import {
  HEADERS,
  X402_VERSION,
  buildOpenTransaction,
  buildTopUpTransaction,
  createSessionToken,
  decodePaymentRequiredHeader,
  encodePaymentSignatureHeader,
  readElapsedRequirements,
  type ElapsedRequirements,
  type PaymentPayload,
  type PaymentRequired,
  type SessionStatus,
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

/** `paid` and `refunded` are absent when the gate could not read the `Closed` event of a confirmed close. */
export interface CloseReceipt {
  readonly paid?: bigint;
  readonly refunded?: bigint;
  readonly transaction: string;
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

/** The buyer's runtime (spec §9.4). It needs only a signer: no SOL and no node access (spec §9.1). */
export function createStintClient(options: ClientOptions): StintClient {
  const now = options.now ?? Date.now;
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
        const response = await fetch(`${gateUrl}/sessions/${opened.session}/close`, {
          method: "POST",
          headers: { authorization: `Bearer ${await token("close")}` },
        });
        const body = await readBody(response);
        if (response.status !== 200) throw new StintError(`Close failed (HTTP ${response.status}): ${describeBody(body)}`, response.status, body);
        closed = true;
        const receipt = body as { paid?: string; refunded?: string; transaction: string };
        return {
          ...(receipt.paid === undefined ? {} : { paid: BigInt(receipt.paid) }),
          ...(receipt.refunded === undefined ? {} : { refunded: BigInt(receipt.refunded) }),
          transaction: receipt.transaction,
        };
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
