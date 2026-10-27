import { generateKeyPairSigner } from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS, findAssociatedTokenPda } from "@solana-program/token";
import { beforeEach, describe, expect, it } from "vitest";
import {
  STINT_ERROR__ACCOUNT_MISMATCH,
  STINT_ERROR__DEPOSIT_TOO_LARGE,
  STINT_ERROR__DEPOSIT_TOO_SMALL,
  STINT_ERROR__INVALID_TERMS,
  findOpenedEvent,
  findSessionPda,
  getSessionDecoder,
} from "../../src/index.js";
import { Fixture, type Wallet } from "./fixture.js";

describe("open", () => {
  let fixture: Fixture;
  let buyer: Wallet;

  beforeEach(async () => {
    fixture = await Fixture.create();
    buyer = await fixture.wallet(1_000_000n);
  });

  it("stores the terms, credits the vault and emits Opened", async () => {
    const now = fixture.now();
    const { session, vault, sent } = await fixture.open({ authority: buyer, deposit: 30_000n, seed: 7n });
    expect(sent.ok, sent.logs.join("\n")).toBe(true);

    const account = fixture.svm.getAccount(session);
    if (!account.exists) throw new Error("no session");
    const stored = getSessionDecoder().decode(account.data);
    expect(stored).toMatchObject({
      version: 1,
      authority: buyer.signer.address,
      seed: 7n,
      mint: fixture.mint,
      receiver: fixture.seller.signer.address,
      receiverAuthorizer: fixture.receiverAuthorizer.address,
      refundOwner: buyer.signer.address,
      rentPayer: fixture.rentPayer.address,
      rate: 1_000n,
      minSeconds: 5,
      maxSeconds: 120,
      startedAt: now,
      deposited: 30_000n,
      claimed: 0n,
    });
    expect(fixture.tokenAmount(vault)).toBe(30_000n);
    expect(findOpenedEvent(sent.inner)).toMatchObject({
      session,
      authority: buyer.signer.address,
      deposited: 30_000n,
      startedAt: now,
      paidUntil: now + 30n,
    });
  });

  it("has the rent payer fund the session and the vault", async () => {
    const before = fixture.lamportsOf(fixture.rentPayer.address);
    const { session, vault } = await fixture.open({ authority: buyer, deposit: 30_000n });
    const spent = before - fixture.lamportsOf(fixture.rentPayer.address);
    expect(spent).toBe(fixture.lamportsOf(session) + fixture.lamportsOf(vault));
  });

  it.each([
    ["a zero rate", { rate: 0n }],
    ["a zero minimum", { minSeconds: 0 }],
    ["a minimum above the maximum", { minSeconds: 10, maxSeconds: 9 }],
  ])("refuses %s with InvalidTerms", async (_, terms) => {
    const { sent } = await fixture.open({ authority: buyer, deposit: 30_000n, ...terms });
    expect(sent.errorCode).toBe(STINT_ERROR__INVALID_TERMS);
  });

  it("refuses a deposit below rate × minSeconds", async () => {
    const { sent } = await fixture.open({ authority: buyer, deposit: 4_999n });
    expect(sent.errorCode).toBe(STINT_ERROR__DEPOSIT_TOO_SMALL);
  });

  it("refuses a deposit above rate × maxSeconds", async () => {
    const { sent } = await fixture.open({ authority: buyer, deposit: 120_001n });
    expect(sent.errorCode).toBe(STINT_ERROR__DEPOSIT_TOO_LARGE);
  });

  it("refuses the session itself as receiver or refund owner", async () => {
    const [session] = await findSessionPda(buyer.signer.address, 11n);
    const asReceiver = await fixture.open({ authority: buyer, deposit: 30_000n, seed: 11n, receiver: session });
    expect(asReceiver.sent.errorCode).toBe(STINT_ERROR__INVALID_TERMS);
    const asRefundOwner = await fixture.open({ authority: buyer, deposit: 30_000n, seed: 11n, refundOwner: session });
    expect(asRefundOwner.sent.errorCode).toBe(STINT_ERROR__INVALID_TERMS);
  });

  it("refuses a vault that is a token account of the session but not its associated one (S6)", async () => {
    const [session] = await findSessionPda(buyer.signer.address, 12n);
    const impostor = (await generateKeyPairSigner()).address;
    fixture.writeTokenAccount(impostor, session, 0n);
    const { sent } = await fixture.open({ authority: buyer, deposit: 30_000n, seed: 12n, vault: impostor });
    expect(sent.errorCode).toBe(STINT_ERROR__ACCOUNT_MISMATCH);
  });

  it("refuses the session's associated token account for another mint (S7)", async () => {
    const [session] = await findSessionPda(buyer.signer.address, 14n);
    const otherMint = (await generateKeyPairSigner()).address;
    const [otherVault] = await findAssociatedTokenPda({ owner: session, mint: otherMint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    fixture.writeTokenAccount(otherVault, session, 30_000n, otherMint);
    const canonicalVault = await fixture.ata(session);
    const { sent } = await fixture.open({
      authority: buyer,
      deposit: 30_000n,
      seed: 14n,
      vault: otherVault,
      fundedAccount: canonicalVault,
    });
    expect(sent.errorCode).toBe(STINT_ERROR__ACCOUNT_MISMATCH);
  });

  it("never resets a live session: a second open at its address fails and changes nothing", async () => {
    const first = await fixture.open({ authority: buyer, deposit: 30_000n, seed: 13n });
    const second = await fixture.open({ authority: buyer, deposit: 10_000n, seed: 13n });
    expect(second.sent.ok).toBe(false);
    const account = fixture.svm.getAccount(first.session);
    if (!account.exists) throw new Error("no session");
    expect(getSessionDecoder().decode(account.data).deposited).toBe(30_000n);
  });
});
