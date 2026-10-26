import {
  SYSTEM_PROGRAM_ADDRESS,
  SystemInstruction,
  getCreateAccountInstructionDataDecoder,
  getTransferSolInstructionDataDecoder,
  identifySystemInstruction,
} from "@solana-program/system";
import { getBase58Encoder, type Address, type ReadonlyUint8Array } from "@solana/kit";
import { refuse, type Check, type FacilitatorKeys, type InspectedTransaction } from "@lxfoundry/stint-x402";

/**
 * An instruction the transaction would execute, top-level or inner: raw, or in the `jsonParsed`
 * form a node uses for the inner instructions of a program it knows.
 */
export type ExecutedInstruction =
  | { readonly programAddress: Address; readonly accounts: readonly Address[]; readonly data: ReadonlyUint8Array }
  | { readonly programAddress: Address; readonly parsed: { readonly type: string; readonly info: Readonly<Record<string, unknown>> } };

/** What the rent payer may fund: only these accounts, and at most `budget` lamports in all. */
export interface Funding {
  readonly destinations: readonly Address[];
  readonly budget: bigint;
}

/** A System Program instruction, as far as the payer check needs it. */
type SystemCall =
  /** `CreateAccount` or `Transfer`: account 0 funds account 1 with `lamports`. */
  | { readonly kind: "fund"; readonly accounts: readonly Address[]; readonly lamports: bigint }
  | { readonly kind: "other"; readonly accounts: readonly Address[] };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Every string anywhere in a parsed instruction's `info`: a superset of the addresses it names. */
function stringsIn(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (isRecord(value)) return Object.values(value).flatMap(stringsIn);
  return [];
}

function lamportsOf(value: unknown): bigint | undefined {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  return undefined;
}

function systemCall(ix: ExecutedInstruction): SystemCall {
  if ("parsed" in ix) {
    const { type, info } = ix.parsed;
    const lamports = lamportsOf(info.lamports);
    const destinationKey = type === "createAccount" ? "newAccount" : type === "transfer" ? "destination" : undefined;
    const destination = destinationKey && info[destinationKey];
    if (destinationKey && lamports !== undefined && typeof info.source === "string" && typeof destination === "string") {
      // The source and destination first, then every other field, so that a payer named again
      // elsewhere (as the new account's owner, say) still counts as appearing out of place.
      const rest = Object.entries(info)
        .filter(([key]) => key !== "source" && key !== destinationKey)
        .flatMap(([, value]) => stringsIn(value));
      return { kind: "fund", accounts: [info.source, destination, ...rest] as Address[], lamports };
    }
    return { kind: "other", accounts: stringsIn(info) as Address[] };
  }
  try {
    switch (identifySystemInstruction(ix.data)) {
      case SystemInstruction.CreateAccount:
        return { kind: "fund", accounts: ix.accounts, lamports: getCreateAccountInstructionDataDecoder().decode(ix.data).lamports };
      case SystemInstruction.TransferSol:
        return { kind: "fund", accounts: ix.accounts, lamports: getTransferSolInstructionDataDecoder().decode(ix.data).amount };
      default:
        return { kind: "other", accounts: ix.accounts };
    }
  } catch {
    return { kind: "other", accounts: ix.accounts }; // data no System instruction has
  }
}

/**
 * Spec §5.4: the fee payer is debited only the fee, and the rent payer funds only the session's
 * accounts. Both are system-owned wallets, so only a System Program instruction they sign can debit
 * them: the fee payer may appear in none, and the rent payer only as the funding source (account 0)
 * of a `CreateAccount` or `Transfer` to an allowed destination, within the budget.
 */
export function checkPayerFunding(
  instructions: readonly ExecutedInstruction[],
  keys: FacilitatorKeys,
  funding: Funding,
): Check<null> {
  let funded = 0n;
  for (const ix of instructions) {
    if (ix.programAddress !== SYSTEM_PROGRAM_ADDRESS) continue;
    const call = systemCall(ix);
    if (call.accounts.includes(keys.feePayer)) return refuse("payer_misuse", "the fee payer would pay more than the fee");
    if (!call.accounts.includes(keys.rentPayer)) continue;
    if (
      call.kind !== "fund" ||
      call.accounts.some((account, index) => account === keys.rentPayer && index !== 0) ||
      !funding.destinations.includes(call.accounts[1]!)
    ) {
      return refuse("payer_misuse", "the rent payer would fund an account other than the session's");
    }
    funded += call.lamports;
  }
  if (funded > funding.budget) return refuse("payer_misuse", "the rent payer would fund more than the session's accounts");
  return { ok: true, value: null };
}

const asIndex = (value: unknown) => (typeof value === "number" || typeof value === "bigint" ? Number(value) : undefined);

/** One inner instruction as a node returns it: `jsonParsed`, partially decoded, or compiled. */
function readInner(ix: unknown, accounts: readonly Address[]): ExecutedInstruction | undefined {
  const unreadable = () =>
    new Error(
      `The node's simulation returned an unreadable inner instruction: ${JSON.stringify(ix, (_, v) => (typeof v === "bigint" ? v.toString() : v))}`,
    );
  if (!isRecord(ix)) throw unreadable();
  const programIndex = asIndex(ix.programIdIndex);
  const programAddress =
    typeof ix.programId === "string" ? (ix.programId as Address) : programIndex !== undefined ? accounts[programIndex] : undefined;
  if (programAddress === undefined) throw unreadable();
  // Only System Program instructions matter to the payer check.
  if (programAddress !== SYSTEM_PROGRAM_ADDRESS) return undefined;
  if ("parsed" in ix) {
    const parsed = ix.parsed;
    if (!isRecord(parsed) || typeof parsed.type !== "string" || !isRecord(parsed.info)) throw unreadable();
    return { programAddress, parsed: { type: parsed.type, info: parsed.info } };
  }
  if (!Array.isArray(ix.accounts) || typeof ix.data !== "string") throw unreadable();
  const named = ix.accounts.map((account) => {
    const index = asIndex(account);
    const resolved = typeof account === "string" ? account : index !== undefined ? accounts[index] : undefined;
    if (resolved === undefined) throw unreadable();
    return resolved as Address;
  });
  return { programAddress, accounts: named, data: getBase58Encoder().encode(ix.data) };
}

/**
 * Every instruction the simulated transaction executes: its own, then the node's inner
 * instructions (spec §5.4). Inner account indices refer to the static keys: there are no lookup
 * tables (spec §3.5).
 */
export function executedInstructions(tx: InspectedTransaction, innerInstructions: unknown): ExecutedInstruction[] {
  if (!Array.isArray(innerInstructions)) throw new Error("The node's simulation returned no inner instructions");
  const own: ExecutedInstruction[] = tx.instructions.map((ix) => ({
    programAddress: ix.programAddress,
    accounts: (ix.accounts ?? []).map((meta) => meta.address),
    data: ix.data ?? new Uint8Array(),
  }));
  const inner = innerInstructions.flatMap((group: unknown) => {
    if (!isRecord(group) || !Array.isArray(group.instructions)) {
      throw new Error("The node's simulation returned an unreadable inner instruction group");
    }
    return group.instructions.flatMap((ix: unknown) => readInner(ix, tx.accounts) ?? []);
  });
  return [...own, ...inner];
}
