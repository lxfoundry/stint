import { address, type Address, type KeyPairSigner } from "@solana/kit";
import {
  HEADERS,
  X402_VERSION,
  buildOpenTransaction,
  createSessionToken,
  decodePaymentRequiredHeader,
  encodePaymentSignatureHeader,
  readElapsedRequirements,
  type PaymentPayload,
  type PaymentRequired,
  type SessionStatus,
  type TokenPurpose,
} from "@lxfoundry/stint-x402";
import { WebSocket } from "ws";
import { checkOffer, type Policy } from "./policy.js";

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

export interface StintSession {
  readonly id: Address;
  readonly gateUrl: string;
  /** Unix seconds. */
  readonly paidUntil: number;
  readonly wsUrl: string;
  /** The deposit, in base units. */
  readonly cost: bigint;
  connect(): Promise<WebSocket>;
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

  function sessionFrom(gateUrl: string, opened: { session: string; paidUntil: number; wsUrl: string }, cost: bigint): StintSession {
    const audience = new URL(gateUrl).origin;
    const token = (purpose: TokenPurpose) => createSessionToken(options.signer, { session: opened.session, audience, purpose });
    let closed = false;
    const session: StintSession = {
      id: address(opened.session),
      gateUrl,
      paidUntil: opened.paidUntil,
      wsUrl: opened.wsUrl,
      cost,
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
      const first = await fetch(endpoint, { method: "POST" });
      if (first.status !== 402) {
        const body = await readBody(first);
        throw new StintError(`Expected 402 from ${endpoint}, got ${first.status}: ${describeBody(body)}`, first.status, body);
      }
      const header = first.headers.get(HEADERS.paymentRequired);
      const required = (header ? decodePaymentRequiredHeader(header) : await first.json()) as PaymentRequired;
      if (required.x402Version !== X402_VERSION) throw new StintError(`x402Version ${required.x402Version} is not supported`);

      // The entry is echoed exactly as received: the object decoded from the gate's response.
      const offer = required.accepts
        .map(readElapsedRequirements)
        .find((entry) => entry?.extra.action === "open" && (seconds === undefined || entry.extra.seconds === seconds));
      if (!offer) throw new StintError(`No elapsed offer${seconds === undefined ? "" : ` for ${seconds} s`}`);
      const check = checkOffer(options.policy, offer, seconds ?? offer.extra.seconds, locked(), options.signer.address);
      if (!check.ok) throw new StintError(`Policy refuses the offer: ${check.reason}`);

      // Reserved in the same synchronous step as the check, so that concurrent opens cannot
      // both pass against the same locked amount. Once signed, the payment may land whatever
      // the answer, so the entry stays unless the gate refused it before settlement.
      const entry = { at: now(), amount: check.amount };
      ledger.push(entry);
      const release = () => {
        const index = ledger.indexOf(entry);
        if (index >= 0) ledger.splice(index, 1);
      };
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
      const second = await fetch(endpoint, {
        method: "POST",
        headers: { [HEADERS.paymentSignature]: signature },
      });
      const body = await readBody(second);
      if (second.status === 402 || second.status === 400) {
        release(); // refused before settlement: nothing was charged
        throw new StintError(`The gate refused the payment: ${describeBody(body)}`, second.status, body);
      }
      if (second.status !== 201) {
        throw new StintError(`The open is not confirmed (HTTP ${second.status}); the payment may still land`, second.status, body);
      }
      const opened = body as { session: string; paidUntil: number; wsUrl: string };
      if (opened.session !== built.session) throw new StintError("The gate reported another session", 201, body);
      return sessionFrom(gateUrl, opened, check.amount);
    },
  };
}
