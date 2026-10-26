import { address, type Address, type RpcSubscriptions, type SolanaRpcSubscriptionsApi } from "@solana/kit";
import type { ResourceAdapter } from "@lxfoundry/stint-gate";

/** Accounts one connection may watch (spec §8). */
export const MAX_ACCOUNTS = 10;

export interface ClientMessage {
  readonly op: "subscribe" | "unsubscribe";
  readonly accounts: readonly Address[];
}

export type Parsed =
  | { readonly ok: true; readonly message: ClientMessage }
  | { readonly ok: false; readonly code: "invalid_json" | "invalid_message" | "invalid_address"; readonly message: string };

export function parseClientMessage(text: string): Parsed {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, code: "invalid_json", message: "messages are JSON" };
  }
  const record = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  if ((record.op !== "subscribe" && record.op !== "unsubscribe") || !Array.isArray(record.accounts)) {
    return { ok: false, code: "invalid_message", message: 'expected {"op": "subscribe" | "unsubscribe", "accounts": [...]}' };
  }
  try {
    return { ok: true, message: { op: record.op, accounts: record.accounts.map((account) => address(String(account))) } };
  } catch {
    return { ok: false, code: "invalid_address", message: "accounts are base58 addresses" };
  }
}

const toJson = (value: unknown) => JSON.stringify(value, (_, inner) => (typeof inner === "bigint" ? inner.toString() : inner));

/**
 * Streams account changes at `confirmed` (spec §8). Nothing is provisioned: the stream needs no
 * per-session resource. Subscriptions belong to a connection and end with it.
 */
export function createStreamAdapter(subscriptions: RpcSubscriptions<SolanaRpcSubscriptionsApi>): ResourceAdapter<null> {
  return {
    provision: async () => null,
    attach(_session, socket) {
      const watching = new Map<Address, AbortController>();
      const send = (message: object) => {
        if (socket.readyState === socket.OPEN) socket.send(toJson(message));
      };

      async function watch(account: Address, controller: AbortController): Promise<void> {
        try {
          const notifications = await subscriptions
            .accountNotifications(account, { commitment: "confirmed", encoding: "jsonParsed" })
            .subscribe({ abortSignal: controller.signal });
          for await (const { context, value } of notifications) {
            const parsed = !Array.isArray(value.data);
            send({
              type: "account",
              address: account,
              slot: context.slot,
              lamports: value.lamports,
              owner: value.owner,
              encoding: parsed ? "jsonParsed" : "base64",
              data: Array.isArray(value.data) ? value.data[0] : value.data,
            });
          }
        } catch (error) {
          if (!controller.signal.aborted) {
            send({ type: "error", code: "subscription_failed", message: `${account}: ${error instanceof Error ? error.message : String(error)}` });
          }
        }
      }

      socket.on("message", (data) => {
        const parsed = parseClientMessage(String(data));
        if (!parsed.ok) return send({ type: "error", code: parsed.code, message: parsed.message });
        const { op, accounts } = parsed.message;
        if (op === "unsubscribe") {
          for (const account of accounts) {
            watching.get(account)?.abort();
            watching.delete(account);
          }
          return;
        }
        const added = [...new Set(accounts)].filter((account) => !watching.has(account));
        if (watching.size + added.length > MAX_ACCOUNTS) {
          return send({ type: "error", code: "too_many_accounts", message: `at most ${MAX_ACCOUNTS} accounts per connection` });
        }
        for (const account of added) {
          const controller = new AbortController();
          watching.set(account, controller);
          void watch(account, controller);
        }
      });

      socket.on("close", () => {
        for (const controller of watching.values()) controller.abort();
        watching.clear();
      });
    },
    teardown: async () => {},
  };
}
