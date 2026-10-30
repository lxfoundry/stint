import {
  containsBytes,
  getAddressEncoder,
  getProgramDerivedAddress,
  getU64Encoder,
  type Address,
  type ProgramDerivedAddress,
  type ReadonlyUint8Array,
} from "@solana/kit";
import { CLAIMED_EVENT_DISCRIMINATOR, parseClaimedEvent, type ClaimedEvent } from "./generated/events/claimed.js";
import { CLOSED_EVENT_DISCRIMINATOR, parseClosedEvent, type ClosedEvent } from "./generated/events/closed.js";
import { OPENED_EVENT_DISCRIMINATOR, parseOpenedEvent, type OpenedEvent } from "./generated/events/opened.js";
import { STINT_PROGRAM_ADDRESS } from "./generated/programs/stint.js";

/** The session PDA: `["session", authority, seed]`, the seed as little-endian bytes (spec §4.1). */
export function findSessionPda(authority: Address, seed: bigint): Promise<ProgramDerivedAddress> {
  return getProgramDerivedAddress({
    programAddress: STINT_PROGRAM_ADDRESS,
    seeds: ["session", getAddressEncoder().encode(authority), getU64Encoder().encode(seed)],
  });
}

/** The two accounts `#[event_cpi]` adds to an instruction that emits events (spec §4.4). */
export async function eventAccounts(): Promise<{ eventAuthority: Address; program: Address }> {
  const [eventAuthority] = await getProgramDerivedAddress({
    programAddress: STINT_PROGRAM_ADDRESS,
    seeds: ["__event_authority"],
  });
  return { eventAuthority, program: STINT_PROGRAM_ADDRESS };
}

/** `started_at + floor(deposited / rate)` (spec §4.2). */
export function paidUntil(session: { startedAt: bigint; deposited: bigint; rate: bigint }): bigint {
  return session.startedAt + session.deposited / session.rate;
}

/** An instruction as it appears in a transaction's inner instructions. */
export interface ProgramInstruction {
  readonly programAddress: Address;
  readonly data: ReadonlyUint8Array;
}

/** Anchor's `EVENT_IX_TAG`, `0x1d9acb512ea545e4`, little-endian: it starts every `emit_cpi!`. */
export const EVENT_IX_TAG = new Uint8Array([0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d]);

/** The event payloads (discriminator and fields) that the Stint program emitted. */
export function eventPayloads(instructions: Iterable<ProgramInstruction>): ReadonlyUint8Array[] {
  const payloads: ReadonlyUint8Array[] = [];
  for (const instruction of instructions) {
    if (instruction.programAddress !== STINT_PROGRAM_ADDRESS) continue;
    if (!containsBytes(instruction.data, EVENT_IX_TAG, 0)) continue;
    payloads.push(instruction.data.slice(EVENT_IX_TAG.length));
  }
  return payloads;
}

export function findOpenedEvent(instructions: Iterable<ProgramInstruction>): OpenedEvent | undefined {
  const payload = eventPayloads(instructions).find((data) => containsBytes(data, OPENED_EVENT_DISCRIMINATOR, 0));
  return payload && parseOpenedEvent(payload);
}

export function findClosedEvent(instructions: Iterable<ProgramInstruction>): ClosedEvent | undefined {
  const payload = eventPayloads(instructions).find((data) => containsBytes(data, CLOSED_EVENT_DISCRIMINATOR, 0));
  return payload && parseClosedEvent(payload);
}

export function findClaimedEvent(instructions: Iterable<ProgramInstruction>): ClaimedEvent | undefined {
  const payload = eventPayloads(instructions).find((data) => containsBytes(data, CLAIMED_EVENT_DISCRIMINATOR, 0));
  return payload && parseClaimedEvent(payload);
}

interface Terms {
  readonly startedAt: bigint;
  readonly deposited: bigint;
  readonly rate: bigint;
}

const min = (a: bigint, b: bigint) => (a < b ? a : b);
const max = (a: bigint, b: bigint) => (a > b ? a : b);

/** `max(0, min(now, paid_until) - started_at)`, in seconds (spec §4.2). */
export function elapsedAt(session: Terms, now: bigint): bigint {
  return max(0n, min(now, paidUntil(session)) - session.startedAt);
}

/** `min(deposited, rate × elapsed)`: what `claim` may pay out at `now` (spec §4.2). */
export function earnedAt(session: Terms, now: bigint): bigint {
  return min(session.deposited, session.rate * elapsedAt(session, now));
}

/** `min(deposited, rate × max(min_seconds, elapsed))`: the session's total charge if it closed at `now` (spec §4.2). */
export function dueAt(session: Terms & { readonly minSeconds: number }, now: bigint): bigint {
  return min(session.deposited, session.rate * max(BigInt(session.minSeconds), elapsedAt(session, now)));
}
