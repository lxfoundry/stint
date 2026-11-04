import { blockhash, generateKeyPairSigner } from "@solana/kit";
import type { Buyer } from "@lxfoundry/stint-conformance";
import { fetchMaybeSession, fetchSession } from "@lxfoundry/stint-program-client";
import {
  SOLANA_DEVNET,
  USDC_DEVNET,
  buildCloseRequirements,
  buildCloseTransaction,
  buildOpenOffer,
  buildOpenTransaction,
  buildSponsoredClose,
  fetchClosedEvent,
  readCloseInfo,
  tokenBalanceChanges,
  type CloseInfo,
  type ElapsedRequirements,
  type FacilitatorExtra,
  type OfferInput,
  type PaymentPayload,
  type SettleResponse,
  type SponsoredCloseResponse,
  type SupportedResponse,
} from "@lxfoundry/stint-x402";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newBuyer } from "../src/fixtures/buyers.js";
import { startLocalStack, type LocalStack } from "../src/targets/local.js";

describe("facilitator on the local network, through Kora", () => {
  let stack: LocalStack;
  let base: Omit<OfferInput, "seconds" | "lifetime">;

  beforeAll(async () => {
    stack = await startLocalStack();
    const supported = (await (await fetch(`${stack.facilitator.url}/supported`)).json()) as SupportedResponse;
    base = {
      network: SOLANA_DEVNET,
      asset: USDC_DEVNET.mint,
      payTo: stack.keys.seller.signer.address,
      receiverAuthorizer: stack.keys.receiverAuthorizer.signer.address,
      terms: { rate: 1_000n, minSeconds: 5, maxSeconds: 120 },
      facilitator: supported.kinds[0]!.extra as unknown as FacilitatorExtra,
      maxTimeoutSeconds: 60,
      idleCloseSeconds: 10,
      closeOnOutage: true,
    };
  });

  afterAll(async () => {
    await stack?.stop();
  });

  async function lifetime() {
    const { value } = await stack.network.rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
    return value;
  }

  async function call(path: "/verify" | "/settle", paymentPayload: PaymentPayload, paymentRequirements: ElapsedRequirements) {
    const response = await fetch(`${stack.facilitator.url}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${stack.facilitatorApiKey}` },
      body: JSON.stringify({ x402Version: 2, paymentPayload, paymentRequirements }),
    });
    return response.json();
  }

  async function openPayment(buyer: Buyer, offerOverride?: ElapsedRequirements) {
    const offer = buildOpenOffer({ ...base, seconds: 30, lifetime: await lifetime() });
    const built = await buildOpenTransaction({ requirements: offerOverride ?? offer, authority: buyer.signer, decimals: 6 });
    const payload: PaymentPayload = {
      x402Version: 2,
      resource: { url: "http://gate.test/sessions" },
      accepted: offer,
      payload: { type: "open", transaction: built.transaction, session: built.session },
    };
    return { offer, payload, session: built.session };
  }

  /** `GET closeUrl?session=`, read as any client reads it. */
  async function closeInfoFor(session: string): Promise<CloseInfo> {
    const response = await fetch(`${stack.facilitator.closeUrl}?session=${session}`);
    expect(response.status).toBe(200);
    const info = readCloseInfo(await response.json());
    expect(info?.session).toBeDefined();
    return info!;
  }

  /** `POST closeUrl`, with no API key. */
  async function postClose(transaction: string): Promise<SponsoredCloseResponse> {
    const response = await fetch(stack.facilitator.closeUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ transaction }),
    });
    expect(response.status).toBe(200);
    return (await response.json()) as SponsoredCloseResponse;
  }

  it("verifies an open without changing the chain", async () => {
    const buyer = await newBuyer(stack.network.rpc, stack.keys.mintAuthority.signer, 1_000_000n);
    const { offer, payload, session } = await openPayment(buyer);
    expect(await call("/verify", payload, offer)).toEqual({ isValid: true, payer: buyer.signer.address });
    expect((await fetchMaybeSession(stack.network.rpc, session)).exists).toBe(false);
  });

  it("refuses the fee payer as the vault's funder (payer_misuse)", async () => {
    const buyer = await newBuyer(stack.network.rpc, stack.keys.mintAuthority.signer, 1_000_000n);
    const honest = buildOpenOffer({ ...base, seconds: 30, lifetime: await lifetime() });
    const misplaced = { ...honest, extra: { ...honest.extra, rentPayer: honest.extra.feePayer } };
    const { payload } = await openPayment(buyer, misplaced);
    expect(await call("/verify", { ...payload, accepted: honest }, honest)).toMatchObject({
      isValid: false,
      invalidReason: "payer_misuse",
    });
  });

  it("settles an open, with the rent payer funding the session inside the program (spec §14 Q2), then a close", async () => {
    const buyer = await newBuyer(stack.network.rpc, stack.keys.mintAuthority.signer, 1_000_000n);
    const { offer, payload, session } = await openPayment(buyer);
    const opened = await call("/settle", payload, offer);
    expect(opened).toMatchObject({ success: true, payer: buyer.signer.address, amount: "30000", network: SOLANA_DEVNET });
    const stored = await fetchSession(stack.network.rpc, session);
    expect(stored.data).toMatchObject({ deposited: 30_000n, rentPayer: stack.facilitator.rentPayer, refundOwner: buyer.signer.address });

    const closeLifetime = await lifetime();
    const transaction = await buildCloseTransaction({
      session,
      stored: stored.data,
      closer: stack.keys.receiverAuthorizer.signer,
      feePayer: stack.facilitator.feePayer,
      lifetime: closeLifetime,
    });
    const requirements = buildCloseRequirements({ ...base, lifetime: closeLifetime, session });
    const closed = (await call(
      "/settle",
      { x402Version: 2, accepted: requirements, payload: { type: "close", transaction } },
      requirements,
    )) as SettleResponse;
    expect(closed).toMatchObject({ success: true, payer: buyer.signer.address });

    const event = (await fetchClosedEvent(stack.network.rpc, closed.transaction))!;
    expect(closed.amount).toBe((event.owed + event.redirected).toString());
    expect(event.owed + event.refunded).toBe(30_000n);
    const changes = await tokenBalanceChanges(stack.network.rpc, closed.transaction);
    expect(changes.get(stack.keys.sellerUsdcAccount)).toBe(event.owed);
    expect(changes.get(buyer.usdcAccount)).toBe(event.refunded);
    expect((await fetchMaybeSession(stack.network.rpc, session)).exists).toBe(false);
  });

  /** The buyer's USDC at `confirmed`, in base units. */
  async function usdcOf(buyer: Buyer): Promise<string> {
    return (await stack.network.rpc.getTokenAccountBalance(buyer.usdcAccount, { commitment: "confirmed" }).send()).value.amount;
  }

  it("answers a payment it has settled from its record: the same answer, one transaction, the buyer charged once", async () => {
    const buyer = await newBuyer(stack.network.rpc, stack.keys.mintAuthority.signer, 100_000n);
    const { offer, payload, session } = await openPayment(buyer);
    const first = (await call("/settle", payload, offer)) as SettleResponse;
    expect(first).toMatchObject({ success: true, payer: buyer.signer.address, amount: "30000" });

    // The session exists now, so a verification of the payload as new would fail its simulation: the record answers.
    expect(await call("/verify", payload, offer)).toEqual({ isValid: true, payer: buyer.signer.address });
    expect(await call("/settle", payload, offer)).toEqual(first);

    const changes = await tokenBalanceChanges(stack.network.rpc, first.transaction);
    expect(changes.get(buyer.usdcAccount)).toBe(-30_000n);
    expect(await usdcOf(buyer)).toBe("70000");
    expect((await fetchSession(stack.network.rpc, session)).data.deposited).toBe(30_000n);
  });

  it("settles two identical payments sent at once with one transaction", async () => {
    const buyer = await newBuyer(stack.network.rpc, stack.keys.mintAuthority.signer, 100_000n);
    const { offer, payload } = await openPayment(buyer);
    const [a, b] = (await Promise.all([call("/settle", payload, offer), call("/settle", payload, offer)])) as SettleResponse[];
    expect(a).toMatchObject({ success: true });
    expect(b).toEqual(a);
    expect(await usdcOf(buyer)).toBe("70000");
  });

  it("refuses a payment it has settled when it comes back with other requirements", async () => {
    const buyer = await newBuyer(stack.network.rpc, stack.keys.mintAuthority.signer, 100_000n);
    const { offer, payload } = await openPayment(buyer);
    expect(await call("/settle", payload, offer)).toMatchObject({ success: true });
    // The same transaction, echoing the other requirements it now comes with: only the record can tell it apart.
    const other = { ...offer, extra: { ...offer.extra, idleCloseSeconds: 11 } };
    const again = { ...payload, accepted: other };
    expect(await call("/settle", again, other)).toMatchObject({ success: false, errorReason: "invalid_payment_requirements" });
    expect(await call("/verify", again, other)).toMatchObject({ isValid: false, invalidReason: "invalid_payment_requirements" });
    expect(await usdcOf(buyer)).toBe("70000");
  });

  it("answers GET /close with its fee payer, a current blockhash and the block height, and 404 for an address with no session", async () => {
    const info = readCloseInfo(await (await fetch(stack.facilitator.closeUrl)).json());
    expect(info).toMatchObject({ feePayer: stack.facilitator.feePayer, programId: base.facilitator.programId });
    const { value: valid } = await stack.network.rpc.isBlockhashValid(blockhash(info!.recentBlockhash), { commitment: "confirmed" }).send();
    expect(valid).toBe(true);
    expect(BigInt(info!.blockHeight)).toBeLessThanOrEqual(BigInt(info!.lastValidBlockHeight));
    // No session: an address that holds no account, and an account that another program owns (the fee payer's wallet).
    for (const address of [(await generateKeyPairSigner()).address, stack.facilitator.feePayer]) {
      const missing = await fetch(`${stack.facilitator.closeUrl}?session=${address}`);
      expect(missing.status).toBe(404);
    }
  });

  it("settles a sponsored close built only from GET /close and signed by the authority, with no API key", async () => {
    const buyer = await newBuyer(stack.network.rpc, stack.keys.mintAuthority.signer, 1_000_000n);
    const { offer, payload, session } = await openPayment(buyer);
    expect(await call("/settle", payload, offer)).toMatchObject({ success: true });

    const info = await closeInfoFor(session);
    expect(info.session).toMatchObject({
      address: session,
      authority: buyer.signer.address,
      rentPayer: stack.facilitator.rentPayer,
      deposited: "30000",
    });
    const closed = await postClose(await buildSponsoredClose(info, { session, closer: buyer.signer }));
    expect(closed.success).toBe(true);

    const event = (await fetchClosedEvent(stack.network.rpc, closed.transaction))!;
    expect(event.closedBy).toBe(buyer.signer.address);
    expect(closed).toEqual({
      success: true,
      transaction: closed.transaction,
      paid: (event.claimed + event.owed + event.redirected).toString(),
      refunded: event.refunded.toString(),
    });
    const changes = await tokenBalanceChanges(stack.network.rpc, closed.transaction);
    expect(changes.get(buyer.usdcAccount)).toBe(event.refunded);
    expect((await fetchMaybeSession(stack.network.rpc, session)).exists).toBe(false);
  });

  it("refuses a sponsored close of a session whose rent payer is not the facilitator's, and leaves the session open", async () => {
    const direct = stack.context().direct!;
    const buyer = await newBuyer(stack.network.rpc, stack.keys.mintAuthority.signer, 1_000_000n);
    const opened = await direct.open({ buyer, seconds: 10 });
    try {
      const info = await closeInfoFor(opened.session);
      expect(info.session?.rentPayer).toBe(opened.rentPayer);
      expect(await postClose(await buildSponsoredClose(info, { session: opened.session, closer: buyer.signer }))).toMatchObject({
        success: false,
        errorReason: "invalid_terms",
        transaction: "",
      });
      expect((await fetchMaybeSession(stack.network.rpc, opened.session)).exists).toBe(true);
    } finally {
      await direct.close(opened, buyer.signer);
    }
  });
});
