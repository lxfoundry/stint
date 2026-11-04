import {
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  TOKEN_PROGRAM_ADDRESS,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
} from "@solana-program/token";
import {
  address,
  appendTransactionMessageInstructions,
  blockhash,
  createNoopSigner,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  partiallySignTransactionMessageWithSigners,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Blockhash,
  type Instruction,
  type TransactionSigner,
} from "@solana/kit";
import {
  CloseKind,
  eventAccounts,
  findSessionPda,
  getCloseInstruction,
  getOpenInstruction,
  getTopUpInstruction,
  type Session,
} from "@lxfoundry/stint-program-client";
import { OWN_FUNDS, fundingInstruction, refundOwnerOf, type FundingSource } from "./funding.js";
import type { ElapsedRequirements } from "./types.js";

/** A fresh random seed for every session (spec §4.1). */
export function randomSeed(): bigint {
  return crypto.getRandomValues(new BigUint64Array(1))[0]!;
}

export async function associatedTokenAddress(owner: Address, mint: Address): Promise<Address> {
  const [account] = await findAssociatedTokenPda({ owner, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  return account;
}

async function compile(
  feePayer: Address,
  lifetime: { blockhash: Blockhash; lastValidBlockHeight: bigint },
  instructions: readonly Instruction[],
): Promise<string> {
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(lifetime, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  // Only the client's own signers sign; the fee payer's and rent payer's slots stay empty.
  return getBase64EncodedWireTransaction(await partiallySignTransactionMessageWithSigners(message));
}

export interface BuildOpenInput {
  readonly requirements: ElapsedRequirements;
  readonly authority: TransactionSigner;
  /** The asset's decimals, from the client's allowlist (spec §5.1, "Decimals"). */
  readonly decimals: number;
  readonly seed?: bigint;
  /** Where the deposit comes from (spec §10). Default: the authority's own associated token account. */
  readonly funding?: FundingSource;
}

export interface BuiltOpen {
  readonly transaction: string;
  readonly session: Address;
  readonly seed: bigint;
}

/**
 * The `open` layout of spec §5.3: create the vault (funded by the rent payer), fund it with
 * exactly `amount`, from the authority's associated token account or by one pull from its
 * allowance (spec §10.2), then `stint.open`. Refunds go back to the account the money came from.
 */
export async function buildOpenTransaction(input: BuildOpenInput): Promise<BuiltOpen> {
  const { requirements, authority } = input;
  const extra = requirements.extra;
  const mint = address(requirements.asset);
  const seed = input.seed ?? randomSeed();
  const [session] = await findSessionPda(authority.address, seed);
  const vault = await associatedTokenAddress(session, mint);
  const funding = input.funding ?? OWN_FUNDS;
  // One signer object per address: the rent payer appears in two instructions.
  const rentPayer = createNoopSigner(address(extra.rentPayer));

  const instructions = [
    getCreateAssociatedTokenIdempotentInstruction({ payer: rentPayer, ata: vault, owner: session, mint }),
    await fundingInstruction({ funding, authority, mint, vault, amount: BigInt(requirements.amount), decimals: input.decimals }),
    getOpenInstruction({
      authority,
      rentPayer,
      session,
      mint,
      vault,
      receiver: address(requirements.payTo),
      receiverAuthorizer: address(extra.receiverAuthorizer),
      refundOwner: refundOwnerOf(funding, authority.address),
      ...(await eventAccounts()),
      seed,
      rate: BigInt(extra.rate),
      minSeconds: extra.minSeconds,
      maxSeconds: extra.maxSeconds,
    }),
  ];
  const transaction = await compile(
    address(extra.feePayer),
    { blockhash: blockhash(extra.recentBlockhash), lastValidBlockHeight: BigInt(extra.lastValidBlockHeight) },
    instructions,
  );
  return { transaction, session, seed };
}

export interface BuildTopUpInput {
  /** A `topUp` entry: `extra.session` names the session it extends. */
  readonly requirements: ElapsedRequirements;
  readonly authority: TransactionSigner;
  /** The asset's decimals, from the client's allowlist (spec §5.1, "Decimals"). */
  readonly decimals: number;
  /** Where the deposit comes from (spec §10). Default: the authority's own associated token account. */
  readonly funding?: FundingSource;
}

/**
 * The `topUp` layout of spec §5.3: fund the session's vault with exactly `amount`, from the account the session's deposit
 * came from: pass the `funding` the session was opened with, since the facilitator requires the funding to come from the
 * stored refund owner (spec §5.4). Then `stint.top_up`. The fee payer's slot stays empty; nobody else signs.
 */
export async function buildTopUpTransaction(input: BuildTopUpInput): Promise<string> {
  const { requirements, authority } = input;
  const extra = requirements.extra;
  if (extra.action !== "topUp" || extra.session === undefined) throw new Error("Not a top-up entry: no topUp action, or no session");
  const mint = address(requirements.asset);
  const session = address(extra.session);
  const vault = await associatedTokenAddress(session, mint);
  const instructions = [
    await fundingInstruction({
      funding: input.funding ?? OWN_FUNDS,
      authority,
      mint,
      vault,
      amount: BigInt(requirements.amount),
      decimals: input.decimals,
    }),
    getTopUpInstruction({ authority, session, vault, ...(await eventAccounts()) }),
  ];
  return compile(
    address(extra.feePayer),
    { blockhash: blockhash(extra.recentBlockhash), lastValidBlockHeight: BigInt(extra.lastValidBlockHeight) },
    instructions,
  );
}

export interface BuildCloseInput {
  readonly session: Address;
  /** The stored fields a close derives its accounts from (spec §4.1). */
  readonly stored: Pick<Session, "mint" | "receiver" | "refundOwner" | "rentPayer">;
  readonly closer: TransactionSigner;
  readonly feePayer: Address;
  readonly lifetime: { readonly blockhash: string; readonly lastValidBlockHeight: bigint };
  readonly kind?: CloseKind;
}

/** The `close` layout of spec §5.3, without a recreated `receiver_token`. */
export async function buildCloseTransaction(input: BuildCloseInput): Promise<string> {
  const { stored } = input;
  const instruction = getCloseInstruction({
    closer: input.closer,
    session: input.session,
    vault: await associatedTokenAddress(input.session, stored.mint),
    receiverToken: await associatedTokenAddress(stored.receiver, stored.mint),
    refundTo: await associatedTokenAddress(stored.refundOwner, stored.mint),
    rentPayer: stored.rentPayer,
    ...(await eventAccounts()),
    kind: input.kind ?? CloseKind.Standard,
  });
  return compile(
    input.feePayer,
    { blockhash: blockhash(input.lifetime.blockhash), lastValidBlockHeight: input.lifetime.lastValidBlockHeight },
    [instruction],
  );
}

export { ASSOCIATED_TOKEN_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS };
