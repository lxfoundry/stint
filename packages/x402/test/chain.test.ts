import {
  TOKEN_PROGRAM_ADDRESS,
  getCloseAccountInstruction,
  getMintToInstruction,
  getTransferCheckedInstruction,
  getTransferInstruction,
} from "@solana-program/token";
import { STINT_PROGRAM_ADDRESS } from "@lxfoundry/stint-program-client";
import { generateKeyPairSigner, getBase58Decoder, type Address, type Instruction, type TransactionSigner } from "@solana/kit";
import { beforeAll, describe, expect, it } from "vitest";
import { fetchClosedEvent, lamportBalances, tokenBalanceChanges, tokenTransferChanges, type RecordedTransaction } from "../src/index.js";

const SYSTEM_PROGRAM = "11111111111111111111111111111111" as Address;

/** Compiles instructions against one list of account keys, as a fetched transaction records them. */
function compiler() {
  const accountKeys: Address[] = [];
  const indexOf = (key: Address) => {
    const found = accountKeys.indexOf(key);
    if (found >= 0) return found;
    accountKeys.push(key);
    return accountKeys.length - 1;
  };
  const compile = (instruction: Instruction) => ({
    programIdIndex: indexOf(instruction.programAddress),
    accounts: (instruction.accounts ?? []).map((meta) => indexOf(meta.address)),
    data: getBase58Decoder().decode(instruction.data ?? new Uint8Array()),
  });
  return { accountKeys, compile };
}

describe("tokenTransferChanges (spec §12.2, T9)", () => {
  let owner: TransactionSigner;
  let vault: Address;
  let receiver: Address;
  let buyer: Address;
  let mint: Address;
  let other: Address;
  let another: Address;

  beforeAll(async () => {
    owner = await generateKeyPairSigner();
    [vault, receiver, buyer, mint, other, another] = await Promise.all(
      Array.from({ length: 6 }, async () => (await generateKeyPairSigner()).address),
    ) as [Address, Address, Address, Address, Address, Address];
  });

  const transfer = (source: Address, destination: Address, amount: bigint) =>
    getTransferInstruction({ source, destination, authority: owner, amount });

  it("sums a close's inner transfers from the vault and ignores closeAccount", () => {
    const { accountKeys, compile } = compiler();
    const close = compile({ programAddress: STINT_PROGRAM_ADDRESS });
    const transaction: RecordedTransaction = {
      accountKeys,
      instructions: [close],
      innerInstructions: [
        {
          instructions: [
            compile(transfer(vault, receiver, 5_000n)),
            compile(transfer(vault, buyer, 25_000n)),
            compile(getCloseAccountInstruction({ account: vault, destination: other, owner })),
          ],
        },
      ],
    };
    expect(tokenTransferChanges(transaction)).toEqual(
      new Map([
        [vault, -30_000n],
        [receiver, 5_000n],
        [buyer, 25_000n],
      ]),
    );
  });

  it("sums an open's TransferChecked from the buyer to the vault, ignoring other programs", () => {
    const { accountKeys, compile } = compiler();
    const transaction: RecordedTransaction = {
      accountKeys,
      instructions: [
        compile({ programAddress: SYSTEM_PROGRAM }),
        compile(getTransferCheckedInstruction({ source: buyer, mint, destination: vault, authority: owner, amount: 30_000n, decimals: 6 })),
      ],
    };
    expect(tokenTransferChanges(transaction)).toEqual(
      new Map([
        [buyer, -30_000n],
        [vault, 30_000n],
      ]),
    );
  });

  it("keeps an unrelated transfer to its own two accounts", () => {
    const { accountKeys, compile } = compiler();
    const transaction: RecordedTransaction = {
      accountKeys,
      instructions: [compile(transfer(buyer, vault, 30_000n)), compile(transfer(other, another, 7n))],
    };
    const changes = tokenTransferChanges(transaction);
    expect(changes.get(buyer)).toBe(-30_000n);
    expect(changes.get(vault)).toBe(30_000n);
    expect(changes.get(other)).toBe(-7n);
    expect(changes.get(another)).toBe(7n);
  });

  it("sums top-level and inner transfers to the same account together", () => {
    const { accountKeys, compile } = compiler();
    const transaction: RecordedTransaction = {
      accountKeys,
      instructions: [compile(transfer(buyer, vault, 10_000n)), compile({ programAddress: SYSTEM_PROGRAM })],
      innerInstructions: [{ instructions: [compile(transfer(buyer, vault, 20_000n)), compile(transfer(vault, receiver, 1_000n))] }],
    };
    expect(tokenTransferChanges(transaction)).toEqual(
      new Map([
        [buyer, -30_000n],
        [vault, 29_000n],
        [receiver, 1_000n],
      ]),
    );
  });

  it("throws on a failed transaction, whose recorded transfers never took effect", () => {
    const { accountKeys, compile } = compiler();
    const transaction: RecordedTransaction = {
      accountKeys,
      err: { InstructionError: [0, { Custom: 6004 }] },
      instructions: [compile({ programAddress: STINT_PROGRAM_ADDRESS })],
      innerInstructions: [{ instructions: [compile(transfer(vault, receiver, 5_000n))] }],
    };
    expect(() => tokenTransferChanges(transaction)).toThrow(/failed.*InstructionError/);
  });

  it("accepts a transaction whose error is null", () => {
    const { accountKeys, compile } = compiler();
    const changes = tokenTransferChanges({ accountKeys, err: null, instructions: [compile(transfer(buyer, vault, 1n))] });
    expect(changes.get(vault)).toBe(1n);
  });

  it("names no account that no transfer moved, closeAccount's included", () => {
    const { accountKeys, compile } = compiler();
    const changes = tokenTransferChanges({
      accountKeys,
      instructions: [compile(getCloseAccountInstruction({ account: vault, destination: other, owner }))],
    });
    expect(changes.size).toBe(0);
  });

  it("throws on a token instruction it cannot decode", () => {
    const { accountKeys, compile } = compiler();
    const garbage = compile({ programAddress: TOKEN_PROGRAM_ADDRESS, data: new Uint8Array([250, 1, 2]) });
    expect(() => tokenTransferChanges({ accountKeys, instructions: [garbage] })).toThrow();
  });

  it("throws on a token instruction that changes a balance without a transfer", () => {
    const { accountKeys, compile } = compiler();
    const mintTo = compile(getMintToInstruction({ mint, token: buyer, mintAuthority: owner, amount: 1n }));
    expect(() => tokenTransferChanges({ accountKeys, instructions: [mintTo] })).toThrow(/MintTo/);
  });

  it("throws on an account index outside the transaction's keys", () => {
    const { accountKeys, compile } = compiler();
    const compiled = compile(transfer(buyer, vault, 1n));
    const broken = { ...compiled, accounts: [compiled.accounts[0]!, 99, compiled.accounts[2]!] };
    expect(() => tokenTransferChanges({ accountKeys, instructions: [broken] })).toThrow(/index 99/);
  });
});

