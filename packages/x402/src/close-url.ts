import { address, type Address, type TransactionSigner } from "@solana/kit";
import { CloseKind, STINT_PROGRAM_ADDRESS, type Session } from "@lxfoundry/stint-program-client";
import { isAddressText, isBlockhashText, isRecord, isU32, isU64String } from "./guards.js";
import { buildCloseTransaction } from "./transactions.js";

/**
 * A session's stored fields (spec §4.1) other than `version` and `bump`, as `GET /close?session=` answers them: `u64`
 * values as decimal strings, `u32` values as numbers, `startedAt` in Unix seconds.
 */
export interface StoredSessionFields {
  readonly address: string;
  readonly authority: string;
  readonly seed: string;
  readonly mint: string;
  readonly receiver: string;
  readonly receiverAuthorizer: string;
  readonly refundOwner: string;
  readonly rentPayer: string;
  readonly rate: string;
  readonly minSeconds: number;
  readonly maxSeconds: number;
  readonly startedAt: number;
  readonly deposited: string;
  readonly claimed: string;
}

/** The body of the facilitator's `GET /close` (spec §6.1): what a client needs to build a close without a node. */
export interface CloseInfo {
  readonly feePayer: string;
  readonly recentBlockhash: string;
  readonly lastValidBlockHeight: string;
  /** Read at `confirmed`: a client without a node learns from it when its own transaction can no longer land (spec §9.3). */
  readonly blockHeight: string;
  readonly programId: string;
  /** With `?session=`. */
  readonly session?: StoredSessionFields;
}

/** The facilitator's answer to `POST /close` (spec §6.1). The amounts are absent when the close's `Closed` event cannot be read. */
export type SponsoredCloseResponse =
  | { readonly success: true; readonly transaction: string; readonly paid?: string; readonly refunded?: string }
  | { readonly success: false; readonly errorReason: string; readonly errorMessage?: string; readonly transaction: string };

export function storedSessionFields(session: Address, stored: Omit<Session, "discriminator" | "version" | "bump">): StoredSessionFields {
  return {
    address: session,
    authority: stored.authority,
    seed: stored.seed.toString(),
    mint: stored.mint,
    receiver: stored.receiver,
    receiverAuthorizer: stored.receiverAuthorizer,
    refundOwner: stored.refundOwner,
    rentPayer: stored.rentPayer,
    rate: stored.rate.toString(),
    minSeconds: stored.minSeconds,
    maxSeconds: stored.maxSeconds,
    startedAt: Number(stored.startedAt),
    deposited: stored.deposited.toString(),
    claimed: stored.claimed.toString(),
  };
}

function isStoredSessionFields(value: unknown): boolean {
  return (
    isRecord(value) &&
    isAddressText(value.address) &&
    isAddressText(value.authority) &&
    isU64String(value.seed) &&
    isAddressText(value.mint) &&
    isAddressText(value.receiver) &&
    isAddressText(value.receiverAuthorizer) &&
    isAddressText(value.refundOwner) &&
    isAddressText(value.rentPayer) &&
    isU64String(value.rate) &&
    isU32(value.minSeconds) &&
    isU32(value.maxSeconds) &&
    Number.isSafeInteger(value.startedAt) &&
    isU64String(value.deposited) &&
    isU64String(value.claimed)
  );
}

/**
 * Returns the value as a `GET /close` body if every field has its encoding. The body comes from a URL in a seller's offer,
 * so it is not trusted to have any shape.
 */
export function readCloseInfo(value: unknown): CloseInfo | undefined {
  if (!isRecord(value)) return undefined;
  const valid =
    isAddressText(value.feePayer) &&
    isBlockhashText(value.recentBlockhash) &&
    isU64String(value.lastValidBlockHeight) &&
    isU64String(value.blockHeight) &&
    isAddressText(value.programId) &&
    (value.session === undefined || isStoredSessionFields(value.session));
  return valid ? (value as unknown as CloseInfo) : undefined;
}

/**
 * A `close` of `expected.session`, signed by `expected.closer`, with the facilitator's fee payer and blockhash. Everything
 * comes from `GET /close?session=`, so the client needs no node (spec §6.1); the fee payer's signature is Kora's to add.
 * The body comes from a URL in a seller's offer, so it must describe the session the client asked about, and name the
 * closer as its authority (spec §5.3: a sponsored close is signed by the session's authority).
 */
export async function buildSponsoredClose(
  info: CloseInfo,
  expected: { readonly session: Address; readonly closer: TransactionSigner; readonly kind?: CloseKind },
): Promise<string> {
  if (info.programId !== STINT_PROGRAM_ADDRESS) throw new Error(`GET /close names another program: ${info.programId}`);
  if (info.feePayer === expected.closer.address) throw new Error("GET /close names the closer as its fee payer");
  const stored = info.session;
  if (!stored) throw new Error("GET /close was read without ?session=: it carries no session to close");
  if (stored.address !== expected.session) throw new Error(`GET /close describes another session: ${stored.address}`);
  if (stored.authority !== expected.closer.address) throw new Error(`the session's authority is ${stored.authority}, not the closer`);
  return buildCloseTransaction({
    session: expected.session,
    stored: {
      mint: address(stored.mint),
      receiver: address(stored.receiver),
      refundOwner: address(stored.refundOwner),
      rentPayer: address(stored.rentPayer),
    },
    closer: expected.closer,
    feePayer: address(info.feePayer),
    lifetime: { blockhash: info.recentBlockhash, lastValidBlockHeight: BigInt(info.lastValidBlockHeight) },
    kind: expected.kind ?? CloseKind.Standard,
  });
}
