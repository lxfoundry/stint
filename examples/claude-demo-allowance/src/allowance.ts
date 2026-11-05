import { readAllowance, type AllowanceReport } from "@lxfoundry/stint-client";
import type { Rpc, SolanaRpcApi } from "@solana/kit";
import { formatAmount, formatUsdc } from "../../claude-demo/app/model.js";
import type { Demo } from "../../claude-demo/src/demo.js";
import type { DemoState } from "../../claude-demo/src/state.js";
import { utcTime, type AllowanceRead, type AllowanceState, type AllowanceView } from "./budget.js";

export type AllowanceRef = Parameters<typeof readAllowance>[1];

/** A state read starts a read of the allowance at most this often; an action always reads it again. */
export const ALLOWANCE_READ_EVERY_MS = 5_000;
/** The longest a state read waits for the allowance before it answers with the read before. */
export const ALLOWANCE_READ_WAIT_MS = 2_000;
/** The longest one read of the allowance (three requests to the node) runs. */
export const ALLOWANCE_READ_TIMEOUT_MS = 10_000;

/** Reads the delegation, the owner's balance and the chain's clock, each read given up after `timeoutMs`. */
export function createAllowanceReader(rpc: Rpc<SolanaRpcApi>, ref: AllowanceRef, timeoutMs = ALLOWANCE_READ_TIMEOUT_MS): () => Promise<AllowanceReport> {
  return () => readAllowance(rpc, ref, { abortSignal: AbortSignal.timeout(timeoutMs) });
}

export function toRead(report: AllowanceReport): AllowanceRead {
  const period = report.period;
  if (!period) return { status: "none" };
  return {
    status: period.status,
    perPeriod: period.perPeriod.toString(),
    pulled: period.pulled.toString(),
    left: period.available.toString(),
    periodEnd: Number(period.periodEnd),
    ...(period.expiresAt === 0n ? {} : { expiresAt: Number(period.expiresAt) }),
  };
}

/** A payment or a top-up the gate refused after the facilitator's simulation failed: how the chain refuses a pull (spec §10.3). */
export function isChainRefusal(message: string): boolean {
  return /^The gate refused the (payment|top-up):/.test(message) && message.includes("simulation_failed");
}

const usdc = (amount: bigint) => formatUsdc(amount.toString());

/** Why the allowance, as `report` shows it, cannot fund `amount`; undefined when it can. */
function shortfall(report: AllowanceReport, amount: bigint): string | undefined {
  const period = report.period;
  if (!period) return "this owner has granted the agent no allowance, or has revoked it";
  if (period.status === "expired") return "the allowance has expired";
  if (period.status === "notStarted") return "the allowance has not started yet";
  if (period.available < amount) {
    if (amount > period.perPeriod) return `the payment, ${usdc(amount)}, is larger than the allowance's cap per period, ${usdc(period.perPeriod)}`;
    const pulled = `${formatAmount(period.pulled.toString())} of ${usdc(period.perPeriod)} pulled; the period ends at ${utcTime(Number(period.periodEnd))}`;
    if (period.available > 0n) return `the allowance for this period has ${usdc(period.available)} left, less than the ${usdc(amount)} needed (${pulled})`;
    return `the allowance for this period is used up (${pulled})`;
  }
  if (report.ownerBalance < amount) return `the owner's account holds ${usdc(report.ownerBalance)}, less than the ${usdc(amount)} needed`;
  if (report.delegatedAmount < amount) return "the owner's USDC account no longer lets the allowance program move its tokens";
  return undefined;
}

/** The words for a chain refusal of `amount`, from a read made after it (or none, when that read failed). */
export function refusalWords(report: AllowanceReport | undefined, amount: bigint): string {
  const why = report ? shortfall(report, amount) : undefined;
  return why
    ? `Refused on-chain: ${why}.`
    : "Refused on-chain: the seller's simulation of the payment failed, which an allowance does when it is used up for the period, expired or revoked, or when the owner's balance is too low.";
}

export interface AllowanceDemo extends Demo {
  state(options?: { readonly refreshBalance?: boolean }): Promise<AllowanceState>;
  launch(): Promise<AllowanceState>;
  topUp(): Promise<AllowanceState>;
  close(): Promise<AllowanceState>;
}

