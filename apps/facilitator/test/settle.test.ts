import {
  SOLANA_ERROR__JSON_RPC__INTERNAL_ERROR,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
  SOLANA_ERROR__TRANSACTION_ERROR__ALREADY_PROCESSED,
  SOLANA_ERROR__TRANSACTION_ERROR__BLOCKHASH_NOT_FOUND,
  SolanaError,
  generateKeyPairSigner,
  getBase58Decoder,
  type Address,
  type Rpc,
  type SolanaRpcApi,
} from "@solana/kit";
import { CloseKind, EVENT_IX_TAG, STINT_PROGRAM_ADDRESS, getClosedEventEncoder } from "@lxfoundry/stint-program-client";
import { beforeAll, describe, expect, it } from "vitest";
import { resolveRecorded, sendAndConfirm, submitSettlement, type SignedSettlement } from "../src/settle.js";

const NETWORK = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const SIGNATURE = getBase58Decoder().decode(new Uint8Array(64).fill(7));
const BLOCKHASH = "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N";

/** What the fake node answers: each read takes the next entry of its list, the last one repeating. */
interface Script {
  send?: () => unknown;
  statuses: (() => unknown)[];
  transactions: (() => unknown)[];
  /** What `isBlockhashValid` answers, in turn. Default: valid. */
  valid?: (() => boolean)[];
}

function fakeRpc(script: Script): {
  rpc: Rpc<SolanaRpcApi>;
  /** How many reads of each kind were made, and for each status read whether it searched the transaction history. */
  reads: { statuses: number; transactions: number; valid: number; sent: number; history: boolean[] };
} {
  const reads = { statuses: 0, transactions: 0, valid: 0, sent: 0, history: [] as boolean[] };
  const next = <T>(list: (() => T)[], index: number) => list[Math.min(index, list.length - 1)]!();
  const call = (answer: () => unknown) => ({ send: async () => answer() });
  const rpc = {
    sendTransaction: () =>
      call(() => {
        reads.sent++;
        return (script.send ?? (() => SIGNATURE))();
      }),
    getSignatureStatuses: (_: unknown, config?: { searchTransactionHistory?: boolean }) => {
      reads.history.push(config?.searchTransactionHistory === true);
      return call(() => ({ value: [next(script.statuses, reads.statuses++)] }));
    },
    isBlockhashValid: () => call(() => ({ value: script.valid ? next(script.valid, reads.valid++) : true })),
    getTransaction: () => call(() => next(script.transactions, reads.transactions++)),
  };
  return { rpc: rpc as unknown as Rpc<SolanaRpcApi>, reads };
}

const confirmed = () => ({ confirmationStatus: "confirmed", err: null });
const failed = () => ({ confirmationStatus: "confirmed", err: { InstructionError: [2, { Custom: 6000 }] } });
const notLanded = () => null;
/** A JSON-RPC error from the node's preflight, as `@solana/kit` reports it: the transaction error is its cause. */
const preflight = (cause: SolanaError) => () => {
  throw new SolanaError(SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE, { cause } as never);
};

/** A confirmed close as `getTransaction` returns it with `json` encoding: one inner `Closed` event. */
function closeTransaction(session: Address, closedBy: Address) {
  const event = getClosedEventEncoder().encode({
    session,
    kind: CloseKind.Standard,
    claimed: 1_000n,
    owed: 7_000n,
    refunded: 22_000n,
    redirected: 500n,
    closedBy,
    paidUntil: 1_800_000_030n,
    at: 1_800_000_008n,
  });
  const data = getBase58Decoder().decode(Uint8Array.from([...EVENT_IX_TAG, ...event]));
  return {
    transaction: { message: { accountKeys: [STINT_PROGRAM_ADDRESS], instructions: [] } },
    meta: { err: null, innerInstructions: [{ index: 0, instructions: [{ programIdIndex: 0, accounts: [], data }] }] },
  };
}

