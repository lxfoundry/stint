import { generateKeyPairSigner, isSignerRole, type Address } from "@solana/kit";
import { beforeEach, describe, expect, it } from "vitest";
import {
  CloseKind,
  STINT_ERROR__ACCOUNT_MISMATCH,
  eventAccounts,
  findClaimedEvent,
  findClosedEvent,
  getClaimInstruction,
  getSessionDecoder,
} from "../../src/index.js";
import { Fixture, type Wallet } from "./fixture.js";

describe("claim", () => {
  let fixture: Fixture;
  let buyer: Wallet;
  let startedAt: bigint;

  beforeEach(async () => {
    fixture = await Fixture.create();
    buyer = await fixture.wallet(1_000_000n);
    startedAt = fixture.now();
  });

  /** Opens `deposit` at 1,000 per second (minimum 5 s), then moves the clock `seconds` forward. */
  async function openAndWait(seconds: bigint, deposit = 30_000n) {
    const opened = await fixture.open({ authority: buyer, deposit });
    expect(opened.sent.ok, opened.sent.logs.join("\n")).toBe(true);
    fixture.setNow(startedAt + seconds);
    return opened;
  }

  /** The session as the account stores it. */
  function stored(session: Address) {
    const account = fixture.svm.getAccount(session);
    if (!account.exists) throw new Error(`no session at ${session}`);
    return getSessionDecoder().decode(account.data);
  }

  it("pays what has been earned to the receiver, and records it", async () => {
    const { session, vault } = await openAndWait(8n);
    const sent = await fixture.claim({ session });

    expect(sent.ok, sent.logs.join("\n")).toBe(true);
    expect(fixture.tokenAmount(fixture.seller.token)).toBe(8_000n);
    expect(fixture.tokenAmount(vault)).toBe(22_000n);
    expect(stored(session).claimed).toBe(8_000n);
    expect(findClaimedEvent(sent.inner)).toMatchObject({ session, amount: 8_000n, claimed: 8_000n });
  });

  it("declares no signer, so anyone may call it: the fee payer is the only key that signs", async () => {
    const { session, vault } = await openAndWait(8n);
    const accounts = { session, vault, receiverToken: fixture.seller.token, ...(await eventAccounts()) };
    const instruction = getClaimInstruction(accounts);

    expect(instruction.accounts.some((meta) => isSignerRole(meta.role))).toBe(false);
    const sent = await fixture.send([instruction]);
    expect(sent.ok, sent.logs.join("\n")).toBe(true);
    expect(fixture.tokenAmount(fixture.seller.token)).toBe(8_000n);
  });

  it("pays nothing, and emits nothing, when claimed again in the same second", async () => {
    const { session, vault } = await openAndWait(8n);
    expect((await fixture.claim({ session })).ok).toBe(true);

    const again = await fixture.claim({ session });

    expect(again.ok, again.logs.join("\n")).toBe(true);
    expect(findClaimedEvent(again.inner)).toBeUndefined();
    expect(again.inner).toEqual([]);
    expect(fixture.tokenAmount(fixture.seller.token)).toBe(8_000n);
    expect(fixture.tokenAmount(vault)).toBe(22_000n);
    expect(stored(session).claimed).toBe(8_000n);
  });

  it.each([0n, -100n])("pays nothing when nothing is earned yet: the clock is %s s from the start", async (seconds) => {
    const { session, vault } = await openAndWait(seconds);
    const sent = await fixture.claim({ session });

    expect(sent.ok, sent.logs.join("\n")).toBe(true);
    expect(findClaimedEvent(sent.inner)).toBeUndefined();
    expect(fixture.tokenAmount(vault)).toBe(30_000n);
    expect(stored(session).claimed).toBe(0n);
  });

  it("adds up, over time, to what has been earned", async () => {
    const { session } = await openAndWait(0n);
    const steps = [
      { seconds: 3n, amount: 3_000n, claimed: 3_000n },
      { seconds: 10n, amount: 7_000n, claimed: 10_000n },
      { seconds: 29n, amount: 19_000n, claimed: 29_000n },
    ];

    for (const step of steps) {
      fixture.setNow(startedAt + step.seconds);
      const sent = await fixture.claim({ session });
      expect(sent.ok, sent.logs.join("\n")).toBe(true);
      expect(findClaimedEvent(sent.inner)).toMatchObject({ session, amount: step.amount, claimed: step.claimed });
      expect(fixture.tokenAmount(fixture.seller.token)).toBe(step.claimed);
      expect(stored(session).claimed).toBe(step.claimed);
    }
  });

  it.each([30n, 60n])("pays the covered time and no more, %s s after the start", async (seconds) => {
    // 30,500 buys 30 s: the 500 left over is never earned.
    const { session, vault } = await openAndWait(seconds, 30_500n);
    const first = await fixture.claim({ session });

    expect(first.ok, first.logs.join("\n")).toBe(true);
    expect(findClaimedEvent(first.inner)).toMatchObject({ amount: 30_000n, claimed: 30_000n });
    expect(fixture.tokenAmount(fixture.seller.token)).toBe(30_000n);
    expect(fixture.tokenAmount(vault)).toBe(500n);

    fixture.setNow(startedAt + 90n);
    const later = await fixture.claim({ session });
    expect(later.ok, later.logs.join("\n")).toBe(true);
    expect(findClaimedEvent(later.inner)).toBeUndefined();
    expect(fixture.tokenAmount(fixture.seller.token)).toBe(30_000n);
  });

  it("pays nothing, and keeps what was claimed, when the clock has stepped back", async () => {
    const { session } = await openAndWait(20n);
    expect((await fixture.claim({ session })).ok).toBe(true);
    fixture.setNow(startedAt + 10n);

    const sent = await fixture.claim({ session });

    expect(sent.ok, sent.logs.join("\n")).toBe(true);
    expect(findClaimedEvent(sent.inner)).toBeUndefined();
    expect(fixture.tokenAmount(fixture.seller.token)).toBe(20_000n);
    expect(stored(session).claimed).toBe(20_000n);

    // The running total carries on from where it was, not from the earlier clock.
    fixture.setNow(startedAt + 25n);
    const resumed = await fixture.claim({ session });
    expect(findClaimedEvent(resumed.inner)).toMatchObject({ amount: 5_000n, claimed: 25_000n });
  });

  it("leaves the session open and the vault funded for the rest", async () => {
    const { session, vault } = await openAndWait(8n);
    await fixture.claim({ session });

    expect(fixture.exists(session)).toBe(true);
    expect(fixture.exists(vault)).toBe(true);
    expect(fixture.tokenAmount(vault)).toBe(22_000n);
    expect(stored(session)).toMatchObject({ deposited: 30_000n, claimed: 8_000n });
  });

  it("skips a transfer of zero: a closed receiver account does not matter when nothing is earned", async () => {
    const { session } = await openAndWait(0n);
    fixture.removeAccount(fixture.seller.token);
    const sent = await fixture.claim({ session });

    expect(sent.ok, sent.logs.join("\n")).toBe(true);
    expect(stored(session).claimed).toBe(0n);
  });

  it("fails, and changes nothing, when something is earned and the receiver's account is closed", async () => {
    const { session, vault } = await openAndWait(8n);
    fixture.removeAccount(fixture.seller.token);
    const sent = await fixture.claim({ session });

    expect(sent.ok).toBe(false);
    expect(fixture.tokenAmount(vault)).toBe(30_000n);
    expect(stored(session).claimed).toBe(0n);
  });

  it.each(["vault", "receiverToken"] as const)("refuses a substituted %s with AccountMismatch (S2)", async (field) => {
    const { session } = await openAndWait(8n);
    const other = await fixture.wallet(0n);
    const sent = await fixture.claim({ session, [field]: other.token });

    expect(sent.errorCode).toBe(STINT_ERROR__ACCOUNT_MISMATCH);
    expect(fixture.tokenAmount(fixture.seller.token)).toBe(0n);
  });

  it("refuses a vault that the session owns but that is not its associated token account (S6)", async () => {
    const { session } = await openAndWait(8n);
    const decoy = (await generateKeyPairSigner()).address;
    fixture.writeTokenAccount(decoy, session, 30_000n);
    const sent = await fixture.claim({ session, vault: decoy });

    expect(sent.errorCode).toBe(STINT_ERROR__ACCOUNT_MISMATCH);
    expect(fixture.tokenAmount(decoy)).toBe(30_000n);
    expect(fixture.tokenAmount(fixture.seller.token)).toBe(0n);
  });

  describe("a close after a claim", () => {
    it("Standard pays only what is still owed: claimed + owed + refunded is the deposit", async () => {
      const { session, vault } = await openAndWait(8n);
      await fixture.claim({ session });
      fixture.setNow(startedAt + 12n);
      const buyerBefore = fixture.tokenAmount(buyer.token)!;

      const sent = await fixture.close({ session, closer: buyer.signer });

      expect(sent.ok, sent.logs.join("\n")).toBe(true);
      const closed = findClosedEvent(sent.inner)!;
      expect(closed).toMatchObject({ kind: CloseKind.Standard, claimed: 8_000n, owed: 4_000n, refunded: 18_000n });
      expect(closed.claimed + closed.owed + closed.refunded + closed.redirected).toBe(30_000n);
      expect(fixture.tokenAmount(fixture.seller.token)).toBe(12_000n);
      expect(fixture.tokenAmount(buyer.token)! - buyerBefore).toBe(18_000n);
      expect(fixture.exists(session)).toBe(false);
      expect(fixture.exists(vault)).toBe(false);
    });

    it("Standard still charges the minimum: the close adds what the claims did not reach", async () => {
      const { session } = await openAndWait(2n);
      await fixture.claim({ session });

      const sent = await fixture.close({ session, closer: buyer.signer });

      const closed = findClosedEvent(sent.inner)!;
      expect(closed).toMatchObject({ claimed: 2_000n, owed: 3_000n, refunded: 25_000n });
      expect(closed.claimed + closed.owed + closed.refunded + closed.redirected).toBe(30_000n);
      expect(fixture.tokenAmount(fixture.seller.token)).toBe(5_000n);
    });
  });
});
