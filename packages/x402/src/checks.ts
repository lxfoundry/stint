import {
  COMPUTE_BUDGET_PROGRAM_ADDRESS,
  ComputeBudgetInstruction,
  identifyComputeBudgetInstruction,
} from "@solana-program/compute-budget";
import {
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  AssociatedTokenInstruction,
  TOKEN_PROGRAM_ADDRESS,
  TokenInstruction,
  identifyAssociatedTokenInstruction,
  identifyTokenInstruction,
  parseCreateAssociatedTokenIdempotentInstruction,
  parseTransferCheckedInstruction,
} from "@solana-program/token";
import {
  address,
  getPublicKeyFromAddress,
  isInstructionWithAccounts,
  isInstructionWithData,
  type AccountMeta,
  type Address,
  type Instruction,
  type InstructionWithAccounts,
  type InstructionWithData,
  type ReadonlyUint8Array,
  verifySignature,
} from "@solana/kit";
import {
  STINT_PROGRAM_ADDRESS,
  StintInstruction,
  findSessionPda,
  identifyStintInstruction,
  parseCloseInstruction,
  parseOpenInstruction,
  type CloseKind,
  type Session,
} from "@lxfoundry/stint-program-client";
import type { InspectedTransaction } from "./inspect.js";
import { associatedTokenAddress } from "./transactions.js";
import { refuse, type Check, type ElapsedRequirements, type SellerTerms } from "./types.js";

export interface FacilitatorKeys {
  readonly feePayer: Address;
  readonly rentPayer: Address;
}

type WithData = Instruction & InstructionWithData<ReadonlyUint8Array>;
type Full = WithData & InstructionWithAccounts<readonly AccountMeta[]>;

/**
 * Kit leaves `accounts` out of an instruction that has none (compute budget), so identification
 * needs the data only; the predicates that read accounts add their own guard.
 */
function is<T>(identify: (ix: WithData) => T, ix: Instruction, programAddress: Address, kind: T): ix is WithData {
  if (ix.programAddress !== programAddress || !isInstructionWithData(ix)) return false;
  try {
    return identify(ix) === kind;
  } catch {
    return false; // data no known instruction of that program has
  }
}

const isVaultCreation = (ix: Instruction): ix is Full =>
  is(identifyAssociatedTokenInstruction, ix, ASSOCIATED_TOKEN_PROGRAM_ADDRESS, AssociatedTokenInstruction.CreateAssociatedTokenIdempotent) &&
  isInstructionWithAccounts(ix);
const isTransferChecked = (ix: Instruction): ix is Full =>
  is(identifyTokenInstruction, ix, TOKEN_PROGRAM_ADDRESS, TokenInstruction.TransferChecked) && isInstructionWithAccounts(ix);
const isStint = (ix: Instruction, kind: StintInstruction): ix is Full =>
  is(identifyStintInstruction, ix, STINT_PROGRAM_ADDRESS, kind) && isInstructionWithAccounts(ix);

/** Whether the signature the transaction carries for `signer` is a valid one over its message. */
async function signedBy(tx: InspectedTransaction, signer: Address): Promise<boolean> {
  const signature = tx.transaction.signatures[signer];
  if (!signature) return false;
  try {
    return await verifySignature(await getPublicKeyFromAddress(signer), signature, tx.transaction.messageBytes);
  } catch {
    return false;
  }
}

/**
 * The transaction requires signatures from exactly `required` (spec §5.3): an extra signer could
 * authorize something no check looked at. Every signature but the facilitator's, which it adds
 * itself, must be present and valid over the message.
 */
async function checkSigners(tx: InspectedTransaction, required: ReadonlySet<Address>, keys: FacilitatorKeys): Promise<Check<null>> {
  if (tx.signers.length !== required.size || tx.signers.some((signer) => !required.has(signer))) {
    return refuse("invalid_payload", "the transaction requires a signature from an account outside the expected signers");
  }
  for (const signer of tx.signers) {
    if (signer === keys.feePayer || signer === keys.rentPayer) continue;
    if (!(await signedBy(tx, signer))) return refuse("invalid_payload", `${signer} has not signed`);
  }
  return { ok: true, value: null };
}

/** `parse`'s result, or undefined when an identified instruction is malformed (too few accounts, short data). */
function tryParse<T>(parse: () => T): T | undefined {
  try {
    return parse();
  } catch {
    return undefined;
  }
}

