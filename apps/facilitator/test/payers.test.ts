import {
  getAssignInstruction,
  getCreateAccountInstruction,
  getCreateAccountWithSeedInstruction,
  getTransferSolInstruction,
} from "@solana-program/system";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { createNoopSigner, generateKeyPairSigner, getBase58Decoder, type Address, type Instruction } from "@solana/kit";
import { STINT_PROGRAM_ADDRESS } from "@lxfoundry/stint-program-client";
import type { InspectedTransaction } from "@lxfoundry/stint-x402";
import { beforeAll, describe, expect, it } from "vitest";
import { checkPayerFunding, executedInstructions, type ExecutedInstruction, type Funding } from "../src/payers.js";

const SESSION_RENT = 2_630_880n;
const VAULT_RENT = 2_039_280n;
const newAddress = async () => (await generateKeyPairSigner()).address;

/** A built instruction in the walker's raw form. */
const raw = (ix: Instruction): ExecutedInstruction => ({
  programAddress: ix.programAddress,
  accounts: (ix.accounts ?? []).map((meta) => meta.address),
  data: ix.data ?? new Uint8Array(),
});

describe("checkPayerFunding (spec §5.4)", () => {
  let keys: { feePayer: Address; rentPayer: Address };
  let session: Address;
  let vault: Address;
  let funding: Funding;

  beforeAll(async () => {
    keys = { feePayer: await newAddress(), rentPayer: await newAddress() };
    session = await newAddress();
    vault = await newAddress();
    funding = { destinations: [session, vault], budget: SESSION_RENT + VAULT_RENT };
  });

  const create = (payer: Address, newAccount: Address, lamports: bigint, space: number, owner: Address) =>
    raw(
      getCreateAccountInstruction({
        payer: createNoopSigner(payer),
        newAccount: createNoopSigner(newAccount),
        lamports,
        space,
        programAddress: owner,
      }),
    );

  /** The two accounts an honest open creates, each funded by the rent payer inside a program. */
  const honestOpen = () => [
    create(keys.rentPayer, vault, VAULT_RENT, 165, TOKEN_PROGRAM_ADDRESS),
    create(keys.rentPayer, session, SESSION_RENT, 250, STINT_PROGRAM_ADDRESS),
  ];

  it("passes an honest open: the rent payer creates the vault and the session, within the budget", () => {
    expect(checkPayerFunding(honestOpen(), keys, funding)).toEqual({ ok: true, value: null });
  });

  /** A System Program instruction in the node's jsonParsed form, as Surfpool returns inner ones. */
  const parsed = (type: string, info: Record<string, unknown>): ExecutedInstruction => ({
    programAddress: "11111111111111111111111111111111" as Address,
    parsed: { type, info },
  });
  const parsedCreate = (newAccount: Address, lamports: bigint | number, space: number, owner: Address) =>
    parsed("createAccount", { source: keys.rentPayer, newAccount, lamports, space, owner });

  it("passes the same open in the node's jsonParsed form", () => {
    const instructions = [
      parsedCreate(vault, VAULT_RENT, 165, TOKEN_PROGRAM_ADDRESS),
      parsedCreate(session, SESSION_RENT, 250, STINT_PROGRAM_ADDRESS),
    ];
    expect(checkPayerFunding(instructions, keys, funding)).toEqual({ ok: true, value: null });
  });

  it("reads jsonParsed lamports given as a number: accepted within the budget, refused above it", () => {
    const within = [
      parsedCreate(vault, Number(VAULT_RENT), 165, TOKEN_PROGRAM_ADDRESS),
      parsedCreate(session, Number(SESSION_RENT), 250, STINT_PROGRAM_ADDRESS),
    ];
    expect(checkPayerFunding(within, keys, funding)).toEqual({ ok: true, value: null });
    const above = [...within, parsed("transfer", { source: keys.rentPayer, destination: session, lamports: 1 })];
    expect(checkPayerFunding(above, keys, funding)).toMatchObject({
      ok: false,
      reason: "payer_misuse",
      message: "the rent payer would fund more than the session's accounts",
    });
  });

  describe("in the node's jsonParsed form", () => {
    it("refuses a parsed transfer whose source is the fee payer", async () => {
      const transfer = parsed("transfer", { source: keys.feePayer, destination: await newAddress(), lamports: 1n });
      expect(checkPayerFunding([transfer], keys, funding)).toMatchObject({
        ok: false,
        reason: "payer_misuse",
        message: "the fee payer would pay more than the fee",
      });
    });

    it("refuses a parsed transfer from the rent payer to an unrelated account", async () => {
      const transfer = parsed("transfer", { source: keys.rentPayer, destination: await newAddress(), lamports: 1n });
      expect(checkPayerFunding([transfer], keys, funding)).toMatchObject({
        ok: false,
        reason: "payer_misuse",
        message: "the rent payer would fund an account other than the session's",
      });
    });

    it("refuses a parsed createAccountWithSeed or transferWithSeed from the rent payer, even towards the session", async () => {
      // A base other than the rent payer, so that only the instruction's kind is at fault.
      const base = await newAddress();
      const createWithSeed = parsed("createAccountWithSeed", {
        source: keys.rentPayer,
        newAccount: session,
        base,
        seed: "s",
        lamports: 1n,
        space: 0,
        owner: STINT_PROGRAM_ADDRESS,
      });
      const transferWithSeed = parsed("transferWithSeed", {
        source: keys.rentPayer,
        sourceBase: base,
        destination: session,
        lamports: 1n,
        sourceSeed: "s",
        sourceOwner: STINT_PROGRAM_ADDRESS,
      });
      for (const instruction of [createWithSeed, transferWithSeed]) {
        expect(checkPayerFunding([instruction], keys, funding)).toMatchObject({ ok: false, reason: "payer_misuse" });
      }
    });

    it("refuses a parsed assign naming the rent payer", () => {
      const assign = parsed("assign", { account: keys.rentPayer, owner: STINT_PROGRAM_ADDRESS });
      expect(checkPayerFunding([assign], keys, funding)).toMatchObject({ ok: false, reason: "payer_misuse" });
    });

    it("refuses a parsed transfer to the rent payer", () => {
      const transfer = parsed("transfer", { source: session, destination: keys.rentPayer, lamports: 1n });
      expect(checkPayerFunding([transfer], keys, funding)).toMatchObject({ ok: false, reason: "payer_misuse" });
    });

    it("refuses a parsed funding instruction that names the rent payer in any other field", () => {
      const create = parsedCreate(session, SESSION_RENT, 250, keys.rentPayer);
      expect(checkPayerFunding([create], keys, funding)).toMatchObject({ ok: false, reason: "payer_misuse" });
    });
  });

  it("refuses the fee payer as a transfer source", async () => {
    const transfer = raw(getTransferSolInstruction({ source: createNoopSigner(keys.feePayer), destination: await newAddress(), amount: 1n }));
    expect(checkPayerFunding([...honestOpen(), transfer], keys, funding)).toMatchObject({
      ok: false,
      reason: "payer_misuse",
      message: "the fee payer would pay more than the fee",
    });
  });

  it("refuses the rent payer funding an unrelated account", async () => {
    const transfer = raw(getTransferSolInstruction({ source: createNoopSigner(keys.rentPayer), destination: await newAddress(), amount: 1n }));
    expect(checkPayerFunding([transfer], keys, funding)).toMatchObject({ ok: false, reason: "payer_misuse" });
  });

  it("refuses the rent payer in an Assign", () => {
    const assign = raw(getAssignInstruction({ account: createNoopSigner(keys.rentPayer), programAddress: STINT_PROGRAM_ADDRESS }));
    expect(checkPayerFunding([...honestOpen(), assign], keys, funding)).toMatchObject({ ok: false, reason: "payer_misuse" });
  });

  it("refuses any System instruction but CreateAccount and Transfer, even towards the session", () => {
    const withSeed = raw(
      getCreateAccountWithSeedInstruction({
        payer: createNoopSigner(keys.rentPayer),
        newAccount: session,
        base: keys.rentPayer,
        seed: "s",
        amount: 1n,
        space: 0,
        programAddress: STINT_PROGRAM_ADDRESS,
      }),
    );
    expect(checkPayerFunding([withSeed], keys, funding)).toMatchObject({ ok: false, reason: "payer_misuse" });
  });

  it("refuses the rent payer as the account a transfer funds", () => {
    const transfer = raw(getTransferSolInstruction({ source: createNoopSigner(session), destination: keys.rentPayer, amount: 1n }));
    expect(checkPayerFunding([transfer], keys, funding)).toMatchObject({ ok: false, reason: "payer_misuse" });
  });

  it("refuses funding over the budget, even to the session's own accounts", () => {
    const topUp = raw(getTransferSolInstruction({ source: createNoopSigner(keys.rentPayer), destination: session, amount: 1n }));
    expect(checkPayerFunding([...honestOpen(), topUp], keys, funding)).toMatchObject({
      ok: false,
      reason: "payer_misuse",
      message: "the rent payer would fund more than the session's accounts",
    });
  });

  it("refuses any rent payer funding for a close: no destination, no budget", () => {
    const close: Funding = { destinations: [], budget: 0n };
    expect(checkPayerFunding(honestOpen(), keys, close)).toMatchObject({ ok: false, reason: "payer_misuse" });
    expect(checkPayerFunding([], keys, close)).toEqual({ ok: true, value: null });
  });
});

