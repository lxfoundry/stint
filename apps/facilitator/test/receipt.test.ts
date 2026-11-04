import { TOKEN_PROGRAM_ADDRESS, getMintToInstruction, getTransferCheckedInstruction } from "@solana-program/token";
import { address, createNoopSigner, generateKeyPairSigner, getBase58Decoder, type Address } from "@solana/kit";
import { beforeAll, describe, expect, it } from "vitest";
import { STINT_PROGRAM_ADDRESS } from "@lxfoundry/stint-program-client";
import {
  buildOpenOffer,
  buildOpenTransaction,
  inspectTransaction,
  type ElapsedRequirements,
  type InspectedTransaction,
} from "@lxfoundry/stint-x402";
import { vaultReceipt } from "../src/receipt.js";

const MINT = address("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");

describe("vaultReceipt (spec §5.4, §10.2)", () => {
  let offer: ElapsedRequirements;

  beforeAll(async () => {
    const key = async () => (await generateKeyPairSigner()).address;
    // The offer of verify.test.ts: 30 s at 1,000 base units a second, so the amount is 30,000.
    offer = buildOpenOffer({
      network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
      asset: MINT,
      payTo: await key(),
      receiverAuthorizer: await key(),
      terms: { rate: 1_000n, minSeconds: 5, maxSeconds: 120 },
      seconds: 30,
      facilitator: { feePayer: await key(), rentPayer: await key(), programId: STINT_PROGRAM_ADDRESS, closeUrl: "http://127.0.0.1:4021/close" },
      lifetime: { blockhash: "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N", lastValidBlockHeight: 1_234n },
      maxTimeoutSeconds: 60,
      idleCloseSeconds: 10,
      closeOnOutage: true,
    });
  });

  /** An open funded from an allowance. Pull accounts: subscription authority 1, owner's account 2, vault 3. */
  async function allowanceOpen(): Promise<{ tx: InspectedTransaction; authority: Address; source: Address; vault: Address }> {
    const built = await buildOpenTransaction({
      requirements: offer,
      authority: await generateKeyPairSigner(),
      decimals: 6,
      funding: { kind: "allowance", owner: (await generateKeyPairSigner()).address, nonce: 0n },
    });
    const tx = inspectTransaction(built.transaction)!;
    const pull = tx.instructions[1]!.accounts!;
    return { tx, authority: pull[1]!.address, source: pull[2]!.address, vault: pull[3]!.address };
  }

  it("counts a top-level TransferChecked into the vault", async () => {
    const built = await buildOpenTransaction({ requirements: offer, authority: await generateKeyPairSigner(), decimals: 6 });
    const tx = inspectTransaction(built.transaction)!;
    // TransferChecked accounts: source 0, mint 1, destination 2, authority 3.
    expect(vaultReceipt(tx, [], tx.instructions[1]!.accounts![2]!.address)).toBe(30_000n);
  });

  it("counts an inner TransferChecked into the vault, as a node compiles it", async () => {
    const { tx, authority, source, vault } = await allowanceOpen();
    const index = (key: Address) => tx.accounts.indexOf(key);
    const transfer = getTransferCheckedInstruction({
      source,
      mint: MINT,
      destination: vault,
      authority: createNoopSigner(authority),
      amount: 30_000n,
      decimals: 6,
    });
    const inner = [
      {
        index: 1,
        instructions: [
          {
            programIdIndex: index(TOKEN_PROGRAM_ADDRESS),
            accounts: [index(source), index(MINT), index(vault), index(authority)],
            data: getBase58Decoder().decode(transfer.data),
          },
        ],
      },
    ];
    expect(vaultReceipt(tx, inner, vault)).toBe(30_000n);
  });

  it("counts parsed inner transfers, less those out of the vault", async () => {
    const { tx, source, vault } = await allowanceOpen();
    const parsed = [
      {
        index: 1,
        instructions: [
          {
            program: "spl-token",
            programId: TOKEN_PROGRAM_ADDRESS,
            parsed: { type: "transferChecked", info: { source, destination: vault, mint: MINT, tokenAmount: { amount: "30000", decimals: 6 } } },
          },
        ],
      },
      {
        index: 2,
        instructions: [
          { program: "spl-token", programId: TOKEN_PROGRAM_ADDRESS, parsed: { type: "transfer", info: { source: vault, destination: source, amount: "1" } } },
        ],
      },
    ];
    expect(vaultReceipt(tx, parsed, vault)).toBe(29_999n);
  });

  it("throws on a mint or a burn that names the vault", async () => {
    const { tx, source, vault } = await allowanceOpen();
    const mint = [
      {
        index: 1,
        instructions: [
          { program: "spl-token", programId: TOKEN_PROGRAM_ADDRESS, parsed: { type: "mintTo", info: { mint: MINT, account: vault, mintAuthority: source, amount: "1" } } },
        ],
      },
    ];
    expect(() => vaultReceipt(tx, mint, vault)).toThrow(/other than by a transfer/);
  });

  it("throws on a mint into the vault, as a node compiles it", async () => {
    const { tx, authority, vault } = await allowanceOpen();
    const index = (key: Address) => tx.accounts.indexOf(key);
    const mint = getMintToInstruction({ mint: MINT, token: vault, mintAuthority: createNoopSigner(authority), amount: 1n });
    const inner = [
      {
        index: 1,
        instructions: [
          { programIdIndex: index(TOKEN_PROGRAM_ADDRESS), accounts: [index(MINT), index(vault), index(authority)], data: getBase58Decoder().decode(mint.data) },
        ],
      },
    ];
    expect(() => vaultReceipt(tx, inner, vault)).toThrow(/other than by a transfer/);
  });

  it("throws on inner instructions it cannot read", async () => {
    const { tx, vault } = await allowanceOpen();
    expect(() => vaultReceipt(tx, "nope", vault)).toThrow();
    expect(() => vaultReceipt(tx, [{ index: 0, instructions: [42] }], vault)).toThrow();
  });
});
