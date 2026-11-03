import { createHash } from "node:crypto";
import {
  assertIsTransactionWithinSizeLimit,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getCompiledTransactionMessageEncoder,
  getInstructionsFromCompiledTransactionMessage,
  getTransactionDecoder,
  type Address,
  type Instruction,
  type ReadonlyUint8Array,
  type Transaction,
} from "@solana/kit";

export interface InspectedTransaction {
  readonly wire: string;
  readonly transaction: Transaction;
  /** The first account (S14). */
  readonly feePayer: Address;
  /** The message's static accounts, in index order. */
  readonly accounts: readonly Address[];
  /** Every account the message requires a signature from, in order. */
  readonly signers: readonly Address[];
  /** The signers whose signature is present. */
  readonly signed: ReadonlySet<Address>;
  readonly blockhash: string;
  readonly instructions: readonly Instruction[];
  /** SHA-256 of the message bytes, hex: the key settlement records are keyed by (spec §5.5). */
  readonly messageHash: string;
}

function sameBytes(a: ReadonlyUint8Array, b: ReadonlyUint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

/** Decodes a base64 wire transaction. Only version 0 without lookup tables is accepted (spec §3.5). */
export function inspectTransaction(wire: string): InspectedTransaction | undefined {
  try {
    const transaction = getTransactionDecoder().decode(getBase64Encoder().encode(wire));
    assertIsTransactionWithinSizeLimit(transaction);
    const compiled = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
    if (compiled.version !== 0) return undefined;
    // The decoders take every byte after the signatures as the message and ignore what follows its end: bytes appended to
    // a wire would give the same instructions another hash, and a retry would not be recognised (spec §5.5).
    const canonical = getCompiledTransactionMessageEncoder().encode(compiled);
    if (!sameBytes(canonical, transaction.messageBytes)) return undefined;
    if ((compiled.addressTableLookups?.length ?? 0) > 0) return undefined;
    const signers = compiled.staticAccounts.slice(0, compiled.header.numSignerAccounts);
    const signed = new Set(
      Object.entries(transaction.signatures)
        .filter(([, signature]) => signature !== null)
        .map(([signer]) => signer as Address),
    );
    return {
      wire,
      transaction,
      feePayer: compiled.staticAccounts[0]!,
      accounts: compiled.staticAccounts,
      signers,
      signed,
      blockhash: compiled.lifetimeToken,
      instructions: getInstructionsFromCompiledTransactionMessage(compiled),
      messageHash: createHash("sha256").update(new Uint8Array(transaction.messageBytes)).digest("hex"),
    };
  } catch {
    return undefined;
  }
}
