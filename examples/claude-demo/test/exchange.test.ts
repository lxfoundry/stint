import {
  HEADERS,
  SOLANA_DEVNET,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
  encodePaymentSignatureHeader,
  type ElapsedRequirements,
  type PaymentRequired,
} from "@lxfoundry/stint-x402";
import { afterEach, describe, expect, it, vi } from "vitest";
import { gateRouteOf, recordExchanges, shortened, type ExchangeSink, type GateAction } from "../src/exchange.js";
import type { ExchangeRow } from "../src/state.js";
import { GATE, SELLER, SESSION, offer, signatureOf } from "./fixtures.js";

type Fetch = typeof globalThis.fetch;

/** A `fetch` that answers with `answers` in order, recording each request's URL, and fails once they run out. */
function fakeFetch(answers: Response[]): { fetch: Fetch; urls: string[] } {
  const urls: string[] = [];
  const fetch = (async (input: string | URL | Request) => {
    urls.push(String(input));
    const next = answers.shift();
    if (!next) throw new TypeError("fetch failed");
    return next;
  }) as Fetch;
  return { fetch, urls };
}

function recorder(): { sink: ExchangeSink; rows: ExchangeRow[]; offers: [GateAction, ElapsedRequirements][]; settled: [GateAction, string][] } {
  const rows: ExchangeRow[] = [];
  const offers: [GateAction, ElapsedRequirements][] = [];
  const settled: [GateAction, string][] = [];
  return {
    sink: {
      row: (row) => void rows.push(row),
      offer: (action, entry) => void offers.push([action, entry]),
      settled: (action, transaction) => void settled.push([action, transaction]),
    },
    rows,
    offers,
    settled,
  };
}

/** Captures what the recorder writes to stderr; `afterEach` restores it. */
function stderrLines(): string[] {
  const lines: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write);
  return lines;
}

afterEach(() => {
  vi.restoreAllMocks();
});

const paymentRequired = (entry: ElapsedRequirements, error?: string): Response => {
  const body: PaymentRequired = { x402Version: 2, ...(error ? { error } : {}), resource: { url: `${GATE}/sessions` }, accepts: [entry] };
  return new Response(JSON.stringify(body), { status: 402, headers: { [HEADERS.paymentRequired]: encodePaymentRequiredHeader(body) } });
};
const settledWith = (status: 200 | 201, transaction: string): Response =>
  new Response("{}", {
    status,
    headers: { [HEADERS.paymentResponse]: encodePaymentResponseHeader({ success: true, transaction, network: SOLANA_DEVNET }) },
  });
const signed = (entry: ElapsedRequirements): string =>
  encodePaymentSignatureHeader({
    x402Version: 2,
    resource: { url: `${GATE}/sessions` },
    accepted: entry,
    payload: { type: "open", transaction: "AQ==", session: SESSION },
  });

describe("the gate's paid routes", () => {
  it("are an open and a top-up, posted to the gate's own origin", () => {
    expect(gateRouteOf(GATE, "POST", `${GATE}/sessions?seconds=100`)).toEqual({ action: "open", path: "/sessions?seconds=100" });
    expect(gateRouteOf(GATE, "POST", `${GATE}/sessions/${SESSION}/top-up?seconds=100`)).toEqual({
      action: "topUp",
      path: `/sessions/${SESSION}/top-up?seconds=100`,
    });
    expect(gateRouteOf(GATE, "GET", `${GATE}/sessions/${SESSION}`)).toBeUndefined();
    expect(gateRouteOf(GATE, "POST", `${GATE}/sessions/${SESSION}/close`)).toBeUndefined();
    expect(gateRouteOf(GATE, "POST", "https://api.devnet.solana.com/sessions")).toBeUndefined();
  });
});

