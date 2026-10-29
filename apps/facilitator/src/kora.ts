import type { Base64EncodedWireTransaction } from "@solana/kit";
import { redactUrls } from "@lxfoundry/stint-x402";

/**
 * Kora's JSON-RPC interface, called directly: its TypeScript client does not support the
 * `@solana/kit` major version pinned here (spec section 14, question 5).
 */
export interface KoraClient {
  getPayerSigner(): Promise<{ signer_address: string; payment_address: string }>;
  /** Adds the fee payer's signature to a transaction that already carries the others. */
  signTransaction(transaction: Base64EncodedWireTransaction): Promise<Base64EncodedWireTransaction>;
}

// Kora quotes the RPC URL it called in its errors, and that URL can carry an API key. The message goes on to the
// buyer, so every URL in it is reduced to its scheme and host.
export function createKoraClient(url: string, apiKey: string): KoraClient {
  let id = 0;

  async function call<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
    });
    const text = await response.text();
    if (!response.ok && !text.trimStart().startsWith("{")) {
      throw new Error(redactUrls(`Kora ${method}: HTTP ${response.status} ${response.statusText} ${text}`.trim()));
    }
    const body = JSON.parse(text) as { result?: T; error?: { code: number; message: string } };
    if (body.error) throw new Error(redactUrls(`Kora ${method}: ${body.error.message} (${body.error.code})`));
    if (body.result === undefined) throw new Error(`Kora ${method}: empty response`);
    return body.result;
  }

  return {
    getPayerSigner: () => call("getPayerSigner", {}),
    signTransaction: async (transaction) =>
      (await call<{ signed_transaction: Base64EncodedWireTransaction }>("signTransaction", { transaction }))
        .signed_transaction,
  };
}
