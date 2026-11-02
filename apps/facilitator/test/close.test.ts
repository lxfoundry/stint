import {
  appendTransactionMessageInstructions,
  blockhash,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase58Decoder,
  getBase64Decoder,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getTransactionDecoder,
  partiallySignTransaction,
  partiallySignTransactionMessageWithSigners,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Instruction,
  type KeyPairSigner,
  type Rpc,
  type SignatureBytes,
  type SolanaRpcApi,
} from "@solana/kit";
import { CloseKind, EVENT_IX_TAG, STINT_PROGRAM_ADDRESS, getClosedEventEncoder, getSessionEncoder } from "@lxfoundry/stint-program-client";
import { buildCloseTransaction, inspectTransaction } from "@lxfoundry/stint-x402";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createCloseInfoSource, createSponsoredCloser, verifySponsoredClose } from "../src/close.js";
import type { KoraClient } from "../src/kora.js";
import type { FacilitatorContext } from "../src/verify.js";

const NETWORK = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const BLOCKHASH = "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N";
const MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU" as Address;

/** What the fake node answers; the defaults are the happy path. */
interface Node {
  accounts: Map<string, Uint8Array>;
  /** The program that owns every account in `accounts`. */
  owner: Address;
  blockhashValid: boolean;
  simulation: { err: unknown; logs?: string[] };
  closedEvent: boolean;
  failLifetime: boolean;
  /** Set: `sendTransaction` answers once it settles. */
  holdSend?: Promise<void>;
  /** Set: `sendTransaction` throws, as a node does when it refuses a transaction at preflight. */
  failSend?: boolean;
  calls: { read: number; simulate: number; send: number; lifetime: number };
}

/** Only the methods the sponsored close calls, each answering from `node`. */
function fakeRpc(node: Node, closed: () => unknown): Rpc<SolanaRpcApi> {
  const call = (answer: () => unknown) => ({ send: async () => answer() });
  const rpc = {
    getAccountInfo: (target: string) =>
      call(() => {
        node.calls.read++;
        const data = node.accounts.get(target);
        if (!data) return { value: null };
        return {
          value: {
            data: [getBase64Decoder().decode(data), "base64"],
            executable: false,
            lamports: 1_000_000n,
            owner: node.owner,
            space: BigInt(data.length),
          },
        };
      }),
    isBlockhashValid: () => call(() => ({ value: node.blockhashValid })),
    simulateTransaction: () =>
      call(() => {
        node.calls.simulate++;
        return { value: { logs: [], innerInstructions: [], ...node.simulation } };
      }),
    getLatestBlockhash: () =>
      call(() => {
        node.calls.lifetime++;
        if (node.failLifetime) throw new Error("node down");
        return { value: { blockhash: BLOCKHASH, lastValidBlockHeight: 1_234n } };
      }),
    getBlockHeight: () => call(() => 1_000n),
    sendTransaction: () =>
      call(async () => {
        node.calls.send++;
        await node.holdSend;
        if (node.failSend) throw new Error("preflight refused");
        return "sent";
      }),
    getSignatureStatuses: () => call(() => ({ value: [{ confirmationStatus: "confirmed", err: null }] })),
    getTransaction: () => call(() => (node.closedEvent ? closed() : null)),
  };
  return rpc as unknown as Rpc<SolanaRpcApi>;
}

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

/** Kora, as far as the sponsored close uses it: it adds the fee payer's signature, or refuses. */
function fakeKora(feePayer: KeyPairSigner, refuses = false): KoraClient {
  return {
    getPayerSigner: async () => ({ signer_address: feePayer.address, payment_address: feePayer.address }),
    signTransaction: async (wire) => {
      if (refuses) throw new Error("policy refused");
      const transaction = getTransactionDecoder().decode(getBase64Encoder().encode(wire));
      return getBase64EncodedWireTransaction(await partiallySignTransaction([feePayer.keyPair], transaction));
    },
  };
}