export interface WithAllowanceOptions {
  readonly owner: string;
  readonly agent: string;
  readonly nonce: bigint;
  readonly read: () => Promise<AllowanceReport>;
  /** What a launch and a top-up pull, in base units. */
  readonly amounts: { readonly launch: bigint; readonly topUp: bigint };
  /** Milliseconds. Default `Date.now`. */
  readonly now?: () => number;
  readonly log?: (line: string) => void;
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * `demo`, with the allowance in every state it gives, and a refusal by the chain said in words. The inner demo keeps a
 * failure's message in its state: the words replace that message in the states this gives, and the error thrown carries
 * the words, then the message.
 */
export function withAllowance(demo: Demo, options: WithAllowanceOptions): AllowanceDemo {
  const now = options.now ?? Date.now;
  const say = (line: string): void => {
    try {
      options.log?.(line);
    } catch {
      // Nowhere left to say so.
    }
  };
  let latest: { readonly read: AllowanceRead; readonly at: number } | undefined;
  let stale = false;
  let reading: Promise<AllowanceReport | undefined> | undefined;
  let lastStarted = -Infinity;
  /** The last chain refusal: the inner demo's message, and the words that replace it. */
  let refusal: { readonly original: string; readonly words: string } | undefined;

  async function readNow(): Promise<AllowanceReport | undefined> {
    try {
      const report = await options.read();
      latest = { read: toRead(report), at: now() };
      stale = false;
      return report;
    } catch (error) {
      stale = true;
      say(`reading the allowance failed: ${message(error)}`);
      return undefined;
    }
  }

  function refresh(): Promise<AllowanceReport | undefined> {
    if (reading) return reading;
    lastStarted = now();
    const started = readNow().finally(() => {
      if (reading === started) reading = undefined;
    });
    reading = started;
    return started;
  }

  /** A read that starts after any in flight: an action's, so that it sees what the action moved. */
  async function fresh(): Promise<AllowanceReport | undefined> {
    if (reading) await reading;
    return refresh();
  }

  function view(): AllowanceView {
    return { owner: options.owner, agent: options.agent, nonce: options.nonce.toString(), ...(latest ? { read: latest.read, readAt: latest.at } : {}), stale };
  }

  /** Waits for `pending` at most `ALLOWANCE_READ_WAIT_MS`: a read that is slower goes on, and what it finds shows in a later state. */
  async function within(pending: Promise<unknown>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const wait = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ALLOWANCE_READ_WAIT_MS);
      timer.unref?.();
    });
    try {
      await Promise.race([pending, wait]);
    } finally {
      clearTimeout(timer);
    }
  }

  function decorate(state: DemoState): AllowanceState {
    // The inner demo stores a failure before it gives it up: a state read in between holds a refusal that `act` has not
    // seen yet. It is reworded all the same, with the general words until `act` has the read that explains it.
    const reworded =
      state.error && isChainRefusal(state.error.message)
        ? { error: { ...state.error, message: `${refusal && refusal.original === state.error.message ? refusal.words : refusalWords(undefined, 0n)} The gate answered simulation_failed.` } }
        : {};
    return { ...state, ...reworded, allowance: view() };
  }

  async function act(work: () => Promise<DemoState>, amount: bigint): Promise<AllowanceState> {
    let state: DemoState;
    try {
      state = await work();
    } catch (error) {
      const original = message(error);
      if (!isChainRefusal(original)) {
        // The failure waits for no read: the next state carries the allowance as it is by then.
        void refresh();
        throw error;
      }
      // The general words at once, for a state read while the allowance is read again (`decorate` rewords any refusal).
      refusal = { original, words: refusalWords(undefined, amount) };
      const words = refusalWords(await fresh(), amount);
      refusal = { original, words };
      throw new Error(`${words} ${original}`);
    }
    // A slow node does not hold the panel's buttons: the read goes on, and a later state carries what it finds.
    await within(fresh());
    return decorate(state);
  }

  return {
    sink: demo.sink,
    async state(stateOptions) {
      const state = await demo.state(stateOptions);
      const due = stateOptions?.refreshBalance === true || now() - lastStarted >= ALLOWANCE_READ_EVERY_MS;
      const pending = due ? refresh() : reading;
      if (pending) await within(pending);
      return decorate(state);
    },
    launch: () => act(() => demo.launch(), options.amounts.launch),
    topUp: () => act(() => demo.topUp(), options.amounts.topUp),
    close: () => act(() => demo.close(), 0n),
    shutdown: () => demo.shutdown(),
  };
}
