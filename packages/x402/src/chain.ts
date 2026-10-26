import {
  TOKEN_PROGRAM_ADDRESS,
  TokenInstruction,
  identifyTokenInstruction,
  parseTransferCheckedInstruction,
  parseTransferInstruction,
} from "@solana-program/token";
import {
  AccountRole,
  blockhash as toBlockhash,
  getBase58Encoder,
  signature as toSignature,
  type Address,
  type Rpc,
  type SolanaRpcApi,
} from "@solana/kit";
import { findClosedEvent, type ClosedEvent, type ProgramInstruction } from "@lxfoundry/stint-program-client";

const json = (value: unknown) => JSON.stringify(value, (_, inner) => (typeof inner === "bigint" ? inner.toString() : inner));

async function fetchConfirmed(rpc: Rpc<SolanaRpcApi>, signature: string) {
  return rpc
    .getTransaction(toSignature(signature), { commitment: "confirmed", encoding: "json", maxSupportedTransactionVersion: 0 })
    .send();
}

/** Every account key of a fetched transaction, lookup-table addresses included, in index order. */
function accountKeysOf(transaction: NonNullable<Awaited<ReturnType<typeof fetchConfirmed>>>): Address[] {
  const loaded = transaction.meta?.loadedAddresses;
  return [...transaction.transaction.message.accountKeys, ...(loaded?.writable ?? []), ...(loaded?.readonly ?? [])];
}

/** The inner instructions of a confirmed transaction, with their program address. */
export async function fetchProgramInstructions(rpc: Rpc<SolanaRpcApi>, signature: string): Promise<ProgramInstruction[] | undefined> {
  const transaction = await fetchConfirmed(rpc, signature);
  if (!transaction) return undefined;
  const keys = accountKeysOf(transaction);
  const base58 = getBase58Encoder();
  return (transaction.meta?.innerInstructions ?? []).flatMap((group) =>
    group.instructions.map((ix) => ({ programAddress: keys[ix.programIdIndex]!, data: base58.encode(ix.data) })),
  );
}

/** The `Closed` event a confirmed close emitted (spec §4.4). */
export async function fetchClosedEvent(rpc: Rpc<SolanaRpcApi>, signature: string): Promise<ClosedEvent | undefined> {
  const instructions = await fetchProgramInstructions(rpc, signature);
  return instructions && findClosedEvent(instructions);
}

/** An instruction as `getTransaction` records it with `json` encoding: account indices and base58 data. */
export interface RecordedInstruction {
  readonly programIdIndex: number;
  readonly accounts: readonly number[];
  readonly data: string;
}

/** The parts of a fetched transaction that token transfers are read from. */
export interface RecordedTransaction {
  /** Every account key, in index order. */
  readonly accountKeys: readonly Address[];
  /** `meta.err`: non-null when the transaction failed. */
  readonly err?: unknown;
  readonly instructions: readonly RecordedInstruction[];
  readonly innerInstructions?: readonly { readonly instructions: readonly RecordedInstruction[] }[];
}

/** Token instructions that change a balance other than by a transfer, which the sum cannot account for. */
const UNSUMMED: ReadonlySet<TokenInstruction> = new Set([
  TokenInstruction.MintTo,
  TokenInstruction.MintToChecked,
  TokenInstruction.Burn,
  TokenInstruction.BurnChecked,
  TokenInstruction.SyncNative,
  TokenInstruction.UnwrapLamports,
  TokenInstruction.Batch,
]);

/**
 * Each token account's change in a transaction, summed from its SPL Token `Transfer` and
 * `TransferChecked` instructions, top-level and inner: minus for the source, plus for the
 * destination. An account that no transfer moved is absent. Throws on a failed transaction, whose
 * recorded instructions moved nothing; on a token instruction it cannot decode; and on one that
 * changes a balance without a transfer.
 */
