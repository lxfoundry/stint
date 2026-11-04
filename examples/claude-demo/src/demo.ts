import type { CloseAllOutput, OpenOutput, SessionTools, TopUpOutput } from "@lxfoundry/stint-client";
import { TOP_UP_MARGIN_SECONDS, redactUrls, type ElapsedRequirements } from "@lxfoundry/stint-x402";
import { closeRefusal, formatUsdc, topUpRefusal } from "../app/model.js";
import type { DemoChain, FoundClose } from "./chain.js";
import type { ExchangeSink, GateAction } from "./exchange.js";
import { explorerAddress, explorerTx } from "./links.js";
import {
  FAUCET_URL,
  LAUNCH_AMOUNT,
  LAUNCH_SECONDS,
  TOP_UP_SECONDS,
  isRunning,
  type DemoAction,
  type DemoSession,
  type DemoState,
  type ExchangeRow,
  type LedgerEntry,
} from "./state.js";

export class DemoError extends Error {
  override name = "DemoError";
}

export interface DemoOptions {
  /** The agent's wallet. */
  readonly address: string;
  readonly gateUrl: string;
  readonly tools: SessionTools;
  readonly chain: DemoChain;
  /** Milliseconds. Default `Date.now`. */
  readonly now?: () => number;
  /** Where the demo's lines go, one at a time: each failure, an action's included. Default: stderr. Every line is redacted first. */
  readonly log?: (line: string) => void;
  /** Milliseconds a state read waits for the chain before it answers without it. Default `STATE_READ_CAP_MS`. */
  readonly stateReadCapMs?: number;
}

export interface Demo {
  /** Where the exchange recorder reports. */
  readonly sink: ExchangeSink;
  /** The state, after following the session: frames, the connection's close code, the close on the chain. */
  state(options?: { readonly refreshBalance?: boolean }): Promise<DemoState>;
  launch(): Promise<DemoState>;
  topUp(): Promise<DemoState>;
  close(): Promise<DemoState>;
  /** Closes the session if one runs and is still paid for; nothing opens afterwards. */
  shutdown(): Promise<CloseAllOutput>;
}

/** How often, at most, the chain is asked for a session's close while one is awaited. */
export const CLOSE_LOOKUP_EVERY_MS = 4_000;
/**
 * The longest a state read waits for the chain, the balance read and the close lookup together. A read of the state that
 * a copy forwards to the owner is waited for 15 s, and each request to the node can take 10 s: the owner answers with
 * what it has, and a read still running carries on, its result seen at a later state read.
 */
export const STATE_READ_CAP_MS = 5_000;
/** How often, at most, the stream subscription is sent again while a session runs. */
export const RESUBSCRIBE_EVERY_MS = 15_000;
/** How many of the wallet's movements the state keeps, the latest: a session of the longest the demo buys logs 11. */
export const LEDGER_LIMIT = 20;
const REASON = "The Stint demo: watch the agent's own USDC account on the example stream";

type Mutable<T> = { -readonly [Key in keyof T]: T[Key] };
type Links = Mutable<Omit<DemoSession["links"], "topUps">> & { topUps: string[] };
type Session = Mutable<Omit<DemoSession, "links">> & { links: Links };
/** A movement to log: the balance after is worked out from the one before. */
interface Movement {
  readonly kind: LedgerEntry["kind"];
  readonly sessionId: string;
  readonly direction: LedgerEntry["direction"];
  readonly amount: string | undefined;
  readonly before: string | undefined;
  readonly link: string | undefined;
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));
/**
 * The error to keep in the state and to throw: the same one unless its message quotes a URL, then a `DemoError` with
 * every URL cut to its host. The demo's RPC URL can carry a key, and a failed request quotes it.
 */
function safe(error: unknown): Error {
  const text = redactUrls(message(error));
  return error instanceof Error && error.message === text ? error : new DemoError(text);
}
const isAccountMessage = (value: unknown) => typeof value === "object" && value !== null && (value as { type?: unknown }).type === "account";
const seconds = (ms: number) => Math.floor(ms / 1000);

function toStderr(line: string): void {
  process.stderr.write(`stint-claude-demo: ${line}\n`);
}

