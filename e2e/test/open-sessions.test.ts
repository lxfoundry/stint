import { getBase64Decoder } from "@solana/kit";
import type { Address } from "@solana/kit";
import { getSessionEncoder } from "@lxfoundry/stint-program-client";
import { describe, expect, it } from "vitest";
import { findOpenSessions } from "../src/devnet/funds.js";
import { USDC_DEVNET_MINT } from "../src/fixtures/usdc.js";

const key = (n: number) => `${"1".repeat(31)}${n}` as Address;
const HELD = key(2);
const OTHER_MINT = key(3);

function sessionAccount(pubkey: Address, mint: Address, rentPayer: Address) {
  const data = getSessionEncoder().encode({
    version: 1,
    bump: 255,
    authority: key(4),
    seed: 1n,
    mint,
    receiver: key(5),
    receiverAuthorizer: key(6),
    refundOwner: key(7),
    rentPayer,
    rate: 1n,
    minSeconds: 1,
    maxSeconds: 10,
    startedAt: 0n,
    deposited: 10n,
    claimed: 0n,
  });
  return { pubkey, account: { data: [getBase64Decoder().decode(data), "base64"] } };
}

const rpcWith = (accounts: unknown[]) => ({ getProgramAccounts: () => ({ send: async () => accounts }) }) as never;

describe("findOpenSessions", () => {
  it("returns the sessions of USDC that name a held key, and sets apart those of another mint", async () => {
    const usdc = key(8);
    const other = key(9);
    const unrelated = key(1);
    const rpc = rpcWith([
      sessionAccount(usdc, USDC_DEVNET_MINT, HELD),
      sessionAccount(other, OTHER_MINT, HELD),
      sessionAccount(unrelated, USDC_DEVNET_MINT, key(5)),
    ]);

    const found = await findOpenSessions(rpc, new Set([HELD]));

    expect(found.sessions).toEqual([usdc]);
    expect(found.otherMint).toEqual([other]);
  });
});