export function tokenTransferChanges(transaction: RecordedTransaction): Map<Address, bigint> {
  if (transaction.err != null) throw new Error(`The transaction failed (${json(transaction.err)}): it moved no tokens`);
  const base58 = getBase58Encoder();
  const keyAt = (index: number): Address => {
    const key = transaction.accountKeys[index];
    if (key === undefined) throw new Error(`Account index ${index} is outside the transaction's ${transaction.accountKeys.length} keys`);
    return key;
  };
  const changes = new Map<Address, bigint>();
  const add = (account: Address, amount: bigint) => changes.set(account, (changes.get(account) ?? 0n) + amount);
  const recorded = [...transaction.instructions, ...(transaction.innerInstructions ?? []).flatMap((group) => group.instructions)];
  for (const entry of recorded) {
    if (keyAt(entry.programIdIndex) !== TOKEN_PROGRAM_ADDRESS) continue;
    const instruction = {
      programAddress: TOKEN_PROGRAM_ADDRESS,
      accounts: entry.accounts.map((index) => ({ address: keyAt(index), role: AccountRole.READONLY })),
      data: base58.encode(entry.data),
    };
    const type = identifyTokenInstruction(instruction);
    if (type === TokenInstruction.Transfer || type === TokenInstruction.TransferChecked) {
      const parsed = type === TokenInstruction.Transfer ? parseTransferInstruction(instruction) : parseTransferCheckedInstruction(instruction);
      add(parsed.accounts.source.address, -parsed.data.amount);
      add(parsed.accounts.destination.address, parsed.data.amount);
    } else if (UNSUMMED.has(type)) {
      throw new Error(`Token instruction ${TokenInstruction[type]} changes a balance without a transfer`);
    }
  }
  return changes;
}

/**
 * Token balance changes in a confirmed transaction, by token account (spec §12.2). They are summed
 * from the transaction's token transfer instructions, not read from its `preTokenBalances` and
 * `postTokenBalances`: Surfpool truncates `preTokenBalances` to the length of `postTokenBalances`,
 * so a transaction that closes a token account loses one pre balance (T9). A token account that no
 * transfer moved is absent from the map. Throws if the transaction failed.
 */
export async function tokenBalanceChanges(rpc: Rpc<SolanaRpcApi>, signature: string): Promise<Map<Address, bigint>> {
  const transaction = await fetchConfirmed(rpc, signature);
  if (!transaction?.meta) throw new Error(`Transaction ${signature} not found at confirmed`);
  return tokenTransferChanges({
    accountKeys: accountKeysOf(transaction),
    err: transaction.meta.err,
    instructions: transaction.transaction.message.instructions,
    innerInstructions: transaction.meta.innerInstructions ?? [],
  });
}

export type Confirmation = "confirmed" | "expired" | "pending";

/** The transaction landed with an error: its signature status carries `err`. */
export class TransactionFailedError extends Error {
  constructor(
    readonly signature: string,
    readonly err: unknown,
  ) {
    super(`Transaction ${signature} failed: ${json(err)}`);
    this.name = "TransactionFailedError";
  }
}

export interface RetryOptions {
  /** Reads in all, the first included. */
  readonly attempts: number;
  /** Milliseconds between reads. */
  readonly delayMs: number;
}

/**
 * Reads until the result is defined, at most `attempts` times: a node can answer `null` for a
 * transaction or an account just after reporting it `confirmed`. Undefined if every read found
 * nothing. A read that throws ends the retries with its error.
 */
export async function readUntilFound<T>(read: () => Promise<T | null | undefined>, options: RetryOptions): Promise<T | undefined> {
  for (let attempt = 1; ; attempt++) {
    const value = await read();
    if (value != null) return value;
    if (attempt >= options.attempts) return undefined;
    await new Promise((resolve) => setTimeout(resolve, options.delayMs));
  }
}

/**
 * Waits for `confirmed`. Throws `TransactionFailedError` if the transaction failed, and the RPC's
 * error if a read fails. Returns `expired` once its blockhash is no longer valid and one last
 * status read finds nothing (spec §7.1), and `pending` at the timeout.
 */
export async function waitForConfirmation(
  rpc: Rpc<SolanaRpcApi>,
  signature: string,
  blockhash: string,
  timeoutMs = 30_000,
): Promise<Confirmation> {
  const read = async () => {
    const { value } = await rpc.getSignatureStatuses([toSignature(signature)]).send();
    const status = value[0];
    if (status?.err) throw new TransactionFailedError(signature, status.err);
    return status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized";
  };
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await read()) return "confirmed";
    const { value: valid } = await rpc.isBlockhashValid(toBlockhash(blockhash), { commitment: "confirmed" }).send();
    if (!valid) return (await read()) ? "confirmed" : "expired";
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return "pending";
}
