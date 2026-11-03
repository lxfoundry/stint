import { address, createSolanaRpc, type Address } from "@solana/kit";
import { USDC_DEVNET, associatedTokenAddress, findClose } from "@lxfoundry/stint-x402";

/** A session's close found on the chain, from its `Closed` event (spec §4.4). */
export interface FoundClose {
  readonly signature: string;
  /** Unix seconds, on the chain's clock. */
  readonly at: number;
  readonly paidUntil: number;
  /** All the seller was paid for the session: claimed, owed and redirected. */
  readonly paid: string;
  readonly refunded: string;
}

/** What the demo reads from the chain itself; everything else goes through the gate. */
export interface DemoChain {
  /** The agent's USDC account, which the stream watches. */
  readonly usdcAccount: string;
  /** Its balance in base units; 0 while the account does not exist. */
  usdcBalance(): Promise<bigint>;
  findClose(session: string): Promise<FoundClose | undefined>;
}

export async function createRpcDemoChain(rpcUrl: string, owner: Address): Promise<DemoChain> {
  const rpc = createSolanaRpc(rpcUrl);
  const usdcAccount = await associatedTokenAddress(owner, USDC_DEVNET.mint);
  // The transactions already read and found to hold no close of a session: a look again does not read them again.
  const notCloses = new Map<string, Set<string>>();
  return {
    usdcAccount,
    async usdcBalance() {
      const { value } = await rpc.getAccountInfo(usdcAccount, { commitment: "confirmed", encoding: "base64" }).send();
      if (value === null) return 0n;
      const balance = await rpc.getTokenAccountBalance(usdcAccount, { commitment: "confirmed" }).send();
      return BigInt(balance.value.amount);
    },
    async findClose(session) {
      let seen = notCloses.get(session);
      if (!seen) notCloses.set(session, (seen = new Set()));
      const found = await findClose(rpc, address(session), undefined, seen);
      if (!found) return undefined;
      const { event } = found;
      return {
        signature: found.signature,
        at: Number(event.at),
        paidUntil: Number(event.paidUntil),
        paid: (event.claimed + event.owed + event.redirected).toString(),
        refunded: event.refunded.toString(),
      };
    },
  };
}
