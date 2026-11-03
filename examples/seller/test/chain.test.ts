import type { Address, Rpc, SolanaRpcApi } from "@solana/kit";
import type { Session } from "@lxfoundry/stint-program-client";
import { describe, expect, it } from "vitest";
import { DEVNET_GENESIS_HASH, FUNDING_MARGIN_LAMPORTS, assertDevnet, closableAtStart, fundingNeeded, lamportsToSend, type ListedSession } from "../src/chain.js";

const RENT_PAYER = "SysvarRent111111111111111111111111111111111" as Address;
const AUTHORIZER = "SysvarC1ock11111111111111111111111111111111" as Address;
const OTHER = "Stake11111111111111111111111111111111111111" as Address;
const [A, B, C, D] = [
  "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDyLb",
  "So11111111111111111111111111111111111111112",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
] as [Address, Address, Address, Address];

/** A session of 100 s from 1,000 at 1000 base units a second, the deployment's own unless `fields` say otherwise. */
const listed = (address: Address, fields: Partial<Session> = {}): ListedSession => ({
  address,
  stored: { rentPayer: RENT_PAYER, receiverAuthorizer: AUTHORIZER, startedAt: 1_000n, deposited: 100_000n, rate: 1_000n, ...fields } as unknown as Session,
});

/** An RPC that reports `genesis` as its genesis hash and answers nothing else. */
const rpcWithGenesis = (genesis: string) => ({ getGenesisHash: () => ({ send: async () => genesis }) }) as unknown as Rpc<SolanaRpcApi>;

describe("the network the seller runs on", () => {
  it("goes on with an RPC that reports devnet's genesis hash", async () => {
    expect(DEVNET_GENESIS_HASH).toBe("EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG");
    await expect(assertDevnet(rpcWithGenesis(DEVNET_GENESIS_HASH))).resolves.toBeUndefined();
  });

  it("refuses an RPC that reports any other genesis hash", async () => {
    const mainnet = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
    await expect(assertDevnet(rpcWithGenesis(mainnet))).rejects.toThrow(`The RPC reports genesis hash ${mainnet}, which is not devnet's: refusing to start`);
  });
});

describe("the SOL the stack's keys are given", () => {
  it("tops a key up to its target, and sends nothing to one that holds as much or more", () => {
    expect(lamportsToSend(0n, 50_000_000n)).toBe(50_000_000n);
    expect(lamportsToSend(49_000_000n, 50_000_000n)).toBe(1_000_000n);
    expect(lamportsToSend(50_000_000n, 50_000_000n)).toBe(0n);
    expect(lamportsToSend(70_000_000n, 50_000_000n)).toBe(0n);
  });

  it("asks the funding key for a margin whenever it has to pay, the seller's missing token account included", () => {
    expect(fundingNeeded(0n, false)).toBe(0n);
    expect(fundingNeeded(0n, true)).toBe(FUNDING_MARGIN_LAMPORTS);
    expect(fundingNeeded(5_000_000n, false)).toBe(5_000_000n + FUNDING_MARGIN_LAMPORTS);
    expect(fundingNeeded(5_000_000n, true)).toBe(5_000_000n + FUNDING_MARGIN_LAMPORTS);
  });
});

describe("the sessions the start-up closes", () => {
  it("closes the deployment's own sessions that are still paid for, and leaves the rest to the sweeper or their owner", () => {
    const sessions = [listed(A), listed(B, { startedAt: 900n }), listed(C, { rentPayer: OTHER }), listed(D, { receiverAuthorizer: OTHER })];
    expect(closableAtStart(sessions, { rentPayer: RENT_PAYER, receiverAuthorizer: AUTHORIZER }, 1_050n)).toEqual([A]);
  });

  it("leaves a session alone from its paid_until on", () => {
    expect(closableAtStart([listed(A)], { rentPayer: RENT_PAYER, receiverAuthorizer: AUTHORIZER }, 1_100n)).toEqual([]);
  });
});
