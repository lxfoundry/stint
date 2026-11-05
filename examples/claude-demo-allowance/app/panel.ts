import { App, applyDocumentTheme, applyHostFonts, applyHostStyleVariables } from "@modelcontextprotocol/ext-apps/app-with-deps";
import {
  FAUCET_URL,
  LAUNCH_AMOUNT,
  TOP_UP_SECONDS,
  isRunning,
  type DemoAction,
  type DemoState,
  type ExchangeRow,
  type LedgerEntry,
} from "../../claude-demo/src/state.js";
import {
  canLaunch,
  capsule,
  closeRefusal,
  formatUsdc,
  headline,
  isStale,
  ledgerLine,
  needsFunding,
  secondsLeft,
  skewOf,
  surfaceOf,
  topUpRefusal,
} from "../../claude-demo/app/model.js";
import { createPoller } from "../../claude-demo/app/poller.js";
import { budgetLine, budgetShare, grantCommand, launchHint, type AllowanceState } from "../src/budget.js";
// This extension's names under the first demo's identifier, so that every call below names this server's tools.
import { ALLOWANCE_TOOL as TOOL } from "../src/names.js";

type ToolAnswer = Awaited<ReturnType<App["callServerTool"]>>;
/** The parts of the host's context the panel uses (optional: the host's theme, colours and fonts). */
type HostContext = Partial<NonNullable<ReturnType<App["getHostContext"]>>>;

/** Empty: a key that a tool does not name is refused by the server. */
type NoArguments = { readonly [key: string]: never };
/** The arguments each tool the panel calls names, and no others. */
interface ToolArguments {
  readonly [TOOL.state]: { readonly refreshBalance?: true };
  readonly [TOOL.launch]: NoArguments;
  readonly [TOOL.topUp]: NoArguments;
  readonly [TOOL.close]: NoArguments;
}
type ActionTool = typeof TOOL.launch | typeof TOOL.topUp | typeof TOOL.close;

const POLL_MS = 2_000;
const BUSY_POLL_MS = 500;
const REDRAW_MS = 250;
const MAX_REASON_LENGTH = 120;

const app = new App({ name: "Stint allowance demo", version: "0.1.0" });
let state: AllowanceState | undefined;
let skew = 0;
let acting: DemoAction | undefined;
let refreshing = false;
/** Why the last action failed, as the tool or the host said it. */
let actionError: string | undefined;
/** Why the last state read failed, while reads keep failing: they are retried. */
let pollFailure: string | undefined;
/** What the last link, copy or chat update did, when the person should know; `url` is shown to be selected. */
let notice: { readonly text: string; readonly url?: string } | undefined;
let rowsKey = "";
let linksKey = "";
let ledgerKey = "";

function element<T extends HTMLElement = HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`The panel has no #${id}`);
  return found as T;
}