describe("executedInstructions", () => {
  const system = "11111111111111111111111111111111" as Address;

  it("reads the node's jsonParsed, partially decoded and compiled inner instructions, and keeps only the System ones", async () => {
    const rentPayer = await newAddress();
    const session = await newAddress();
    const transfer = getTransferSolInstruction({ source: createNoopSigner(rentPayer), destination: session, amount: 7n });
    const data = getBase58Decoder().decode(transfer.data);
    const tx = { instructions: [], accounts: [rentPayer, session, system] } as unknown as InspectedTransaction;
    const inner = [
      {
        index: 0,
        instructions: [
          { programId: system, parsed: { type: "createAccount", info: { source: rentPayer, newAccount: session, lamports: 5n } } },
          { programId: STINT_PROGRAM_ADDRESS, accounts: [session], data: "1" },
          { programId: system, accounts: [rentPayer, session], data },
          { programIdIndex: 2n, accounts: [0n, 1n], data },
        ],
      },
    ];
    const instructions = executedInstructions(tx, inner);
    expect(instructions).toHaveLength(3);
    expect(instructions[1]).toEqual({ programAddress: system, accounts: [rentPayer, session], data: transfer.data });
    expect(instructions[2]).toEqual(instructions[1]);
    expect(checkPayerFunding(instructions, { feePayer: await newAddress(), rentPayer }, { destinations: [session], budget: 19n })).toEqual({
      ok: true,
      value: null,
    });
  });

  describe("refuses to guess at an inner instruction it cannot read", () => {
    const tx = { instructions: [], accounts: [system] } as unknown as InspectedTransaction;
    const read = (ix: unknown) => () => executedInstructions(tx, [{ index: 0, instructions: [ix] }]);
    const unreadable = "The node's simulation returned an unreadable inner instruction";

    it("without a programId or a programIdIndex", () => {
      expect(read({ accounts: [], data: "1" })).toThrow(unreadable);
    });

    it("with a System parsed field that is not {type, info}", () => {
      expect(read({ programId: system, parsed: "transfer" })).toThrow(unreadable);
      expect(read({ programId: system, parsed: { type: "transfer" } })).toThrow(unreadable);
    });

    it("with System data that is not a string", () => {
      expect(read({ programId: system, accounts: [], data: [2, 0, 0, 0] })).toThrow(unreadable);
    });

    it("with an index outside the static keys", () => {
      expect(read({ programIdIndex: 0n, accounts: [5n], data: "1" })).toThrow(unreadable);
      expect(read({ programIdIndex: 5n, accounts: [], data: "1" })).toThrow(unreadable);
    });

    it("in a group without instructions", () => {
      expect(() => executedInstructions(tx, [{ index: 0 }])).toThrow(
        "The node's simulation returned an unreadable inner instruction group",
      );
    });
  });

  it("throws when the node returns no inner instructions", () => {
    const tx = { instructions: [], accounts: [] } as unknown as InspectedTransaction;
    expect(() => executedInstructions(tx, null)).toThrow("The node's simulation returned no inner instructions");
    expect(() => executedInstructions(tx, undefined)).toThrow("The node's simulation returned no inner instructions");
  });
});