describe("the sponsored close (spec §6.1)", () => {
  let buyer: KeyPairSigner;
  let authorizer: KeyPairSigner;
  let feePayer: KeyPairSigner;
  let rentPayer: KeyPairSigner;
  let seller: Address;
  let session: Address;
  let node: Node;

  const sessionData = (rentPayerOf: Address) =>
    Uint8Array.from(
      getSessionEncoder().encode({
        version: 1,
        bump: 255,
        authority: buyer.address,
        seed: 1n,
        mint: MINT,
        receiver: seller,
        receiverAuthorizer: authorizer.address,
        refundOwner: buyer.address,
        rentPayer: rentPayerOf,
        rate: 1_000n,
        minSeconds: 5,
        maxSeconds: 120,
        startedAt: 1_800_000_000n,
        deposited: 30_000n,
        claimed: 0n,
      }),
    );

  const closeBy = (closer: KeyPairSigner, kind: CloseKind = CloseKind.Standard, payer: Address = feePayer.address) =>
    buildCloseTransaction({
      session,
      stored: { mint: MINT, receiver: seller, refundOwner: buyer.address, rentPayer: rentPayer.address },
      closer,
      feePayer: payer,
      lifetime: { blockhash: BLOCKHASH, lastValidBlockHeight: 100n },
      kind,
    });

  /** The buyer's close with `change` applied to its instructions, signed again by the buyer. */
  const closeChanged = async (change: (instructions: readonly Instruction[]) => readonly Instruction[]): Promise<string> => {
    const tx = inspectTransaction(await closeBy(buyer))!;
    const instructions = change(tx.instructions).map((ix) => ({
      ...ix,
      accounts: ix.accounts?.map((meta) => (meta.address === buyer.address ? { ...meta, signer: buyer } : meta)),
    }));
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayer(tx.feePayer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: blockhash(BLOCKHASH), lastValidBlockHeight: 100n }, m),
      (m) => appendTransactionMessageInstructions(instructions as Instruction[], m),
    );
    return getBase64EncodedWireTransaction(await partiallySignTransactionMessageWithSigners(message));
  };

  const context = (kora: KoraClient = fakeKora(feePayer)): FacilitatorContext => ({
    rpc: fakeRpc(node, () => closeTransaction(session, buyer.address)),
    network: NETWORK,
    keys: { feePayer: feePayer.address, rentPayer: rentPayer.address },
    rentPayer,
    kora,
    confirmTimeoutMs: 1_000,
    readRetry: { attempts: 2, delayMs: 5 },
  });

  beforeAll(async () => {
    buyer = await generateKeyPairSigner();
    authorizer = await generateKeyPairSigner();
    feePayer = await generateKeyPairSigner();
    rentPayer = await generateKeyPairSigner();
    seller = (await generateKeyPairSigner()).address;
    session = (await generateKeyPairSigner()).address;
  });

  // The session exists and names this facilitator's rent payer, the blockhash is valid, the simulation succeeds and the
  // close's event can be read, until a test says otherwise.
  beforeEach(() => {
    node = {
      accounts: new Map<string, Uint8Array>([[session, sessionData(rentPayer.address)]]),
      owner: STINT_PROGRAM_ADDRESS,
      blockhashValid: true,
      simulation: { err: null },
      closedEvent: true,
      failLifetime: false,
      calls: { read: 0, simulate: 0, send: 0, lifetime: 0 },
    };
  });

  describe("createCloseInfoSource", () => {
    it("serves the fee payer, a blockhash, the block height and the program", async () => {
      expect(await createCloseInfoSource(context()).read()).toEqual({
        feePayer: feePayer.address,
        recentBlockhash: BLOCKHASH,
        lastValidBlockHeight: "1234",
        blockHeight: "1000",
        programId: STINT_PROGRAM_ADDRESS,
      });
    });

    it("adds the session's stored fields when asked for a session, and answers nothing for an address with no session or another program's account", async () => {
      const source = createCloseInfoSource(context());
      expect((await source.read(session))?.session).toEqual({
        address: session,
        authority: buyer.address,
        seed: "1",
        mint: MINT,
        receiver: seller,
        receiverAuthorizer: authorizer.address,
        refundOwner: buyer.address,
        rentPayer: rentPayer.address,
        rate: "1000",
        minSeconds: 5,
        maxSeconds: 120,
        startedAt: 1_800_000_000,
        deposited: "30000",
        claimed: "0",
      });
      expect(await source.read((await generateKeyPairSigner()).address)).toBeUndefined();
      // Another program's account is no session, whatever its bytes decode to.
      node.owner = (await generateKeyPairSigner()).address;
      expect(await source.read(session)).toBeUndefined();
    });

    it("serves one blockhash for ttlMs, then asks the node again", async () => {
      let now = 0;
      const source = createCloseInfoSource(context(), { ttlMs: 2_000, clock: () => now });
      await source.read();
      now = 1_999;
      await source.read(session);
      expect(node.calls.lifetime).toBe(1);
      now = 2_000;
      await source.read();
      expect(node.calls.lifetime).toBe(2);
    });

    it("asks the node again when the clock has gone back", async () => {
      let now = 5_000;
      const source = createCloseInfoSource(context(), { ttlMs: 2_000, clock: () => now });
      await source.read();
      now = 1_000;
      await source.read();
      expect(node.calls.lifetime).toBe(2);
    });

    it("does not serve a read that failed: the next request asks the node", async () => {
      const source = createCloseInfoSource(context(), { clock: () => 0 });
      node.failLifetime = true;
      await expect(source.read()).rejects.toThrow("node down");
      node.failLifetime = false;
      expect(await source.read()).toMatchObject({ recentBlockhash: BLOCKHASH });
      expect(node.calls.lifetime).toBe(2);
    });
  });

  describe("verifySponsoredClose (spec §5.4, sponsored row)", () => {
    it("accepts a Standard close signed by the session's authority, and simulates it once", async () => {
      expect(await verifySponsoredClose(context(), await closeBy(buyer))).toMatchObject({
        ok: true,
        value: { session, payer: buyer.address },
      });
      expect(node.calls.simulate).toBe(1);
    });

    it("accepts an AtExpiry close signed by the session's authority", async () => {
      expect(await verifySponsoredClose(context(), await closeBy(buyer, CloseKind.AtExpiry))).toMatchObject({ ok: true });
    });

    it("refuses a body without a transaction, and a transaction that does not decode", async () => {
      expect(await verifySponsoredClose(context(), undefined)).toMatchObject({ ok: false, reason: "invalid_payload" });
      expect(await verifySponsoredClose(context(), "nope")).toMatchObject({ ok: false, reason: "invalid_payload" });
    });

    it("refuses another program's account and a session that does not exist, before simulating", async () => {
      // The account's bytes are a session that this facilitator would sponsor: only its owner is wrong.
      node.owner = (await generateKeyPairSigner()).address;
      expect(await verifySponsoredClose(context(), await closeBy(buyer))).toMatchObject({ ok: false, reason: "unknown_session" });
      node.accounts.clear();
      expect(await verifySponsoredClose(context(), await closeBy(buyer))).toMatchObject({ ok: false, reason: "unknown_session" });
      expect(node.calls.simulate).toBe(0);
    });

    it("refuses a session whose rent payer is not this facilitator's, before simulating", async () => {
      node.accounts.set(session, sessionData((await generateKeyPairSigner()).address));
      expect(await verifySponsoredClose(context(), await closeBy(buyer))).toEqual({
        ok: false,
        reason: "invalid_terms",
        message: "the session's rent payer is not this facilitator's",
      });
      expect(node.calls.simulate).toBe(0);
    });

    it("refuses a close signed by anyone but the session's authority, the receiver authorizer included", async () => {
      expect(await verifySponsoredClose(context(), await closeBy(authorizer))).toEqual({
        ok: false,
        reason: "invalid_payload",
        message: "the closer is not the session's authority",
      });
      expect(node.calls.simulate).toBe(0);
    });

    it("refuses a WaiveMinimum close before reading the session", async () => {
      expect(await verifySponsoredClose(context(), await closeBy(buyer, CloseKind.WaiveMinimum))).toEqual({
        ok: false,
        reason: "invalid_terms",
        message: "a sponsored close is Standard or AtExpiry",
      });
      expect(node.calls.read).toBe(0);
    });

    it("refuses, before reading the session, another instruction, a second close, another fee payer and a forged signature", async () => {
      const foreign: Instruction = { programAddress: (await generateKeyPairSigner()).address, data: new Uint8Array([1]) };
      const { transaction } = inspectTransaction(await closeBy(buyer))!;
      const forged = getBase64EncodedWireTransaction({
        ...transaction,
        signatures: { ...transaction.signatures, [buyer.address]: new Uint8Array(64).fill(7) as SignatureBytes },
      });
      const refused: [wire: string, reason: string][] = [
        [await closeChanged((ixs) => [...ixs, foreign]), "unexpected_instruction"],
        [await closeChanged((ixs) => [...ixs, ...ixs]), "unexpected_instruction"],
        [await closeBy(buyer, CloseKind.Standard, (await generateKeyPairSigner()).address), "payer_misuse"],
        [forged, "invalid_payload"],
      ];
      for (const [wire, reason] of refused) {
        expect(await verifySponsoredClose(context(), wire)).toMatchObject({ ok: false, reason });
      }
      expect(node.calls.read).toBe(0);
    });

    it("refuses a transaction whose blockhash is no longer valid", async () => {
      node.blockhashValid = false;
      expect(await verifySponsoredClose(context(), await closeBy(buyer))).toMatchObject({ ok: false, reason: "blockhash_expired" });
    });

    it("refuses a close whose simulation fails", async () => {
      node.simulation = { err: { InstructionError: [0, { Custom: 6000 }] }, logs: ["Program failed"] };
      expect(await verifySponsoredClose(context(), await closeBy(buyer))).toMatchObject({ ok: false, reason: "simulation_failed" });
    });
  });

  describe("createSponsoredCloser", () => {
    it("answers a refusal with success false and no transaction, and sends nothing", async () => {
      node.accounts.clear();
      expect(await createSponsoredCloser(context())(await closeBy(buyer))).toEqual({
        success: false,
        errorReason: "unknown_session",
        errorMessage: "no such session",
        transaction: "",
      });
      expect(node.calls.send).toBe(0);
    });

    it("answers simulation_failed when Kora refuses to sign, and sends nothing", async () => {
      expect(await createSponsoredCloser(context(fakeKora(feePayer, true)))(await closeBy(buyer))).toEqual({
        success: false,
        errorReason: "simulation_failed",
        errorMessage: "Kora: policy refused",
        transaction: "",
      });
      expect(node.calls.send).toBe(0);
    });

    it("submits the close with Kora's signature, and reports paid = claimed + owed + redirected, and refunded", async () => {
      expect(await createSponsoredCloser(context())(await closeBy(buyer))).toEqual({
        success: true,
        transaction: expect.any(String),
        paid: "8500",
        refunded: "22000",
      });
      expect(node.calls.send).toBe(1);
    });

    it("settles one close at a time per session: a close sent meanwhile gets the first one's answer and is not sent", async () => {
      let release!: () => void;
      node.holdSend = new Promise<void>((resolve) => {
        release = () => resolve();
      });
      const settle = createSponsoredCloser(context());
      const first = settle(await closeBy(buyer));
      const second = settle(await closeBy(buyer, CloseKind.AtExpiry));
      // Both are verified; the one that reaches the check second finds the other being sent, which the held send keeps there.
      await vi.waitFor(() => expect(node.calls.simulate).toBe(2));
      await new Promise((resolve) => setTimeout(resolve, 50));
      release();
      const [a, b] = await Promise.all([first, second]);
      expect(a).toMatchObject({ success: true, paid: "8500" });
      expect(b).toEqual(a);
      expect(node.calls.send).toBe(1);
    });

    it("sends a close of a session again once an earlier close of it has failed, which answered simulation_failed with its signature", async () => {
      const settle = createSponsoredCloser(context());
      node.failSend = true;
      const failed = await settle(await closeBy(buyer));
      expect(failed).toMatchObject({ success: false, errorReason: "simulation_failed", transaction: expect.stringMatching(/.+/) });
      node.failSend = false;
      expect(await settle(await closeBy(buyer))).toMatchObject({ success: true, paid: "8500" });
      expect(node.calls.send).toBe(2);
    });

    it("reports a confirmed close without amounts when its Closed event cannot be read", async () => {
      node.closedEvent = false;
      expect(await createSponsoredCloser(context())(await closeBy(buyer))).toEqual({ success: true, transaction: expect.any(String) });
    });
  });
});