describe("readers of a confirmed transaction (spec §12.2)", () => {
  const signature = getBase58Decoder().decode(new Uint8Array(64).fill(1));
  const key = "11111111111111111111111111111112" as Address;
  const fetched = {
    slot: 1n,
    meta: { err: null, preBalances: [5], postBalances: [7], innerInstructions: [] },
    transaction: { message: { accountKeys: [key], instructions: [] } },
  };
  /** An RPC whose `getTransaction` finds nothing for the first `empty` reads, as a lagging node does. */
  const laggingRpc = (empty: number) => {
    const state = { reads: 0 };
    const rpc = { getTransaction: () => ({ send: async () => (++state.reads <= empty ? null : fetched) }) } as never;
    return { rpc, state };
  };
  const retry = { attempts: 3, delayMs: 1 };

  it("retries a read that finds nothing when given a retry, for the balance readers and the event reader", async () => {
    const tokens = laggingRpc(1);
    expect((await tokenBalanceChanges(tokens.rpc, signature, retry)).size).toBe(0);
    expect(tokens.state.reads).toBe(2);
    const lamports = laggingRpc(2);
    expect((await lamportBalances(lamports.rpc, signature, retry)).get(key)).toEqual({ pre: 5n, post: 7n });
    expect(lamports.state.reads).toBe(3);
    const events = laggingRpc(1);
    expect(await fetchClosedEvent(events.rpc, signature, retry)).toBeUndefined();
    expect(events.state.reads).toBe(2);
  });

  it("reads once without a retry, and says so when nothing is found", async () => {
    const { rpc, state } = laggingRpc(1);
    await expect(tokenBalanceChanges(rpc, signature)).rejects.toThrow(/not found/);
    expect(state.reads).toBe(1);
  });
});
