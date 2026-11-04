/**
 * The demo's state, as the server keeps it and the panel draws it, and the constants both use. This module imports
 * nothing: the panel's bundle includes it. Amounts are base-unit decimal strings; times are Unix seconds, except five
 * fields, in milliseconds: `DemoState.now`, each `ExchangeRow.at`, each `LedgerEntry.at`, `DemoWallet.checkedAt` and
 * `DemoState.error.at`.
 */

/** How long a launch buys, and how long a top-up adds. */
export const LAUNCH_SECONDS = 100;
export const TOP_UP_SECONDS = 100;
/** What a launch needs in the wallet, in base units: 100 s at the example seller's 1000 base units a second. */
export const LAUNCH_AMOUNT = "100000";
/** Circle's faucet, which gives devnet USDC for Solana Devnet. */
export const FAUCET_URL = "https://faucet.circle.com/";
/** The panel, as an MCP App resource. */
export const PANEL_URI = "ui://stint-demo/panel.html";

export const TOOL = {
  demo: "stint_demo",
  state: "stint_demo_state",
  launch: "stint_demo_launch",
  topUp: "stint_demo_top_up",
  close: "stint_demo_close",
} as const;
export type ToolName = (typeof TOOL)[keyof typeof TOOL];

export type DemoAction = "launch" | "top-up" | "close";

/**
 * `closed`: the buyer closed it through this server. `expired`: it ended at or after its `paidUntil`, and the seller was
 * paid the whole deposit. `ended`: another party closed it before its end, such as the gate's idle close (`4410`).
 */
export type SessionPhase = "none" | "opening" | "open" | "closing" | "closed" | "expired" | "ended";

/** One line of the x402 exchange between the client and the gate (spec §5). */
export interface ExchangeRow {
  readonly kind: "request" | "payment-required" | "payment" | "settled" | "error";
  /** When it happened, in milliseconds. */
  readonly at: number;
  readonly label: string;
  readonly detail?: string;
  readonly link?: string;
}

/** Explorer pages, on devnet. */
export interface DemoLinks {
  readonly session?: string;
  readonly open?: string;
  readonly topUps: readonly string[];
  readonly close?: string;
  readonly seller?: string;
}

export interface DemoSession {
  readonly state: SessionPhase;
  readonly sessionId?: string;
  readonly startedAt?: number;
  readonly paidUntil?: number;
  /** When it was closed, or ended: the capsule stops there. */
  readonly endedAt?: number;
  readonly deposited?: string;
  readonly rate?: string;
  readonly maxSeconds?: number;
  /** A top-up is refused this close to the end, on the facilitator's clock (spec §5.4). */
  readonly topUpMarginSeconds: number;
  readonly paid?: string;
  readonly refunded?: string;
  /** The stream connection's close code, once it has closed (spec §7.4). */
  readonly closeCode?: number;
  /** Account messages the stream has sent. */
  readonly frames: number;
  readonly links: DemoLinks;
}

/**
 * What moved the agent's USDC: one of the demo's actions, or an end of the session it did not make (`expired`: the paid
 * time ran out and the seller was paid in full; `ended`: the seller closed it before its end, and refunded the rest).
 */
export type LedgerKind = "launch" | "top-up" | "close" | "expired" | "ended";

/**
 * One movement of the agent's USDC. The balance before a launch is the one the launch read from the chain; before
 * anything else, the balance after the session's movement before it. So a session's lines add up, from its launch on.
 */
export interface LedgerEntry {
  readonly kind: LedgerKind;
  readonly sessionId: string;
  /** When it was logged, in milliseconds. */
  readonly at: number;
  /** `out` of the wallet, into the session's escrow, or `in`, refunded from it. */
  readonly direction: "out" | "in";
  /** Absent when a close's answer did not report its refund. */
  readonly amount?: string;
  /** Absent when the launch could not read the balance, or the amount is not known. */
  readonly before?: string;
  readonly after?: string;
  /** The movement's transaction on Explorer, once known. */
  readonly link?: string;
}

export interface DemoWallet {
  readonly address: string;
  /** Its USDC, in base units, as last read; absent until a read succeeds. */
  readonly usdc?: string;
  /** When `usdc` was last read, in milliseconds. */
  readonly checkedAt?: number;
}

export interface DemoState {
  readonly wallet: DemoWallet;
  readonly gateUrl: string;
  readonly faucetUrl: string;
  /** The latest session. */
  readonly session: DemoSession;
  /** The rows of the action under way, and those of the last one that ended. */
  readonly exchange: {
    readonly current: readonly ExchangeRow[];
    readonly last?: { readonly action: DemoAction; readonly rows: readonly ExchangeRow[] };
  };
  /** The movements of the agent's USDC this server made or saw, oldest first: the latest `LEDGER_LIMIT` of them. */
  readonly ledger: readonly LedgerEntry[];
  /** The server's clock, in milliseconds: the panel corrects its own by it. */
  readonly now: number;
  readonly busy?: DemoAction;
  /** Why the last action failed, whoever started it (`at`, in milliseconds). Cleared when the next one starts. */
  readonly error?: { readonly action: DemoAction; readonly message: string; readonly at: number };
}

/**
 * Whether a session is under way: being opened, open, or being closed. The server refuses a second launch while this
 * holds, and the panel offers no launch.
 */
export function isRunning(session: Pick<DemoSession, "state">): boolean {
  return session.state === "opening" || session.state === "open" || session.state === "closing";
}
