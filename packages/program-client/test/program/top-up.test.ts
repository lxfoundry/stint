import { generateKeyPairSigner, isSignerRole, type Address } from "@solana/kit";
import { beforeEach, describe, expect, it } from "vitest";
import {
  CloseKind,
  STINT_ERROR__ACCOUNT_MISMATCH,
  STINT_ERROR__DEPOSIT_TOO_LARGE,
  STINT_ERROR__NOTHING_TO_TOP_UP,
  STINT_ERROR__NOT_EXPIRED,
  STINT_ERROR__SESSION_EXPIRED,
  STINT_ERROR__UNAUTHORIZED,
  eventAccounts,
  findClosedEvent,
  findToppedUpEvent,
  getSessionDecoder,
  getTopUpInstruction,
} from "../../src/index.js";
import { Fixture, type Wallet } from "./fixture.js";

describe("top_up", () => {
  let fixture: Fixture;
  let buyer: Wallet;
  let startedAt: bigint;

  beforeEach(async () => {
    fixture = await Fixture.create();
    buyer = await fixture.wallet(1_000_000n);
    startedAt = fixture.now();
  });

  /** Opens 30,000 at 1,000 per second (5 s to 120 s), then moves the clock `seconds` forward. */
  async function openAndWait(seconds: bigint) {
    const opened = await fixture.open({ authority: buyer, deposit: 30_000n });
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

  it("credits what the funding sent, and moves paid_until by the seconds it buys", async () => {
    const { session, vault } = await openAndWait(10n);
    const sent = await fixture.topUp({ session, authority: buyer, amount: 20_000n });

    expect(sent.ok, sent.logs.join("\n")).toBe(true);
    expect(fixture.tokenAmount(vault)).toBe(50_000n);
    expect(stored(session)).toMatchObject({ deposited: 50_000n, claimed: 0n, startedAt });
    expect(findToppedUpEvent(sent.inner)).toEqual({ session, added: 20_000n, deposited: 50_000n, paidUntil: startedAt + 50n });
  });

  it("declares the authority as its one signer", async () => {
    const { session, vault } = await openAndWait(10n);
    const instruction = getTopUpInstruction({ authority: buyer.signer, session, vault, ...(await eventAccounts()) });

    expect(instruction.accounts.filter((meta) => isSignerRole(meta.role)).map((meta) => meta.address)).toEqual([buyer.signer.address]);
  });

  it("credits a top-up after claims: the deposit grows by what arrived, not by what the vault holds", async () => {
    const { session, vault } = await openAndWait(8n);
    expect((await fixture.claim({ session })).ok).toBe(true); // pays 8,000
    const sent = await fixture.topUp({ session, authority: buyer, amount: 10_000n });

    expect(sent.ok, sent.logs.join("\n")).toBe(true);
    expect(fixture.tokenAmount(vault)).toBe(32_000n);
    expect(stored(session)).toMatchObject({ deposited: 40_000n, claimed: 8_000n });
    expect(findToppedUpEvent(sent.inner)).toMatchObject({ added: 10_000n, deposited: 40_000n, paidUntil: startedAt + 40n });
  });

  it("credits tokens that reached the vault uncredited before it", async () => {
    const { session, vault } = await openAndWait(5n);
    fixture.writeTokenAccount(vault, session, 30_500n); // 500 sent to the vault outside any top-up
    const sent = await fixture.topUp({ session, authority: buyer, amount: 10_000n });

    expect(sent.ok, sent.logs.join("\n")).toBe(true);
    expect(findToppedUpEvent(sent.inner)).toMatchObject({ added: 10_500n, deposited: 40_500n, paidUntil: startedAt + 40n });
  });

  it("is accepted one second before paid_until, and refused with SessionExpired at it and after it", async () => {
    const { session } = await openAndWait(29n);
    expect((await fixture.topUp({ session, authority: buyer, amount: 1_000n })).ok).toBe(true); // paid until +31

    fixture.setNow(startedAt + 31n);
    expect(await fixture.topUp({ session, authority: buyer, amount: 1_000n })).toMatchObject({ ok: false, errorCode: STINT_ERROR__SESSION_EXPIRED });
    fixture.setNow(startedAt + 90n);
    expect(await fixture.topUp({ session, authority: buyer, amount: 1_000n })).toMatchObject({ ok: false, errorCode: STINT_ERROR__SESSION_EXPIRED });

    // The refused transactions moved nothing: their funding failed with them (S13).
    expect(stored(session).deposited).toBe(31_000n);
    expect(fixture.tokenAmount(buyer.token)).toBe(969_000n);
  });

  it("is refused with NothingToTopUp when no tokens arrived", async () => {
    const { session } = await openAndWait(5n);

    expect(await fixture.topUp({ session, authority: buyer, amount: 0n })).toMatchObject({ ok: false, errorCode: STINT_ERROR__NOTHING_TO_TOP_UP });
  });

  it("is accepted up to max_seconds, and refused with DepositTooLarge past it", async () => {
    const { session } = await openAndWait(5n);

    expect(await fixture.topUp({ session, authority: buyer, amount: 90_001n })).toMatchObject({ ok: false, errorCode: STINT_ERROR__DEPOSIT_TOO_LARGE });
    const full = await fixture.topUp({ session, authority: buyer, amount: 90_000n });
    expect(full.ok, full.logs.join("\n")).toBe(true);
    expect(findToppedUpEvent(full.inner)).toMatchObject({ deposited: 120_000n, paidUntil: startedAt + 120n });
  });

  it.each(["receiver authorizer", "stranger"])("refuses a top-up signed by the %s with Unauthorized", async (who) => {
    const { session } = await openAndWait(5n);
    const signer = who === "stranger" ? await generateKeyPairSigner() : fixture.receiverAuthorizer;

    expect(await fixture.topUp({ session, authority: buyer, amount: 10_000n, signer })).toMatchObject({ ok: false, errorCode: STINT_ERROR__UNAUTHORIZED });
    expect(stored(session).deposited).toBe(30_000n);
  });

  it("refuses a vault that is not the session's canonical one with AccountMismatch", async () => {
    const { session } = await openAndWait(5n);
    const other = (await generateKeyPairSigner()).address;
    fixture.writeTokenAccount(other, session, 40_000n); // owned by the session, at another address

    expect(await fixture.topUp({ session, authority: buyer, amount: 10_000n, vault: other })).toMatchObject({ ok: false, errorCode: STINT_ERROR__ACCOUNT_MISMATCH });
  });

  it("extends what a close charges for: the close counts the top-up", async () => {
    const { session } = await openAndWait(5n);
    expect((await fixture.topUp({ session, authority: buyer, amount: 30_000n })).ok).toBe(true); // paid for 60 s
    fixture.setNow(startedAt + 40n);
    const closed = await fixture.close({ session, closer: buyer.signer });

    expect(closed.ok, closed.logs.join("\n")).toBe(true);
    expect(findClosedEvent(closed.inner)).toMatchObject({ owed: 40_000n, refunded: 20_000n, paidUntil: startedAt + 60n });
  });

  it("makes an AtExpiry close fail with NotExpired at the old paid_until, and succeed at the new one", async () => {
    const { session } = await openAndWait(20n);
    expect((await fixture.topUp({ session, authority: buyer, amount: 10_000n })).ok).toBe(true); // paid until +40

    fixture.setNow(startedAt + 30n);
    expect(await fixture.close({ session, closer: fixture.receiverAuthorizer, kind: CloseKind.AtExpiry })).toMatchObject({
      ok: false,
      errorCode: STINT_ERROR__NOT_EXPIRED,
    });
    fixture.setNow(startedAt + 40n);
    const closed = await fixture.close({ session, closer: fixture.receiverAuthorizer, kind: CloseKind.AtExpiry });
    expect(closed.ok, closed.logs.join("\n")).toBe(true);
    expect(findClosedEvent(closed.inner)).toMatchObject({ kind: CloseKind.AtExpiry, owed: 40_000n, refunded: 0n });
  });
});
