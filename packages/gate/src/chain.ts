import type { Address, Rpc, SolanaRpcApi } from "@solana/kit";
import { fetchMaybeSession, type ClosedEvent, type Session } from "@lxfoundry/stint-program-client";
import { fetchClosedEvent } from "@lxfoundry/stint-x402";

/** The chain reads the gate needs, so tests can replace them. */
export interface GateChain {
  latestBlockhash(): Promise<{ readonly blockhash: string; readonly lastValidBlockHeight: bigint }>;
  /** The session at `confirmed`, or undefined when no account is there. */
  readSession(session: Address): Promise<Session | undefined>;
  closedEvent(signature: string): Promise<ClosedEvent | undefined>;
}

export function createRpcChain(rpc: Rpc<SolanaRpcApi>): GateChain {
  return {
    latestBlockhash: async () => (await rpc.getLatestBlockhash({ commitment: "confirmed" }).send()).value,
    readSession: async (session) => {
      const account = await fetchMaybeSession(rpc, session, { commitment: "confirmed" });
      return account.exists ? account.data : undefined;
    },
    closedEvent: (signature) => fetchClosedEvent(rpc, signature),
  };
}
