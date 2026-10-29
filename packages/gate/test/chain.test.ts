import { generateKeyPairSigner, getBase64Decoder, type Address, type Rpc, type SolanaRpcApi } from "@solana/kit";
import { STINT_PROGRAM_ADDRESS, getSessionEncoder, type SessionArgs } from "@lxfoundry/stint-program-client";
import { describe, expect, it } from "vitest";
import { createRpcChain } from "../src/chain.js";

const SYSTEM_PROGRAM = "11111111111111111111111111111111" as Address;
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as Address;

/** An RPC whose `getAccountInfo` answers with one account (or none), as the node would. */
function rpcHolding(account: { owner: Address; data: Uint8Array } | null): Rpc<SolanaRpcApi> {
  return {
    getAccountInfo: () => ({
      send: async () => ({
        context: { slot: 1n },
        value: account && {
          data: [getBase64Decoder().decode(account.data), "base64"],
          executable: false,
          lamports: 1_000_000n,
          owner: account.owner,
          space: BigInt(account.data.length),
        },
      }),
    }),
  } as unknown as Rpc<SolanaRpcApi>;
}

async function sessionArgs(): Promise<SessionArgs> {
  const [authority, mint, receiver, receiverAuthorizer, refundOwner, rentPayer] = await Promise.all(
    Array.from({ length: 6 }, async () => (await generateKeyPairSigner()).address),
  );
  return {
    version: 1,
    bump: 255,
    authority: authority!,
    seed: 7n,
    mint: mint!,
    receiver: receiver!,
    receiverAuthorizer: receiverAuthorizer!,
    refundOwner: refundOwner!,
    rentPayer: rentPayer!,
    rate: 1_000n,
    minSeconds: 5,
    maxSeconds: 120,
    startedAt: 1_800_000_000n,
    deposited: 30_000n,
    claimed: 0n,
  };
}

describe("the RPC chain's session read", () => {
  const where = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDyLb" as Address;

  it("returns the session an account of the program holds", async () => {
    const args = await sessionArgs();
    const data = new Uint8Array(getSessionEncoder().encode(args));

    const read = await createRpcChain(rpcHolding({ owner: STINT_PROGRAM_ADDRESS, data })).readSession(where);

    expect(read).toMatchObject({ authority: args.authority, rate: 1_000n, deposited: 30_000n });
  });

  it("returns undefined where no account exists", async () => {
    expect(await createRpcChain(rpcHolding(null)).readSession(where)).toBeUndefined();
  });

  it("returns undefined for a wallet, which holds no data", async () => {
    const wallet = rpcHolding({ owner: SYSTEM_PROGRAM, data: new Uint8Array(0) });
    expect(await createRpcChain(wallet).readSession(where)).toBeUndefined();
  });

  it("returns undefined for an account of the program too short to be a session", async () => {
    const short = rpcHolding({ owner: STINT_PROGRAM_ADDRESS, data: new Uint8Array(40) });
    expect(await createRpcChain(short).readSession(where)).toBeUndefined();
  });

  it("returns undefined for an account of another program, even one that is long enough", async () => {
    const args = await sessionArgs();
    const data = new Uint8Array(getSessionEncoder().encode(args));
    expect(await createRpcChain(rpcHolding({ owner: TOKEN_PROGRAM, data })).readSession(where)).toBeUndefined();
  });

  it("returns undefined for an account of the program that is not a session", async () => {
    const args = await sessionArgs();
    const data = new Uint8Array(getSessionEncoder().encode(args));
    data.fill(0, 0, 8);
    expect(await createRpcChain(rpcHolding({ owner: STINT_PROGRAM_ADDRESS, data })).readSession(where)).toBeUndefined();
  });

  it("still rejects when the node cannot be reached", async () => {
    const down = {
      getAccountInfo: () => ({
        send: async () => {
          throw new Error("fetch failed");
        },
      }),
    } as unknown as Rpc<SolanaRpcApi>;
    await expect(createRpcChain(down).readSession(where)).rejects.toThrow(/fetch failed/);
  });
});
