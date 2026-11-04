import {
  TOKEN_PROGRAM_ADDRESS,
  TokenInstruction,
  identifyTokenInstruction,
  parseTransferCheckedInstruction,
  parseTransferInstruction,
} from "@solana-program/token";
import { AccountRole, getBase58Encoder, type Address, type ReadonlyUint8Array } from "@solana/kit";
import { UNSUMMED_TOKEN_INSTRUCTIONS, type InspectedTransaction } from "@lxfoundry/stint-x402";
import { asIndex, isRecord, stringsIn } from "./payers.js";

/**
 * A token transfer's source, destination and amount; the accounts of a token instruction that changes a balance other
 * than by a transfer (a mint, a burn) or whose kind cannot be told; undefined for any other token instruction.
 */
type Movement =
  | { readonly source: string; readonly destination: string; readonly amount: bigint }
  | { readonly unsummed: readonly string[] }
  | undefined;

/**
 * The names under which a node reports the instructions of `UNSUMMED_TOKEN_INSTRUCTIONS` in its parsed form. It parses
 * only some of them: the others are named here as well, so that one it does parse is refused all the same.
 */
const UNSUMMED_PARSED: ReadonlySet<string> = new Set([
  "mintTo",
  "mintToChecked",
  "burn",
  "burnChecked",
  "syncNative",
  "unwrapLamports",
  "batch",
]);

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
    // What it does is unknown: it may change the vault's balance, so it is treated as an instruction that does.
    return { unsummed: accounts };
  }
  if (type === TokenInstruction.Transfer) {
    const t = parseTransferInstruction(ix);
    return { source: t.accounts.source.address, destination: t.accounts.destination.address, amount: t.data.amount };
  }
  if (type === TokenInstruction.TransferChecked) {
    const t = parseTransferCheckedInstruction(ix);
    return { source: t.accounts.source.address, destination: t.accounts.destination.address, amount: t.data.amount };
  }
  return UNSUMMED_TOKEN_INSTRUCTIONS.has(type) ? { unsummed: accounts } : undefined;
}

function parsedMovement(parsed: unknown): Movement {
  if (!isRecord(parsed) || typeof parsed.type !== "string" || !isRecord(parsed.info)) {
    throw new Error("The node returned an unreadable parsed token instruction");
  }
  const { type, info } = parsed;
  if (type !== "transfer" && type !== "transferChecked") return UNSUMMED_PARSED.has(type) ? { unsummed: stringsIn(info) } : undefined;
  const amount = type === "transfer" ? info.amount : isRecord(info.tokenAmount) ? info.tokenAmount.amount : undefined;
  if (typeof info.source !== "string" || typeof info.destination !== "string" || typeof amount !== "string") {
    throw new Error("The node returned an unreadable token transfer");
  }
  return { source: info.source, destination: info.destination, amount: BigInt(amount) };
}

/**
 * What the simulated transaction would move into `vault` (spec §5.4, §10.2): its SPL Token transfers into the vault, less
 * those out of it, its own and those its programs invoke. A pull from an allowance moves its tokens in an inner
 * instruction, which the static checks cannot see. Inner account indices refer to the static keys: there are no lookup
 * tables (spec §3.5). Throws on an inner instruction it cannot read, as the payer check does, and on a mint, a burn or
 * a token instruction of a kind it cannot identify that names the vault, whose effect a sum of transfers cannot tell.
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
