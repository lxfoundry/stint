import {
  HEADERS,
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  decodePaymentSignatureHeader,
  readElapsedRequirements,
  redactUrls,
  type ElapsedRequirements,
} from "@lxfoundry/stint-x402";
import { formatUsdc } from "../app/model.js";
import { explorerAddress, explorerTx } from "./links.js";
import type { ExchangeRow } from "./state.js";

/** The gate's two paid routes (spec §7.1): an open, `POST /sessions`, and a top-up, `POST /sessions/:id/top-up`. */
export type GateAction = "open" | "topUp";

/** Where the recorder reports. */
export interface ExchangeSink {
  row(row: ExchangeRow): void;
  /** The entry of a 402 for the request's action: the terms the payment that follows is for. */
  offer(action: GateAction, entry: ElapsedRequirements): void;
  /** A payment the gate settled, with the signature of its transaction (`PAYMENT-RESPONSE`). */
  settled(action: GateAction, transaction: string): void;
}

type Fetch = typeof globalThis.fetch;

const STATUS_TEXT: Readonly<Record<number, string>> = {
  200: "OK",
  201: "Created",
  202: "Accepted",
  400: "Bad Request",
  401: "Unauthorized",
  402: "Payment Required",
  404: "Not Found",
  409: "Conflict",
  500: "Internal Server Error",
  502: "Bad Gateway",
};
const statusLine = (response: Response): string => `${response.status} ${STATUS_TEXT[response.status] ?? response.statusText}`.trim();
const TOP_UP_PATH = /^\/sessions\/[1-9A-HJ-NP-Za-km-z]{32,44}\/top-up$/;

/** `ABCD…WXYZ`: an address or a signature, short enough for a row. */
export const shortened = (text: string): string => (text.length > 12 ? `${text.slice(0, 4)}…${text.slice(-4)}` : text);

/** Which paid route of the gate at `gateUrl` a request is, or undefined for anything else. */
export function gateRouteOf(gateUrl: string, method: string, url: string): { readonly action: GateAction; readonly path: string } | undefined {
  if (method !== "POST" || !URL.canParse(url)) return undefined;
  const gate = new URL(gateUrl);
  const target = new URL(url);
  const prefix = gate.pathname.replace(/\/+$/, "");
  if (target.origin !== gate.origin || !target.pathname.startsWith(`${prefix}/`)) return undefined;
  const rest = target.pathname.slice(prefix.length);
  const path = `${target.pathname}${target.search}`;
  if (rest === "/sessions") return { action: "open", path };
  if (TOP_UP_PATH.test(rest)) return { action: "topUp", path };
  return undefined;
}

function requestOf(input: Parameters<Fetch>[0], init: RequestInit | undefined): { url: string; method: string; headers: Headers } {
  if (input instanceof Request) {
    return { url: input.url, method: (init?.method ?? input.method).toUpperCase(), headers: new Headers(init?.headers ?? input.headers) };
  }
  return { url: input instanceof URL ? input.href : input, method: (init?.method ?? "GET").toUpperCase(), headers: new Headers(init?.headers) };
}

/** A header that cannot be decoded. It names the header and never carries its value, which a decoder's error would quote. */
class HeaderError extends Error {
  override name = "HeaderError";
}

function decoded<T>(header: string, decode: (value: string) => T, value: string): T {
  try {
    return decode(value);
  } catch {
    throw new HeaderError(`the ${header} header cannot be decoded`);
  }
}

/**
 * Says on stderr that a row was not recorded, in one line. The message passes through `redactUrls`, and a header's value
 * is never in it. Nothing here throws: the recorder sits between the client and the gate, and fails neither.
 */
function report(error: unknown): void {
  const message = error instanceof HeaderError ? error.message : redactUrls(error instanceof Error ? error.message : String(error));
  try {
    process.stderr.write(`stint-claude-demo: could not record an exchange row: ${message.replace(/\s+/g, " ")}\n`);
  } catch {
    // stderr itself is gone: there is nowhere left to say so.
  }
}

/** Runs `record`; a failure is reported and goes no further. */
function attempt(record: () => void): void {
  try {
    record();
  } catch (error) {
    report(error);
  }
}

function describeOffer(entry: ElapsedRequirements): string {
  const { extra } = entry;
  return `${entry.scheme} · ${formatUsdc(extra.rate)}/s · ${extra.seconds} s · min ${extra.minSeconds} s · max ${extra.maxSeconds} s · seller ${shortened(entry.payTo)}`;
}

