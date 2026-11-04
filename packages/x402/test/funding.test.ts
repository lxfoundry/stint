import { generateKeyPairSigner, type Address, type KeyPairSigner } from "@solana/kit";
import { beforeAll, describe, expect, it } from "vitest";
import { STINT_PROGRAM_ADDRESS, parseOpenInstruction } from "@lxfoundry/stint-program-client";
import {
  SUBSCRIPTIONS_PROGRAM_ADDRESS,
  allowanceAccounts,
  parseTransferRecurringInstruction,
} from "@lxfoundry/stint-subscriptions-client";
import {
  associatedTokenAddress,
  buildOpenOffer,
  buildOpenTransaction,
  buildTopUpOffer,
  buildTopUpTransaction,
  inspectTransaction,
  refundOwnerOf,
  type ElapsedRequirements,
} from "../src/index.js";
import { offerInput } from "./fixtures.js";

describe("funding from an allowance (spec §10.2)", () => {
  let agent: KeyPairSigner;
  let owner: Address;
  let offer: ElapsedRequirements;

  beforeAll(async () => {
    agent = await generateKeyPairSigner();
    owner = (await generateKeyPairSigner()).address;
    offer = buildOpenOffer(offerInput());
  });

  it("names the owner as refund owner, and the authority otherwise", () => {
    expect(refundOwnerOf({ kind: "allowance", owner, nonce: 0n }, agent.address)).toBe(owner);
    expect(refundOwnerOf({ kind: "own" }, agent.address)).toBe(agent.address);
  });

  it("opens with one pull from the owner's account into the vault, and the owner as refund owner", async () => {
    const built = await buildOpenTransaction({
      requirements: offer,
      authority: agent,
      decimals: 6,
      funding: { kind: "allowance", owner, nonce: 0n },
    });
    const tx = inspectTransaction(built.transaction)!;
    expect([...tx.signed]).toEqual([agent.address]);
    const [create, pull, open] = tx.instructions;
    expect(create).toBeDefined();
    expect(pull!.programAddress).toBe(SUBSCRIPTIONS_PROGRAM_ADDRESS);
    expect(open!.programAddress).toBe(STINT_PROGRAM_ADDRESS);
    const vault = await associatedTokenAddress(built.session, offer.asset as Address);
    const p = parseTransferRecurringInstruction(pull as never);
    const accounts = await allowanceAccounts({ owner, agent: agent.address, mint: offer.asset as Address, nonce: 0n });
    expect(p.accounts.receiverAta.address).toBe(vault);
    expect(p.accounts.delegatorAta.address).toBe(accounts.ownerToken);
    expect(p.accounts.delegatee.address).toBe(agent.address);
    expect(p.data.transferData.amount).toBe(BigInt(offer.amount));
    expect(parseOpenInstruction(open as never).accounts.refundOwner.address).toBe(owner);
  });

  it("tops up with one pull into the session's vault", async () => {
    const session = (await generateKeyPairSigner()).address;
    const entry = buildTopUpOffer({ ...offerInput(), seconds: 10, session });
    const wire = await buildTopUpTransaction({ requirements: entry, authority: agent, decimals: 6, funding: { kind: "allowance", owner, nonce: 3n } });
    const [pull] = inspectTransaction(wire)!.instructions;
    const p = parseTransferRecurringInstruction(pull as never);
    expect(p.accounts.receiverAta.address).toBe(await associatedTokenAddress(session, entry.asset as Address));
    const accounts = await allowanceAccounts({ owner, agent: agent.address, mint: entry.asset as Address, nonce: 3n });
    expect(p.accounts.delegationPda.address).toBe(accounts.delegation);
  });
});
