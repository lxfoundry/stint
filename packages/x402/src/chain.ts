import {
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

/** Token balance changes recorded in a confirmed transaction, by token account (spec §12.2). */
export async function tokenBalanceChanges(rpc: Rpc<SolanaRpcApi>, signature: string): Promise<Map<Address, bigint>> {
  const transaction = await fetchConfirmed(rpc, signature);
  if (!transaction?.meta) throw new Error(`Transaction ${signature} not found at confirmed`);
  const keys = accountKeysOf(transaction);
  const changes = new Map<Address, bigint>();
  const add = (index: number, amount: bigint) => {
    const key = keys[index]!;
    changes.set(key, (changes.get(key) ?? 0n) + amount);
  };
  for (const balance of transaction.meta.preTokenBalances ?? []) add(balance.accountIndex, -BigInt(balance.uiTokenAmount.amount));
  for (const balance of transaction.meta.postTokenBalances ?? []) add(balance.accountIndex, BigInt(balance.uiTokenAmount.amount));
  return changes;
}

export type Confirmation = "confirmed" | "expired" | "pending";

/**
 * Waits for `confirmed`. Throws if the transaction failed. Returns `expired` once its blockhash is
 * no longer valid and one last status read finds nothing (spec §7.1), and `pending` at the timeout.
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
    if (status?.err) throw new Error(`Transaction ${signature} failed: ${json(status.err)}`);
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