/** The owner's state and its actions (the panel's buttons and the model's tools alike), one session at a time. */
export function createDemo(options: DemoOptions): Demo {
  const now = options.now ?? Date.now;
  const { tools, chain } = options;
  const emit = options.log ?? toStderr;
  /** One line, each URL in it cut to its host. A log that fails must not fail what it reports on, and has nowhere left to say so. */
  const say = (line: string): void => {
    try {
      emit(redactUrls(line).replace(/\s+/g, " ").trim());
    } catch {
      // Nothing is left to report to.
    }
  };
  const blank = (): Session => ({ state: "none", topUpMarginSeconds: TOP_UP_MARGIN_SECONDS, frames: 0, links: { topUps: [] } });

  let wallet: { usdc?: string; checkedAt?: number } = {};
  /** Whether the next state read reads the balance: it has not been read yet, or the last read failed. */
  let balanceStale = true;
  /** Reads of the balance started, and the newest one whose answer was kept: an answer older than that one is dropped. */
  let balanceReads = 0;
  let balanceKept = 0;
  /** The balance read that a state read waits for, while it runs: a state read starts none beside it. */
  let balanceReading: Promise<void> | undefined;
  let session = blank();
  let ledger: LedgerEntry[] = [];
  let current: ExchangeRow[] = [];
  let last: { action: DemoAction; rows: ExchangeRow[] } | undefined;
  let busy: DemoAction | undefined;
  let failure: { action: DemoAction; message: string; at: number } | undefined;
  let openOffer: ElapsedRequirements | undefined;
  const settled: Partial<Record<GateAction, string>> = {};
  let lastLookup = -Infinity;
  let lastSubscribe = -Infinity;
  let following: Promise<void> | undefined;
  /** The close lookup in flight, and the session it is for: another for that session is not started while it runs. */
  let lookup: { readonly id: string; readonly done: Promise<void> } | undefined;
  /** The session whose subscription is being sent: at most one in flight for a session, however long it takes. */
  let subscribing: string | undefined;
  let leaving = false;

  const sink: ExchangeSink = {
    row: (row) => void current.push(row),
    offer: (action, entry) => {
      if (action === "open") openOffer = entry;
    },
    settled: (action, transaction) => {
      settled[action] = transaction;
    },
  };

  /**
   * Reads the balance. Reads can overlap (one that a state read gave up on, one an action ends with): the answer of the
   * newest read decides, and an older one that arrives later is dropped.
   */
  async function refreshBalance(): Promise<void> {
    const read = ++balanceReads;
    try {
      const usdc = (await chain.usdcBalance()).toString();
      if (read < balanceKept) return;
      balanceKept = read;
      wallet = { usdc, checkedAt: now() };
      balanceStale = false;
    } catch (error) {
      if (read >= balanceKept) balanceStale = true;
      say(`reading the wallet's balance failed: ${message(error)}`);
    }
  }

  /** The balance read for a state read: the one already running if there is one. It cannot reject. */
  const readBalanceForState = (): Promise<void> =>
    (balanceReading ??= refreshBalance().finally(() => {
      balanceReading = undefined;
    }));

  /** The entry for a movement, stamped now, with no field for what is not known. */
  function entryOf(movement: Movement): LedgerEntry {
    const { kind, sessionId, direction, amount, before, link } = movement;
    const after =
      amount === undefined || before === undefined ? undefined : (direction === "out" ? BigInt(before) - BigInt(amount) : BigInt(before) + BigInt(amount)).toString();
    return {
      kind,
      sessionId,
      at: now(),
      direction,
      ...(amount === undefined ? {} : { amount }),
      ...(before === undefined ? {} : { before }),
      ...(after === undefined ? {} : { after }),
      ...(link === undefined ? {} : { link }),
    };
  }

  /** Logs a movement of the wallet's USDC; past `LEDGER_LIMIT`, the oldest goes. */
  function logMovement(movement: Movement): void {
    ledger.push(entryOf(movement));
    if (ledger.length > LEDGER_LIMIT) ledger = ledger.slice(-LEDGER_LIMIT);
  }

  /** The balance after the session's latest movement: the one its next movement starts from. */
  const balanceAfter = (id: string): string | undefined => ledger.findLast((entry) => entry.sessionId === id)?.after;

  /**
   * Logs how a session that this server did not close ended, once it is `expired` or `ended` with its refund known: the
   * refund is what comes back. An end already logged for the session is replaced, from the same balance and at the same
   * time, as when the chain's figures and the close's link follow the stream's report of an expiry.
   */
  function logEnd(id: string): void {
    const kind = session.state === "expired" || session.state === "ended" ? session.state : undefined;
    if (!kind || session.refunded === undefined) return;
    const index = ledger.findIndex((entry) => entry.sessionId === id && (entry.kind === "expired" || entry.kind === "ended"));
    const logged = index >= 0 ? ledger[index] : undefined;
    const movement: Movement = {
      kind,
      sessionId: id,
      direction: "in",
      amount: session.refunded,
      before: logged ? logged.before : balanceAfter(id),
      link: session.links.close,
    };
    if (logged) ledger[index] = { ...entryOf(movement), at: logged.at };
    else logMovement(movement);
  }

  function snapshot(): DemoState {
    return {
      wallet: { address: options.address, ...wallet },
      gateUrl: options.gateUrl,
      faucetUrl: FAUCET_URL,
      session: { ...session, links: { ...session.links, topUps: [...session.links.topUps] } },
      exchange: { current: [...current], ...(last ? { last: { action: last.action, rows: [...last.rows] } } : {}) },
      ledger: ledger.map((entry) => ({ ...entry })),
      now: now(),
      ...(busy ? { busy } : {}),
      ...(failure ? { error: { ...failure } } : {}),
    };
  }

  /**
   * One action at a time. Its rows, if it had any, become the last exchange: a close, or a top-up refused before it
   * reached the gate, leaves the panel showing the exchange before it. The balance is read again, however it ends.
   * A failure is kept in the state, whoever asked, and thrown with its message redacted.
   */
  async function run(action: DemoAction, work: () => Promise<void>): Promise<DemoState> {
    if (busy) throw new DemoError(`A ${busy} is already under way`);
    busy = action;
    current = [];
    failure = undefined;
    try {
      await work();
    } catch (error) {
      const redacted = safe(error);
      failure = { action, message: redacted.message, at: now() };
      say(`${action} failed: ${redacted.message}`);
      throw redacted;
    } finally {
      if (current.length > 0) last = { action, rows: current };
      current = [];
      busy = undefined;
      await refreshBalance();
    }
    return snapshot();
  }

  /**
   * Sends the stream subscription to the agent's own USDC account: frames arrive when its money moves. Sent again at
   * most every `RESUBSCRIBE_EVERY_MS`, while more than 3 s are paid for: the stream ignores an account a connection
   * already watches, and `stint_send` opens the connection again if it dropped.
   *
   * Its callers do not wait for it: a connection that never opens must not hold a launch, which would keep the person
   * from closing, nor every later state read. It cannot reject (everything that can fail is inside the `try`, and `say`
   * does not throw), and the next one is not sent while this one is still in flight.
   */
  async function subscribe(force: boolean): Promise<void> {
    const id = session.sessionId;
    if (session.state !== "open" || !id || session.paidUntil === undefined || subscribing === id) return;
    if (!force && now() - lastSubscribe < RESUBSCRIBE_EVERY_MS) return;
    if (now() >= (session.paidUntil - 3) * 1000) return;
    lastSubscribe = now();
    subscribing = id;
    try {
      await tools.tools.stint_send.run({ sessionId: id, message: { op: "subscribe", accounts: [chain.usdcAccount] } });
    } catch (error) {
      say(`the stream subscription failed: ${message(error)}`);
    } finally {
      if (subscribing === id) subscribing = undefined;
    }
  }

  /**
   * Looks the session's close up on the chain (optional: without it, the session's address link lists the close), at
   * most every `CLOSE_LOOKUP_EVERY_MS` unless `force`. The close decides: `expired` at or after its `paid_until`;
   * `ended` before, unless this server closed it. A close found moves the agent's money, so the balance is read again.
   * A lookup that fails is logged, and made again at a later state read.
   *
   * One lookup runs at a time for a session: a call made while it runs waits for it instead of starting another. A
   * state read does not wait for it past `STATE_READ_CAP_MS`; the lookup carries on, and its result, applied when it
   * arrives, is seen at the next read.
   */
  function lookUpClose(force: boolean): Promise<void> {
    const id = session.sessionId;
    if (!id || session.links.close) return Promise.resolve();
    if (lookup?.id === id) return lookup.done;
    if (!force && now() - lastLookup < CLOSE_LOOKUP_EVERY_MS) return Promise.resolve();
    lastLookup = now();
    const done: Promise<void> = findAndApplyClose(id).finally(() => {
      if (lookup?.done === done) lookup = undefined;
    });
    lookup = { id, done };
    return done;
  }

  /** The lookup itself: what it finds is applied to the session only if that is still the session it was made for. */
  async function findAndApplyClose(id: string): Promise<void> {
    let found: FoundClose | undefined;
    try {
      found = await chain.findClose(id);
    } catch (error) {
      say(`looking up the close of ${id} failed: ${message(error)}`);
      return;
    }
    if (!found || session.sessionId !== id) return;
    session.links.close = explorerTx(found.signature);
    session.paid = found.paid;
    session.refunded = found.refunded;
    session.endedAt = found.at;
    if (found.at >= found.paidUntil) session.state = "expired";
    else if (session.state !== "closed") session.state = "ended";
    logEnd(id);
    await refreshBalance();
  }

  /** Follows the session at a state read: frames (optional), the connection's close code, then the close on the chain. */
  async function follow(): Promise<void> {
    const id = session.sessionId;
    if (!id) return;
    if (isRunning(session)) {
      try {
        const { messages } = await tools.tools.stint_receive.run({ sessionId: id, max: 100, timeoutSeconds: 0 });
        if (session.sessionId === id) session.frames += messages.filter(isAccountMessage).length;
      } catch (error) {
        // A background read: the frames are optional, so this is logged and the state goes without.
        say(`reading the stream's messages failed: ${message(error)}`);
      }
    }
    if (session.state !== "open") {
      if ((session.state === "expired" || session.state === "ended") && !session.links.close) await lookUpClose(false);
      return;
    }
    const code = tools.closeCode(id);
    if (code !== undefined) session.closeCode = code;
    if (code === 4410) {
      session.state = "ended";
      session.endedAt ??= seconds(now());
      return lookUpClose(true);
    }
    if (code === 4402) {
      session.state = "expired";
      session.endedAt = session.paidUntil;
      session.paid ??= session.deposited;
      session.refunded ??= "0";
      logEnd(id);
      return lookUpClose(true);
    }
    if (session.paidUntil !== undefined && now() >= session.paidUntil * 1000) return lookUpClose(false);
    void subscribe(false);
  }

  const refuseWhenLeaving = (): void => {
    if (leaving) throw new DemoError("The demo is shutting down: no session can be opened");
  };

  async function launch(): Promise<void> {
    refuseWhenLeaving();
    if (isRunning(session)) throw new DemoError("A session is already running: top it up, close it, or let it end");
    await refreshBalance();
    // A shutdown during the balance read found no session to close: nothing may open after it. No await from here to the open.
    refuseWhenLeaving();
    // The balance the wallet's log starts this session from: none if this read failed, rather than an older one.
    const before = balanceStale ? undefined : wallet.usdc;
    if (wallet.usdc !== undefined && BigInt(wallet.usdc) < BigInt(LAUNCH_AMOUNT)) {
      throw new DemoError(
        `The wallet holds ${formatUsdc(wallet.usdc)} and a launch needs ${formatUsdc(LAUNCH_AMOUNT)}: get devnet USDC for ${options.address} at ${FAUCET_URL}`,
      );
    }
    openOffer = undefined;
    delete settled.open;
    lastLookup = -Infinity;
    lastSubscribe = -Infinity;
    session = { ...blank(), state: "opening" };
    let opened: OpenOutput;
    try {
      opened = await tools.tools.stint_open_session.run({ url: options.gateUrl, seconds: LAUNCH_SECONDS, reason: REASON });
    } catch (error) {
      session = blank();
      throw error;
    }
    // Assigned by the recorder while the open ran: the compiler does not see that.
    const offered = openOffer as ElapsedRequirements | undefined;
    const rate = offered ? BigInt(offered.extra.rate) : undefined;
    // A rate of 0 divides by nothing: the session is open and paid for all the same, so it is kept without its terms.
    const priced = rate !== undefined && rate > 0n ? rate : undefined;
    session = {
      ...blank(),
      state: "open",
      sessionId: opened.sessionId,
      paidUntil: opened.paidUntil,
      deposited: opened.cost,
      ...(priced === undefined ? {} : { startedAt: opened.paidUntil - Number(BigInt(opened.cost) / priced), rate: priced.toString() }),
      ...(offered ? { maxSeconds: offered.extra.maxSeconds } : {}),
      links: {
        session: explorerAddress(opened.sessionId),
        open: settled.open === undefined ? undefined : explorerTx(settled.open),
        topUps: [],
        seller: offered ? explorerAddress(offered.payTo) : undefined,
      },
    };
    logMovement({ kind: "launch", sessionId: opened.sessionId, direction: "out", amount: opened.cost, before, link: session.links.open });
    void subscribe(true);
  }

  async function topUp(): Promise<void> {
    const refusal = topUpRefusal(session, now());
    if (refusal) throw new DemoError(refusal);
    const id = session.sessionId!;
    delete settled.topUp;
    let receipt: TopUpOutput;
    try {
      receipt = await tools.tools.stint_top_up.run({ sessionId: id, seconds: TOP_UP_SECONDS });
    } catch (error) {
      // The session may have ended meanwhile, or the gate no longer knows it (a 404): the chain says.
      await lookUpClose(true);
      throw error;
    }
    session.paidUntil = Math.max(session.paidUntil ?? 0, receipt.paidUntil);
    session.deposited = (BigInt(session.deposited ?? "0") + BigInt(receipt.cost)).toString();
    const link = settled.topUp === undefined ? undefined : explorerTx(settled.topUp);
    if (link) session.links.topUps.push(link);
    logMovement({ kind: "top-up", sessionId: id, direction: "out", amount: receipt.cost, before: balanceAfter(id), link });
  }

  async function close(): Promise<void> {
    const refusal = closeRefusal(session, now());
    if (refusal) throw new DemoError(refusal);
    const id = session.sessionId!;
    session.state = "closing";
    try {
      const receipt = await tools.tools.stint_close_session.run({ sessionId: id });
      session.state = "closed";
      session.endedAt = seconds(now());
      if (receipt.paid !== undefined) session.paid = receipt.paid;
      if (receipt.refunded !== undefined) session.refunded = receipt.refunded;
      session.links.close = explorerTx(receipt.transaction);
      logMovement({ kind: "close", sessionId: id, direction: "in", amount: receipt.refunded, before: balanceAfter(id), link: session.links.close });
    } catch (error) {
      if (session.state === "closing") session.state = "open";
      // The session may have ended meanwhile, closed by the gate or another party: the chain says.
      await lookUpClose(true);
      throw error;
    }
  }

  return {
    sink,
    async state(request = {}) {
      // One cap for the whole read. What is still running when it expires carries on and is seen at a later read.
      let timer: NodeJS.Timeout | undefined;
      const expired = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, options.stateReadCapMs ?? STATE_READ_CAP_MS);
      });
      try {
        if (request.refreshBalance || balanceStale) await Promise.race([readBalanceForState(), expired]);
        following ??= follow()
          .catch((error: unknown) => say(`following the session failed: ${message(error)}`))
          .finally(() => {
            following = undefined;
          });
        await Promise.race([following, expired]);
      } finally {
        clearTimeout(timer);
      }
      return snapshot();
    },
    launch: () => run("launch", launch),
    topUp: () => run("top-up", topUp),
    close: () => run("close", close),
    async shutdown() {
      leaving = true;
      const paidFor = session.paidUntil === undefined || now() < session.paidUntil * 1000;
      if (!isRunning(session) || !paidFor) return { closed: [], failed: [] };
      say(session.sessionId ? `closing session ${session.sessionId}` : "closing the session being opened");
      return tools.closeAll();
    },
  };
}
