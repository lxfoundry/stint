import {
  AccountRole,
  createNoopSigner,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  partiallySignTransaction,
  type Address,
  type Instruction,
  type KeyPairSigner,
  type SignatureBytes,
} from "@solana/kit";
import { getSetComputeUnitLimitInstruction, getSetComputeUnitPriceInstruction } from "@solana-program/compute-budget";
import { getCreateAssociatedTokenIdempotentInstruction } from "@solana-program/token";
import { beforeAll, describe, expect, it } from "vitest";
import { CloseKind, type Session } from "@lxfoundry/stint-program-client";
import {
  associatedTokenAddress,
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

/** The same transaction with `signer`'s signature replaced by 64 bytes that are not a signature. */
function forged(wire: string, signer: Address): string {
  const { transaction } = inspectTransaction(wire)!;
  const signatures = { ...transaction.signatures, [signer]: new Uint8Array(64).fill(7) as SignatureBytes };
  return getBase64EncodedWireTransaction({ ...transaction, signatures });
}

/** The instruction with `extra` appended to its accounts as a signer, which its parser ignores. */
const withExtraSigner = (ix: Instruction, extra: KeyPairSigner): Instruction => ({
  ...ix,
  accounts: [...(ix.accounts ?? []), { address: extra.address, role: AccountRole.READONLY_SIGNER, signer: extra } as never],
});

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

  it("accepts a compute-unit limit and refuses a compute-unit price", async () => {
    const built = await buildOpenTransaction({ requirements: offer, authority: buyer, decimals: 6 });
    const withLimit = await rebuild(built.transaction, buyer, (ixs) => [getSetComputeUnitLimitInstruction({ units: 200_000 }), ...ixs]);
    expect(await checkOpenTransaction(inspectTransaction(withLimit)!, offer, keys())).toMatchObject({ ok: true });
    const withPrice = await rebuild(built.transaction, buyer, (ixs) => [getSetComputeUnitPriceInstruction({ microLamports: 1n }), ...ixs]);
    expect(await checkOpenTransaction(inspectTransaction(withPrice)!, offer, keys())).toMatchObject({ ok: false, reason: "unexpected_instruction" });
  });

  it("refuses the rent payer funding any account but the vault", async () => {
    const built = await buildOpenTransaction({ requirements: offer, authority: buyer, decimals: 6 });
    const mint = offer.asset as Address;
    const createFor = async (owner: Address) =>
      getCreateAssociatedTokenIdempotentInstruction({
        payer: createNoopSigner(rentPayer),
        ata: await associatedTokenAddress(owner, mint),
        owner,
        mint,
      });
    const extra = await createFor(buyer.address);
    const replaced = await rebuild(built.transaction, buyer, (ixs) => [extra, ...ixs.slice(1)]);
    expect(await checkOpenTransaction(inspectTransaction(replaced)!, offer, keys())).toMatchObject({ ok: false, reason: "payer_misuse" });
    const added = await rebuild(built.transaction, buyer, (ixs) => [extra, ...ixs]);
    expect(await checkOpenTransaction(inspectTransaction(added)!, offer, keys())).toMatchObject({ ok: false, reason: "payer_misuse" });
    const noOpen = await rebuild(built.transaction, buyer, (ixs) => ixs.slice(0, 2));
    expect(await checkOpenTransaction(inspectTransaction(noOpen)!, offer, keys())).toMatchObject({ ok: false, reason: "payer_misuse" });
  });

  it("refuses an authority signature that is not valid over the message", async () => {
    const built = await buildOpenTransaction({ requirements: offer, authority: buyer, decimals: 6 });
    const check = await checkOpenTransaction(inspectTransaction(forged(built.transaction, buyer.address))!, offer, keys());
    expect(check).toMatchObject({ ok: false, reason: "invalid_payload" });
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

  it("refuses an extra signer, even one whose signature is valid", async () => {
    const built = await buildOpenTransaction({ requirements: offer, authority: buyer, decimals: 6 });
    const extra = await generateKeyPairSigner();
    const wire = await rebuild(built.transaction, buyer, (ixs) => [...ixs.slice(0, -1), withExtraSigner(ixs.at(-1)!, extra)]);
    const tx = inspectTransaction(wire)!;
    expect(tx.signed).toEqual(new Set([buyer.address, extra.address]));
    expect(await checkOpenTransaction(tx, offer, keys())).toMatchObject({ ok: false, reason: "invalid_payload" });
  });

  it("refuses a TransferChecked with too few accounts instead of throwing", async () => {
    const built = await buildOpenTransaction({ requirements: offer, authority: buyer, decimals: 6 });
    const wire = await rebuild(built.transaction, buyer, ([create, transfer, open]) => [
      create!,
      { ...transfer!, accounts: transfer!.accounts!.slice(0, 2) },
      open!,
    ]);
    expect(await checkOpenTransaction(inspectTransaction(wire)!, offer, keys())).toMatchObject({ ok: false, reason: "unexpected_instruction" });
  });

  /** The built open with one account of one instruction replaced; `open` is [create, transfer, open]. */
  async function withAccount(which: "create" | "transfer" | "open", index: number, replacement: Address): Promise<string> {
    const built = await buildOpenTransaction({ requirements: offer, authority: buyer, decimals: 6 });
    return rebuild(built.transaction, buyer, (ixs) =>
      ixs.map((ix, i) =>
        ["create", "transfer", "open"][i] !== which
          ? ix
          : { ...ix, accounts: ix.accounts!.map((meta, at) => (at === index ? { ...meta, address: replacement } : meta)) },
      ),
    );
  }

  // TransferChecked accounts: source 0, mint 1, destination 2, authority 3.
  // `open` accounts: authority 0, rent payer 1, session 2, mint 3, vault 4, receiver 5, receiver authorizer 6, refund owner 7.
  it.each([
    ["a funding source that is not the refund owner's associated token account", "transfer", 0],
    ["a funding mint other than the asset", "transfer", 1],
    ["a funding destination that is not the vault", "transfer", 2],
    ["a receiver other than the offer's", "open", 5],
    ["a receiver authorizer other than the offer's", "open", 6],
    ["a refund owner whose account is not the funding source", "open", 7],
  ] as const)("refuses %s", async (_, which, index) => {
    const other = (await generateKeyPairSigner()).address;
    const wire = await withAccount(which, index, other);
    expect(await checkOpenTransaction(inspectTransaction(wire)!, offer, keys())).toMatchObject({ ok: false, reason: "invalid_terms" });
  });

  it("refuses a session that is not the one derived from the authority and seed", async () => {
    const wire = await withAccount("open", 2, (await generateKeyPairSigner()).address);
    expect(await checkOpenTransaction(inspectTransaction(wire)!, offer, keys())).toMatchObject({ ok: false, reason: "invalid_terms" });
  });

  it("refuses a vault that is not the session's associated token account for the asset", async () => {
    const wire = await withAccount("open", 4, (await generateKeyPairSigner()).address);
    expect(await checkOpenTransaction(inspectTransaction(wire)!, offer, keys())).toMatchObject({ ok: false, reason: "invalid_terms" });
  });

  it("refuses a mint other than the asset, even when the vault creation follows it", async () => {
    const built = await buildOpenTransaction({ requirements: offer, authority: buyer, decimals: 6 });
    const otherMint = (await generateKeyPairSigner()).address;
    const otherVault = await associatedTokenAddress(built.session, otherMint);
    const at = (ix: Instruction, replacements: Record<number, Address>): Instruction => ({
      ...ix,
      accounts: ix.accounts!.map((meta, index) => (replacements[index] ? { ...meta, address: replacements[index]! } : meta)),
    });
    // The vault creation and the open agree on the other mint, so only the comparison with the asset can refuse them.
    const wire = await rebuild(built.transaction, buyer, ([create, transfer, open]) => [
      at(create!, { 1: otherVault, 3: otherMint }),
      transfer!,
      at(open!, { 3: otherMint, 4: otherVault }),
    ]);
    expect(await checkOpenTransaction(inspectTransaction(wire)!, offer, keys())).toMatchObject({ ok: false, reason: "invalid_terms" });
  });

  it("refuses an open whose offer is for another program", async () => {
    const built = await buildOpenTransaction({ requirements: offer, authority: buyer, decimals: 6 });
    const other = { ...offer, extra: { ...offer.extra, programId: feePayer } };
    expect(await checkOpenTransaction(inspectTransaction(built.transaction)!, other, keys())).toMatchObject({
      ok: false,
      reason: "invalid_payment_requirements",
    });
  });

  it("accepts a funding transfer authorised by another key, as long as that key has signed", async () => {
    const funder = await generateKeyPairSigner();
    const built = await buildOpenTransaction({ requirements: offer, authority: buyer, decimals: 6 });
    const wire = await rebuild(built.transaction, buyer, ([create, transfer, open]) => [
      create!,
      {
        ...transfer!,
        accounts: transfer!.accounts!.map((meta, at) =>
          at === 3 ? { address: funder.address, role: AccountRole.READONLY_SIGNER, signer: funder } : meta,
        ),
      } as Instruction,
      open!,
    ]);
    const tx = inspectTransaction(wire)!;
    expect(tx.signed).toEqual(new Set([buyer.address, funder.address]));
    expect(await checkOpenTransaction(tx, offer, keys())).toMatchObject({ ok: true });
  });

  it("refuses a funding authority that has not signed", async () => {
    const funder = await generateKeyPairSigner();
    const built = await buildOpenTransaction({ requirements: offer, authority: buyer, decimals: 6 });
    const wire = await rebuild(built.transaction, buyer, ([create, transfer, open]) => [
      create!,
      {
        ...transfer!,
        accounts: transfer!.accounts!.map((meta, at) =>
          at === 3 ? { address: funder.address, role: AccountRole.READONLY_SIGNER, signer: createNoopSigner(funder.address) } : meta,
        ),
      } as Instruction,
      open!,
    ]);
    expect(await checkOpenTransaction(inspectTransaction(wire)!, offer, keys())).toMatchObject({ ok: false, reason: "invalid_payload" });
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
    expect(await checkCloseTransaction(tx, { session, closer: closer.address }, { feePayer, rentPayer })).toMatchObject({
      ok: true,
      value: { kind: CloseKind.Standard },
    });
    expect(await checkCloseTransaction(tx, { session, closer: authority.address }, { feePayer, rentPayer })).toMatchObject({
      ok: false,
      reason: "invalid_payload",
    });
    expect(await checkCloseTransaction(tx, { session: closer.address, closer: closer.address }, { feePayer, rentPayer })).toMatchObject({
      ok: false,
      reason: "invalid_terms",
    });
    const withLimit = await rebuild(wire, closer, (ixs) => [getSetComputeUnitLimitInstruction({ units: 100_000 }), ...ixs]);
    expect(await checkCloseTransaction(inspectTransaction(withLimit)!, { session, closer: closer.address }, { feePayer, rentPayer })).toMatchObject({
      ok: true,
    });
    const extra = await generateKeyPairSigner();
    const withExtra = await rebuild(wire, closer, (ixs) => [withExtraSigner(ixs[0]!, extra)]);
    expect(inspectTransaction(withExtra)!.signed).toEqual(new Set([closer.address, extra.address]));
    expect(await checkCloseTransaction(inspectTransaction(withExtra)!, { session, closer: closer.address }, { feePayer, rentPayer })).toMatchObject({
      ok: false,
      reason: "invalid_payload",
    });
    const forgedWire = forged(wire, closer.address);
    expect(
      await checkCloseTransaction(inspectTransaction(forgedWire)!, { session, closer: closer.address }, { feePayer, rentPayer }),
    ).toMatchObject({ ok: false, reason: "invalid_payload" });
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
