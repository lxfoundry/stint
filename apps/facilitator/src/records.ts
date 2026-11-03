import { blockhash } from "@solana/kit";
import type { SettleResponse } from "@lxfoundry/stint-x402";
import type { SignedSettlement } from "./settle.js";
import type { FacilitatorContext } from "./verify.js";

/**
 * A settlement record (spec §5.5, "Idempotency"). It starts as the claim of a message's hash, made before anything is
 * verified, so that two identical payloads can never both proceed. It is completed with the transaction signed by every
 * party before that transaction is submitted, and with its outcome once that is known.
 */
export interface SettlementRecord {
  /** SHA-256 of the transaction's message, hex: the record's key. */
  readonly messageHash: string;
  /** SHA-256 of the API key the payload came with, hex. The key itself is never stored. */
  readonly apiKey: string;
  /** The requirements it came with, as `retryRequirementsKey` gives them: without the advisory fields. */
  readonly requirements: string;
  /** Set before the transaction is first submitted. */
  readonly signed?: SignedSettlement;
  /** The final answer: the transaction is confirmed, landed with an error, or can no longer land. Absent while not known. */
  readonly outcome?: SettleResponse;
}

/**
 * Where settlement records live (spec §6.5). Each method is atomic. A store that survives restarts and is shared by the
 * facilitator's instances implements this interface; this repository provides only `createMemoryStore`, whose claims
 * end with the process that made them. A shared store must also release a claim whose instance stopped before it
 * recorded a transaction: the pruner keeps such claims, and another instance answers their payload
 * `settlement_pending` without a transaction until then.
 */
export interface SettlementStore {
  /**
   * Claims `record.messageHash`. Resolves undefined when no claim or record held it, and the store now holds `record`;
   * otherwise resolves to the record that holds it, unchanged.
   */
  claim(record: SettlementRecord): Promise<SettlementRecord | undefined>;
  get(messageHash: string): Promise<SettlementRecord | undefined>;
  /** Replaces the record of `record.messageHash`. */
  put(record: SettlementRecord): Promise<void>;
  /** Removes the claim or the record of `messageHash`. */
  release(messageHash: string): Promise<void>;
  list(): Promise<readonly SettlementRecord[]>;
}

/** Records in this process's memory: lost when it stops, and seen by no other instance (spec §6.5). */
export function createMemoryStore(): SettlementStore {
  const records = new Map<string, SettlementRecord>();
  return {
    async claim(record) {
      const held = records.get(record.messageHash);
      if (held) return held;
      records.set(record.messageHash, record);
      return undefined;
    },
    get: async (messageHash) => records.get(messageHash),
    put: async (record) => void records.set(record.messageHash, record),
    release: async (messageHash) => void records.delete(messageHash),
    list: async () => [...records.values()],
  };
}

/** How long a record outlives the moment its transaction's blockhash was first found no longer valid (spec §5.5). */
export const RECORD_MARGIN_MS = 60_000;
/** How often the facilitator looks for records to drop. */
export const DEFAULT_PRUNE_INTERVAL_MS = 30_000;

export interface RecordPruner {
  /** One pass: resolves to the number of records dropped. A pass already running is joined. */
  pruneOnce(): Promise<number>;
}

/**
 * Drops each record a margin after the node first reported its transaction's blockhash no longer valid, at `confirmed`,
 * the commitment the facilitator verifies at (spec §5.5, "How long"). A payload that comes back after that is verified as
 * new, and refused as `blockhash_expired`, so a landed transaction cannot be presented as a payment again. A claim that
 * holds no transaction yet is being settled, and is kept. When the node's answer cannot be read, the next pass asks again.
 * When each blockhash was first seen expired is kept here, not in the store, so that a pass never writes a record.
 */
export function createRecordPruner(
  ctx: Pick<FacilitatorContext, "rpc">,
  store: SettlementStore,
  options: { readonly marginMs?: number; readonly clock?: () => number } = {},
): RecordPruner {
  const marginMs = options.marginMs ?? RECORD_MARGIN_MS;
  const clock = options.clock ?? Date.now;
  const expiredSince = new Map<string, number>();
  let running: Promise<number> | undefined;

  async function pass(): Promise<number> {
    const records = await store.list();
    const held = new Set(records.map((record) => record.messageHash));
    for (const messageHash of expiredSince.keys()) if (!held.has(messageHash)) expiredSince.delete(messageHash);
    let dropped = 0;
    for (const record of records) {
      const signed = record.signed;
      if (!signed) continue;
      const since = expiredSince.get(record.messageHash);
      if (since === undefined) {
        const lifetime = blockhash(signed.blockhash);
        try {
          const { value: valid } = await ctx.rpc.isBlockhashValid(lifetime, { commitment: "confirmed" }).send();
          if (!valid) expiredSince.set(record.messageHash, clock());
        } catch {
          // Asked again at the next pass.
        }
        continue;
      }
      if (clock() - since < marginMs) continue;
      await store.release(record.messageHash);
      expiredSince.delete(record.messageHash);
      dropped++;
    }
    return dropped;
  }

  return {
    pruneOnce: () => (running ??= pass().finally(() => (running = undefined))),
  };
}
