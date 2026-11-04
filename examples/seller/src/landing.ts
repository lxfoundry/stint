import type { Terms } from "@lxfoundry/stint-x402";

/** The repository, and the pages of it that the landing page links to. */
export const REPOSITORY_URL = "https://github.com/lxfoundry/stint";
export const LIVE_DEMO_GUIDE_URL = `${REPOSITORY_URL}/blob/main/docs/live-demo.md`;
export const LATEST_RELEASE_URL = `${REPOSITORY_URL}/releases/latest`;
export const SPECIFICATION_URL = `${REPOSITORY_URL}/blob/main/docs/specs/stint-system.md`;

export interface LandingPageInput {
  /** The origin buyers reach the deployment at, such as `https://stint-demo.lxfoundry.ai`. */
  readonly origin: string;
  readonly terms: Terms;
  /** What a request that names no duration is offered. */
  readonly durations: readonly number[];
  readonly idleCloseSeconds: number;
  /** The Stint program's address on devnet. */
  readonly programId: string;
}

const escapeHtml = (text: string): string =>
  text.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);

/** Base units of USDC (6 decimals) as USDC, with at least three decimals: 1000n is "0.001". */
export function usdc(baseUnits: bigint): string {
  const whole = baseUnits / 1_000_000n;
  const fraction = (baseUnits % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "").padEnd(3, "0");
  return `${whole}.${fraction}`;
}

/** The mark: the session's bounds, the time used (solid) and the time left (outline). */
const MARK = `<svg xmlns="http://www.w3.org/2000/svg" width="80" height="26" viewBox="0 0 160 52" aria-hidden="true"><path d="M10 2 H3 V50 H10" fill="none" stroke="currentColor" stroke-width="4"/><path d="M150 2 H157 V50 H150" fill="none" stroke="currentColor" stroke-width="4"/><path d="M38 6 H91 V46 H38 A20 20 0 0 1 38 6 Z" fill="currentColor"/><path d="M99 8 H120 A18 18 0 0 1 120 44 H99 Z" fill="none" stroke="currentColor" stroke-width="4"/></svg>`;

const STYLE = `
:root { --paper: #F4F5F2; --ink: #111318; --accent: #0B6B45; --muted: #5E636C; --rule: #D9DBD6; --code: #E8EAE5; color-scheme: light dark; }
@media (prefers-color-scheme: dark) { :root { --paper: #111318; --ink: #F4F5F2; --accent: #2ED18B; --muted: #A9AEB6; --rule: #2A2D34; --code: #1C1F25; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--paper); color: var(--ink); font: 16px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 760px; margin: 0 auto; padding: 40px 16px 64px; }
header { display: flex; align-items: center; gap: 14px; }
header strong { font-size: 26px; letter-spacing: -0.01em; }
.line { font-size: 22px; margin: 18px 0 8px; }
h2 { font-size: 18px; margin: 36px 0 10px; padding-top: 18px; border-top: 1px solid var(--rule); }
p, li { max-width: 68ch; }
ul, ol { padding-left: 22px; }
li { margin: 6px 0; }
a { color: var(--accent); }
code, pre { font-family: ui-monospace, "JetBrains Mono", Consolas, monospace; font-size: 14px; background: var(--code); border-radius: 4px; }
code { padding: 1px 5px; }
pre { padding: 12px 14px; overflow-x: auto; }
table { border-collapse: collapse; }
td { padding: 4px 18px 4px 0; vertical-align: top; }
td:first-child { color: var(--muted); white-space: nowrap; }
.note, footer { color: var(--muted); font-size: 14px; }
footer { margin-top: 40px; padding-top: 18px; border-top: 1px solid var(--rule); }
.button { display: inline-block; margin: 6px 0; padding: 8px 14px; border: 2px solid var(--accent); border-radius: 6px; font-weight: 600; text-decoration: none; }
`;

/**
 * The deployment's landing page, served at `/`: what it sells, on what terms, how to try it in Claude Desktop, and what
 * Stint provides. Static: no script, and nothing loaded from elsewhere. Every value on it comes from the deployment's
 * own settings.
 */
