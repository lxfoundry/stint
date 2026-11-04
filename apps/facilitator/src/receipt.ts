import {
  TOKEN_PROGRAM_ADDRESS,
  TokenInstruction,
  identifyTokenInstruction,
  parseTransferCheckedInstruction,
  parseTransferInstruction,
} from "@solana-program/token";
import { AccountRole, getBase58Encoder, type Address, type ReadonlyUint8Array } from "@solana/kit";
import type { InspectedTransaction } from "@lxfoundry/stint-x402";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const asIndex = (value: unknown) => (typeof value === "number" || typeof value === "bigint" ? Number(value) : undefined);

/**
 * A token transfer's source, destination and amount; the accounts of a token instruction that changes a balance other
 * than by a transfer (a mint, a burn); undefined for any other token instruction.
 */
type Movement =
  | { readonly source: string; readonly destination: string; readonly amount: bigint }
  | { readonly unsummed: readonly string[] }
  | undefined;

/**
 * Token instructions that change a balance other than by a transfer, which a sum of transfers cannot account for: the set
 * that the scheme's `tokenTransferChanges` (`packages/x402/src/chain.ts`) refuses. A node parses only some of them.
 */
const UNSUMMED: ReadonlySet<TokenInstruction> = new Set([
  TokenInstruction.MintTo,
  TokenInstruction.MintToChecked,
  TokenInstruction.Burn,
  TokenInstruction.BurnChecked,
  TokenInstruction.SyncNative,
  TokenInstruction.UnwrapLamports,
  TokenInstruction.Batch,
]);
const UNSUMMED_PARSED: ReadonlySet<string> = new Set(["mintTo", "mintToChecked", "burn", "burnChecked", "syncNative"]);

/** Every string anywhere in a parsed instruction's `info`: a superset of the addresses it names. */
const stringsIn = (value: unknown): string[] =>
  typeof value === "string" ? [value] : Array.isArray(value) ? value.flatMap(stringsIn) : isRecord(value) ? Object.values(value).flatMap(stringsIn) : [];

function compiledMovement(accounts: readonly Address[], data: ReadonlyUint8Array): Movement {
  const ix = {
    programAddress: TOKEN_PROGRAM_ADDRESS,
    accounts: accounts.map((address) => ({ address, role: AccountRole.READONLY })),
    data,
  };
  let type: TokenInstruction;
  try {
    type = identifyTokenInstruction(ix);
  } catch {
    return undefined;
  }
  if (type === TokenInstruction.Transfer) {
    const t = parseTransferInstruction(ix);
    return { source: t.accounts.source.address, destination: t.accounts.destination.address, amount: t.data.amount };
  }
  if (type === TokenInstruction.TransferChecked) {
    const t = parseTransferCheckedInstruction(ix);
    return { source: t.accounts.source.address, destination: t.accounts.destination.address, amount: t.data.amount };
  }
  return UNSUMMED.has(type) ? { unsummed: accounts } : undefined;
}

function parsedMovement(parsed: unknown): Movement {
  if (!isRecord(parsed) || !isRecord(parsed.info)) throw new Error("The node returned an unreadable parsed token instruction");
  const { type, info } = parsed;
  const amount = type === "transfer" ? info.amount : type === "transferChecked" && isRecord(info.tokenAmount) ? info.tokenAmount.amount : undefined;
  if (amount === undefined) return typeof type === "string" && UNSUMMED_PARSED.has(type) ? { unsummed: stringsIn(info) } : undefined;
  if (typeof info.source !== "string" || typeof info.destination !== "string" || typeof amount !== "string") {
    throw new Error("The node returned an unreadable token transfer");
  }
  return { source: info.source, destination: info.destination, amount: BigInt(amount) };
}

/**
 * What the simulated transaction would move into `vault` (spec §5.4, §10.2): its SPL Token transfers into the vault, less
 * those out of it, its own and those its programs invoke. A pull from an allowance moves its tokens in an inner
 * instruction, which the static checks cannot see. Inner account indices refer to the static keys: there are no lookup
 * tables (spec §3.5). Throws on an inner instruction it cannot read, as the payer check does, and on a mint or a burn
 * that names the vault, whose effect a sum of transfers cannot tell.
 */
export function vaultReceipt(tx: InspectedTransaction, innerInstructions: unknown, vault: Address): bigint {
  if (!Array.isArray(innerInstructions)) throw new Error("The node's simulation returned no inner instructions");
  const movements: Movement[] = tx.instructions
    .filter((ix) => ix.programAddress === TOKEN_PROGRAM_ADDRESS)
    .map((ix) => compiledMovement((ix.accounts ?? []).map((meta) => meta.address), ix.data ?? new Uint8Array()));
  for (const group of innerInstructions) {
    if (!isRecord(group) || !Array.isArray(group.instructions)) throw new Error("The node's simulation returned an unreadable inner instruction group");
    for (const ix of group.instructions) {
      if (!isRecord(ix)) throw new Error("The node's simulation returned an unreadable inner instruction");
      const programIndex = asIndex(ix.programIdIndex);
      const program = typeof ix.programId === "string" ? ix.programId : programIndex !== undefined ? tx.accounts[programIndex] : undefined;
      if (program === undefined) throw new Error("The node's simulation returned an inner instruction without its program");
      if (program !== TOKEN_PROGRAM_ADDRESS) continue;
      if ("parsed" in ix) {
        movements.push(parsedMovement(ix.parsed));
        continue;
      }
      if (!Array.isArray(ix.accounts) || typeof ix.data !== "string") throw new Error("The node's simulation returned an unreadable token instruction");
      const accounts = ix.accounts.map((account) => {
        const resolved = typeof account === "string" ? account : tx.accounts[asIndex(account) ?? -1];
        if (resolved === undefined) throw new Error("The node's simulation returned an account index outside the transaction's keys");
        return resolved as Address;
      });
      movements.push(compiledMovement(accounts, getBase58Encoder().encode(ix.data)));
    }
  }
  let received = 0n;
  for (const movement of movements) {
    if (!movement) continue;
    if ("unsummed" in movement) {
      if (movement.unsummed.includes(vault)) throw new Error("a token instruction would change the vault's balance other than by a transfer");
      continue;
    }
    if (movement.destination === vault) received += movement.amount;
    if (movement.source === vault) received -= movement.amount;
  }
  return received;
}
