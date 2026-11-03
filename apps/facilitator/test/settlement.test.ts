import { AccountState, TOKEN_PROGRAM_ADDRESS, getTokenEncoder } from "@solana-program/token";
import {
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
  SOLANA_ERROR__TRANSACTION_ERROR__BLOCKHASH_NOT_FOUND,
  SolanaError,
  generateKeyPairSigner,
  getBase64Decoder,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getTransactionDecoder,
  none,
  partiallySignTransaction,
  type Address,
  type KeyPairSigner,
  type Rpc,
  type SolanaRpcApi,
} from "@solana/kit";
import { STINT_PROGRAM_ADDRESS, getSessionSize } from "@lxfoundry/stint-program-client";
import { associatedTokenAddress, buildOpenOffer, buildOpenTransaction, inspectTransaction, type ElapsedRequirements } from "@lxfoundry/stint-x402";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { KoraClient } from "../src/kora.js";
import { createMemoryStore, type SettlementStore } from "../src/records.js";
import { createSettlement, type Settlement } from "../src/settle.js";
import type { FacilitatorContext } from "../src/verify.js";

const NETWORK = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const BLOCKHASH = "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N";
const MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU" as Address;
/** Digests of two API keys, as the server passes them. */
const API_KEY = "a".repeat(64);
const OTHER_KEY = "b".repeat(64);
const CONFIRMED = { confirmationStatus: "confirmed", err: null };

/**
 * What the fake node does. Until a test says otherwise: the seller's token account exists, the blockhash is valid, the
 * simulation succeeds, and a transaction sent lands at once.
 */
interface Node {
  accounts: Map<string, { owner: Address; data: Uint8Array }>;
  blockhashValid: boolean;
  simulationErr: unknown;
  /** Runs on each `sendTransaction`; throws to fail it. */
  onSend: () => void;
  /** The status the node reports for any signature. */
  status: unknown;
  calls: { simulate: number; send: number };
}

function fakeRpc(node: Node): Rpc<SolanaRpcApi> {
  const call = (answer: () => unknown) => ({ send: async () => answer() });
  const rpc = {
    getAccountInfo: (target: string) =>
      call(() => {
        const account = node.accounts.get(target);
        if (!account) return { value: null };
        return {
          value: {
            data: [getBase64Decoder().decode(account.data), "base64"],
            executable: false,
            lamports: 1_000_000n,
            owner: account.owner,
            space: BigInt(account.data.length),
          },
        };
      }),
    getMinimumBalanceForRentExemption: (space: bigint) => call(() => (space === BigInt(getSessionSize()) ? 2_000_000n : 2_039_280n)),
    isBlockhashValid: () => call(() => ({ value: node.blockhashValid })),
    simulateTransaction: () =>
      call(() => {
        node.calls.simulate++;
        return { value: { err: node.simulationErr, logs: [], innerInstructions: [] } };
      }),
    sendTransaction: () =>
      call(() => {
        node.calls.send++;
        node.onSend();
        return "sent";
      }),
    getSignatureStatuses: () => call(() => ({ value: [node.status] })),
    getTransaction: () => call(() => null),
  };
  return rpc as unknown as Rpc<SolanaRpcApi>;
}

/** Signs as the fee payer, as Kora does, counting its signatures; while `hold` is set, it waits for it first. */
function fakeKora(feePayer: KeyPairSigner, state: { signed: number; hold?: Promise<void> }): KoraClient {
  return {
    getPayerSigner: async () => ({ signer_address: feePayer.address, payment_address: feePayer.address }),
    signTransaction: async (wire) => {
      state.signed++;
      await state.hold;
      const transaction = getTransactionDecoder().decode(getBase64Encoder().encode(wire));
      return getBase64EncodedWireTransaction(await partiallySignTransaction([feePayer.keyPair], transaction));
    },
  };
}

function tokenAccount(owner: Address): { owner: Address; data: Uint8Array } {
  const data = getTokenEncoder().encode({
    mint: MINT,
    owner,
    amount: 0n,
    delegate: none(),
    state: AccountState.Initialized,
    isNative: none(),
    delegatedAmount: 0n,
    closeAuthority: none(),
  });
  return { owner: TOKEN_PROGRAM_ADDRESS, data: Uint8Array.from(data) };
}

