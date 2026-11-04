import {
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_MIN_CONTEXT_SLOT_NOT_REACHED,
  containsBytes,
  fetchEncodedAccount,
  isSolanaError,
  parseBase64RpcAccount,
  signature as toSignature,
  type Address,
  type MaybeEncodedAccount,
  type Rpc,
  type RpcSubscriptions,
  type SolanaRpcApi,
  type SolanaRpcSubscriptionsApi,
} from "@solana/kit";
import {
  SESSION_DISCRIMINATOR,
  STINT_PROGRAM_ADDRESS,
  decodeSession,
  getSessionSize,
  type ClosedEvent,
  type Session,
} from "@lxfoundry/stint-program-client";
import { fetchClosedEvent, findClose } from "@lxfoundry/stint-x402";

/** The chain reads the gate needs, so tests can replace them. */
export interface GateChain {
  latestBlockhash(): Promise<{ readonly blockhash: string; readonly lastValidBlockHeight: bigint }>;
  /** The session at `confirmed`, or undefined when the address holds no Stint session. */
  readSession(session: Address): Promise<Session | undefined>;
  /**
   * The session at `confirmed` as it stands once the confirmed transaction `signature` has run (spec §7.3), from a node
   * at or past that transaction's slot: `stored` is undefined when the address then holds no Stint session. Undefined
   * while the node does not show the transaction confirmed yet, or has not reached its slot. One look: the gate repeats
   * it within `readRetry`. Optional: a gate whose chain cannot read after a transaction reads the session with
   * `readSession` once a top-up has settled, a read that can lag the transaction and so find an earlier end, never a
   * later one.
   */
  readSessionAfter?(session: Address, signature: string): Promise<{ readonly stored: Session | undefined } | undefined>;
  closedEvent(signature: string): Promise<ClosedEvent | undefined>;
  /**
   * The `Closed` event of the newest successful close of the session at `session` (spec §7.3, "Account closed by another
   * party"), from the address's transactions at `confirmed`, which a node still lists once the account is gone. Undefined
   * while none shows. One look, each listed transaction read once: the gate repeats the look for about 2 s at most,
   * passing the same `notCloses`, so that a transaction read and found to hold no close is not read again.
   * Optional: a gate whose chain cannot look a close up compares its session clock with the last `paid_until` it saw.
   */
  lastClose?(session: Address, notCloses?: Set<string>): Promise<ClosedEvent | undefined>;
  /**
   * Follows the account at `session` at `confirmed` (spec §7.3): `onChange` receives the session after each change to the
   * account, or undefined once the address holds no Stint session; `onError` receives a subscription that failed or ended,
   * after which nothing more is reported. Returns what ends the subscription. Optional: a gate whose chain cannot follow an
   * account finds a top-up it did not settle when its end timer fires.
   */
  watchSession?(session: Address, onChange: (stored: Session | undefined) => void, onError: (error: unknown) => void): () => void;
}

/** The session an account holds, or undefined: no account, a wallet, an account of another program, or a closed one. */
function sessionIn(account: MaybeEncodedAccount): Session | undefined {
  if (!account.exists || account.programAddress !== STINT_PROGRAM_ADDRESS) return undefined;
  if (account.data.length < getSessionSize() || !containsBytes(account.data, SESSION_DISCRIMINATOR, 0)) return undefined;
  return decodeSession(account).data;
}

/** The chain over an RPC client and, to follow session accounts, an RPC subscriptions client. */
export function createRpcChain(rpc: Rpc<SolanaRpcApi>, subscriptions?: RpcSubscriptions<SolanaRpcSubscriptionsApi>): GateChain {
  const chain: GateChain = {
    latestBlockhash: async () => (await rpc.getLatestBlockhash({ commitment: "confirmed" }).send()).value,
    // Any address can be asked about: a wallet, or an account of another program, is not a session.
    readSession: async (session) => sessionIn(await fetchEncodedAccount(rpc, session, { commitment: "confirmed" })),
    async readSessionAfter(session, signature) {
      // In the node's transaction history too: a payment settled again can be answered from a record older than the
      // node's recent statuses.
      const { value } = await rpc.getSignatureStatuses([toSignature(signature)], { searchTransactionHistory: true }).send();
      const status = value[0];
      if (status?.confirmationStatus !== "confirmed" && status?.confirmationStatus !== "finalized") return undefined;
      try {
        const account = await fetchEncodedAccount(rpc, session, { commitment: "confirmed", minContextSlot: status.slot });
        return { stored: sessionIn(account) };
      } catch (error) {
        if (isSolanaError(error, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_MIN_CONTEXT_SLOT_NOT_REACHED)) return undefined;
        throw error;
      }
    },
    closedEvent: (signature) => fetchClosedEvent(rpc, signature),
    lastClose: async (session, notCloses) => (await findClose(rpc, session, undefined, notCloses))?.event,
  };
  if (!subscriptions) return chain;
  return {
    ...chain,
    watchSession(session, onChange, onError) {
      const controller = new AbortController();
      (async () => {
        const notifications = await subscriptions
          .accountNotifications(session, { commitment: "confirmed", encoding: "base64" })
          .subscribe({ abortSignal: controller.signal });
        for await (const { value } of notifications) {
          // Typed as possibly missing, the account parses to a `MaybeEncodedAccount`, as a read's does.
          onChange(sessionIn(parseBase64RpcAccount(session, value as typeof value | null)));
        }
        throw new Error(`${session}: notifications ended`);
      })().catch((error: unknown) => {
        // Ending the subscription ends its notifications too: that is not a failure.
        if (!controller.signal.aborted) onError(error);
      });
      return () => controller.abort();
    },
  };
}