/** Writes text through `textContent`, and only when it changed, so that a redraw leaves a selection alone. */
function setText(id: string, text: string): void {
  const target = element(id);
  if (target.textContent !== text) target.textContent = text;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isDemoState(value: unknown): value is AllowanceState {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<Record<keyof AllowanceState, unknown>>;
  return (
    typeof candidate.now === "number" &&
    typeof candidate.wallet === "object" &&
    typeof candidate.session === "object" &&
    typeof candidate.exchange === "object" &&
    typeof candidate.allowance === "object"
  );
}

/**
 * Takes a state the server sent, and corrects the panel's clock by the server's. False when the value is no state. A state
 * stamped before the one drawn came late (a read that overlapped an action): it is a state, and it is not drawn.
 */
function accept(value: unknown): boolean {
  if (!isDemoState(value)) return false;
  if (isStale(state, value)) return true;
  state = value;
  skew = skewOf(value.now, Date.now());
  render();
  return true;
}

/** The host's theme, colours and fonts (optional). */
function applyHost(context: HostContext): void {
  if (context.theme) applyDocumentTheme(context.theme);
  if (context.styles?.variables) applyHostStyleVariables(context.styles.variables);
  if (context.styles?.css?.fonts) applyHostFonts(context.styles.css.fonts);
  markSurface();
}

/** Marks whether the page is on a dark surface, from the colour it is painted: only then is Signal text or fill (see the stylesheet). */
function markSurface(): void {
  const surface = surfaceOf(getComputedStyle(document.body).backgroundColor);
  if (document.documentElement.dataset.surface !== surface) document.documentElement.dataset.surface = surface;
}

function textOf(answer: Pick<ToolAnswer, "content">): string {
  for (const block of answer.content ?? []) if (block.type === "text") return block.text;
  return "The tool failed";
}

/** Shows an error nobody is waiting on, such as one from a button's handler: it is never dropped. */
function fail(error: unknown): void {
  actionError = messageOf(error);
  renderMessages();
}

// Set before `connect`: the host may send the tool's input and result as soon as the panel is connected.
// The tool's input holds nothing the panel draws.
app.ontoolinput = () => {};
app.ontoolresult = (params) => {
  accept(params.structuredContent);
  if (params.isError) fail(textOf(params));
};
app.onhostcontextchanged = (context) => applyHost(context);

async function callTool<Name extends keyof ToolArguments>(name: Name, args: ToolArguments[Name]): Promise<ToolAnswer> {
  const answer = await app.callServerTool({ name, arguments: args });
  accept(answer.structuredContent);
  return answer;
}

/** Reads the state every 2 s, and every 0.5 s while an action runs: rows fill in as the exchange goes. One read at a time. */
const poller = createPoller({
  read: pollOnce,
  nextDelay: () => (acting || state?.busy ? BUSY_POLL_MS : POLL_MS),
  onError: (error) => {
    pollFailure = messageOf(error);
    renderMessages();
  },
});

/** One read. One that fails is shown as a quiet line until one succeeds: the poller tries again. */
async function pollOnce(): Promise<void> {
  try {
    const answer = await callTool(TOOL.state, {});
    pollFailure = answer.isError ? textOf(answer) : isDemoState(answer.structuredContent) ? undefined : "the answer holds no state";
  } catch (error) {
    pollFailure = messageOf(error);
  }
  renderMessages();
}

/** Tells the model what the panel did (optional), so that the chat knows the session's state. */
async function tellModel(): Promise<void> {
  if (!state || !app.getHostCapabilities()?.updateModelContext) return;
  const id = state.session.sessionId;
  const latest = state.ledger.at(-1);
  const text = `Stint allowance demo panel: ${headline(state, Date.now() + skew)}${id ? ` (session ${id})` : ""}.${latest ? ` Owner's USDC log: ${ledgerLine(latest)}` : ""}`;
  try {
    await app.updateModelContext({ content: [{ type: "text", text }] });
  } catch (error) {
    notice = { text: `The chat was not told what the panel did: ${messageOf(error)}` };
    renderMessages();
  }
}

async function act(action: DemoAction, name: ActionTool): Promise<void> {
  if (acting) return;
  acting = action;
  actionError = undefined;
  notice = undefined;
  render();
  poller.schedule(BUSY_POLL_MS);
  try {
    const answer = await callTool(name, {});
    if (answer.isError) actionError = textOf(answer);
    else void tellModel();
  } catch (error) {
    actionError = messageOf(error);
  } finally {
    acting = undefined;
    render();
  }
}

/** Reads the state with the wallet's USDC read again. */
async function refresh(): Promise<void> {
  if (refreshing) return;
  refreshing = true;
  actionError = undefined;
  render();
  try {
    const answer = await callTool(TOOL.state, { refreshBalance: true });
    if (answer.isError) actionError = textOf(answer);
  } catch (error) {
    actionError = messageOf(error);
  } finally {
    refreshing = false;
    render();
  }
}

/** Opens a link through the host, which asks the person first; if it will not, the address is shown to copy. */
async function openLink(url: string): Promise<void> {
  notice = undefined;
  try {
    const answer = await app.openLink({ url });
    if (answer.isError) notice = { text: "The host did not open the link. Open this address yourself:", url };
  } catch (error) {
    notice = { text: `The link did not open (${messageOf(error)}). Open this address yourself:`, url };
  }
  renderMessages();
  if (notice?.url) getSelection()?.selectAllChildren(element("notice-url"));
}

/** Copies the wallet's address (optional); a frame that may not write the clipboard selects it instead. */
async function copyAddress(): Promise<void> {
  if (!state) return;
  try {
    await navigator.clipboard.writeText(state.wallet.address);
    notice = { text: "Address copied" };
  } catch {
    // The frame may not write the clipboard: the address is selected to copy by hand, and the line says so.
    getSelection()?.selectAllChildren(element("address"));
    notice = { text: "The clipboard is not available here. The address is selected: copy it with Ctrl+C or Cmd+C" };
  }
  renderMessages();
}

function show(id: string, visible: boolean, enabled: boolean): void {
  const button = element<HTMLButtonElement>(id);
  button.hidden = !visible;
  button.disabled = !enabled;
}

function linkButton(label: string, url: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "link";
  button.textContent = label;
  button.addEventListener("click", () => void openLink(url).catch(fail));
  return button;
}

/** Rebuilt only when they change, so that a redraw every 250 ms leaves the buttons alone. */
function renderRows(rows: readonly ExchangeRow[]): void {
  element("exchange").hidden = rows.length === 0;
  const key = JSON.stringify(rows);
  if (key === rowsKey) return;
  rowsKey = key;
  element("rows").replaceChildren(
    ...rows.map((row) => {
      const item = document.createElement("li");
      item.dataset.kind = row.kind;
      const label = document.createElement("strong");
      label.textContent = row.label;
      item.append(label);
      if (row.detail) {
        const detail = document.createElement("span");
        detail.className = "mono";
        detail.textContent = row.detail;
        item.append(detail);
      }
      if (row.link) item.append(linkButton("View on Explorer", row.link));
      return item;
    }),
  );
}

/** One line per movement of the wallet's USDC, oldest first, each with its transaction; rebuilt only when it changes. */
function renderLedger(entries: readonly LedgerEntry[]): void {
  element("wallet-log").hidden = entries.length === 0;
  const key = JSON.stringify(entries);
  if (key === ledgerKey) return;
  ledgerKey = key;
  element("ledger").replaceChildren(
    ...entries.map((entry) => {
      const item = document.createElement("li");
      const line = document.createElement("span");
      line.className = "mono";
      line.textContent = ledgerLine(entry);
      item.append(line);
      if (entry.link) item.append(linkButton("Explorer", entry.link));
      return item;
    }),
  );
}

function renderLinks(session: DemoState["session"]): void {
  const { links } = session;
  const entries: [string, string | undefined][] = [
    ["Session account", links.session],
    ["Open transaction", links.open],
    ...links.topUps.map((link, index): [string, string] => [`Top-up ${index + 1}`, link]),
    ["Close transaction", links.close],
    ["Seller", links.seller],
  ];
  const present = entries.filter((entry): entry is [string, string] => entry[1] !== undefined);
  element("explorer").hidden = present.length === 0;
  const key = JSON.stringify(present);
  if (key === linksKey) return;
  linksKey = key;
  element("links").replaceChildren(
    ...present.map(([label, url]) => {
      const item = document.createElement("li");
      item.append(linkButton(label, url));
      return item;
    }),
  );
}

/** What went wrong, or what the person should know: shown whether or not a state has arrived. */
function renderMessages(): void {
  setText("error", actionError ?? state?.error?.message ?? "");
  const reason = pollFailure?.replace(/\s+/g, " ").trim().slice(0, MAX_REASON_LENGTH);
  setText("offline", pollFailure === undefined ? "" : `Can't reach the demo, retrying${reason ? ` (${reason})` : ""}`);
  setText("notice-text", notice?.text ?? "");
  setText("notice-url", notice?.url ?? "");
}

/** Draws the state at the server's time: text through `textContent`, sizes through the CSSOM, nothing else. */
function renderState(current: AllowanceState): void {
  const nowMs = Date.now() + skew;
  const session = current.session;
  const usdc = current.wallet.usdc;
  setText("address", current.wallet.address);
  setText("balance", usdc === undefined ? "checking…" : formatUsdc(usdc));
  const funding = needsFunding(current);
  element("needs").hidden = !funding;
  element("fund").hidden = !funding;
  const allowance = current.allowance;
  setText("agent", allowance.agent);
  setText("budget", budgetLine(allowance));
  element("budget-pulled").style.width = `${(budgetShare(allowance) * 100).toFixed(2)}%`;
  const none = allowance.read?.status === "none";
  element("grant").hidden = !none;
  setText("grant-command", none ? grantCommand(allowance, current.now) : "");
  setText("launch-hint", isRunning(session) ? "" : (launchHint(allowance, BigInt(LAUNCH_AMOUNT)) ?? ""));
  setText("headline", headline(current, nowMs));
  const { used, paid } = capsule(session, nowMs);
  // Nothing is paid for before a session opens: no capsule to draw.
  element("track").hidden = paid === 0;
  element("track").dataset.state = session.state;
  element("paid").style.width = `${(paid * 100).toFixed(2)}%`;
  element("used").style.width = paid > 0 ? `${((used / paid) * 100).toFixed(2)}%` : "0%";
  setText("time-left", session.state === "open" ? `${secondsLeft(session, nowMs)} s left` : "");
  setText("frames", session.sessionId ? `${session.frames} stream ${session.frames === 1 ? "message" : "messages"}` : "");
  const busy = acting ?? current.busy;
  const topUpReason = topUpRefusal(session, nowMs);
  show("launch", !isRunning(session), canLaunch(current) && !busy);
  show("refresh", !isRunning(session), !busy && !refreshing);
  show("top-up", session.state === "open", !busy && !topUpReason);
  show("close", session.state === "open", !busy && !closeRefusal(session, nowMs));
  setText("top-up-reason", session.state === "open" ? (topUpReason ?? "") : "");
  renderLedger(current.ledger);
  renderRows(busy ? current.exchange.current : (current.exchange.last?.rows ?? []));
  renderLinks(session);
}

function render(): void {
  markSurface();
  renderMessages();
  if (state) renderState(state);
}

/** The timer's redraw: a state that cannot be drawn is shown, not left to the console. */
function redraw(): void {
  try {
    render();
  } catch (error) {
    fail(error);
  }
}

async function main(): Promise<void> {
  markSurface();
  setText("headline", "Connecting to the demo…");
  setText("needs", `needs ${formatUsdc(LAUNCH_AMOUNT)}`);
  setText("top-up", `Top up +${TOP_UP_SECONDS} s`);
  element("launch").addEventListener("click", () => void act("launch", TOOL.launch).catch(fail));
  element("top-up").addEventListener("click", () => void act("top-up", TOOL.topUp).catch(fail));
  element("close").addEventListener("click", () => void act("close", TOOL.close).catch(fail));
  element("refresh").addEventListener("click", () => void refresh().catch(fail));
  element("faucet").addEventListener("click", () => void openLink(FAUCET_URL).catch(fail));
  element("copy").addEventListener("click", () => void copyAddress().catch(fail));
  await app.connect();
  applyHost(app.getHostContext() ?? {});
  poller.schedule(0);
  setInterval(redraw, REDRAW_MS);
}

main().catch(fail);