/** The row of a request that carries `PAYMENT-SIGNATURE`: one transaction that funds the vault and opens or tops up. */
function paymentRow(action: GateAction, header: string, at: number): ExchangeRow {
  let amount: string | undefined;
  try {
    amount = readElapsedRequirements(decoded(HEADERS.paymentSignature, decodePaymentSignatureHeader, header).accepted)?.amount;
  } catch (error) {
    report(error);
  }
  const into = action === "open" ? "vault + open" : "vault + top-up";
  return { kind: "payment", at, label: "PAYMENT-SIGNATURE", detail: `one transaction: ${amount === undefined ? "the deposit" : formatUsdc(amount)} → ${into}` };
}

async function excerpt(response: Response): Promise<string> {
  try {
    return redactUrls((await response.clone().text()).slice(0, 200));
  } catch (error) {
    report(error);
    return "";
  }
}

/**
 * A `fetch` that records, through `sink`, the x402 exchanges with the gate at `gateUrl` (spec §5): for each POST to
 * its paid routes, the request line or the payment it carries, then the 402 and its terms, the settled transaction,
 * or the refusal. Every other request goes to `base` untouched, and every answer, recorded or not, is returned as `base`
 * gave it: recording reads only headers and clones, and a failure to record is reported on stderr and goes no further.
 */
export function recordExchanges(gateUrl: string, sink: ExchangeSink, base: Fetch, clock: () => number = Date.now): Fetch {
  async function note(action: GateAction, paid: boolean, response: Response): Promise<void> {
    const at = clock();
    if (!paid && response.status === 402) {
      const header = response.headers.get(HEADERS.paymentRequired);
      const required = header === null ? undefined : decoded(HEADERS.paymentRequired, decodePaymentRequiredHeader, header);
      const entry = required?.accepts.map(readElapsedRequirements).find((candidate) => candidate?.extra.action === action);
      if (entry) {
        const link = explorerAddress(entry.payTo);
        sink.offer(action, entry);
        sink.row({ kind: "payment-required", at, label: statusLine(response), detail: describeOffer(entry), ...(link ? { link } : {}) });
      } else {
        sink.row({ kind: "error", at, label: statusLine(response), detail: required?.error ?? "no offer for this request" });
      }
      return;
    }
    if (paid && (response.status === 200 || response.status === 201)) {
      const header = response.headers.get(HEADERS.paymentResponse);
      const transaction = header === null ? undefined : decoded(HEADERS.paymentResponse, decodePaymentResponseHeader, header).transaction;
      const link = transaction ? explorerTx(transaction) : undefined;
      if (transaction) sink.settled(action, transaction);
      sink.row({
        kind: "settled",
        at,
        label: statusLine(response),
        ...(transaction ? { detail: `transaction ${shortened(transaction)}` } : {}),
        ...(link ? { link } : {}),
      });
      return;
    }
    const refused = paid && response.status === 402 ? response.headers.get(HEADERS.paymentRequired) : null;
    const detail =
      refused === null ? await excerpt(response) : (decoded(HEADERS.paymentRequired, decodePaymentRequiredHeader, refused).error ?? "payment refused");
    sink.row({ kind: "error", at, label: statusLine(response), detail });
  }

  return async (input, init) => {
    let seen: { route: { readonly action: GateAction; readonly path: string }; signature: string | null } | undefined;
    try {
      const request = requestOf(input, init);
      const route = gateRouteOf(gateUrl, request.method, request.url);
      if (route) seen = { route, signature: request.headers.get(HEADERS.paymentSignature) };
    } catch (error) {
      report(error);
    }
    if (!seen) return base(input, init);

    const { route, signature } = seen;
    attempt(() => sink.row(signature === null ? { kind: "request", at: clock(), label: `POST ${route.path}` } : paymentRow(route.action, signature, clock())));
    let response: Response;
    try {
      response = await base(input, init);
    } catch (error) {
      attempt(() =>
        sink.row({ kind: "error", at: clock(), label: "No answer from the gate", detail: redactUrls(error instanceof Error ? error.message : String(error)) }),
      );
      throw error;
    }
    await note(route.action, signature !== null, response).catch(report);
    return response;
  };
}
