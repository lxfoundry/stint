import { containsBytes, fetchEncodedAccount, type Address, type Rpc, type SolanaRpcApi } from "@solana/kit";
import {
  SESSION_DISCRIMINATOR,
  STINT_PROGRAM_ADDRESS,
  decodeSession,
  getSessionSize,
  type ClosedEvent,
  type Session,
} from "@lxfoundry/stint-program-client";
import { fetchClosedEvent } from "@lxfoundry/stint-x402";

/** The chain reads the gate needs, so tests can replace them. */
export interface GateChain {
  latestBlockhash(): Promise<{ readonly blockhash: string; readonly lastValidBlockHeight: bigint }>;
  /** The session at `confirmed`, or undefined when the address holds no Stint session. */
  readSession(session: Address): Promise<Session | undefined>;
  closedEvent(signature: string): Promise<ClosedEvent | undefined>;
}

export function createRpcChain(rpc: Rpc<SolanaRpcApi>): GateChain {
  return {
    latestBlockhash: async () => (await rpc.getLatestBlockhash({ commitment: "confirmed" }).send()).value,
    readSession: async (session) => {
      const account = await fetchEncodedAccount(rpc, session, { commitment: "confirmed" });
      // Any address can be asked about: a wallet, or an account of another program, is not a session.
      if (!account.exists || account.programAddress !== STINT_PROGRAM_ADDRESS) return undefined;
      if (account.data.length < getSessionSize() || !containsBytes(account.data, SESSION_DISCRIMINATOR, 0)) return undefined;
      return decodeSession(account).data;
    },
    closedEvent: (signature) => fetchClosedEvent(rpc, signature),
  };
}
