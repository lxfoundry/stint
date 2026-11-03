import { address, createDefaultRpcTransport, createSolanaRpcFromTransport, type Address, type RpcTransport } from "@solana/kit";
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

/** The longest one request to the node is waited for: the default transport of `@solana/kit` never gives up. */
export const RPC_REQUEST_TIMEOUT_MS = 10_000;

/** `transport`, with each request given up at `timeoutMs` (a `TimeoutError`), as well as at its own signal. */
function limited(transport: RpcTransport, timeoutMs: number): RpcTransport {
  return (config) => {
    const limit = AbortSignal.timeout(timeoutMs);
    return transport({ ...config, signal: config.signal ? AbortSignal.any([config.signal, limit]) : limit });
  };
}

/**
 * The agent's USDC account and the reads of the chain the demo makes. Every request to the node is limited to
 * `requestTimeoutMs`: a slow node fails a read, which the demo logs and makes again, rather than freezing it.
 */
export async function createRpcDemoChain(
  rpcUrl: string,
  owner: Address,
  options: { readonly requestTimeoutMs?: number } = {},
): Promise<DemoChain> {
  const rpc = createSolanaRpcFromTransport(limited(createDefaultRpcTransport({ url: rpcUrl }), options.requestTimeoutMs ?? RPC_REQUEST_TIMEOUT_MS));
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