export function landingPage(input: LandingPageInput): string {
  const origin = escapeHtml(input.origin);
  const { rate, minSeconds, maxSeconds } = input.terms;
  const defaults = input.durations.map((seconds) => `${seconds} s (${usdc(rate * BigInt(seconds))} USDC)`).join(", ");
  const program = escapeHtml(input.programId);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Stint · devnet seller</title>
<meta name="description" content="An example Stint seller on Solana devnet: a live stream of Solana account changes, sold by the second over x402.">
<style>${STYLE}</style>
</head>
<body>
<main>
<header>${MARK}<strong>Stint</strong></header>
<p class="line">Rent time on live connections, and get back what you don't use.</p>
<p>This is an example Stint seller on Solana devnet. It sells a live stream of Solana account changes over WebSocket,
by the second, through x402. An agent pays once to open a session. A Solana program holds the deposit, pays the seller
for the time that elapses, and refunds the rest when the agent closes early.</p>
<p class="note">Devnet only: test USDC, no real money.</p>

<h2>Try it in Claude Desktop</h2>
<ol>
<li>Download <code>stint-claude-demo.mcpb</code> from the <a href="${LATEST_RELEASE_URL}">latest release</a>.</li>
<li>Open it with Claude Desktop to install the extension, and keep the default wallet folder.</li>
<li>In a new chat, ask Claude to start the Stint demo. The panel shows the agent's wallet: get devnet USDC for it at
Circle's faucet, then launch a 100 s session, top it up, or close it early and get the rest back.</li>
</ol>
<p><a class="button" href="${LIVE_DEMO_GUIDE_URL}">The live demo guide, step by step</a></p>
<p class="note">The agent's wallet holds USDC only: this seller's facilitator pays the network fees through Kora.
The agent's spending limits are set in the extension's code, whatever the seller offers or the model asks.</p>

<h2>The offer</h2>
<table>
<tr><td>Price</td><td>${usdc(rate)} USDC a second (${rate} base units of devnet USDC)</td></tr>
<tr><td>Session length</td><td>from ${minSeconds} s to ${maxSeconds} s; ${defaults} when a request names no duration</td></tr>
<tr><td>Early close</td><td>the seller is paid for the time used, at least ${minSeconds} s; the rest is refunded</td></tr>
<tr><td>Nobody connected</td><td>after ${input.idleCloseSeconds} s, the gate closes the session and refunds the rest</td></tr>
<tr><td>Paid time over</td><td>the gate drops the connection with <code>4402</code>, and the seller is paid in full</td></tr>
</table>
<p>See the offer for yourself: the gate answers <code>402 Payment Required</code>, with the <code>elapsed</code> terms in
its <code>PAYMENT-REQUIRED</code> header.</p>
<pre>curl -i -X POST ${origin}/sessions</pre>

<h2>What Stint provides</h2>
<ul>
<li><strong>A Solana program</strong> that holds each session's deposit in a vault of its own and settles it by the
chain's clock: <code>open</code>, <code>top_up</code>, <code>claim</code> and <code>close</code>.</li>
<li><strong><code>elapsed</code>, an x402 scheme for time</strong>: a price per second, the time bought, a minimum and a
maximum. Paying and opening the session are one transaction.</li>
<li><strong>A facilitator</strong> that checks each payment against its offer before anything is signed, settles it
through Kora, keeps a record of each settlement so that a payment sent twice is settled once, and closes expired
sessions.</li>
<li><strong>A gate</strong>, middleware in front of a long-lived connection: it sells sessions, checks each one on
Solana, and ends the connection when the paid time ends.</li>
<li><strong>A client library</strong> whose spending limits are enforced in code, and <strong>an MCP server</strong>
that gives any MCP host the session tools.</li>
<li><strong>Allowance funding</strong>: an owner gives an agent a budget per period with the Solana Foundation's
Subscriptions &amp; Allowances program. Each open and top-up is pulled from it, refunds go back to the owner, and past
the period's cap the program refuses the pull, so no session opens. The agent cannot raise its own budget.</li>
</ul>
<p>Open source under the MIT licence: <a href="${REPOSITORY_URL}">github.com/lxfoundry/stint</a>.</p>

<footer>
<a href="${REPOSITORY_URL}">Source</a> ·
<a href="${SPECIFICATION_URL}">Specification</a> ·
<a href="${LIVE_DEMO_GUIDE_URL}">Live demo guide</a> ·
<a href="https://explorer.solana.com/address/${program}?cluster=devnet">The program on devnet</a>
</footer>
</main>
</body>
</html>
`;
}
