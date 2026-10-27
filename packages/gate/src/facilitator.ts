import type { PaymentPayload, PaymentRequirements, SettleResponse, SupportedResponse, VerifyResponse } from "@lxfoundry/stint-x402";

/** The facilitator's interface for resource servers (spec §6.1). */
export interface FacilitatorClient {
  supported(): Promise<SupportedResponse>;
  verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse>;
  settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse>;
}

export function createFacilitatorClient(url: string, apiKey: string): FacilitatorClient {
  async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${url}${path}`, {
      method,
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new Error(`Facilitator ${path}: HTTP ${response.status} ${await response.text()}`);
    return (await response.json()) as T;
  }
  return {
    supported: () => call("GET", "/supported"),
    verify: (paymentPayload, paymentRequirements) =>
      call("POST", "/verify", { x402Version: 2, paymentPayload, paymentRequirements }),
    settle: (paymentPayload, paymentRequirements) =>
      call("POST", "/settle", { x402Version: 2, paymentPayload, paymentRequirements }),
  };
}