/**
 * Where the facilitator's keys may appear (spec §5.3). The fee payer: only as the first account,
 * unsigned. The rent payer: only where `rentPayerAllowed` says.
 */
function checkPayerPositions(
  tx: InspectedTransaction,
  keys: FacilitatorKeys,
  rentPayerAllowed: (ix: Instruction, accountIndex: number) => boolean,
): Check<null> {
  if (tx.feePayer !== keys.feePayer) return refuse("payer_misuse", "the fee payer is not the facilitator's");
  if (tx.signed.has(keys.feePayer)) return refuse("payer_misuse", "the fee payer's signature slot is not empty");
  for (const ix of tx.instructions) {
    if (ix.programAddress === keys.feePayer || ix.programAddress === keys.rentPayer) {
      return refuse("payer_misuse", "a facilitator key is invoked as a program");
    }
    for (const [index, meta] of (ix.accounts ?? []).entries()) {
      if (meta.address === keys.feePayer) return refuse("payer_misuse", "the fee payer appears in an instruction");
      if (meta.address === keys.rentPayer && !rentPayerAllowed(ix, index)) {
        return refuse("payer_misuse", "the rent payer appears where it may not");
      }
    }
  }
  return { ok: true, value: null };
}

/** Leading compute-budget instructions, which may only set a compute-unit limit. */
function layoutBody(tx: InspectedTransaction): Check<readonly Instruction[]> {
  let start = 0;
  while (tx.instructions[start]?.programAddress === COMPUTE_BUDGET_PROGRAM_ADDRESS) {
    const ix = tx.instructions[start]!;
    if (!is(identifyComputeBudgetInstruction, ix, COMPUTE_BUDGET_PROGRAM_ADDRESS, ComputeBudgetInstruction.SetComputeUnitLimit)) {
      return refuse("unexpected_instruction", "only a compute-unit limit is allowed among compute-budget instructions");
    }
    start++;
  }
  return { ok: true, value: tx.instructions.slice(start) };
}

