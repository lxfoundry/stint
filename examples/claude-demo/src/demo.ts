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
  /** Where a failure that is not an action's goes, one line at a time. Default: stderr. Every line is redacted first. */
  readonly log?: (line: string) => void;
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
/** How often, at most, the stream subscription is sent again while a session runs. */
export const RESUBSCRIBE_EVERY_MS = 15_000;
const REASON = "The Stint demo: watch the agent's own USDC account on the example stream";

type Mutable<T> = { -readonly [Key in keyof T]: T[Key] };
type Links = Mutable<Omit<DemoSession["links"], "topUps">> & { topUps: string[] };
type Session = Mutable<Omit<DemoSession, "links">> & { links: Links };

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
  let session = blank();
  let current: ExchangeRow[] = [];
  let last: { action: DemoAction; rows: ExchangeRow[] } | undefined;
  let busy: DemoAction | undefined;
  let failure: { action: DemoAction; message: string; at: number } | undefined;
  let openOffer: ElapsedRequirements | undefined;
  const settled: Partial<Record<GateAction, string>> = {};
  let lastLookup = -Infinity;
  let lastSubscribe = -Infinity;
  let following: Promise<void> | undefined;
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

  async function refreshBalance(): Promise<void> {
    try {
      wallet = { usdc: (await chain.usdcBalance()).toString(), checkedAt: now() };
      balanceStale = false;
    } catch (error) {
      balanceStale = true;
      say(`reading the wallet's balance failed: ${message(error)}`);
    }
  }

  function snapshot(): DemoState {
    return {
      wallet: { address: options.address, ...wallet },
      gateUrl: options.gateUrl,
      faucetUrl: FAUCET_URL,
      session: { ...session, links: { ...session.links, topUps: [...session.links.topUps] } },
      exchange: { current: [...current], ...(last ? { last: { action: last.action, rows: [...last.rows] } } : {}) },
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
   */
  async function subscribe(force: boolean): Promise<void> {
    const id = session.sessionId;
    if (session.state !== "open" || !id || session.paidUntil === undefined) return;
    if (!force && now() - lastSubscribe < RESUBSCRIBE_EVERY_MS) return;
    if (now() >= (session.paidUntil - 3) * 1000) return;
    lastSubscribe = now();
    try {
      await tools.tools.stint_send.run({ sessionId: id, message: { op: "subscribe", accounts: [chain.usdcAccount] } });
    } catch (error) {
      say(`the stream subscription failed: ${message(error)}`);
    }
  }

  /**
   * Looks the session's close up on the chain (optional: without it, the session's address link lists the close), at
   * most every `CLOSE_LOOKUP_EVERY_MS` unless `force`. The close decides: `expired` at or after its `paid_until`;
   * `ended` before, unless this server closed it. A close found moves the agent's money, so the balance is read again.
   * A lookup that fails is logged, and made again at a later state read.
   */
  async function lookUpClose(force: boolean): Promise<void> {
    const id = session.sessionId;
    if (!id || session.links.close) return;
    if (!force && now() - lastLookup < CLOSE_LOOKUP_EVERY_MS) return;
    lastLookup = now();
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
      return lookUpClose(true);
    }
    if (session.paidUntil !== undefined && now() >= session.paidUntil * 1000) return lookUpClose(false);
    await subscribe(false);
  }

  async function launch(): Promise<void> {
    if (leaving) throw new DemoError("The demo is shutting down: no session can be opened");
    if (isRunning(session)) throw new DemoError("A session is already running: top it up, close it, or let it end");
    await refreshBalance();
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
    await subscribe(true);
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
      if (request.refreshBalance || balanceStale) await refreshBalance();
      following ??= follow()
        .catch((error: unknown) => say(`following the session failed: ${message(error)}`))
        .finally(() => {
          following = undefined;
        });
      await following;
      return snapshot();
    },
    launch: () => run("launch", launch),
    topUp: () => run("top-up", topUp),
    close: () => run("close", close),
    async shutdown() {
      leaving = true;
      const paidFor = session.paidUntil === undefined || now() < session.paidUntil * 1000;
      if (!isRunning(session) || !paidFor) return { closed: [], failed: [] };
      return tools.closeAll();
    },
  };
}