describe("submitSettlement (spec §5.5)", () => {
  let payer: Address;
  let session: Address;
  const ctx = (rpc: Rpc<SolanaRpcApi>) => ({ rpc, network: NETWORK, confirmTimeoutMs: 2_000, readRetry: { attempts: 3, delayMs: 5 } });
  const signed = (type: SignedSettlement["type"], amount = type === "close" ? "0" : "30000"): SignedSettlement => ({
    type,
    wire: "AQ==",
    signature: SIGNATURE,
    blockhash: BLOCKHASH,
    payer,
    amount,
  });

  beforeAll(async () => {
    payer = (await generateKeyPairSigner()).address;
    session = (await generateKeyPairSigner()).address;
  });

  it("answers settlement_pending with the signature when the RPC fails after the node accepted the transaction", async () => {
    const { rpc } = fakeRpc({
      statuses: [
        () => {
          throw new Error("fetch failed");
        },
      ],
      transactions: [() => null],
    });
    expect(await submitSettlement(ctx(rpc), signed("open"))).toMatchObject({
      success: false,
      errorReason: "settlement_pending",
      transaction: SIGNATURE,
      payer,
    });
  });

  it("answers simulation_failed for a transaction that landed with an error", async () => {
    const { rpc } = fakeRpc({ statuses: [() => ({ confirmationStatus: "confirmed", err: { InstructionError: [0, "Custom"] } })], transactions: [() => null] });
    expect(await submitSettlement(ctx(rpc), signed("close"))).toMatchObject({
      success: false,
      errorReason: "simulation_failed",
      transaction: SIGNATURE,
    });
  });

  it("re-reads a confirmed close the node does not return yet, then reports what it paid", async () => {
    const { rpc, reads } = fakeRpc({ statuses: [confirmed], transactions: [() => null, () => closeTransaction(session, payer)] });
    expect(await submitSettlement(ctx(rpc), signed("close"))).toEqual({
      success: true,
      transaction: SIGNATURE,
      network: NETWORK,
      payer,
      amount: "7500",
    });
    expect(reads.transactions).toBe(2);
  });

  it("answers success with the signature, and no amount, when a confirmed close cannot be read at all", async () => {
    const failing = [
      () => null,
      () => {
        throw new Error("fetch failed");
      },
    ];
    const { rpc, reads } = fakeRpc({ statuses: [confirmed], transactions: failing });
    expect(await submitSettlement(ctx(rpc), signed("close"))).toEqual({ success: true, transaction: SIGNATURE, network: NETWORK, payer });
    expect(reads.transactions).toBe(3);
  });

  it("answers an open's deposit once it is confirmed", async () => {
    const { rpc, reads } = fakeRpc({ statuses: [() => null, confirmed], transactions: [() => null] });
    expect(await submitSettlement(ctx(rpc), signed("open"))).toEqual({
      success: true,
      transaction: SIGNATURE,
      network: NETWORK,
      payer,
      amount: "30000",
    });
    expect(reads.transactions).toBe(0);
  });

  it("answers a top-up's deposit once it is confirmed, without reading the transaction", async () => {
    const { rpc, reads } = fakeRpc({ statuses: [confirmed], transactions: [() => null] });
    expect(await submitSettlement(ctx(rpc), signed("topUp", "12000"))).toEqual({
      success: true,
      transaction: SIGNATURE,
      network: NETWORK,
      payer,
      amount: "12000",
    });
    expect(reads.transactions).toBe(0);
  });
});

describe("sendAndConfirm (spec §5.5)", () => {
  let payer: Address;
  const ctx = (rpc: Rpc<SolanaRpcApi>) => ({ rpc, network: NETWORK, confirmTimeoutMs: 300, readRetry: { attempts: 1, delayMs: 0 } });
  const signed = (): SignedSettlement => ({ type: "open", wire: "AQ==", signature: SIGNATURE, blockhash: BLOCKHASH, payer, amount: "30000" });

  beforeAll(async () => {
    payer = (await generateKeyPairSigner()).address;
  });

  it("waits for the outcome when sending gets no answer, since the node may have taken the transaction", async () => {
    const lost = () => {
      throw new TypeError("fetch failed");
    };
    // It had taken it, and it lands.
    expect(await sendAndConfirm(ctx(fakeRpc({ send: lost, statuses: [confirmed], transactions: [() => null] }).rpc), signed())).toMatchObject({
      kind: "settled",
      response: { success: true, amount: "30000" },
    });
    // It had not, and the blockhash expires: it can no longer land. The answer keeps why the send failed.
    const neverTaken = fakeRpc({ send: lost, statuses: [notLanded], transactions: [() => null], valid: [() => false] });
    expect(await sendAndConfirm(ctx(neverTaken.rpc), signed())).toMatchObject({
      kind: "settled",
      response: { errorReason: "blockhash_expired", errorMessage: "fetch failed" },
    });
    // Neither shows before the wait ends: still unknown, with the send's error.
    const undecided = fakeRpc({ send: lost, statuses: [notLanded], transactions: [() => null] });
    expect(await sendAndConfirm(ctx(undecided.rpc), signed())).toMatchObject({
      kind: "pending",
      response: { success: false, errorReason: "settlement_pending", errorMessage: "fetch failed", transaction: SIGNATURE, payer },
    });
  });

  it("does not take a JSON-RPC error other than those a node returns before forwarding for a refusal", async () => {
    const internal = () => {
      throw new SolanaError(SOLANA_ERROR__JSON_RPC__INTERNAL_ERROR, { __serverMessage: "internal error" } as never);
    };
    const { rpc } = fakeRpc({ send: internal, statuses: [notLanded], transactions: [() => null] });
    expect(await sendAndConfirm(ctx(rpc), signed())).toMatchObject({ kind: "pending", response: { errorReason: "settlement_pending" } });
  });

  it("is a refusal when the node refuses the first submission, and leaves the outcome open when it refuses one sent again", async () => {
    const refusing = { send: preflight(new SolanaError(SOLANA_ERROR__TRANSACTION_ERROR__BLOCKHASH_NOT_FOUND)), statuses: [notLanded], transactions: [() => null] };
    expect(await sendAndConfirm(ctx(fakeRpc(refusing).rpc), signed())).toMatchObject({
      kind: "refused",
      response: { success: false, errorReason: "simulation_failed" },
    });
    expect(await sendAndConfirm(ctx(fakeRpc(refusing).rpc), signed(), { resent: true })).toMatchObject({
      kind: "pending",
      response: { errorReason: "settlement_pending", transaction: SIGNATURE },
    });
  });

  it("reads the outcome by the transaction's ID when the node reports it already processed", async () => {
    const { rpc } = fakeRpc({ send: preflight(new SolanaError(SOLANA_ERROR__TRANSACTION_ERROR__ALREADY_PROCESSED)), statuses: [confirmed], transactions: [() => null] });
    expect(await sendAndConfirm(ctx(rpc), signed())).toEqual({
      kind: "settled",
      response: { success: true, transaction: SIGNATURE, network: NETWORK, payer, amount: "30000" },
    });
  });

  it("is final for a transaction that landed with an error, and for one whose blockhash expired before it landed", async () => {
    expect(await sendAndConfirm(ctx(fakeRpc({ statuses: [failed], transactions: [() => null] }).rpc), signed())).toMatchObject({
      kind: "settled",
      response: { errorReason: "simulation_failed" },
    });
    const expired = fakeRpc({ statuses: [notLanded], transactions: [() => null], valid: [() => false] });
    expect(await sendAndConfirm(ctx(expired.rpc), signed())).toMatchObject({ kind: "settled", response: { errorReason: "blockhash_expired" } });
  });
});