describe("settlement records on /verify and /settle (spec §5.5)", () => {
  let buyer: KeyPairSigner;
  let feePayer: KeyPairSigner;
  let rentPayer: KeyPairSigner;
  let offer: ElapsedRequirements;
  let node: Node;
  let kora: { signed: number; hold?: Promise<void> };
  let store: SettlementStore;
  let settlement: Settlement;

  beforeAll(async () => {
    buyer = await generateKeyPairSigner();
    feePayer = await generateKeyPairSigner();
    rentPayer = await generateKeyPairSigner();
    offer = buildOpenOffer({
      network: NETWORK,
      asset: MINT,
      payTo: (await generateKeyPairSigner()).address,
      receiverAuthorizer: (await generateKeyPairSigner()).address,
      terms: { rate: 1_000n, minSeconds: 5, maxSeconds: 120 },
      seconds: 30,
      facilitator: { feePayer: feePayer.address, rentPayer: rentPayer.address, programId: STINT_PROGRAM_ADDRESS, closeUrl: "http://127.0.0.1:4021/close" },
      lifetime: { blockhash: BLOCKHASH, lastValidBlockHeight: 1_234n },
      maxTimeoutSeconds: 60,
      idleCloseSeconds: 10,
      closeOnOutage: true,
    });
  });

  beforeEach(async () => {
    node = {
      accounts: new Map(),
      blockhashValid: true,
      simulationErr: null,
      onSend: () => void (node.status = CONFIRMED),
      status: null,
      calls: { simulate: 0, send: 0 },
    };
    node.accounts.set(await associatedTokenAddress(offer.payTo as Address, MINT), tokenAccount(offer.payTo as Address));
    kora = { signed: 0 };
    const ctx: FacilitatorContext = {
      rpc: fakeRpc(node),
      network: NETWORK,
      keys: { feePayer: feePayer.address, rentPayer: rentPayer.address },
      rentPayer,
      kora: fakeKora(feePayer, kora),
      confirmTimeoutMs: 300,
      readRetry: { attempts: 1, delayMs: 0 },
    };
    store = createMemoryStore();
    settlement = createSettlement(ctx, store);
  });

  async function openPayload() {
    const built = await buildOpenTransaction({ requirements: offer, authority: buyer, decimals: 6 });
    return { x402Version: 2, accepted: offer, payload: { type: "open", transaction: built.transaction, session: built.session } };
  }
  const hashOf = (payload: Awaited<ReturnType<typeof openPayload>>) => inspectTransaction(payload.payload.transaction)!.messageHash;
  const dropsAtOnce = () => void (node.status = CONFIRMED);
  /** A transaction the node takes, and that does not land. */
  const neverLands = () => {};
  /** A node that refuses the transaction before forwarding it: a failed preflight, as a lagging node's BlockhashNotFound. */
  const preflightRefusal = () => {
    const cause = new SolanaError(SOLANA_ERROR__TRANSACTION_ERROR__BLOCKHASH_NOT_FOUND);
    throw new SolanaError(SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE, { cause } as never);
  };

  it("settles an open once, records the outcome, and answers a retry from it: nothing verified, signed or sent again", async () => {
    const payload = await openPayload();
    const first = await settlement.settle(payload, offer, API_KEY);
    expect(first).toMatchObject({ success: true, payer: buyer.address, amount: "30000" });
    expect((await store.get(hashOf(payload)))?.outcome).toEqual(first);
    // What a replay meets on the chain: a fresh verification would refuse it.
    node.simulationErr = { InstructionError: [2, { Custom: 0 }] };

    expect(await settlement.settle(payload, offer, API_KEY)).toEqual(first);
    expect(await settlement.verify(payload, offer, API_KEY)).toEqual({ ok: true, payer: buyer.address });
    expect(node.calls).toEqual({ simulate: 1, send: 1 });
    expect(kora.signed).toBe(1);
  });

  it("answers a retry whose requirements differ from the record's in the advisory fields only", async () => {
    const payload = await openPayload();
    const first = await settlement.settle(payload, offer, API_KEY);
    const fresh = {
      ...offer,
      maxTimeoutSeconds: 30,
      extra: { ...offer.extra, recentBlockhash: "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi", lastValidBlockHeight: "9999" },
    };
    expect(await settlement.settle(payload, fresh, API_KEY)).toEqual(first);
    expect(await settlement.verify(payload, fresh, API_KEY)).toEqual({ ok: true, payer: buyer.address });
    expect(node.calls.simulate).toBe(1);
  });

  it("refuses a payload of a recorded settlement that comes with other requirements or another API key", async () => {
    const payload = await openPayload();
    await settlement.settle(payload, offer, API_KEY);
    const other = { ...offer, extra: { ...offer.extra, idleCloseSeconds: 11 } };
    for (const [requirements, apiKey] of [
      [other, API_KEY],
      [offer, OTHER_KEY],
    ] as const) {
      expect(await settlement.settle(payload, requirements, apiKey)).toMatchObject({
        success: false,
        errorReason: "invalid_payment_requirements",
        transaction: "",
      });
      expect(await settlement.verify(payload, requirements, apiKey)).toMatchObject({ ok: false, reason: "invalid_payment_requirements" });
    }
    expect(node.calls).toEqual({ simulate: 1, send: 1 });
  });

  it("lets two identical settlements sent at once share one: one verification, one signature, one submission", async () => {
    const payload = await openPayload();
    const [a, b] = await Promise.all([settlement.settle(payload, offer, API_KEY), settlement.settle(payload, offer, API_KEY)]);
    expect(a).toMatchObject({ success: true });
    expect(b).toEqual(a);
    expect(node.calls).toEqual({ simulate: 1, send: 1 });
    expect(kora.signed).toBe(1);
  });

  it("refuses a duplicate in flight that comes with another API key, and lets the first settle", async () => {
    const payload = await openPayload();
    const [a, b] = await Promise.all([settlement.settle(payload, offer, API_KEY), settlement.settle(payload, offer, OTHER_KEY)]);
    expect(a).toMatchObject({ success: true });
    expect(b).toMatchObject({ success: false, errorReason: "invalid_payment_requirements" });
    expect(node.calls.send).toBe(1);
  });

  it("releases the claim when verification refuses the payment, so that the payload is verified again when it comes back", async () => {
    const payload = await openPayload();
    node.simulationErr = { InstructionError: [1, { Custom: 1 }] }; // the buyer cannot pay yet
    expect(await settlement.settle(payload, offer, API_KEY)).toMatchObject({ success: false, errorReason: "simulation_failed" });
    expect(await store.get(hashOf(payload))).toBeUndefined();
    node.simulationErr = null;
    expect(await settlement.settle(payload, offer, API_KEY)).toMatchObject({ success: true });
    expect(node.calls).toEqual({ simulate: 2, send: 1 });
  });

  it("releases the claim when the node refuses the first submission: it did not take the transaction", async () => {
    const payload = await openPayload();
    node.onSend = preflightRefusal;
    expect(await settlement.settle(payload, offer, API_KEY)).toMatchObject({ success: false, errorReason: "simulation_failed" });
    expect(await store.get(hashOf(payload))).toBeUndefined();
    node.onSend = dropsAtOnce;
    expect(await settlement.settle(payload, offer, API_KEY)).toMatchObject({ success: true });
    expect(node.calls).toEqual({ simulate: 2, send: 2 });
  });

  it("keeps the record when sending gets no answer, and a retry finds the transaction landed, without sending it again", async () => {
    const payload = await openPayload();
    node.onSend = () => {
      throw new TypeError("fetch failed");
    };
    const pending = await settlement.settle(payload, offer, API_KEY);
    expect(pending).toMatchObject({ success: false, errorReason: "settlement_pending" });
    expect(pending.transaction).not.toBe("");
    expect((await store.get(hashOf(payload)))?.signed?.signature).toBe(pending.transaction);
    expect((await store.get(hashOf(payload)))?.outcome).toBeUndefined();

    node.status = CONFIRMED; // it landed after all
    const settled = await settlement.settle(payload, offer, API_KEY);
    expect(settled).toMatchObject({ success: true, transaction: pending.transaction });
    expect((await store.get(hashOf(payload)))?.outcome).toEqual(settled);
    expect(node.calls).toEqual({ simulate: 1, send: 1 });
  });

  it("sends a recorded transaction again when it has not landed and its blockhash is still valid", async () => {
    const payload = await openPayload();
    node.onSend = neverLands;
    expect(await settlement.settle(payload, offer, API_KEY)).toMatchObject({ errorReason: "settlement_pending" });
    node.onSend = dropsAtOnce;
    expect(await settlement.settle(payload, offer, API_KEY)).toMatchObject({ success: true });
    expect(node.calls).toEqual({ simulate: 1, send: 2 });
    expect(kora.signed).toBe(1);
  });

  it("keeps the record, with no outcome, when the node refuses a recorded transaction sent again: its first submission may still land", async () => {
    const payload = await openPayload();
    node.onSend = neverLands;
    const pending = await settlement.settle(payload, offer, API_KEY);
    expect(pending).toMatchObject({ success: false, errorReason: "settlement_pending" });
    node.onSend = preflightRefusal;

    const again = await settlement.settle(payload, offer, API_KEY);

    expect(again).toMatchObject({ success: false, errorReason: "settlement_pending", transaction: pending.transaction });
    const record = await store.get(hashOf(payload));
    expect(record?.signed?.signature).toBe(pending.transaction);
    expect(record?.outcome).toBeUndefined();
    expect(node.calls).toEqual({ simulate: 1, send: 2 });
  });

  it("records blockhash_expired for a transaction that never landed, once its blockhash has expired, and /verify reports it", async () => {
    const payload = await openPayload();
    node.onSend = neverLands;
    await settlement.settle(payload, offer, API_KEY);
    node.blockhashValid = false;
    const expired = await settlement.settle(payload, offer, API_KEY);
    expect(expired).toMatchObject({ success: false, errorReason: "blockhash_expired" });
    expect((await store.get(hashOf(payload)))?.outcome).toEqual(expired);
    expect(await settlement.verify(payload, offer, API_KEY)).toMatchObject({ ok: false, reason: "blockhash_expired" });
    expect(node.calls).toEqual({ simulate: 1, send: 1 });
  });

  it("records simulation_failed for a transaction that landed with an error, and /verify reports it", async () => {
    const payload = await openPayload();
    node.onSend = neverLands;
    await settlement.settle(payload, offer, API_KEY);
    node.status = { confirmationStatus: "confirmed", err: { InstructionError: [2, { Custom: 6000 }] } };
    expect(await settlement.settle(payload, offer, API_KEY)).toMatchObject({ success: false, errorReason: "simulation_failed" });
    expect(await settlement.verify(payload, offer, API_KEY)).toMatchObject({ ok: false, reason: "simulation_failed" });
  });

  it("answers /verify valid while a recorded settlement is pending, without verifying it again", async () => {
    const payload = await openPayload();
    node.onSend = neverLands;
    await settlement.settle(payload, offer, API_KEY);
    expect(await settlement.verify(payload, offer, API_KEY)).toEqual({ ok: true, payer: buyer.address });
    expect(node.calls.simulate).toBe(1);
  });

  it("verifies on /verify a payload whose claim holds no transaction yet: it has not been submitted", async () => {
    const payload = await openPayload();
    let release!: () => void;
    kora.hold = new Promise<void>((resolve) => (release = resolve));
    const settling = settlement.settle(payload, offer, API_KEY);
    // Claimed and verified, and waiting on the fee payer's signature.
    await expect.poll(() => kora.signed).toBe(1);
    expect(await settlement.verify(payload, offer, API_KEY)).toEqual({ ok: true, payer: buyer.address });
    expect(node.calls.simulate).toBe(2);
    release();
    expect(await settling).toMatchObject({ success: true });
  });

  it("answers already_processed, and keeps no record, for a message the chain has processed and it holds no record of", async () => {
    const payload = await openPayload();
    node.simulationErr = "AlreadyProcessed";
    expect(await settlement.verify(payload, offer, API_KEY)).toMatchObject({ ok: false, reason: "already_processed" });
    expect(await settlement.settle(payload, offer, API_KEY)).toMatchObject({ success: false, errorReason: "already_processed" });
    expect(await store.list()).toEqual([]);
    expect(node.calls.send).toBe(0);
  });

  it("refuses a payload whose transaction does not decode, as verification does, and keeps no record", async () => {
    const payload = { x402Version: 2, accepted: offer, payload: { type: "open", transaction: "AQ==", session: "x" } };
    expect(await settlement.settle(payload, offer, API_KEY)).toMatchObject({ success: false, errorReason: "invalid_payload" });
    expect(await store.list()).toEqual([]);
  });

  it("claims and records nothing on /verify", async () => {
    const payload = await openPayload();
    expect(await settlement.verify(payload, offer, API_KEY)).toEqual({ ok: true, payer: buyer.address });
    expect(await store.list()).toEqual([]);
    expect(node.calls.send).toBe(0);
  });
});