describe("the exchange recorder", () => {
  it("records an open: the request, the 402 and its terms, the payment, and the settled transaction", async () => {
    const { sink, rows, offers, settled } = recorder();
    const entry = offer("open");
    const transaction = signatureOf(7);
    const fetch = recordExchanges(GATE, sink, fakeFetch([paymentRequired(entry), settledWith(201, transaction)]).fetch, () => 1_000);

    await fetch(`${GATE}/sessions?seconds=100`, { method: "POST" });
    await fetch(`${GATE}/sessions?seconds=100`, { method: "POST", headers: { [HEADERS.paymentSignature]: signed(entry) } });

    expect(rows).toEqual([
      { kind: "request", at: 1_000, label: "POST /sessions?seconds=100" },
      {
        kind: "payment-required",
        at: 1_000,
        label: "402 Payment Required",
        detail: `elapsed · 0.001 USDC/s · 100 s · min 5 s · max 1000 s · seller ${shortened(SELLER)}`,
        link: `https://explorer.solana.com/address/${SELLER}?cluster=devnet`,
      },
      { kind: "payment", at: 1_000, label: "PAYMENT-SIGNATURE", detail: "one transaction: 0.100 USDC → vault + open" },
      {
        kind: "settled",
        at: 1_000,
        label: "201 Created",
        detail: `transaction ${shortened(transaction)}`,
        link: `https://explorer.solana.com/tx/${transaction}?cluster=devnet`,
      },
    ]);
    expect(offers).toEqual([["open", entry]]);
    expect(settled).toEqual([["open", transaction]]);
  });

  it("records a top-up's 402 and its 200", async () => {
    const { sink, rows, settled } = recorder();
    const entry = offer("topUp");
    const transaction = signatureOf(8);
    const fetch = recordExchanges(GATE, sink, fakeFetch([paymentRequired(entry), settledWith(200, transaction)]).fetch);
    const url = `${GATE}/sessions/${SESSION}/top-up?seconds=100`;

    await fetch(url, { method: "POST" });
    await fetch(url, { method: "POST", headers: { [HEADERS.paymentSignature]: signed(entry) } });

    expect(rows.map((row) => row.label)).toEqual([`POST /sessions/${SESSION}/top-up?seconds=100`, "402 Payment Required", "PAYMENT-SIGNATURE", "200 OK"]);
    expect(rows[2]?.detail).toBe("one transaction: 0.100 USDC → vault + top-up");
    expect(settled).toEqual([["topUp", transaction]]);
  });

  it("passes every other request through untouched, and records nothing", async () => {
    const { sink, rows } = recorder();
    const answers = [new Response("a"), new Response("b"), new Response("c")];
    const first = answers[0];
    const base = fakeFetch(answers);
    const fetch = recordExchanges(GATE, sink, base.fetch);

    expect(await fetch(`${GATE}/sessions/${SESSION}`)).toBe(first);
    await fetch(`${GATE}/sessions/${SESSION}/close`, { method: "POST" });
    await fetch("https://api.devnet.solana.com", { method: "POST", body: "{}" });

    expect(rows).toEqual([]);
    expect(base.urls).toEqual([`${GATE}/sessions/${SESSION}`, `${GATE}/sessions/${SESSION}/close`, "https://api.devnet.solana.com"]);
  });

  it("records a refused payment with the gate's reason, and a gate that cannot be reached", async () => {
    const { sink, rows } = recorder();
    const entry = offer("open");
    const fetch = recordExchanges(GATE, sink, fakeFetch([paymentRequired(entry, "insufficient_funds")]).fetch, () => 5);

    await fetch(`${GATE}/sessions?seconds=100`, { method: "POST", headers: { [HEADERS.paymentSignature]: signed(entry) } });
    await expect(fetch(`${GATE}/sessions?seconds=100`, { method: "POST" })).rejects.toThrow("fetch failed");

    expect(rows).toEqual([
      { kind: "payment", at: 5, label: "PAYMENT-SIGNATURE", detail: "one transaction: 0.100 USDC → vault + open" },
      { kind: "error", at: 5, label: "402 Payment Required", detail: "insufficient_funds" },
      { kind: "request", at: 5, label: "POST /sessions?seconds=100" },
      { kind: "error", at: 5, label: "No answer from the gate", detail: "fetch failed" },
    ]);
  });

  it("records a settled payment whose transaction is not a valid signature, without a link and without a log line", async () => {
    const { sink, rows, settled } = recorder();
    const lines = stderrLines();
    const entry = offer("open");
    // A signature's length, with a character outside base58: `isSignature` throws on it rather than answering false.
    const transaction = `${signatureOf(7).slice(0, -1)}0`;
    const fetch = recordExchanges(GATE, sink, fakeFetch([settledWith(201, transaction)]).fetch, () => 1);

    const response = await fetch(`${GATE}/sessions?seconds=100`, { method: "POST", headers: { [HEADERS.paymentSignature]: signed(entry) } });

    expect(response.status).toBe(201);
    expect(rows.map((row) => row.kind)).toEqual(["payment", "settled"]);
    expect(rows[1]).toEqual({ kind: "settled", at: 1, label: "201 Created", detail: `transaction ${shortened(transaction)}` });
    expect(settled).toEqual([["open", transaction]]);
    expect(lines).toEqual([]);
  });
});