/** The vault of the transaction's first parseable `stint.open`: the session's associated token account. */
async function vaultOf(tx: InspectedTransaction): Promise<Address | undefined> {
  for (const ix of tx.instructions) {
    if (!isStint(ix, StintInstruction.Open)) continue;
    try {
      const o = parseOpenInstruction(ix);
      const [session] = await findSessionPda(o.accounts.authority.address, o.data.seed);
      return await associatedTokenAddress(session, o.accounts.mint.address);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export interface OpenFacts {
  readonly session: Address;
  readonly authority: Address;
  readonly seed: bigint;
  readonly vault: Address;
  readonly refundOwner: Address;
}

/** The static checks of spec §5.4 for an `open`. Simulation and the blockhash are the caller's. */
export async function checkOpenTransaction(
  tx: InspectedTransaction,
  requirements: ElapsedRequirements,
  keys: FacilitatorKeys,
): Promise<Check<OpenFacts>> {
  // The rent payer may fund only the vault the `stint.open` names, so that vault is derived first.
  const canonicalVault = await vaultOf(tx);
  const positions = checkPayerPositions(
    tx,
    keys,
    (ix, index) =>
      (isVaultCreation(ix) && index === 0 && canonicalVault !== undefined && ix.accounts[1]?.address === canonicalVault) ||
      (isStint(ix, StintInstruction.Open) && index === 1),
  );
  if (!positions.ok) return positions;

  const body = layoutBody(tx);
  if (!body.ok) return body;
  const [create, transfer, open, ...rest] = body.value;
  if (!create || !transfer || !open || rest.length > 0) {
    return refuse("unexpected_instruction", "an open is: create the vault, one funding transfer, stint.open");
  }
  if (!isVaultCreation(create) || !isTransferChecked(transfer) || !isStint(open, StintInstruction.Open)) {
    return refuse("unexpected_instruction", "an open is: create the vault, one funding transfer, stint.open");
  }

  const c = tryParse(() => parseCreateAssociatedTokenIdempotentInstruction(create));
  const t = tryParse(() => parseTransferCheckedInstruction(transfer));
  const o = tryParse(() => parseOpenInstruction(open));
  if (!c || !t || !o) return refuse("unexpected_instruction", "an instruction of the open is malformed");
  const extra = requirements.extra;
  const asset = address(requirements.asset);

  if (extra.programId !== STINT_PROGRAM_ADDRESS) return refuse("invalid_payment_requirements", "another program");
  if (
    o.data.rate !== BigInt(extra.rate) ||
    o.data.minSeconds !== extra.minSeconds ||
    o.data.maxSeconds !== extra.maxSeconds ||
    o.accounts.receiver.address !== requirements.payTo ||
    o.accounts.receiverAuthorizer.address !== extra.receiverAuthorizer ||
    o.accounts.mint.address !== asset ||
    o.accounts.rentPayer.address !== keys.rentPayer
  ) {
    return refuse("invalid_terms", "the open's terms differ from the offer");
  }

  const authority = o.accounts.authority.address;
  const [session] = await findSessionPda(authority, o.data.seed);
  const vault = await associatedTokenAddress(session, asset);
  if (
    o.accounts.session.address !== session ||
    o.accounts.vault.address !== vault ||
    c.accounts.ata.address !== vault ||
    c.accounts.owner.address !== session ||
    c.accounts.mint.address !== asset ||
    c.accounts.payer.address !== keys.rentPayer
  ) {
    return refuse("invalid_terms", "the session or its vault is not the canonical one");
  }

  const refundOwner = o.accounts.refundOwner.address;
  if (
    t.accounts.mint.address !== asset ||
    t.accounts.destination.address !== vault ||
    t.accounts.source.address !== (await associatedTokenAddress(refundOwner, asset))
  ) {
    return refuse("invalid_terms", "the funding must move the asset from the refund owner's account into the vault");
  }
  if (t.data.amount !== BigInt(requirements.amount)) {
    return refuse("invalid_amount", `the funding moves ${t.data.amount}, not ${requirements.amount}`);
  }
  // The authority and the transfer authority may be the same key.
  const signers = await checkSigners(tx, new Set([keys.feePayer, keys.rentPayer, authority, t.accounts.authority.address]), keys);
  if (!signers.ok) return signers;
  return { ok: true, value: { session, authority, seed: o.data.seed, vault, refundOwner } };
}

export interface CloseFacts {
  readonly kind: CloseKind;
}

/** The static checks of spec §5.4 for a `close` sent by a gate through `/settle`. */
export async function checkCloseTransaction(
  tx: InspectedTransaction,
  expected: { readonly session: Address; readonly closer: Address },
  keys: FacilitatorKeys,
): Promise<Check<CloseFacts>> {
  // `rent_payer` is the sixth account of `close`: it receives lamports and does not sign.
  const positions = checkPayerPositions(tx, keys, (ix, index) => isStint(ix, StintInstruction.Close) && index === 5);
  if (!positions.ok) return positions;
  const body = layoutBody(tx);
  if (!body.ok) return body;
  const [close, ...rest] = body.value;
  if (!close || rest.length > 0 || !isStint(close, StintInstruction.Close)) {
    return refuse("unexpected_instruction", "a close is stint.close alone");
  }
  const parsed = tryParse(() => parseCloseInstruction(close));
  if (!parsed) return refuse("unexpected_instruction", "the stint.close is malformed");
  if (parsed.accounts.session.address !== expected.session) return refuse("invalid_terms", "another session");
  if (parsed.accounts.closer.address !== expected.closer) return refuse("invalid_payload", "the closer is not the expected one");
  const signers = await checkSigners(tx, new Set([keys.feePayer, expected.closer]), keys);
  if (!signers.ok) return signers;
  return { ok: true, value: { kind: parsed.data.kind } };
}

/** Check 4 of spec §7.2: the session's terms match the seller's offer, mint included (S5). */
export function sessionMatches(
  session: Pick<Session, "mint" | "receiver" | "receiverAuthorizer" | "rate" | "minSeconds" | "maxSeconds">,
  seller: SellerTerms,
): boolean {
  return (
    seller.programId === STINT_PROGRAM_ADDRESS &&
    session.mint === seller.asset &&
    session.receiver === seller.payTo &&
    session.receiverAuthorizer === seller.receiverAuthorizer &&
    session.rate === seller.terms.rate &&
    session.minSeconds === seller.terms.minSeconds &&
    session.maxSeconds === seller.terms.maxSeconds
  );
}
