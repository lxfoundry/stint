import {
  getBase58Decoder,
  getBase64Decoder,
  getBase64Encoder,
  getSignatureFromTransaction,
  getSolanaErrorFromJsonRpcError,
  getTransactionDecoder,
  type Rpc,
  type SolanaRpcApi,
} from "@solana/kit";
import {
  EVENT_IX_TAG,
  STINT_PROGRAM_ADDRESS,
  getClosedEventEncoder,
  getSessionEncoder,
  type ClosedEventArgs,
  type SessionArgs,
} from "@lxfoundry/stint-program-client";

/** A well-formed signature, one for each `fill`: the scheme package checks the form of the signatures a node lists. */
export const fakeSignature = (fill: number) => getBase58Decoder().decode(new Uint8Array(64).fill(fill));

/** The signature of a base64 wire transaction, its fee payer's: what a node answers `sendTransaction` with. */
export const signatureOf = (wire: string): string => getSignatureFromTransaction(getTransactionDecoder().decode(getBase64Encoder().encode(wire)));

/** The rent-exempt minimum of an account with no data, as the fake node reports it. */
export const RENT_EXEMPT_LAMPORTS = 890_880n;

/** A node holding one session account, or none, and the signer's balance. It confirms every transaction it accepts. */
export interface FakeNode {
  /** The session at the address the client reads, or none. */
  session?: SessionArgs;
  /** What the signer holds. */
  lamports: bigint;
  /** The JSON-RPC error the node answers `sendTransaction` with: it refuses the transaction without taking it, as a failed preflight does. */
  refuse?: { readonly code: number; readonly message: string; readonly data?: Record<string, unknown> };
  /** While set, the node takes each transaction sent, and the connection drops before its answer. */
  sendDrops?: boolean;
  /** The `Closed` event of the close it accepted; without one, the node cannot return that transaction. */
  closed?: ClosedEventArgs;
  /** The signature that the session address's transactions list shows, the close that `closed` describes; none without it. */
  landed?: string;
  /** While set, reads of the session account fail, as a node that cannot be reached fails them. */
  readFails?: boolean;
  /** While set, the list of the session address's transactions cannot be read. */
  listFails?: boolean;
  /** While set, the status of a transaction sent cannot be read, so its confirmation cannot be told. */
  statusFails?: boolean;
  /** While set, a transaction cannot be fetched, so the `Closed` event of a close cannot be read. */
  transactionFails?: boolean;
  /**
   * The methods whose requests the node takes, acts on and never answers, as a node that keeps the connection and never
   * answers does: such a request is given up only when its abort signal fires. A transaction sent is accepted all the same.
   */
  silent?: readonly (keyof SolanaRpcApi)[];
  /** The transactions accepted, as base64 wire transactions. */
  readonly sent: string[];
}

const answer = <T>(value: T) => ({ send: async () => value });
const failing = () => ({
  send: async () => {
    throw new Error("node down");
  },
});
/** A request with no answer: it fails only when `signal` fires, with the signal's reason, as the transport does. */
const unanswered = (signal?: AbortSignal) =>
  new Promise<never>((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true }));

export function fakeRpc(node: FakeNode): Rpc<SolanaRpcApi> {
  const methods: Record<string, (...args: never[]) => { send: () => Promise<unknown> }> = {
    getAccountInfo: () =>
      node.readFails ? failing() : answer({ context: { slot: 1n }, value: node.session ? accountHolding(node.session) : null }),
    getBalance: () => answer({ context: { slot: 1n }, value: node.lamports }),
    getMinimumBalanceForRentExemption: () => answer(RENT_EXEMPT_LAMPORTS),
    getSignaturesForAddress: () =>
      node.listFails
        ? failing()
        : answer(node.landed ? [{ signature: node.landed, err: null, slot: 1n, memo: null, blockTime: null, confirmationStatus: "confirmed" }] : []),
    getLatestBlockhash: () =>
      answer({ context: { slot: 1n }, value: { blockhash: "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N", lastValidBlockHeight: 100n } }),
    sendTransaction: (wire: string) => ({
      send: async () => {
        // As `@solana/kit` reports a JSON-RPC error answer.
        if (node.refuse) throw getSolanaErrorFromJsonRpcError(node.refuse);
        node.sent.push(wire);
        if (node.sendDrops) throw new TypeError("fetch failed", { cause: new Error("other side closed") });
        return signatureOf(wire);
      },
    }),
    getSignatureStatuses: () =>
      node.statusFails
        ? failing()
        : answer({ context: { slot: 1n }, value: [{ slot: 1n, confirmations: null, err: null, confirmationStatus: "confirmed" }] }),
    isBlockhashValid: () => answer({ context: { slot: 1n }, value: true }),
    getTransaction: () => (node.transactionFails ? failing() : answer(node.closed ? closeTransaction(node.closed) : null)),
  };
  return Object.fromEntries(
    Object.entries(methods).map(([name, method]) => [
      name,
      (...args: never[]) => {
        const request = method(...args);
        return {
          send: (options?: { readonly abortSignal?: AbortSignal }) => {
            if (!node.silent?.includes(name as keyof SolanaRpcApi)) return request.send();
            void request.send().catch(() => {}); // taken and acted on, whatever its answer would have been
            return unanswered(options?.abortSignal);
          },
        };
      },
    ]),
  ) as unknown as Rpc<SolanaRpcApi>;
}

function accountHolding(session: SessionArgs) {
  const data = new Uint8Array(getSessionEncoder().encode(session));
  return { data: [getBase64Decoder().decode(data), "base64"], executable: false, lamports: 2_000_000n, owner: STINT_PROGRAM_ADDRESS, space: BigInt(data.length) };
}

/** A confirmed close as `getTransaction` returns it with `json` encoding: one inner `Closed` event. */
function closeTransaction(event: ClosedEventArgs) {
  const data = getBase58Decoder().decode(Uint8Array.from([...EVENT_IX_TAG, ...getClosedEventEncoder().encode(event)]));
  return {
    transaction: { message: { accountKeys: [STINT_PROGRAM_ADDRESS], instructions: [] } },
    meta: { err: null, innerInstructions: [{ index: 0, instructions: [{ programIdIndex: 0, accounts: [], data }] }] },
  };
}