describe("a failure to record", () => {
  it("leaves the response intact and writes one line to stderr, never the header's raw value", async () => {
    const { sink, rows, offers } = recorder();
    const lines = stderrLines();
    const raw = "not-base64-secret-marker!!";
    const answer = new Response("body of the 402", { status: 402, headers: { [HEADERS.paymentRequired]: raw } });
    const fetch = recordExchanges(GATE, sink, fakeFetch([answer]).fetch, () => 1);

    const response = await fetch(`${GATE}/sessions?seconds=100`, { method: "POST" });

    expect(response).toBe(answer);
    expect(response.status).toBe(402);
    expect(response.headers.get(HEADERS.paymentRequired)).toBe(raw);
    expect(await response.text()).toBe("body of the 402");
    expect(rows).toEqual([{ kind: "request", at: 1, label: "POST /sessions?seconds=100" }]);
    expect(offers).toEqual([]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^stint-claude-demo: could not record an exchange row: .+\n$/);
    expect(lines[0]).not.toContain("secret-marker");
  });

  it("does the same for a malformed PAYMENT-RESPONSE on a payment the gate accepted", async () => {
    const { sink, rows, settled } = recorder();
    const lines = stderrLines();
    const entry = offer("open");
    const answer = new Response("{}", { status: 201, headers: { [HEADERS.paymentResponse]: "{{secret-marker" } });
    const fetch = recordExchanges(GATE, sink, fakeFetch([answer]).fetch, () => 1);

    const response = await fetch(`${GATE}/sessions?seconds=100`, { method: "POST", headers: { [HEADERS.paymentSignature]: signed(entry) } });

    expect(response).toBe(answer);
    expect(rows.map((row) => row.kind)).toEqual(["payment"]);
    expect(settled).toEqual([]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("secret-marker");
  });

  it("still sends a payment row, and logs, when the PAYMENT-SIGNATURE cannot be read", async () => {
    const { sink, rows } = recorder();
    const lines = stderrLines();
    const answer = new Response("{}", { status: 200 });
    const fetch = recordExchanges(GATE, sink, fakeFetch([answer]).fetch, () => 1);

    const response = await fetch(`${GATE}/sessions/${SESSION}/top-up?seconds=100`, {
      method: "POST",
      headers: { [HEADERS.paymentSignature]: "%%secret-marker%%" },
    });

    expect(response).toBe(answer);
    expect(rows[0]).toEqual({ kind: "payment", at: 1, label: "PAYMENT-SIGNATURE", detail: "one transaction: the deposit → vault + top-up" });
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("secret-marker");
  });

  it("never throws into the client when the sink does, and redacts the URLs of the line it logs", async () => {
    const lines = stderrLines();
    const sink: ExchangeSink = {
      row: () => {
        throw new Error("write to https://rpc.example/v2?api-key=secret-marker failed");
      },
      offer: () => undefined,
      settled: () => undefined,
    };
    const answer = new Response("{}", { status: 200 });
    const fetch = recordExchanges(GATE, sink, fakeFetch([answer]).fetch, () => 1);

    await expect(fetch(`${GATE}/sessions/${SESSION}/top-up`, { method: "POST" })).resolves.toBe(answer);

    // The request row, then the answer's row: one line each.
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line).toContain("stint-claude-demo: could not record an exchange row:");
      expect(line).not.toContain("secret-marker");
    }
    expect(lines.join("")).toContain("https://rpc.example");
  });

  it("redacts the URLs in the error of a gate that cannot be reached, which a row shows", async () => {
    const { sink, rows } = recorder();
    const base = (async () => {
      throw new TypeError("connect to https://gate.internal/path?token=secret-marker failed");
    }) as unknown as Fetch;
    const fetch = recordExchanges(GATE, sink, base, () => 1);

    await expect(fetch(`${GATE}/sessions`, { method: "POST" })).rejects.toThrow(TypeError);

    expect(rows[1]).toEqual({ kind: "error", at: 1, label: "No answer from the gate", detail: "connect to https://gate.internal failed" });
  });
});
