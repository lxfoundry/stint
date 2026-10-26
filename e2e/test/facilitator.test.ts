import { fetchMaybeSession, fetchSession } from "@lxfoundry/stint-program-client";
import {
  SOLANA_DEVNET,
  USDC_DEVNET,
  buildCloseRequirements,
  buildCloseTransaction,
  buildOpenOffer,
  buildOpenTransaction,
  fetchClosedEvent,
  tokenBalanceChanges,
  type ElapsedRequirements,
  type FacilitatorExtra,
  type OfferInput,
  type PaymentPayload,
  type SettleResponse,
  type SupportedResponse,
} from "@lxfoundry/stint-x402";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newBuyer, type Buyer } from "../src/fixtures/buyers.js";
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
});
