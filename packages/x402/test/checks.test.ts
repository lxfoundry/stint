import {
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  partiallySignTransaction,
  type Address,
  type KeyPairSigner,
} from "@solana/kit";
import { getSetComputeUnitPriceInstruction } from "@solana-program/compute-budget";
import { beforeAll, describe, expect, it } from "vitest";
import { CloseKind, type Session } from "@lxfoundry/stint-program-client";
import {
  buildCloseTransaction,
  buildOpenOffer,
  buildOpenTransaction,
  checkCloseTransaction,
  checkOpenTransaction,
  inspectTransaction,
  sessionMatches,
  sellerTermsOf,
  type ElapsedRequirements,
} from "../src/index.js";
import { offerInput } from "./fixtures.js";
import { rebuild } from "./rebuild.js";

describe("open transactions (spec §5.3, §5.4)", () => {
  let buyer: KeyPairSigner;
  let feePayer: Address;
  let rentPayer: Address;
  let offer: ElapsedRequirements;

  beforeAll(async () => {
    buyer = await generateKeyPairSigner();
    feePayer = (await generateKeyPairSigner()).address;
    rentPayer = (await generateKeyPairSigner()).address;
    offer = buildOpenOffer(
      offerInput({ facilitator: { ...offerInput().facilitator, feePayer, rentPayer } }),
    );
  });

  const keys = () => ({ feePayer, rentPayer });

  it("builds what the facilitator accepts, signed by the authority only", async () => {
    const built = await buildOpenTransaction({ requirements: offer, authority: buyer, decimals: 6, seed: 42n });
    const tx = inspectTransaction(built.transaction)!;
    expect(tx.feePayer).toBe(feePayer);
    expect([...tx.signed]).toEqual([buyer.address]);
    const check = await checkOpenTransaction(tx, offer, keys());
    expect(check).toMatchObject({ ok: true, value: { session: built.session, authority: buyer.address, seed: 42n } });
  });

  it("refuses a deposit that is not exactly the amount", async () => {
    const built = await buildOpenTransaction({ requirements: { ...offer, amount: "29999" }, authority: buyer, decimals: 6 });
    const check = await checkOpenTransaction(inspectTransaction(built.transaction)!, offer, keys());
    expect(check).toMatchObject({ ok: false, reason: "invalid_amount" });
  });

  it("refuses terms that differ from the offer", async () => {
    const other = { ...offer, extra: { ...offer.extra, rate: "999", minSeconds: 1 } };
    const built = await buildOpenTransaction({ requirements: other, authority: buyer, decimals: 6 });
    const check = await checkOpenTransaction(inspectTransaction(built.transaction)!, offer, keys());
    expect(check).toMatchObject({ ok: false, reason: "invalid_terms" });
  });

  it("refuses the fee payer anywhere but as fee payer", async () => {
    const misplaced = { ...offer, extra: { ...offer.extra, rentPayer: feePayer } };
    const built = await buildOpenTransaction({ requirements: misplaced, authority: buyer, decimals: 6 });
    const check = await checkOpenTransaction(inspectTransaction(built.transaction)!, offer, keys());
    expect(check).toMatchObject({ ok: false, reason: "payer_misuse" });
  });

  it("refuses a priority fee, and an instruction outside the layout", async () => {
    const built = await buildOpenTransaction({ requirements: offer, authority: buyer, decimals: 6 });
    const withPrice = await rebuild(built.transaction, buyer, (ixs) => [getSetComputeUnitPriceInstruction({ microLamports: 1n }), ...ixs]);
    expect(await checkOpenTransaction(inspectTransaction(withPrice)!, offer, keys())).toMatchObject({ ok: false, reason: "unexpected_instruction" });
    const reversed = await rebuild(built.transaction, buyer, (ixs) => [...ixs].reverse());
    expect(await checkOpenTransaction(inspectTransaction(reversed)!, offer, keys())).toMatchObject({ ok: false, reason: "unexpected_instruction" });
  });

  it("refuses a transaction whose fee payer has already signed", async () => {
    const payer = await generateKeyPairSigner();
    const payerOffer = { ...offer, extra: { ...offer.extra, feePayer: payer.address } };
    const built = await buildOpenTransaction({ requirements: payerOffer, authority: buyer, decimals: 6 });
    const signed = await partiallySignTransaction([payer.keyPair], inspectTransaction(built.transaction)!.transaction);
    const check = await checkOpenTransaction(inspectTransaction(getBase64EncodedWireTransaction(signed))!, payerOffer, {
      feePayer: payer.address,
      rentPayer,
    });
    expect(check).toMatchObject({ ok: false, reason: "payer_misuse" });
  });

  it("returns undefined for bytes that are not a version 0 transaction", () => {
    expect(inspectTransaction("AQ==")).toBeUndefined();
  });
});

describe("close transactions (spec §5.3, §5.4)", () => {
  it("accepts a close signed by the expected closer, and nothing else", async () => {
    const closer = await generateKeyPairSigner();
    const authority = await generateKeyPairSigner();
    const feePayer = (await generateKeyPairSigner()).address;
    const rentPayer = (await generateKeyPairSigner()).address;
    const session = (await generateKeyPairSigner()).address;
    const stored = {
      authority: authority.address,
      mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU" as Address,
      receiver: (await generateKeyPairSigner()).address,
      refundOwner: authority.address,
      rentPayer,
    };
    const wire = await buildCloseTransaction({
      session,
      stored,
      closer,
      feePayer,
      lifetime: { blockhash: "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N", lastValidBlockHeight: 100n },
    });
    const tx = inspectTransaction(wire)!;
    expect(checkCloseTransaction(tx, { session, closer: closer.address }, { feePayer, rentPayer })).toMatchObject({
      ok: true,
      value: { kind: CloseKind.Standard },
    });
    expect(checkCloseTransaction(tx, { session, closer: authority.address }, { feePayer, rentPayer })).toMatchObject({
      ok: false,
      reason: "invalid_payload",
    });
    expect(checkCloseTransaction(tx, { session: closer.address, closer: closer.address }, { feePayer, rentPayer })).toMatchObject({
      ok: false,
      reason: "invalid_terms",
    });
  });
});

describe("sessionMatches (spec §7.2, check 4)", () => {
  it("requires the program's terms, the mint, the receiver and the receiver authorizer", () => {
    const seller = sellerTermsOf(buildOpenOffer(offerInput()));
    const session = {
      mint: seller.asset,
      receiver: seller.payTo,
      receiverAuthorizer: seller.receiverAuthorizer,
      rate: 1_000n,
      minSeconds: 5,
      maxSeconds: 120,
    } as Session;
    expect(sessionMatches(session, seller)).toBe(true);
    expect(sessionMatches({ ...session, mint: seller.payTo }, seller)).toBe(false);
    expect(sessionMatches({ ...session, rate: 999n }, seller)).toBe(false);
    expect(sessionMatches({ ...session, receiverAuthorizer: seller.payTo }, seller)).toBe(false);
  });
});
