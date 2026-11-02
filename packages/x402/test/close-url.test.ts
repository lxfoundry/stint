import { generateKeyPairSigner, type Address, type KeyPairSigner } from "@solana/kit";
import { CloseKind, STINT_PROGRAM_ADDRESS, type Session } from "@lxfoundry/stint-program-client";
import { beforeAll, describe, expect, it } from "vitest";
import {
  buildSponsoredClose,
  checkCloseTransaction,
  inspectTransaction,
  readCloseInfo,
  storedSessionFields,
  type CloseInfo,
} from "../src/index.js";

const BLOCKHASH = "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N";
const MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU" as Address;

describe("the closeUrl wire (spec §6.1)", () => {
  let authority: KeyPairSigner;
  let session: Address;
  let feePayer: Address;
  let stored: Omit<Session, "discriminator" | "version" | "bump">;
  let info: CloseInfo;

  beforeAll(async () => {
    authority = await generateKeyPairSigner();
    session = (await generateKeyPairSigner()).address;
    feePayer = (await generateKeyPairSigner()).address;
    stored = {
      authority: authority.address,
      seed: 7n,
      mint: MINT,
      receiver: (await generateKeyPairSigner()).address,
      receiverAuthorizer: (await generateKeyPairSigner()).address,
      refundOwner: authority.address,
      rentPayer: (await generateKeyPairSigner()).address,
      rate: 1_000n,
      minSeconds: 5,
      maxSeconds: 120,
      startedAt: 1_800_000_000n,
      deposited: 30_000n,
      claimed: 2_000n,
    };
    info = {
      feePayer,
      recentBlockhash: BLOCKHASH,
      lastValidBlockHeight: "1234",
      blockHeight: "1000",
      programId: STINT_PROGRAM_ADDRESS,
      session: storedSessionFields(session, stored),
    };
  });

  it("encodes a session's stored fields: u64 values as decimal strings, u32 values as numbers, startedAt in Unix seconds", () => {
    expect(storedSessionFields(session, stored)).toEqual({
      address: session,
      authority: authority.address,
      seed: "7",
      mint: MINT,
      receiver: stored.receiver,
      receiverAuthorizer: stored.receiverAuthorizer,
      refundOwner: authority.address,
      rentPayer: stored.rentPayer,
      rate: "1000",
      minSeconds: 5,
      maxSeconds: 120,
      startedAt: 1_800_000_000,
      deposited: "30000",
      claimed: "2000",
    });
  });

  it("reads a body with and without a session, as JSON delivers it", () => {
    expect(readCloseInfo(JSON.parse(JSON.stringify(info)))).toEqual(info);
    const { session: _, ...withoutSession } = info;
    expect(readCloseInfo(withoutSession)).toEqual(withoutSession);
  });

  it("refuses a body with a field that lacks its encoding", () => {
    expect(readCloseInfo("nope")).toBeUndefined();
    expect(readCloseInfo({ ...info, feePayer: "not-an-address" })).toBeUndefined();
    expect(readCloseInfo({ ...info, recentBlockhash: "" })).toBeUndefined();
    expect(readCloseInfo({ ...info, lastValidBlockHeight: 1234 })).toBeUndefined();
    expect(readCloseInfo({ ...info, blockHeight: "18446744073709551616" })).toBeUndefined();
    expect(readCloseInfo({ ...info, session: { ...info.session, rate: 1000 } })).toBeUndefined();
    expect(readCloseInfo({ ...info, session: { ...info.session, minSeconds: -1 } })).toBeUndefined();
    const { rentPayer: _, ...sessionWithoutRentPayer } = info.session!;
    expect(readCloseInfo({ ...info, session: sessionWithoutRentPayer })).toBeUndefined();
  });

  it("builds a close of the session, signed by the closer, paid for by the facilitator's fee payer", async () => {
    const tx = inspectTransaction(await buildSponsoredClose(info, { session, closer: authority }));
    expect(tx).toBeDefined();
    expect(tx!.feePayer).toBe(feePayer);
    expect(tx!.blockhash).toBe(BLOCKHASH);
    expect(tx!.signed.has(authority.address)).toBe(true);
    expect(tx!.signed.has(feePayer)).toBe(false);
    const checked = await checkCloseTransaction(tx!, { session, closer: authority.address }, { feePayer, rentPayer: stored.rentPayer });
    expect(checked).toEqual({ ok: true, value: { kind: CloseKind.Standard } });
  });

  it("builds an AtExpiry close when asked", async () => {
    const tx = inspectTransaction(await buildSponsoredClose(info, { session, closer: authority, kind: CloseKind.AtExpiry }));
    const checked = await checkCloseTransaction(tx!, { session, closer: authority.address }, { feePayer, rentPayer: stored.rentPayer });
    expect(checked).toEqual({ ok: true, value: { kind: CloseKind.AtExpiry } });
  });

  it("refuses to build for another program, with the closer as fee payer, without a session, for another session, or for another authority", async () => {
    await expect(buildSponsoredClose({ ...info, programId: feePayer }, { session, closer: authority })).rejects.toThrow("another program");
    // A fee payer equal to the closer would have the buyer sign as fee payer, and pay the fee itself.
    await expect(buildSponsoredClose({ ...info, feePayer: authority.address }, { session, closer: authority })).rejects.toThrow("fee payer");
    const { session: _, ...withoutSession } = info;
    await expect(buildSponsoredClose(withoutSession, { session, closer: authority })).rejects.toThrow("?session=");
    // A body for one of the buyer's other sessions, which would have the buyer sign a close of that one.
    await expect(buildSponsoredClose(info, { session: feePayer, closer: authority })).rejects.toThrow("another session");
    await expect(buildSponsoredClose(info, { session, closer: await generateKeyPairSigner() })).rejects.toThrow("not the closer");
  });
});
