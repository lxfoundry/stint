import { generateKeyPairSigner } from "@solana/kit";
import type { Session } from "@lxfoundry/stint-program-client";
import { associatedTokenAddress } from "@lxfoundry/stint-x402";
import { describe, expect, it } from "vitest";
import { directSessionOf } from "../src/sessions.js";

describe("directSessionOf", () => {
  it("derives every account a close names from a session's stored fields (spec §4.1, §4.3)", async () => {
    const [session, authority, mint, receiver, refundOwner, rentPayer] = await Promise.all(
      Array.from({ length: 6 }, async () => (await generateKeyPairSigner()).address),
    );
    const stored = {
      authority: authority!,
      mint: mint!,
      receiver: receiver!,
      refundOwner: refundOwner!,
      rentPayer: rentPayer!,
      rate: 1_000n,
      minSeconds: 5,
      maxSeconds: 120,
      startedAt: 1_800_000_000n,
      deposited: 30_000n,
      claimed: 0n,
    } as Session;

    expect(await directSessionOf(session!, stored)).toEqual({
      session,
      vault: await associatedTokenAddress(session!, mint!),
      mint: mint!,
      rentPayer,
      receiverToken: await associatedTokenAddress(receiver!, mint!),
      refundTo: await associatedTokenAddress(refundOwner!, mint!),
      deposit: 30_000n,
      startedAt: 1_800_000_000n,
      paidUntil: 1_800_000_030n,
    });
  });
});
