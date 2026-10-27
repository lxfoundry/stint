import { generateKeyPairSigner } from "@solana/kit";
import { getTransferCheckedInstruction } from "@solana-program/token";
import { beforeEach, describe, expect, it } from "vitest";
import {
  CloseKind,
  STINT_ERROR__ACCOUNT_MISMATCH,
  STINT_ERROR__INVALID_TERMS,
  STINT_ERROR__UNAUTHORIZED,
  findClosedEvent,
} from "../../src/index.js";
import { DECIMALS, Fixture, type Wallet } from "./fixture.js";

describe("close (Standard)", () => {
  let fixture: Fixture;
  let buyer: Wallet;
  let startedAt: bigint;

  beforeEach(async () => {
    fixture = await Fixture.create();
    buyer = await fixture.wallet(1_000_000n);
    startedAt = fixture.now();
  });

  /** Opens 30 s at 1,000 per second (minimum 5 s), then moves the clock `seconds` forward. */
  async function openAndWait(seconds: bigint) {
    const opened = await fixture.open({ authority: buyer, deposit: 30_000n });
    expect(opened.sent.ok, opened.sent.logs.join("\n")).toBe(true);
    fixture.setNow(startedAt + seconds);
    return opened;
  }

  it("by the authority before paid_until: pays the elapsed time and refunds the rest", async () => {
    const { session, vault } = await openAndWait(8n);
    const buyerBefore = fixture.tokenAmount(buyer.token)!;
    const rentBefore = fixture.lamportsOf(fixture.rentPayer.address);
    const deposits = fixture.lamportsOf(session) + fixture.lamportsOf(vault);

    const sent = await fixture.close({ session, closer: buyer.signer });
    expect(sent.ok, sent.logs.join("\n")).toBe(true);

    expect(fixture.tokenAmount(fixture.seller.token)).toBe(8_000n);
    expect(fixture.tokenAmount(buyer.token)! - buyerBefore).toBe(22_000n);
    expect(fixture.exists(session)).toBe(false);
    expect(fixture.exists(vault)).toBe(false);
    expect(fixture.lamportsOf(fixture.rentPayer.address) - rentBefore).toBe(deposits);
    expect(findClosedEvent(sent.inner)).toMatchObject({
      session,
      kind: CloseKind.Standard,
      claimed: 0n,
      owed: 8_000n,
      refunded: 22_000n,
      redirected: 0n,
      closedBy: buyer.signer.address,
      paidUntil: startedAt + 30n,
      at: startedAt + 8n,
    });
  });

  it("charges minSeconds when closed before it", async () => {
    const { session } = await openAndWait(2n);
    const sent = await fixture.close({ session, closer: buyer.signer });
    expect(findClosedEvent(sent.inner)?.owed).toBe(5_000n);
  });

  it("charges minSeconds when the clock is behind started_at", async () => {
    const { session } = await openAndWait(0n);
    fixture.setNow(startedAt - 100n);
    const sent = await fixture.close({ session, closer: buyer.signer });
    expect(findClosedEvent(sent.inner)?.owed).toBe(5_000n);
  });

  it("may be signed by the receiver authorizer before paid_until", async () => {
    const { session } = await openAndWait(8n);
    const sent = await fixture.close({ session, closer: fixture.receiverAuthorizer });
    expect(sent.ok).toBe(true);
    expect(findClosedEvent(sent.inner)?.closedBy).toBe(fixture.receiverAuthorizer.address);
  });

  it("refuses any other key before paid_until", async () => {
    const { session } = await openAndWait(8n);
    const stranger = await generateKeyPairSigner();
    const sent = await fixture.close({ session, closer: stranger });
    expect(sent.errorCode).toBe(STINT_ERROR__UNAUTHORIZED);
  });

  it("accepts any key from paid_until on, and charges the whole deposit", async () => {
    const { session } = await openAndWait(30n);
    const stranger = await generateKeyPairSigner();
    const sent = await fixture.close({ session, closer: stranger });
    expect(sent.ok, sent.logs.join("\n")).toBe(true);
    expect(findClosedEvent(sent.inner)).toMatchObject({ owed: 30_000n, refunded: 0n });
  });

  it("refunds tokens that reached the vault without being credited", async () => {
    const { session, vault } = await openAndWait(8n);
    await fixture.send([
      getTransferCheckedInstruction({
        source: buyer.token,
        mint: fixture.mint,
        destination: vault,
        authority: buyer.signer,
        amount: 500n,
        decimals: DECIMALS,
      }),
    ]);
    const sent = await fixture.close({ session, closer: buyer.signer });
    expect(findClosedEvent(sent.inner)).toMatchObject({ owed: 8_000n, refunded: 22_500n });
  });

  it("sends the remainder of a deposit that is not a multiple of the rate to the refund", async () => {
    const opened = await fixture.open({ authority: buyer, deposit: 30_500n });
    expect(opened.sent.ok, opened.sent.logs.join("\n")).toBe(true);
    fixture.setNow(startedAt + 60n);
    const sent = await fixture.close({ session: opened.session, closer: buyer.signer });
    expect(findClosedEvent(sent.inner)).toMatchObject({ owed: 30_000n, refunded: 500n, paidUntil: startedAt + 30n });
  });

  describe("payout accounts that are closed (S12)", () => {
    it("skips a transfer of zero: a closed refund account does not matter when nothing is refunded", async () => {
      const { session } = await openAndWait(30n);
      fixture.removeAccount(buyer.token);
      const sent = await fixture.close({ session, closer: buyer.signer });
      expect(sent.ok, sent.logs.join("\n")).toBe(true);
      expect(findClosedEvent(sent.inner)).toMatchObject({ owed: 30_000n, refunded: 0n });
      expect(fixture.tokenAmount(fixture.seller.token)).toBe(30_000n);
    });

    it("fails when a refund is due and the refund account is closed, and changes nothing", async () => {
      const { session, vault } = await openAndWait(8n);
      fixture.removeAccount(buyer.token);
      const sent = await fixture.close({ session, closer: buyer.signer });
      expect(sent.ok).toBe(false);
      expect(fixture.exists(session)).toBe(true);
      expect(fixture.tokenAmount(vault)).toBe(30_000n);
      expect(fixture.tokenAmount(fixture.seller.token)).toBe(0n);
    });

    it("fails when the receiver's account is closed and an amount is owed", async () => {
      const { session, vault } = await openAndWait(8n);
      fixture.removeAccount(fixture.seller.token);
      const sent = await fixture.close({ session, closer: buyer.signer });
      expect(sent.ok).toBe(false);
      expect(fixture.exists(session)).toBe(true);
      expect(fixture.tokenAmount(vault)).toBe(30_000n);
    });

    // A known limit, pinned so that it cannot change unnoticed: spec section 4.3 sends a residual owed
    // to a closed refund account to the receiver once the paid time has passed, and `close` does not do
    // that yet. Until it does, the owner of the refund account can leave a session unclosable after
    // expiry by closing that account and sending one base unit to the vault.
    it("cannot yet redirect a residual owed to a closed refund account, even after paid_until", async () => {
      const { session, vault } = await openAndWait(60n);
      await fixture.send([
        getTransferCheckedInstruction({
          source: buyer.token,
          mint: fixture.mint,
          destination: vault,
          authority: buyer.signer,
          amount: 1n,
          decimals: DECIMALS,
        }),
      ]);
      fixture.removeAccount(buyer.token);
      const sent = await fixture.close({ session, closer: await generateKeyPairSigner() });
      expect(sent.ok).toBe(false);
      expect(fixture.exists(session)).toBe(true);
      expect(fixture.tokenAmount(vault)).toBe(30_001n);
    });
  });

  it.each(["vault", "receiverToken", "refundTo", "rentPayer"] as const)(
    "refuses a substituted %s with AccountMismatch (S2)",
    async (field) => {
      const { session } = await openAndWait(8n);
      const other = await fixture.wallet(0n);
      const impostor = field === "rentPayer" ? other.signer.address : other.token;
      const sent = await fixture.close({ session, closer: buyer.signer, [field]: impostor });
      expect(sent.errorCode).toBe(STINT_ERROR__ACCOUNT_MISMATCH);
    },
  );

  it.each([CloseKind.AtExpiry, CloseKind.WaiveMinimum])("does not support kind %s yet", async (kind) => {
    const { session } = await openAndWait(30n);
    const sent = await fixture.close({ session, closer: fixture.receiverAuthorizer, kind });
    expect(sent.errorCode).toBe(STINT_ERROR__INVALID_TERMS);
  });
});
