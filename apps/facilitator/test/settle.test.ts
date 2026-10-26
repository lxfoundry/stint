import { generateKeyPairSigner, getBase58Decoder, type Address, type Rpc, type SolanaRpcApi } from "@solana/kit";
import { CloseKind, EVENT_IX_TAG, STINT_PROGRAM_ADDRESS, getClosedEventEncoder } from "@lxfoundry/stint-program-client";
import { beforeAll, describe, expect, it } from "vitest";
import { submitSettlement, type SignedSettlement } from "../src/settle.js";

const NETWORK = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const SIGNATURE = getBase58Decoder().decode(new Uint8Array(64).fill(7));
const BLOCKHASH = "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N";

/** What the fake node answers: each read takes the next entry of its list, the last one repeating. */
interface Script {
  send?: () => unknown;
  statuses: (() => unknown)[];
  transactions: (() => unknown)[];
}

function fakeRpc(script: Script): { rpc: Rpc<SolanaRpcApi>; reads: { statuses: number; transactions: number } } {
  const reads = { statuses: 0, transactions: 0 };
  const next = (list: (() => unknown)[], index: number) => list[Math.min(index, list.length - 1)]!();
  const call = (answer: () => unknown) => ({ send: async () => answer() });
  const rpc = {
    sendTransaction: () => call(script.send ?? (() => SIGNATURE)),
    getSignatureStatuses: () => call(() => ({ value: [next(script.statuses, reads.statuses++)] })),
    isBlockhashValid: () => call(() => ({ value: true })),
    getTransaction: () => call(() => next(script.transactions, reads.transactions++)),
  };
  return { rpc: rpc as unknown as Rpc<SolanaRpcApi>, reads };
}

const confirmed = () => ({ confirmationStatus: "confirmed", err: null });

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
  const signed = (type: "open" | "close"): SignedSettlement => ({
    type,
    wire: "AQ==",
    signature: SIGNATURE,
    blockhash: BLOCKHASH,
    payer,
    amount: type === "open" ? "30000" : "0",
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
});
