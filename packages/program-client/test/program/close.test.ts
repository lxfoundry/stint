import { generateKeyPairSigner, lamports } from "@solana/kit";
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

    // From paid_until on, a residual owed to a refund account that no longer exists goes to the
    // receiver (spec section 4.3), so that account's owner cannot keep a session open by closing it
    // and sending the vault one base unit.
    describe("a residual owed to a refund account that no longer exists", () => {
      /** Opens 30 s at 1,000 per second for `deposit`, adds `stray` base units to the vault, then closes the refund account. */
      async function openWithClosedRefundAccount(deposit: bigint, stray: bigint) {
        const opened = await fixture.open({ authority: buyer, deposit });
        expect(opened.sent.ok, opened.sent.logs.join("\n")).toBe(true);
        if (stray > 0n) {
          await fixture.send([
            getTransferCheckedInstruction({
              source: buyer.token,
              mint: fixture.mint,
              destination: opened.vault,
              authority: buyer.signer,
              amount: stray,
              decimals: DECIMALS,
            }),
          ]);
        }
        fixture.removeAccount(buyer.token);
        return opened;
      }

      it("goes to the receiver once paid_until has passed, and the rent comes back", async () => {
        const { session, vault } = await openWithClosedRefundAccount(30_000n, 1n);
        fixture.setNow(startedAt + 60n);
        const rentBefore = fixture.lamportsOf(fixture.rentPayer.address);
        const deposits = fixture.lamportsOf(session) + fixture.lamportsOf(vault);

        const sent = await fixture.close({ session, closer: await generateKeyPairSigner() });

        expect(sent.ok, sent.logs.join("\n")).toBe(true);
        expect(findClosedEvent(sent.inner)).toMatchObject({ owed: 30_000n, refunded: 0n, redirected: 1n });
        expect(fixture.tokenAmount(fixture.seller.token)).toBe(30_001n);
        expect(fixture.exists(session)).toBe(false);
        expect(fixture.exists(vault)).toBe(false);
        expect(fixture.lamportsOf(fixture.rentPayer.address) - rentBefore).toBe(deposits);
      });

      it("includes the rounding remainder, from paid_until itself", async () => {
        const { session } = await openWithClosedRefundAccount(30_500n, 0n);
        fixture.setNow(startedAt + 30n);

        const sent = await fixture.close({ session, closer: await generateKeyPairSigner() });

        expect(sent.ok, sent.logs.join("\n")).toBe(true);
        expect(findClosedEvent(sent.inner)).toMatchObject({ owed: 30_000n, refunded: 0n, redirected: 500n });
        expect(fixture.tokenAmount(fixture.seller.token)).toBe(30_500n);
      });

      it("still goes to the receiver when lamports were sent to the closed address (S12)", async () => {
        const { session } = await openWithClosedRefundAccount(30_000n, 1n);
        fixture.svm.airdrop(buyer.token, lamports(1_000_000n));
        fixture.setNow(startedAt + 60n);

        const sent = await fixture.close({ session, closer: await generateKeyPairSigner() });

        expect(sent.ok, sent.logs.join("\n")).toBe(true);
        expect(findClosedEvent(sent.inner)).toMatchObject({ refunded: 0n, redirected: 1n });
      });

      it("is paid to the refund account instead when that account exists again", async () => {
        const { session } = await openWithClosedRefundAccount(30_000n, 1n);
        fixture.writeTokenAccount(buyer.token, buyer.signer.address, 0n);
        fixture.setNow(startedAt + 60n);

        const sent = await fixture.close({ session, closer: await generateKeyPairSigner() });

        expect(sent.ok, sent.logs.join("\n")).toBe(true);
        expect(findClosedEvent(sent.inner)).toMatchObject({ owed: 30_000n, refunded: 1n, redirected: 0n });
        expect(fixture.tokenAmount(buyer.token)).toBe(1n);
      });

      it("is not redirected before paid_until: the close fails and changes nothing", async () => {
        const { session, vault } = await openWithClosedRefundAccount(30_500n, 0n);
        fixture.setNow(startedAt + 29n);

        const sent = await fixture.close({ session, closer: buyer.signer });

        expect(sent.ok).toBe(false);
        expect(fixture.exists(session)).toBe(true);
        expect(fixture.tokenAmount(vault)).toBe(30_500n);
        expect(fixture.tokenAmount(fixture.seller.token)).toBe(0n);

        // The failure is the missing refund account and nothing else: with the account back, the same close goes through.
        fixture.writeTokenAccount(buyer.token, buyer.signer.address, 0n);
        const retried = await fixture.close({ session, closer: buyer.signer });
        expect(retried.ok, retried.logs.join("\n")).toBe(true);
        expect(fixture.exists(session)).toBe(false);
      });

      it("fails, and changes nothing, when the receiver's account is closed too", async () => {
        const { session, vault } = await openWithClosedRefundAccount(30_000n, 1n);
        fixture.removeAccount(fixture.seller.token);
        fixture.setNow(startedAt + 60n);

        const sent = await fixture.close({ session, closer: await generateKeyPairSigner() });

        expect(sent.ok).toBe(false);
        expect(fixture.exists(session)).toBe(true);
        expect(fixture.tokenAmount(vault)).toBe(30_001n);
      });
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
