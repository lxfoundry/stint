import {
  AccountState,
  TOKEN_PROGRAM_ADDRESS,
  getTokenEncoder,
  getTokenSize,
} from "@solana-program/token";
import { generateKeyPairSigner, getBase64Decoder, none, type Address, type KeyPairSigner, type Rpc, type SolanaRpcApi } from "@solana/kit";
import { STINT_PROGRAM_ADDRESS, getSessionEncoder, getSessionSize } from "@lxfoundry/stint-program-client";
import {
  associatedTokenAddress,
  buildCloseTransaction,
  buildOpenOffer,
  buildOpenTransaction,
  buildCloseRequirements,
  type ElapsedRequirements,
} from "@lxfoundry/stint-x402";
import { beforeAll, describe, expect, it } from "vitest";
import { verifyPayment, type FacilitatorContext } from "../src/verify.js";

const NETWORK = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const BLOCKHASH = "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N";
const MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU" as Address;

/** What the fake node answers; the unset parts are the happy path. */
interface Node {
  accounts: Map<string, { owner: Address; data: Uint8Array }>;
  blockhashValid: boolean;
  simulation: { err: unknown; logs?: string[]; innerInstructions?: unknown[] };
  simulated: number;
}

/** Only the methods `verifyPayment` calls, each answering from `node`. */
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
        node.simulated++;
        return { value: { logs: [], innerInstructions: [], ...node.simulation } };
      }),
  };
  return rpc as unknown as Rpc<SolanaRpcApi>;
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
  expect(data.length).toBe(getTokenSize());
  return { owner: TOKEN_PROGRAM_ADDRESS, data: Uint8Array.from(data) };
}

