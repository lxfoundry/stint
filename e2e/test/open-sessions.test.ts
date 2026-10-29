import { containsBytes, getBase58Encoder, getBase64Decoder, getBase64Encoder } from "@solana/kit";
import type { Address } from "@solana/kit";
import { getSessionEncoder } from "@lxfoundry/stint-program-client";
import { describe, expect, it } from "vitest";
import { findOpenSessions } from "../src/devnet/funds.js";
import { USDC_DEVNET_MINT } from "../src/fixtures/usdc.js";

const key = (n: number) => `${"1".repeat(31)}${n}` as Address;
const HELD = key(2);
const OTHER_MINT = key(3);

function sessionAccount(pubkey: Address, mint: Address, rentPayer: Address, discriminator?: Uint8Array) {
  const data = new Uint8Array(getSessionEncoder().encode({
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
  }));
  if (discriminator) data.set(discriminator, 0);
  return { pubkey, account: { data: [getBase64Decoder().decode(data), "base64"] as const } };
}

type Filter = { dataSize: bigint } | { memcmp: { offset: bigint; bytes: string; encoding: "base58" | "base64" } };

/** A node's `getProgramAccounts`, which applies the filters it is given. */
const rpcWith = (accounts: ReturnType<typeof sessionAccount>[]) =>
  ({
    getProgramAccounts: (_program: Address, config: { filters?: Filter[] }) => ({
      send: async () =>
        accounts.filter(({ account }) => {
          const data = getBase64Encoder().encode(account.data[0]);
          return (config.filters ?? []).every((filter) => {
            if ("dataSize" in filter) return BigInt(data.length) === filter.dataSize;
            const { offset, bytes, encoding } = filter.memcmp;
            const expected = encoding === "base58" ? getBase58Encoder().encode(bytes) : getBase64Encoder().encode(bytes);
            return containsBytes(data, expected, Number(offset));
          });
        }),
    }),
  }) as never;

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

  it("leaves out an account of a session's size that is not a session", async () => {
    // Every field names the held key's session, but the first eight bytes are not the session discriminator.
    const rpc = rpcWith([sessionAccount(key(8), USDC_DEVNET_MINT, HELD, new Uint8Array(8))]);

    const found = await findOpenSessions(rpc, new Set([HELD]));

    expect(found.sessions).toEqual([]);
  });
});
