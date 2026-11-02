import { getBase58Decoder, getBase64Decoder, type Rpc, type SolanaRpcApi } from "@solana/kit";
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

/** The signature the fake node gives every transaction sent to it. */
export const SENT_SIGNATURE = fakeSignature(7);

/** The rent-exempt minimum of an account with no data, as the fake node reports it. */
export const RENT_EXEMPT_LAMPORTS = 890_880n;

/** A node holding one session account, or none, and the signer's balance. It confirms every transaction it accepts. */
export interface FakeNode {
  /** The session at the address the client reads, or none. */
  session?: SessionArgs;
  /** What the signer holds. */
  lamports: bigint;
  /** What `sendTransaction` throws, as a node refusing a transaction in preflight does. */
  refuse?: Error;
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
  /** The transactions accepted, as base64 wire transactions. */
  readonly sent: string[];
}

const answer = <T>(value: T) => ({ send: async () => value });
const failing = () => ({
  send: async () => {
    throw new Error("node down");
  },
});

export function fakeRpc(node: FakeNode): Rpc<SolanaRpcApi> {
  return {
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
        if (node.refuse) throw node.refuse;
        node.sent.push(wire);
        return SENT_SIGNATURE;
      },
    }),
    getSignatureStatuses: () =>
      node.statusFails
        ? failing()
        : answer({ context: { slot: 1n }, value: [{ slot: 1n, confirmations: null, err: null, confirmationStatus: "confirmed" }] }),
    isBlockhashValid: () => answer({ context: { slot: 1n }, value: true }),
    getTransaction: () => (node.transactionFails ? failing() : answer(node.closed ? closeTransaction(node.closed) : null)),
  } as unknown as Rpc<SolanaRpcApi>;
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