describe("verifyPayment (spec §5.4)", () => {
  let buyer: KeyPairSigner;
  let feePayer: Address;
  let rentPayer: KeyPairSigner;
  let authorizer: KeyPairSigner;
  let offer: ElapsedRequirements;
  let node: Node;
  let ctx: FacilitatorContext;

  const payload = (accepted: unknown, body: unknown) => ({ x402Version: 2, accepted, payload: body });
  const openPayload = async (requirements: ElapsedRequirements = offer) => {
    const built = await buildOpenTransaction({ requirements, authority: buyer, decimals: 6 });
    return payload(requirements, { type: "open", transaction: built.transaction, session: built.session });
  };

  beforeAll(async () => {
    buyer = await generateKeyPairSigner();
    rentPayer = await generateKeyPairSigner();
    feePayer = (await generateKeyPairSigner()).address;
    const seller = (await generateKeyPairSigner()).address;
    authorizer = await generateKeyPairSigner();
    const receiverAuthorizer = authorizer.address;
    offer = buildOpenOffer({
      network: NETWORK,
      asset: MINT,
      payTo: seller,
      receiverAuthorizer,
      terms: { rate: 1_000n, minSeconds: 5, maxSeconds: 120 },
      seconds: 30,
      facilitator: { feePayer, rentPayer: rentPayer.address, programId: STINT_PROGRAM_ADDRESS, closeUrl: "http://127.0.0.1:4021/close" },
      lifetime: { blockhash: BLOCKHASH, lastValidBlockHeight: 1_234n },
      maxTimeoutSeconds: 60,
      idleCloseSeconds: 10,
      closeOnOutage: true,
    });
  });

  // The seller's token account exists, the blockhash is valid and the simulation succeeds, until a test says otherwise.
  const resetNode = async () => {
    node = { accounts: new Map(), blockhashValid: true, simulation: { err: null }, simulated: 0 };
    node.accounts.set(await associatedTokenAddress(offer.payTo as Address, MINT), tokenAccount(offer.payTo as Address));
    ctx = {
      rpc: fakeRpc(node),
      network: NETWORK,
      keys: { feePayer, rentPayer: rentPayer.address },
      rentPayer,
      kora: undefined as never,
      confirmTimeoutMs: 1_000,
    };
  };

  describe("an open", () => {
    it("accepts a transaction that passes every check and simulates", async () => {
      await resetNode();
      const built = await openPayload();
      const verified = await verifyPayment(ctx, built, offer);
      expect(verified).toMatchObject({ ok: true, type: "open", payer: buyer.address });
      expect(node.simulated).toBe(1);
    });

    it("refuses a payload that is not an object, and a wrong x402 version", async () => {
      await resetNode();
      expect(await verifyPayment(ctx, "nope", offer)).toMatchObject({ ok: false, reason: "invalid_payload" });
      expect(await verifyPayment(ctx, { ...(await openPayload()), x402Version: 1 }, offer)).toMatchObject({
        ok: false,
        reason: "invalid_x402_version",
      });
    });

    it("refuses requirements that are not elapsed requirements", async () => {
      await resetNode();
      expect(await verifyPayment(ctx, await openPayload(), { scheme: "exact" })).toMatchObject({
        ok: false,
        reason: "invalid_payment_requirements",
      });
    });

    it("refuses requirements naming another network, program or fee payer, or rent payer", async () => {
      await resetNode();
      const built = await openPayload();
      const other = (await generateKeyPairSigner()).address;
      // Each variant is echoed as `accepted`, so only the comparison with the facilitator's own keys can refuse it.
      const variants: ElapsedRequirements[] = [
        { ...offer, network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" },
        { ...offer, extra: { ...offer.extra, programId: other } },
        { ...offer, extra: { ...offer.extra, feePayer: other } },
        { ...offer, extra: { ...offer.extra, rentPayer: other } },
      ];
      for (const requirements of variants) {
        const verified = await verifyPayment(ctx, { ...built, accepted: requirements }, requirements);
        expect(verified).toMatchObject({ ok: false, reason: "invalid_payment_requirements" });
        expect(verified.ok ? "" : verified.message).toContain("another network, program or facilitator");
      }
      expect(node.simulated).toBe(0);
    });

    it("refuses requirements with a malformed address as invalid, without throwing", async () => {
      await resetNode();
      const built = await openPayload();
      // Echoed as `accepted` too, so that the read of the requirements is the only thing that can refuse them.
      for (const requirements of [{ ...offer, asset: "0OIl" }, { ...offer, extra: { ...offer.extra, session: "0OIl" } }]) {
        const verified = await verifyPayment(ctx, { ...built, accepted: requirements }, requirements);
        expect(verified).toMatchObject({ ok: false, reason: "invalid_payment_requirements", message: "not elapsed requirements" });
      }
      expect(node.simulated).toBe(0);
    });

    it("refuses an accepted entry that differs from the issued requirements", async () => {
      await resetNode();
      const built = await openPayload();
      const echoed = { ...built, accepted: { ...offer, amount: "1" } };
      expect(await verifyPayment(ctx, echoed, offer)).toMatchObject({ ok: false, reason: "invalid_payment_requirements" });
    });

    it("refuses a payload whose type does not match the action", async () => {
      await resetNode();
      const built = await openPayload();
      const wrongType = { ...built, payload: { ...(built.payload as object), type: "close" } };
      expect(await verifyPayment(ctx, wrongType, offer)).toMatchObject({ ok: false, reason: "invalid_payload" });
    });

    it("refuses a transaction that cannot be decoded", async () => {
      await resetNode();
      expect(await verifyPayment(ctx, payload(offer, { type: "open", transaction: "AQ==", session: buyer.address }), offer)).toMatchObject({
        ok: false,
        reason: "invalid_payload",
      });
    });

    it("refuses a deposit that is not the offered amount", async () => {
      await resetNode();
      const lower = { ...offer, amount: "29999" };
      const built = await buildOpenTransaction({ requirements: lower, authority: buyer, decimals: 6 });
      expect(await verifyPayment(ctx, payload(offer, { type: "open", transaction: built.transaction, session: built.session }), offer)).toMatchObject({
        ok: false,
        reason: "invalid_amount",
      });
    });

    it("refuses a payTo that has no token account for the asset", async () => {
      await resetNode();
      node.accounts.clear();
      expect(await verifyPayment(ctx, await openPayload(), offer)).toMatchObject({ ok: false, reason: "invalid_terms" });
      expect(node.simulated).toBe(0);
    });

    it("refuses an expired blockhash without simulating", async () => {
      await resetNode();
      node.blockhashValid = false;
      expect(await verifyPayment(ctx, await openPayload(), offer)).toMatchObject({ ok: false, reason: "blockhash_expired" });
      expect(node.simulated).toBe(0);
    });

    it("refuses a transaction whose simulation fails, with the node's error", async () => {
      await resetNode();
      node.simulation = { err: { InstructionError: [2, { Custom: 6000 }] }, logs: ["Program log: failed"] };
      const verified = await verifyPayment(ctx, await openPayload(), offer);
      expect(verified).toMatchObject({ ok: false, reason: "simulation_failed" });
      expect(verified.ok ? "" : verified.message).toContain("6000");
    });
  });

  describe("a close", () => {
    let closeRequirements: ElapsedRequirements;
    let session: Address;
    let closer: KeyPairSigner;

    const storedSession = (overrides: { rate?: bigint } = {}) => ({
      owner: STINT_PROGRAM_ADDRESS,
      data: Uint8Array.from(
        getSessionEncoder().encode({
          version: 1,
          bump: 255,
          authority: buyer.address,
          seed: 1n,
          mint: MINT,
          receiver: offer.payTo as Address,
          receiverAuthorizer: authorizer.address,
          refundOwner: buyer.address,
          rentPayer: rentPayer.address,
          rate: overrides.rate ?? 1_000n,
          minSeconds: 5,
          maxSeconds: 120,
          startedAt: 1_800_000_000n,
          deposited: 30_000n,
          claimed: 0n,
        }),
      ),
    });

    const closePayload = async (signedBy: KeyPairSigner = closer) => {
      const wire = await buildCloseTransaction({
        session,
        stored: { mint: MINT, receiver: offer.payTo as Address, refundOwner: buyer.address, rentPayer: rentPayer.address },
        closer: signedBy,
        feePayer,
        lifetime: { blockhash: BLOCKHASH, lastValidBlockHeight: 100n },
      });
      return payload(closeRequirements, { type: "close", transaction: wire });
    };

    beforeAll(async () => {
      session = (await generateKeyPairSigner()).address;
      closeRequirements = buildCloseRequirements({
        network: NETWORK,
        asset: MINT,
        payTo: offer.payTo as Address,
        receiverAuthorizer: offer.extra.receiverAuthorizer as Address,
        terms: { rate: 1_000n, minSeconds: 5, maxSeconds: 120 },
        facilitator: { feePayer, rentPayer: rentPayer.address, programId: STINT_PROGRAM_ADDRESS, closeUrl: "http://127.0.0.1:4021/close" },
        lifetime: { blockhash: BLOCKHASH, lastValidBlockHeight: 100n },
        maxTimeoutSeconds: 60,
        idleCloseSeconds: 10,
        closeOnOutage: true,
        session,
      });
      closer = authorizer;
    });

    it("refuses a session that does not exist", async () => {
      await resetNode();
      expect(await verifyPayment(ctx, await closePayload(), closeRequirements)).toMatchObject({ ok: false, reason: "unknown_session" });
    });

    it("refuses a session whose terms differ from the requirements", async () => {
      await resetNode();
      node.accounts.set(session, storedSession({ rate: 999n }));
      expect(await verifyPayment(ctx, await closePayload(), closeRequirements)).toMatchObject({ ok: false, reason: "invalid_terms" });
      expect(node.simulated).toBe(0);
    });

    it("accepts a close signed by the session's receiver authorizer, and simulates it", async () => {
      await resetNode();
      node.accounts.set(session, storedSession());
      expect(await verifyPayment(ctx, await closePayload(), closeRequirements)).toMatchObject({
        ok: true,
        type: "close",
        payer: buyer.address,
        session,
      });
      expect(node.simulated).toBe(1);
    });

    it("refuses a close that names a closer other than the session's receiver authorizer", async () => {
      await resetNode();
      node.accounts.set(session, storedSession());
      const verified = await verifyPayment(ctx, await closePayload(await generateKeyPairSigner()), closeRequirements);
      expect(verified).toMatchObject({ ok: false, reason: "invalid_payload", message: "the closer is not the expected one" });
      expect(node.simulated).toBe(0);
    });
  });
});