describe("resolveRecorded (spec §5.5: a recorded transaction whose outcome is not known)", () => {
  let payer: Address;
  const ctx = (rpc: Rpc<SolanaRpcApi>) => ({ rpc, network: NETWORK, confirmTimeoutMs: 300, readRetry: { attempts: 1, delayMs: 0 } });
  const signed = (): SignedSettlement => ({ type: "open", wire: "AQ==", signature: SIGNATURE, blockhash: BLOCKHASH, payer, amount: "30000" });

  beforeAll(async () => {
    payer = (await generateKeyPairSigner()).address;
  });

  it("answers a transaction that has landed, without sending it again, from the node's transaction history", async () => {
    const { rpc, reads } = fakeRpc({ statuses: [confirmed], transactions: [() => null] });
    expect(await resolveRecorded(ctx(rpc), signed())).toMatchObject({ kind: "settled", response: { success: true, amount: "30000" } });
    expect(reads.sent).toBe(0);
    // A record outlives the node's recent statuses of its transaction: the lookup searches the history too.
    expect(reads.history).toEqual([true]);
  });

  it("sends again a transaction that has not landed while its blockhash is still valid", async () => {
    const { rpc, reads } = fakeRpc({ statuses: [notLanded, confirmed], transactions: [() => null] });
    expect(await resolveRecorded(ctx(rpc), signed())).toMatchObject({ kind: "settled", response: { success: true } });
    expect(reads.sent).toBe(1);
  });

  it("answers blockhash_expired, without sending, once the blockhash has expired and a last look finds nothing", async () => {
    const { rpc, reads } = fakeRpc({ statuses: [notLanded], transactions: [() => null], valid: [() => false] });
    expect(await resolveRecorded(ctx(rpc), signed())).toMatchObject({ kind: "settled", response: { errorReason: "blockhash_expired" } });
    expect(reads).toMatchObject({ statuses: 2, sent: 0 });
  });

  it("answers the transaction that shows at the last look, after its blockhash expired, from the history too", async () => {
    const { rpc, reads } = fakeRpc({ statuses: [notLanded, confirmed], transactions: [() => null], valid: [() => false] });
    expect(await resolveRecorded(ctx(rpc), signed())).toMatchObject({ kind: "settled", response: { success: true } });
    expect(reads.sent).toBe(0);
    expect(reads.history).toEqual([true, true]);
  });

  it("answers simulation_failed for a transaction that landed with an error", async () => {
    const { rpc } = fakeRpc({ statuses: [failed], transactions: [() => null] });
    expect(await resolveRecorded(ctx(rpc), signed())).toMatchObject({ kind: "settled", response: { errorReason: "simulation_failed" } });
  });

  it("leaves the outcome open, without sending, when the lookup cannot be read", async () => {
    const { rpc, reads } = fakeRpc({
      statuses: [
        () => {
          throw new Error("rpc down");
        },
      ],
      transactions: [() => null],
    });
    expect(await resolveRecorded(ctx(rpc), signed())).toMatchObject({ kind: "pending", response: { errorReason: "settlement_pending" } });
    expect(reads.sent).toBe(0);
  });
});
