import type { PaymentPayload, PaymentRequirements, SettleResponse, SupportedResponse, VerifyResponse } from "@lxfoundry/stint-x402";

/** The facilitator's interface for resource servers (spec §6.1). */
export interface FacilitatorClient {
  supported(): Promise<SupportedResponse>;
  verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse>;
  settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse>;
}

/**
 * How long a request to the facilitator may go without an answer: longer than the facilitator waits for a settlement to
 * confirm before it answers `settlement_pending` (30 s by default).
 */
export const DEFAULT_FACILITATOR_TIMEOUT_MS = 60_000;

export function createFacilitatorClient(url: string, apiKey: string, options: { readonly timeoutMs?: number } = {}): FacilitatorClient {
  const timeoutMs = options.timeoutMs ?? DEFAULT_FACILITATOR_TIMEOUT_MS;
  async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    try {
      const response = await fetch(`${url}${path}`, {
        method,
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new Error(`Facilitator ${path}: HTTP ${response.status} ${await response.text()}`);
      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") throw new Error(`Facilitator ${path}: no answer within ${timeoutMs} ms`, { cause: error });
      throw error;
    }
  }
  return {
    supported: () => call("GET", "/supported"),
    verify: (paymentPayload, paymentRequirements) =>
      call("POST", "/verify", { x402Version: 2, paymentPayload, paymentRequirements }),
    settle: (paymentPayload, paymentRequirements) =>
      call("POST", "/settle", { x402Version: 2, paymentPayload, paymentRequirements }),
  };
}
