# A Stint session funded by an allowance, in Claude Desktop — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or
> executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for
> tracking.

**Goal:** A second Claude Desktop extension, `examples/claude-demo-allowance` ("Stint allowance demo"), whose session
is funded by an owner's allowance on the Subscriptions & Allowances program: every open and top-up is pulled from the
owner, the panel shows a budget strip read from the chain, and a launch past the cap is refused by the chain and said
in words.

**Architecture:** The new package imports `examples/claude-demo`'s modules unchanged, by relative path: the router,
the wallet, the demo's state machine, the chain reads, the exchange recorder, the call handler, and the panel's model
and poller. Its own code: the settings, a start-up that builds the chain on the **owner's** address and the client with
`allowance` and no `rpc`, a wrapper (`withAllowance`) that adds the allowance to every state and rewords the chain's
refusal, an MCP server with its own tool names mapped onto the call handler's, the panel's page with the strip, and
the package's build.

**Tech Stack:** TypeScript 7.0.2, vitest 5.0.5, tsx 4.23.15, `@solana/kit` 8.5.0, `@modelcontextprotocol/server`
2.4.0, `@modelcontextprotocol/ext-apps` 2.0.4, zod 4.6.7, esbuild 0.28.2, `@anthropic-ai/mcpb` 2.1.2, Node.js 24.22.0,
pnpm 12.14.0.

**Spec:** [`docs/specs/claude-demo-allowance.md`](../specs/claude-demo-allowance.md) (the design), and
`docs/specs/stint-system.md` §10 (allowance funding: §10.3 for the refusal without a node).

## Global Constraints

- Platform: Linux x86-64; on Windows, everything runs inside WSL 2. Run every command from the repository root, inside
  WSL. Scratch files of tests go under the package's `.cache/` (git-ignored), never `/tmp`.
- **Nothing under `examples/claude-demo/` changes**, nor anything in `packages/`, `apps/`, `programs/` or
  `conformance/`. `e2e/` gains the new package as a dependency and one test file. Docs that change: the new package's
  `README.md`, `docs/live-demo-allowance.md`, `docs/plans/README.md` (one paragraph), `docs/specs/stint-system.md` §3.3
  (one line), `README.md` (one sentence). `pnpm-lock.yaml` changes through installs only.
- Imports of `examples/claude-demo` are relative paths into its `src/` and `app/` (`../../claude-demo/src/…`): its
  package exports only `src/index.ts`, which does not export the router, the wallet or the panel's helpers.
- Exact versions, as `examples/claude-demo/package.json` pins them: `@modelcontextprotocol/server` 2.4.0,
  `@modelcontextprotocol/client` 2.4.0, `@modelcontextprotocol/core` 2.4.0, `@modelcontextprotocol/ext-apps` 2.0.4,
  `zod` 4.6.7, `@solana/kit` 8.5.0, `esbuild` 0.28.2, `@anthropic-ai/mcpb` 2.1.2.
- **Settings:** `STINT_DEMO_HOME` (required, absolute), `STINT_DEMO_GATE_URL` (default
  `https://stint-demo.lxfoundry.ai`), `STINT_DEMO_RPC_URL` (default `https://api.devnet.solana.com`),
  `STINT_DEMO_ALLOWANCE_OWNER` (required, an address), `STINT_DEMO_ALLOWANCE_NONCE` (a whole number, default 0). The
  files live in the `stint-demo-allowance` subfolder of `STINT_DEMO_HOME`.
- **The policy** is `examples/claude-demo`'s `DEMO_POLICY`; a launch is 100 s (`LAUNCH_SECONDS`), a top-up 100 s, each
  0.100 USDC (`LAUNCH_AMOUNT`, 100000 base units) at the hosted seller's rate.
- **The session tools get no `rpc`**: a payment the allowance cannot fund is refused by the facilitator's simulation
  (`simulation_failed`), and the extension rewords it. The extension's own node reads serve the strip and the
  rewording.
- **Tool names:** `stint_allowance_demo`, `stint_allowance_demo_state`, `stint_allowance_demo_launch`,
  `stint_allowance_demo_top_up`, `stint_allowance_demo_close`, mapped onto `stint_demo`, `stint_demo_state`,
  `stint_demo_launch`, `stint_demo_top_up`, `stint_demo_close`. The panel's resource is
  `ui://stint-allowance-demo/panel.html`. The server's name is `stint-claude-demo-allowance`.
- **The suggested grant** shown in the panel: 200000 base units (0.200 USDC) every 3600 s, expiring a day after the
  panel's clock, `--keypair "$HOME/.config/stint/allowance-owner.json"`.
- No secrets in any commit. No message or log quotes a key file's contents or an RPC URL's key: node errors pass
  through the client's `createNodeRpc`, and log lines through `redactUrls`.
- Amounts are `bigint` in TypeScript and base-unit decimal strings in the state; times in the allowance view are Unix
  seconds, but `readAt` (milliseconds).
- Commit messages are neutral and technical. Each task ends with the package's typecheck and tests green.

---

## File structure

```
examples/claude-demo-allowance/
  package.json            the package; scripts as examples/claude-demo's
  tsconfig.json           src, test, scripts
  README.md               (Task 7)
  app/
    tsconfig.json         the panel's (DOM)
    panel.html            examples/claude-demo's page, with the owner, the agent and the strip
    panel.ts              examples/claude-demo's panel script, on the new names and state
  mcpb/manifest.json      the extension's manifest
  scripts/
    panel.ts              builds app/panel.html with its script inlined
    build.ts              dist/claude-demo-allowance.cjs
    pack.ts               dist/stint-claude-demo-allowance.mcpb
  src/
    names.ts              the tool names, their mapping, the panel's URI (imports nothing at run time)
    budget.ts             the allowance view's types and its words (pure: the server and the panel use it)
    config.ts             the settings
    allowance.ts          the allowance reader and withAllowance
    server.ts             the MCP server
    main.ts               the start-up: owner side, router, server
    cli.ts, dev.ts        entry points
    index.ts              what the end-to-end test composes
  test/
    config.test.ts, budget.test.ts, allowance.test.ts, server.test.ts, main.test.ts, panel.test.ts, manifest.test.ts
e2e/test/claude-demo-allowance.test.ts
```

---

### Task 1: The package and its settings

**Files:**
- Create: `examples/claude-demo-allowance/package.json`, `tsconfig.json`, `app/tsconfig.json`, `src/config.ts`
- Test: `examples/claude-demo-allowance/test/config.test.ts`

**Interfaces:**
- Consumes: `loadConfig`, `ConfigError`, `DemoConfig` from `examples/claude-demo/src/config.ts`.
- Produces: `ALLOWANCE_DIR = "stint-demo-allowance"`; `interface AllowanceConfig extends DemoConfig { readonly owner:
  Address; readonly nonce: bigint }`; `loadConfig(env: Readonly<Record<string, string | undefined>>): AllowanceConfig`,
  throwing `ConfigError` (re-exported) with every problem.

- [ ] **Step 1: Create the package files**

`examples/claude-demo-allowance/package.json`:

```json
{
  "name": "@lxfoundry/stint-claude-demo-allowance",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "typecheck": "tsc -p tsconfig.json && tsc -p app/tsconfig.json",
    "test": "vitest run",
    "build": "tsx scripts/build.ts",
    "mcpb": "tsx scripts/pack.ts",
    "dev": "tsx src/dev.ts"
  },
  "dependencies": {
    "@lxfoundry/stint-claude-demo": "workspace:*",
    "@lxfoundry/stint-client": "workspace:*",
    "@lxfoundry/stint-x402": "workspace:*",
    "@modelcontextprotocol/client": "2.4.0",
    "@modelcontextprotocol/core": "2.4.0",
    "@modelcontextprotocol/ext-apps": "2.0.4",
    "@modelcontextprotocol/server": "2.4.0",
    "@solana/kit": "8.5.0",
    "zod": "4.6.7"
  },
  "devDependencies": {
    "@anthropic-ai/mcpb": "2.1.2",
    "esbuild": "0.28.2"
  }
}
```

`examples/claude-demo-allowance/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src", "test", "scripts"]
}
```

`examples/claude-demo-allowance/app/tsconfig.json`:

```json
{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": { "lib": ["es2023", "dom"], "types": [] },
  "include": ["."]
}
```

Run: `pnpm install` (the root). Expected: the new package linked, `pnpm-lock.yaml` gains its importer.

- [ ] **Step 2: Write the failing test**

`examples/claude-demo-allowance/test/config.test.ts`:

```ts
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEMO_POLICY } from "../../claude-demo/src/config.js";
import { ALLOWANCE_DIR, ConfigError, loadConfig } from "../src/config.js";

const OWNER = "CciCZMJsih7NY5pet9kc1siPSj7169WSFZoTTQ5dGezx";
const HOME = "/home/someone";
const base = { STINT_DEMO_HOME: HOME, STINT_DEMO_ALLOWANCE_OWNER: OWNER };

const problemsOf = (env: Record<string, string | undefined>): readonly string[] => {
  try {
    loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return error.problems;
    throw error;
  }
  throw new Error("no problem was found");
};

describe("the allowance demo's settings", () => {
  it("keeps its files in its own folder, with the first demo's defaults and policy, and nonce 0", () => {
    const config = loadConfig(base);
    expect(config).toMatchObject({
      home: HOME,
      dir: join(HOME, ALLOWANCE_DIR),
      gateUrl: "https://stint-demo.lxfoundry.ai",
      rpcUrl: "https://api.devnet.solana.com",
      owner: OWNER,
      nonce: 0n,
    });
    expect(ALLOWANCE_DIR).toBe("stint-demo-allowance");
    expect(config.policy).toBe(DEMO_POLICY);
  });

  it("takes a nonce, and treats an empty one as 0", () => {
    expect(loadConfig({ ...base, STINT_DEMO_ALLOWANCE_NONCE: "3" }).nonce).toBe(3n);
    expect(loadConfig({ ...base, STINT_DEMO_ALLOWANCE_NONCE: " " }).nonce).toBe(0n);
    expect(loadConfig({ ...base, STINT_DEMO_ALLOWANCE_NONCE: "18446744073709551615" }).nonce).toBe(18_446_744_073_709_551_615n);
  });

  it("names every problem at once, the first demo's included", () => {
    const problems = problemsOf({ STINT_DEMO_GATE_URL: "ftp://x" });
    expect(problems).toContain("STINT_DEMO_HOME is required: the folder that holds the agent's wallet");
    expect(problems).toContain("STINT_DEMO_ALLOWANCE_OWNER is required: the address of the owner whose allowance funds the sessions");
    expect(problems.some((problem) => problem.startsWith("STINT_DEMO_GATE_URL"))).toBe(true);
  });

  it("refuses an owner that is not an address", () => {
    expect(problemsOf({ ...base, STINT_DEMO_ALLOWANCE_OWNER: "not-an-address" })).toEqual([
      'STINT_DEMO_ALLOWANCE_OWNER must be a Solana address, got "not-an-address"',
    ]);
  });

  it.each(["-1", "1.5", "x", "18446744073709551616"])("refuses the nonce %s", (nonce) => {
    expect(problemsOf({ ...base, STINT_DEMO_ALLOWANCE_NONCE: nonce })).toEqual([
      `STINT_DEMO_ALLOWANCE_NONCE must be a whole number from 0 to 18446744073709551615, got "${nonce}"`,
    ]);
  });
});
```

- [ ] **Step 3: Run it to see it fail**

Run: `pnpm --filter @lxfoundry/stint-claude-demo-allowance test test/config.test.ts`
Expected: FAIL, `Cannot find module '../src/config.js'`.

- [ ] **Step 4: Write `src/config.ts`**

```ts
import { join } from "node:path";
import { isAddress, type Address } from "@solana/kit";
import { ConfigError, loadConfig as loadDemoConfig, type DemoConfig } from "../../claude-demo/src/config.js";

export { ConfigError };

/** The folder inside `STINT_DEMO_HOME` that holds this extension's files: never the first demo's `stint-demo`. */
export const ALLOWANCE_DIR = "stint-demo-allowance";

const U64_MAX = 18_446_744_073_709_551_615n;

export interface AllowanceConfig extends DemoConfig {
  /** `STINT_DEMO_ALLOWANCE_OWNER`: the owner whose allowance funds every open and top-up. */
  readonly owner: Address;
  /** `STINT_DEMO_ALLOWANCE_NONCE`: the delegation's nonce. */
  readonly nonce: bigint;
}

/** The settings (`examples/claude-demo-allowance/README.md`): the first demo's, and the owner and nonce. */
export function loadConfig(env: Readonly<Record<string, string | undefined>>): AllowanceConfig {
  const problems: string[] = [];
  let base: DemoConfig | undefined;
  try {
    base = loadDemoConfig(env);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    problems.push(...error.problems);
  }
  const owner = env.STINT_DEMO_ALLOWANCE_OWNER?.trim() || undefined;
  if (!owner) problems.push("STINT_DEMO_ALLOWANCE_OWNER is required: the address of the owner whose allowance funds the sessions");
  else if (!isAddress(owner)) problems.push(`STINT_DEMO_ALLOWANCE_OWNER must be a Solana address, got "${owner}"`);
  const nonceText = env.STINT_DEMO_ALLOWANCE_NONCE?.trim() || "0";
  const nonce = /^\d+$/.test(nonceText) && BigInt(nonceText) <= U64_MAX ? BigInt(nonceText) : undefined;
  if (nonce === undefined) problems.push(`STINT_DEMO_ALLOWANCE_NONCE must be a whole number from 0 to ${U64_MAX}, got "${nonceText}"`);
  if (problems.length > 0 || !base || !owner || nonce === undefined) throw new ConfigError(problems);
  return { ...base, dir: join(base.home, ALLOWANCE_DIR), owner: owner as Address, nonce };
}
```

- [ ] **Step 5: Run the test and the typecheck**

Run: `pnpm --filter @lxfoundry/stint-claude-demo-allowance test test/config.test.ts && pnpm --filter @lxfoundry/stint-claude-demo-allowance exec tsc -p tsconfig.json`
Expected: PASS (6 tests); the typecheck prints nothing. (`app/tsconfig.json` has no file yet: its typecheck waits for
Task 5.)

- [ ] **Step 6: Commit**

```bash
git add examples/claude-demo-allowance pnpm-lock.yaml
git commit -m "Add the allowance demo package and its settings"
```

---

### Task 2: The tool names, and the allowance view's words

**Files:**
- Create: `examples/claude-demo-allowance/src/names.ts`, `src/budget.ts`
- Test: `examples/claude-demo-allowance/test/budget.test.ts`

**Interfaces:**
- Consumes: `TOOL`, `DemoState` from `examples/claude-demo/src/state.ts`; `formatAmount`, `formatUsdc` from
  `examples/claude-demo/app/model.ts`.
- Produces:
  - `names.ts`: `ALLOWANCE_TOOL` (keys `demo`, `state`, `launch`, `topUp`, `close`), `type AllowanceToolName`,
    `TO_HANDLER: Readonly<Record<AllowanceToolName, string>>`, `PANEL_URI = "ui://stint-allowance-demo/panel.html"`;
  - `budget.ts`: `type AllowanceRead`, `interface AllowanceView`, `type AllowanceState = DemoState & { readonly
    allowance: AllowanceView }`, `SUGGESTED_PER_PERIOD = "200000"`, `SUGGESTED_PERIOD_SECONDS = 3600`,
    `utcTime(unixSeconds: number): string`, `budgetLine(view: AllowanceView): string`, `budgetShare(view:
    AllowanceView): number`, `grantCommand(view: AllowanceView, nowMs: number): string`, `launchHint(view:
    AllowanceView, amount: bigint): string | undefined`.

- [ ] **Step 1: Write the failing test**

`examples/claude-demo-allowance/test/budget.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { TOOL } from "../../claude-demo/src/state.js";
import { budgetLine, budgetShare, grantCommand, launchHint, utcTime, type AllowanceView } from "../src/budget.js";
import { ALLOWANCE_TOOL, PANEL_URI, TO_HANDLER } from "../src/names.js";

const OWNER = "CciCZMJsih7NY5pet9kc1siPSj7169WSFZoTTQ5dGezx";
const AGENT = "Eqc9hpkQBqhtSTPyzo1V9skXio92jkKsZejFcEj58sBj";
/** 2026-11-05T17:15:51Z. */
const END = 1_793_898_951;
const view = (read?: AllowanceView["read"], extra: Partial<AllowanceView> = {}): AllowanceView => ({
  owner: OWNER,
  agent: AGENT,
  nonce: "0",
  ...(read ? { read, readAt: 0 } : {}),
  stale: false,
  ...extra,
});
const active = (pulled: string, left: string): NonNullable<AllowanceView["read"]> => ({
  status: "active",
  perPeriod: "200000",
  pulled,
  left,
  periodEnd: END,
  expiresAt: END + 82_800,
});

describe("the tool names", () => {
  it("are the allowance demo's own, each mapped onto the first demo's handler", () => {
    expect(Object.values(ALLOWANCE_TOOL)).toEqual([
      "stint_allowance_demo",
      "stint_allowance_demo_state",
      "stint_allowance_demo_launch",
      "stint_allowance_demo_top_up",
      "stint_allowance_demo_close",
    ]);
    expect(TO_HANDLER).toEqual({
      [ALLOWANCE_TOOL.demo]: TOOL.demo,
      [ALLOWANCE_TOOL.state]: TOOL.state,
      [ALLOWANCE_TOOL.launch]: TOOL.launch,
      [ALLOWANCE_TOOL.topUp]: TOOL.topUp,
      [ALLOWANCE_TOOL.close]: TOOL.close,
    });
    expect(PANEL_URI).toBe("ui://stint-allowance-demo/panel.html");
  });
});

describe("the allowance's words", () => {
  it("gives a time of day in UTC", () => {
    expect(utcTime(END)).toBe("17:15 UTC");
  });

  it("says what was pulled, what is left and when the period ends", () => {
    expect(budgetLine(view(active("100000", "100000")))).toBe("0.100 of 0.200 USDC pulled this period · 0.100 USDC left · the period ends at 17:15 UTC");
    expect(budgetShare(view(active("100000", "100000")))).toBe(0.5);
    expect(budgetShare(view(active("200000", "0")))).toBe(1);
  });

  it("says when nothing was read yet, when there is no allowance, and when it has ended or not started", () => {
    expect(budgetLine(view())).toBe("Reading the allowance…");
    expect(budgetLine(view({ status: "none" }))).toBe("No allowance from this owner for this agent yet");
    expect(budgetLine(view({ ...active("0", "0"), status: "expired" } as AllowanceView["read"]))).toBe("The allowance has expired");
    expect(budgetLine(view({ ...active("0", "0"), status: "notStarted" } as AllowanceView["read"]))).toBe("The allowance has not started yet");
    expect(budgetShare(view({ status: "none" }))).toBe(0);
  });

  it("marks a read that could not be made again", () => {
    expect(budgetLine(view(active("0", "200000"), { stale: true }))).toBe(
      "0.000 of 0.200 USDC pulled this period · 0.200 USDC left · the period ends at 17:15 UTC (the latest read failed: this is the one before)",
    );
  });

  it("gives the grant command with the agent's address, a day's expiry, and the nonce when it is not 0", () => {
    const now = Date.UTC(2026, 10, 5, 16, 0, 0, 500);
    expect(grantCommand(view({ status: "none" }), now)).toBe(
      `pnpm stint allowance grant --keypair "$HOME/.config/stint/allowance-owner.json" --agent ${AGENT} --per-period 200000 --period 3600 --expires 2026-11-06T16:00:00Z`,
    );
    expect(grantCommand(view({ status: "none" }, { nonce: "2" }), now)).toMatch(/ --nonce 2$/);
  });

  it("warns before a launch the allowance cannot fund, and says nothing otherwise", () => {
    expect(launchHint(view(active("200000", "0")), 100_000n)).toBe("0.000 USDC left this period: a launch will be refused on-chain");
    expect(launchHint(view({ status: "none" }), 100_000n)).toBe("No allowance yet: a launch will be refused on-chain");
    expect(launchHint(view({ ...active("0", "0"), status: "expired" } as AllowanceView["read"]), 100_000n)).toBe(
      "The allowance has expired: a launch will be refused on-chain",
    );
    expect(launchHint(view(active("100000", "100000")), 100_000n)).toBeUndefined();
    expect(launchHint(view(), 100_000n)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm --filter @lxfoundry/stint-claude-demo-allowance test test/budget.test.ts`
Expected: FAIL, `Cannot find module '../src/budget.js'`.

- [ ] **Step 3: Write `src/names.ts`**

```ts
import { TOOL } from "../../claude-demo/src/state.js";

/** The tools this server offers. The panel calls them by these names; the call handler knows the first demo's. */
export const ALLOWANCE_TOOL = {
  demo: "stint_allowance_demo",
  state: "stint_allowance_demo_state",
  launch: "stint_allowance_demo_launch",
  topUp: "stint_allowance_demo_top_up",
  close: "stint_allowance_demo_close",
} as const;

export type AllowanceToolName = (typeof ALLOWANCE_TOOL)[keyof typeof ALLOWANCE_TOOL];

/** Each of this server's tools, and the call handler's tool it runs: so both extensions can be installed at once. */
export const TO_HANDLER: Readonly<Record<AllowanceToolName, string>> = {
  [ALLOWANCE_TOOL.demo]: TOOL.demo,
  [ALLOWANCE_TOOL.state]: TOOL.state,
  [ALLOWANCE_TOOL.launch]: TOOL.launch,
  [ALLOWANCE_TOOL.topUp]: TOOL.topUp,
  [ALLOWANCE_TOOL.close]: TOOL.close,
};

/** The panel, as an MCP App resource: not the first demo's URI. */
export const PANEL_URI = "ui://stint-allowance-demo/panel.html";
```

- [ ] **Step 4: Write `src/budget.ts`**

```ts
/**
 * The allowance as the state carries it, and the words the panel and the server use for it. Pure: the panel's bundle
 * includes it.
 */
import { formatAmount, formatUsdc } from "../../claude-demo/app/model.js";
import type { DemoState } from "../../claude-demo/src/state.js";

/** What the chain said at a read: base-unit strings, Unix seconds. */
export type AllowanceRead =
  | { readonly status: "none" }
  | {
      readonly status: "active" | "expired" | "notStarted";
      readonly perPeriod: string;
      readonly pulled: string;
      readonly left: string;
      /** The next period's start, or the expiry if that comes first. */
      readonly periodEnd: number;
      /** Absent for a delegation that never expires. */
      readonly expiresAt?: number;
    };

export interface AllowanceView {
  readonly owner: string;
  readonly agent: string;
  readonly nonce: string;
  /** The latest read that succeeded; absent until one has. */
  readonly read?: AllowanceRead;
  /** When `read` was made, in milliseconds. */
  readonly readAt?: number;
  /** The latest read failed: `read` is the one before. */
  readonly stale: boolean;
}

export type AllowanceState = DemoState & { readonly allowance: AllowanceView };

/** What the panel suggests granting: two payments of 0.100 USDC an hour, for one day. */
export const SUGGESTED_PER_PERIOD = "200000";
export const SUGGESTED_PERIOD_SECONDS = 3_600;
const DAY_MS = 86_400_000;

/** `17:15 UTC`. */
export function utcTime(unixSeconds: number): string {
  return `${new Date(unixSeconds * 1000).toISOString().slice(11, 16)} UTC`;
}

export function budgetLine(view: AllowanceView): string {
  const read = view.read;
  if (!read) return "Reading the allowance…";
  const stale = view.stale ? " (the latest read failed: this is the one before)" : "";
  switch (read.status) {
    case "none":
      return `No allowance from this owner for this agent yet${stale}`;
    case "expired":
      return `The allowance has expired${stale}`;
    case "notStarted":
      return `The allowance has not started yet${stale}`;
    case "active":
      return `${formatAmount(read.pulled)} of ${formatUsdc(read.perPeriod)} pulled this period · ${formatUsdc(read.left)} left · the period ends at ${utcTime(read.periodEnd)}${stale}`;
  }
}

/** The share of the period's cap already pulled, from 0 to 1. */
export function budgetShare(view: AllowanceView): number {
  const read = view.read;
  if (!read || read.status === "none" || BigInt(read.perPeriod) === 0n) return 0;
  return Math.min(1, Number(BigInt(read.pulled) * 10_000n / BigInt(read.perPeriod)) / 10_000);
}

/** The command the owner runs, from the repository, to grant this agent the suggested allowance. */
export function grantCommand(view: AllowanceView, nowMs: number): string {
  const expires = new Date(nowMs + DAY_MS).toISOString().replace(/\.\d{3}Z$/, "Z");
  const nonce = view.nonce === "0" ? "" : ` --nonce ${view.nonce}`;
  return `pnpm stint allowance grant --keypair "$HOME/.config/stint/allowance-owner.json" --agent ${view.agent} --per-period ${SUGGESTED_PER_PERIOD} --period ${SUGGESTED_PERIOD_SECONDS} --expires ${expires}${nonce}`;
}

/** Said before a launch the allowance, as last read, cannot fund: the launch is still offered, and the chain refuses it. */
export function launchHint(view: AllowanceView, amount: bigint): string | undefined {
  const read = view.read;
  if (!read) return undefined;
  const refused = "a launch will be refused on-chain";
  if (read.status === "none") return `No allowance yet: ${refused}`;
  if (read.status === "expired") return `The allowance has expired: ${refused}`;
  if (read.status === "notStarted") return `The allowance has not started yet: ${refused}`;
  return BigInt(read.left) < amount ? `${formatUsdc(read.left)} left this period: ${refused}` : undefined;
}
```

- [ ] **Step 5: Run the test**

Run: `pnpm --filter @lxfoundry/stint-claude-demo-allowance test test/budget.test.ts`
Expected: PASS (7 tests). If `formatAmount("100000")` does not give `0.100` (check
`examples/claude-demo/app/model.ts:8`), fix the expectations to what it gives, not the function.

- [ ] **Step 6: Commit**

```bash
git add examples/claude-demo-allowance/src/names.ts examples/claude-demo-allowance/src/budget.ts examples/claude-demo-allowance/test/budget.test.ts
git commit -m "Name the allowance demo's tools and word its allowance view"
```

---

### Task 3: `withAllowance`: the allowance in every state, and the chain's refusal in words

**Files:**
- Create: `examples/claude-demo-allowance/src/allowance.ts`
- Test: `examples/claude-demo-allowance/test/allowance.test.ts`

**Interfaces:**
- Consumes: `Demo` from `examples/claude-demo/src/demo.ts`; `DemoState` from `examples/claude-demo/src/state.ts`;
  `readAllowance`, `AllowanceReport` from `@lxfoundry/stint-client`; `formatAmount`, `formatUsdc` from
  `examples/claude-demo/app/model.ts`; `AllowanceRead`, `AllowanceState`, `AllowanceView`, `utcTime` from Task 2.
- Produces:
  - `type AllowanceRef = Parameters<typeof readAllowance>[1]`;
  - `createAllowanceReader(rpc: Rpc<SolanaRpcApi>, ref: AllowanceRef, timeoutMs?: number): () => Promise<AllowanceReport>`;
  - `toRead(report: AllowanceReport): AllowanceRead`;
  - `isChainRefusal(message: string): boolean`;
  - `refusalWords(report: AllowanceReport | undefined, amount: bigint): string`;
  - `interface AllowanceDemo extends Demo` (its `state`, `launch`, `topUp`, `close` resolve to `AllowanceState`);
  - `interface WithAllowanceOptions { owner; agent; nonce: bigint; read: () => Promise<AllowanceReport>; amounts: {
    launch: bigint; topUp: bigint }; now?: () => number; log?: (line: string) => void }`;
  - `withAllowance(demo: Demo, options: WithAllowanceOptions): AllowanceDemo`;
  - `ALLOWANCE_READ_EVERY_MS = 5_000`, `ALLOWANCE_READ_WAIT_MS = 2_000`, `ALLOWANCE_READ_TIMEOUT_MS = 10_000`.

- [ ] **Step 1: Write the failing test**

`examples/claude-demo-allowance/test/allowance.test.ts`:

```ts
import type { AllowanceReport } from "@lxfoundry/stint-client";
import type { Address } from "@solana/kit";
import { describe, expect, it } from "vitest";
import type { Demo } from "../../claude-demo/src/demo.js";
import type { DemoState } from "../../claude-demo/src/state.js";
import { ALLOWANCE_READ_EVERY_MS, isChainRefusal, refusalWords, withAllowance } from "../src/allowance.js";

const OWNER = "CciCZMJsih7NY5pet9kc1siPSj7169WSFZoTTQ5dGezx" as Address;
const AGENT = "Eqc9hpkQBqhtSTPyzo1V9skXio92jkKsZejFcEj58sBj" as Address;
const DELEGATION = "55HZmMwLy4icQoTtnUjoApY7HNKLGmDKpXcE6a7CdHb4" as Address;
/** 2026-11-05T17:15:51Z. */
const END = 1_793_898_951;
const REFUSED =
  'The gate refused the payment: {"x402Version":2,"error":"simulation_failed"} (with an allowance, this is how a payment it cannot fund is refused: used up for the period, expired or revoked, or the owner\'s balance too low)';
const REFUSED_TOP_UP = 'The gate refused the top-up: {"x402Version":2,"error":"simulation_failed"}';

type Period = NonNullable<AllowanceReport["period"]>;
function report(period?: Partial<Period>, rest: Partial<AllowanceReport> = {}): AllowanceReport {
  return {
    owner: OWNER,
    delegation: DELEGATION,
    ...(period === undefined
      ? {}
      : {
          period: {
            perPeriod: 200_000n,
            pulled: 0n,
            available: 200_000n,
            periodStart: BigInt(END - 3_600),
            periodEnd: BigInt(END),
            expiresAt: BigInt(END + 82_800),
            status: "active" as const,
            ...period,
          },
        }),
    ownerBalance: 19_896_000n,
    delegatedAmount: 18_446_744_073_709_551_615n,
    ...rest,
  };
}

function baseState(error?: DemoState["error"]): DemoState {
  return {
    wallet: { address: OWNER, usdc: "19896000", checkedAt: 0 },
    gateUrl: "https://gate.example",
    faucetUrl: "https://faucet.circle.com/",
    session: { state: "none", topUpMarginSeconds: 10, frames: 0, links: { topUps: [] } },
    exchange: { current: [] },
    ledger: [],
    now: 0,
    ...(error ? { error } : {}),
  };
}

/** A demo whose launch and top-up fail with `message`, keeping it in its state as `createDemo` does. */
function failingDemo(message: string): Demo {
  let error: DemoState["error"];
  const fail = (action: "launch" | "top-up") => async (): Promise<DemoState> => {
    error = { action, message, at: 1 };
    throw new Error(message);
  };
  return {
    sink: {} as Demo["sink"],
    state: async () => baseState(error),
    launch: fail("launch"),
    topUp: fail("top-up"),
    close: async () => baseState(error),
    shutdown: async () => ({ closed: [], failed: [] }),
  };
}

const amounts = { launch: 100_000n, topUp: 100_000n };

describe("the chain's refusal", () => {
  it("is a payment or a top-up the gate refused after the facilitator's simulation failed", () => {
    expect(isChainRefusal(REFUSED)).toBe(true);
    expect(isChainRefusal(REFUSED_TOP_UP)).toBe(true);
    expect(isChainRefusal('The gate refused the payment: {"error":"invalid_payload"}')).toBe(false);
    expect(isChainRefusal("A session is already running: top it up, close it, or let it end")).toBe(false);
  });

  it("is said from a read of the allowance made after it", () => {
    expect(refusalWords(report({ pulled: 200_000n, available: 0n }), 100_000n)).toBe(
      "Refused on-chain: the allowance for this period is used up (0.200 of 0.200 USDC pulled; the period ends at 17:15 UTC).",
    );
    expect(refusalWords(report({ perPeriod: 50_000n, available: 50_000n }), 100_000n)).toBe(
      "Refused on-chain: the payment, 0.100 USDC, is larger than the allowance's cap per period, 0.050 USDC.",
    );
    expect(refusalWords(report(), 100_000n)).toBe("Refused on-chain: this owner has granted the agent no allowance, or has revoked it.");
    expect(refusalWords(report({ status: "expired", available: 0n }), 100_000n)).toBe("Refused on-chain: the allowance has expired.");
    expect(refusalWords(report({ status: "notStarted", available: 0n }), 100_000n)).toBe("Refused on-chain: the allowance has not started yet.");
    expect(refusalWords(report({}, { ownerBalance: 50_000n }), 100_000n)).toBe(
      "Refused on-chain: the owner's account holds 0.050 USDC, less than the 0.100 USDC needed.",
    );
    expect(refusalWords(report({}, { delegatedAmount: 0n }), 100_000n)).toBe(
      "Refused on-chain: the owner's USDC account no longer lets the allowance program move its tokens.",
    );
  });

  it("names the general reasons when the read explains nothing, or failed", () => {
    const general =
      "Refused on-chain: the seller's simulation of the payment failed, which an allowance does when it is used up for the period, expired or revoked, or when the owner's balance is too low.";
    expect(refusalWords(report({}), 100_000n)).toBe(general);
    expect(refusalWords(undefined, 100_000n)).toBe(general);
  });
});

describe("withAllowance", () => {
  it("adds the allowance, read from the chain, to every state", async () => {
    const demo = withAllowance(failingDemo(REFUSED), { owner: OWNER, agent: AGENT, nonce: 0n, read: async () => report({ pulled: 100_000n, available: 100_000n }), amounts, now: () => 5 });
    const state = await demo.state();
    expect(state.wallet.address).toBe(OWNER);
    expect(state.allowance).toEqual({
      owner: OWNER,
      agent: AGENT,
      nonce: "0",
      read: { status: "active", perPeriod: "200000", pulled: "100000", left: "100000", periodEnd: END, expiresAt: END + 82_800 },
      readAt: 5,
      stale: false,
    });
  });

  it("says none when the owner granted nothing", async () => {
    const demo = withAllowance(failingDemo(REFUSED), { owner: OWNER, agent: AGENT, nonce: 0n, read: async () => report(), amounts });
    expect((await demo.state()).allowance.read).toEqual({ status: "none" });
  });

  it("keeps the last read, marked stale, when a read fails, and logs it", async () => {
    let clock = 0;
    let fails = false;
    const lines: string[] = [];
    const demo = withAllowance(failingDemo(REFUSED), {
      owner: OWNER,
      agent: AGENT,
      nonce: 0n,
      read: async () => {
        if (fails) throw new Error("node down");
        return report({});
      },
      amounts,
      now: () => clock,
      log: (line) => lines.push(line),
    });
    await demo.state();
    fails = true;
    clock = ALLOWANCE_READ_EVERY_MS;
    const state = await demo.state();
    expect(state.allowance).toMatchObject({ read: { status: "active" }, readAt: 0, stale: true });
    expect(lines).toEqual(["reading the allowance failed: node down"]);
  });

  it("reads at most every 5 s on state reads", async () => {
    let clock = 0;
    let reads = 0;
    const demo = withAllowance(failingDemo(REFUSED), {
      owner: OWNER,
      agent: AGENT,
      nonce: 0n,
      read: async () => {
        reads++;
        return report({});
      },
      amounts,
      now: () => clock,
    });
    await demo.state();
    clock = ALLOWANCE_READ_EVERY_MS - 1;
    await demo.state();
    expect(reads).toBe(1);
    clock = ALLOWANCE_READ_EVERY_MS;
    await demo.state();
    expect(reads).toBe(2);
  });

  it("rewords a launch the chain refused, in the error it throws and in the states after it", async () => {
    const demo = withAllowance(failingDemo(REFUSED), { owner: OWNER, agent: AGENT, nonce: 0n, read: async () => report({ pulled: 200_000n, available: 0n }), amounts });
    const words = "Refused on-chain: the allowance for this period is used up (0.200 of 0.200 USDC pulled; the period ends at 17:15 UTC).";
    await expect(demo.launch()).rejects.toThrow(`${words} ${REFUSED}`);
    const state = await demo.state();
    expect(state.error).toEqual({ action: "launch", message: `${words} The gate answered simulation_failed.`, at: 1 });
  });

  it("rewords a top-up the chain refused", async () => {
    const demo = withAllowance(failingDemo(REFUSED_TOP_UP), { owner: OWNER, agent: AGENT, nonce: 0n, read: async () => report({ pulled: 200_000n, available: 0n }), amounts });
    await expect(demo.topUp()).rejects.toThrow(/^Refused on-chain: the allowance for this period is used up/);
  });

  it("passes any other failure on as it is", async () => {
    const message = "A session is already running: top it up, close it, or let it end";
    const demo = withAllowance(failingDemo(message), { owner: OWNER, agent: AGENT, nonce: 0n, read: async () => report({}), amounts });
    await expect(demo.launch()).rejects.toThrow(message);
    expect((await demo.state()).error?.message).toBe(message);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm --filter @lxfoundry/stint-claude-demo-allowance test test/allowance.test.ts`
Expected: FAIL, `Cannot find module '../src/allowance.js'`.

- [ ] **Step 3: Write `src/allowance.ts`**

```ts
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
    return `the allowance for this period is used up (${formatAmount(period.pulled.toString())} of ${usdc(period.perPeriod)} pulled; the period ends at ${utcTime(Number(period.periodEnd))})`;
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
  const say = options.log ?? (() => {});
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
      stale = latest !== undefined;
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

  function decorate(state: DemoState): AllowanceState {
    const reworded =
      state.error && refusal && state.error.message === refusal.original
        ? { error: { ...state.error, message: `${refusal.words} The gate answered simulation_failed.` } }
        : {};
    return { ...state, ...reworded, allowance: view() };
  }

  async function act(work: () => Promise<DemoState>, amount: bigint): Promise<AllowanceState> {
    let state: DemoState;
    try {
      state = await work();
    } catch (error) {
      const original = message(error);
      const report = await fresh();
      if (!isChainRefusal(original)) throw error;
      const words = refusalWords(report, amount);
      refusal = { original, words };
      throw new Error(`${words} ${original}`);
    }
    await fresh();
    return decorate(state);
  }

  return {
    sink: demo.sink,
    async state(stateOptions) {
      const state = await demo.state(stateOptions);
      const due = stateOptions?.refreshBalance === true || now() - lastStarted >= ALLOWANCE_READ_EVERY_MS;
      const pending = due ? refresh() : reading;
      if (pending) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const wait = new Promise<void>((resolve) => {
          timer = setTimeout(resolve, ALLOWANCE_READ_WAIT_MS);
          timer.unref?.();
        });
        await Promise.race([pending, wait]);
        clearTimeout(timer);
      }
      return decorate(state);
    },
    launch: () => act(() => demo.launch(), options.amounts.launch),
    topUp: () => act(() => demo.topUp(), options.amounts.topUp),
    close: () => act(() => demo.close(), 0n),
    shutdown: () => demo.shutdown(),
  };
}
```

- [ ] **Step 4: Run the test and the typecheck**

Run: `pnpm --filter @lxfoundry/stint-claude-demo-allowance test test/allowance.test.ts && pnpm --filter @lxfoundry/stint-claude-demo-allowance exec tsc -p tsconfig.json`
Expected: PASS (10 tests); the typecheck prints nothing.

- [ ] **Step 5: Check that the rewording test fails without the rewording**

Replace the body of `isChainRefusal` with `return false;`, run the test file again: the two rewording tests FAIL.
Restore it and run again: PASS.

- [ ] **Step 6: Commit**

```bash
git add examples/claude-demo-allowance/src/allowance.ts examples/claude-demo-allowance/test/allowance.test.ts
git commit -m "Read the allowance into the demo's state and word the chain's refusal"
```

---

### Task 4: The MCP server, the start-up and the entry points

**Files:**
- Create: `examples/claude-demo-allowance/src/server.ts`, `src/main.ts`, `src/cli.ts`, `src/index.ts`
- Test: `examples/claude-demo-allowance/test/server.test.ts`, `test/main.test.ts`

**Interfaces:**
- Consumes: Task 1 (`loadConfig`, `AllowanceConfig`), Task 2 (`ALLOWANCE_TOOL`, `TO_HANDLER`, `PANEL_URI`), Task 3
  (`withAllowance`, `createAllowanceReader`); from `examples/claude-demo/src/`: `createRouter`, `CallHandler`
  (`owner.ts`), `createDemo` (`demo.ts`), `createRpcDemoChain`, `DemoChain` (`chain.ts`), `recordExchanges`
  (`exchange.ts`), `createCallHandler` (`tools.ts`), `ensureDemoFolder`, `loadOrCreateWallet` (`wallet.ts`), `TOOL`,
  `LAUNCH_AMOUNT`, `LAUNCH_SECONDS`, `TOP_UP_SECONDS` (`state.ts`), `type OwnerSide` (`main.ts`, type only).
- Produces:
  - `server.ts`: `SERVER_INFO`, `TOOL_DESCRIPTIONS`, `INSTRUCTIONS`, `createAllowanceServer(options: { html: string;
    call: CallHandler; log?: (line: string) => void }): McpServer` — `call` receives the **handler's** names;
  - `main.ts`: `interface AllowanceDeps { makeTools; makeChain; makeReader }`, `defaultDeps`,
    `createOwnerSide(config: AllowanceConfig, say, deps?): OwnerSide`, `run(panelHtml: () => Promise<string>): void`,
    `log(message: string): void`;
  - `index.ts`: the exports listed in Step 9.

- [ ] **Step 1: Write the failing server test**

`examples/claude-demo-allowance/test/server.test.ts`:

```ts
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";
import type { CallHandler } from "../../claude-demo/src/owner.js";
import { TOOL } from "../../claude-demo/src/state.js";
import { ALLOWANCE_TOOL, PANEL_URI } from "../src/names.js";
import { createAllowanceServer, SERVER_INFO } from "../src/server.js";

const HTML = "<!doctype html><title>panel</title>";

describe("the allowance demo's MCP server", () => {
  let client: Client | undefined;
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  afterEach(async () => {
    await client?.close();
    client = undefined;
    calls.length = 0;
  });

  async function connect(call: CallHandler): Promise<Client> {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await createAllowanceServer({ html: HTML, call, log: () => {} }).connect(serverTransport);
    client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(clientTransport);
    return client;
  }
  const answering: CallHandler = async (name, args) => {
    calls.push({ name, args });
    return { content: [{ type: "text", text: name }] };
  };

  it("names itself and tells the model the sessions are pulled from the owner's allowance", async () => {
    const c = await connect(answering);
    expect(SERVER_INFO.name).toBe("stint-claude-demo-allowance");
    expect(c.getServerVersion()?.name).toBe("stint-claude-demo-allowance");
    expect(c.getInstructions()).toMatch(/pulled from the owner's USDC account/);
    expect(c.getInstructions()).toMatch(/Refused on-chain/);
  });

  it("offers its own tool names, and runs each as the first demo's tool", async () => {
    const c = await connect(answering);
    const { tools } = await c.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(Object.values(ALLOWANCE_TOOL).sort());
    expect(tools.find((tool) => tool.name === ALLOWANCE_TOOL.demo)?._meta).toMatchObject({ ui: { resourceUri: PANEL_URI } });
    expect(tools.find((tool) => tool.name === ALLOWANCE_TOOL.state)?._meta).toMatchObject({ ui: { visibility: ["app"] } });
    await c.callTool({ name: ALLOWANCE_TOOL.demo, arguments: {} });
    await c.callTool({ name: ALLOWANCE_TOOL.state, arguments: { refreshBalance: true } });
    await c.callTool({ name: ALLOWANCE_TOOL.launch, arguments: {} });
    await c.callTool({ name: ALLOWANCE_TOOL.topUp, arguments: {} });
    await c.callTool({ name: ALLOWANCE_TOOL.close, arguments: {} });
    expect(calls).toEqual([
      { name: TOOL.demo, args: {} },
      { name: TOOL.state, args: { refreshBalance: true } },
      { name: TOOL.launch, args: {} },
      { name: TOOL.topUp, args: {} },
      { name: TOOL.close, args: {} },
    ]);
  });

  it("serves the panel at its own URI", async () => {
    const c = await connect(answering);
    const resource = await c.readResource({ uri: PANEL_URI });
    expect((resource.contents[0] as { text: string }).text).toBe(HTML);
  });

  it("answers a call that fails as a tool error, each URL in it cut to its host", async () => {
    const c = await connect(async () => {
      throw new Error("no answer from https://node.example/secret-key");
    });
    const result = await c.callTool({ name: ALLOWANCE_TOOL.launch, arguments: {} });
    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0]!.text).not.toContain("secret-key");
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm --filter @lxfoundry/stint-claude-demo-allowance test test/server.test.ts`
Expected: FAIL, `Cannot find module '../src/server.js'`.

- [ ] **Step 3: Write `src/server.ts`**

```ts
import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { EXTENSION_ID, RESOURCE_MIME_TYPE, registerAppResource, registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { TOP_UP_MARGIN_SECONDS, redactUrls } from "@lxfoundry/stint-x402";
import * as z from "zod";
import { formatUsdc } from "../../claude-demo/app/model.js";
import type { CallHandler } from "../../claude-demo/src/owner.js";
import { LAUNCH_AMOUNT, LAUNCH_SECONDS, TOP_UP_SECONDS } from "../../claude-demo/src/state.js";
import { ALLOWANCE_TOOL, PANEL_URI, TO_HANDLER, type AllowanceToolName } from "./names.js";

export const SERVER_INFO = { name: "stint-claude-demo-allowance", version: "0.1.0" } as const;

/** As the first demo's: the facilitator's margin and 3 s more. */
const TOP_UP_REFUSED_WITHIN_SECONDS = TOP_UP_MARGIN_SECONDS + 3;

export const TOOL_DESCRIPTIONS: Readonly<Record<AllowanceToolName, string>> = {
  [ALLOWANCE_TOOL.demo]:
    "Shows the Stint allowance demo panel and returns the demo's state, with the owner's allowance. Call it when the person asks to start, open or see the Stint allowance demo.",
  [ALLOWANCE_TOOL.state]:
    "The demo's state, for the panel: the owner's account, the allowance, the session, the x402 exchange. Set refreshBalance to read the owner's USDC again.",
  [ALLOWANCE_TOOL.launch]: `Opens a ${LAUNCH_SECONDS} s Stint session at the demo's gate, paid ${formatUsdc(LAUNCH_AMOUNT)} on devnet over x402, pulled from the owner's allowance on the Solana Foundation's Subscriptions & Allowances program into the session's escrow. The agent's key holds nothing. Past the allowance's cap for the period, the chain refuses the payment. Open the panel first with ${ALLOWANCE_TOOL.demo}.`,
  [ALLOWANCE_TOOL.topUp]: `Buys ${TOP_UP_SECONDS} s more on the running session, pulled from the owner's allowance like the launch. Refused when ${TOP_UP_REFUSED_WITHIN_SECONDS} s or less of paid time is left, when ${TOP_UP_SECONDS} s more would pass the seller's longest session, and by the chain past the allowance's cap.`,
  [ALLOWANCE_TOOL.close]:
    "Closes the running session now: the seller is paid for the time used, and the rest of the deposit is refunded to the owner's account. A refund does not restore the allowance.",
};

/** What the model is told about the server (MCP `instructions`). */
export const INSTRUCTIONS = [
  "This server shows a Stint session in a panel, funded by an allowance: an owner granted this agent a cap per period on the Solana Foundation's Subscriptions & Allowances program, and every launch and top-up is pulled from the owner's USDC account. The agent's own key holds nothing, and it cannot raise the allowance.",
  `${ALLOWANCE_TOOL.demo} shows the panel: call it when the person asks to start or see the Stint allowance demo.`,
  `The panel's buttons and the tools ${ALLOWANCE_TOOL.launch}, ${ALLOWANCE_TOOL.topUp} and ${ALLOWANCE_TOOL.close} act on the same session, so a result saying that a session is already running, is closed or has ended may mean that the person used the panel: say what the result says.`,
  "The first line of a launch, top-up or close that succeeds is its line of the owner's USDC log: the balance before, the amount pulled or refunded, and the balance after. Tell the person what the action did and quote it as it is.",
  "A failure that starts with 'Refused on-chain' was refused by the chain, not by this server: say so, and quote its first sentence.",
  "The panel shows the time left and the allowance as they change: do not poll for them.",
].join(" ");

function toStderr(line: string): void {
  process.stderr.write(`stint-claude-demo-allowance: ${line}\n`);
}

/**
 * The MCP server, as the first demo's (`examples/claude-demo/src/server.ts`), with this extension's names: each tool runs
 * `call` with the call handler's name for it (`TO_HANDLER`). It holds no state: `serveStdio` may build it more than once.
 */
export function createAllowanceServer(options: { readonly html: string; readonly call: CallHandler; readonly log?: (line: string) => void }): McpServer {
  const report = options.log ?? toStderr;
  async function run(name: AllowanceToolName, args: Record<string, unknown>): Promise<CallToolResult> {
    try {
      return await options.call(TO_HANDLER[name], args);
    } catch (error) {
      const message = redactUrls(error instanceof Error ? error.message : String(error));
      try {
        report(`${name} failed: ${message.replace(/\s+/g, " ").trim()}`);
      } catch {
        // Nothing is left to report to.
      }
      return { isError: true, content: [{ type: "text", text: message }] };
    }
  }

  const server = new McpServer(SERVER_INFO, { capabilities: { extensions: { [EXTENSION_ID]: {} } }, instructions: INSTRUCTIONS });
  registerAppTool(
    server,
    ALLOWANCE_TOOL.demo,
    { description: TOOL_DESCRIPTIONS[ALLOWANCE_TOOL.demo], inputSchema: z.strictObject({}), _meta: { ui: { resourceUri: PANEL_URI } } },
    async () => run(ALLOWANCE_TOOL.demo, {}),
  );
  registerAppResource(
    server,
    "Stint allowance demo panel",
    PANEL_URI,
    { description: "The Stint allowance demo's panel: the owner, the allowance, the session, the x402 exchange" },
    async () => ({ contents: [{ uri: PANEL_URI, mimeType: RESOURCE_MIME_TYPE, text: options.html }] }),
  );
  server.registerTool(
    ALLOWANCE_TOOL.state,
    {
      description: TOOL_DESCRIPTIONS[ALLOWANCE_TOOL.state],
      inputSchema: z.strictObject({ refreshBalance: z.boolean().optional() }),
      _meta: { ui: { visibility: ["app"] } },
    },
    async (args) => run(ALLOWANCE_TOOL.state, args),
  );
  for (const name of [ALLOWANCE_TOOL.launch, ALLOWANCE_TOOL.topUp, ALLOWANCE_TOOL.close]) {
    server.registerTool(
      name,
      { description: TOOL_DESCRIPTIONS[name], inputSchema: z.strictObject({}), _meta: { ui: { visibility: ["model", "app"] } } },
      async () => run(name, {}),
    );
  }
  return server;
}
```

- [ ] **Step 4: Run the server test**

Run: `pnpm --filter @lxfoundry/stint-claude-demo-allowance test test/server.test.ts`
Expected: PASS (4 tests). If `c.getServerVersion()` is not the client's method in `@modelcontextprotocol/client` 2.4.0,
check `examples/claude-demo/test/server.test.ts` for how it reads the server's name and do the same.

- [ ] **Step 5: Write the failing start-up test**

`examples/claude-demo-allowance/test/main.test.ts`:

```ts
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AllowanceReport, SessionTools } from "@lxfoundry/stint-client";
import type { Address, KeyPairSigner } from "@solana/kit";
import { afterEach, describe, expect, it } from "vitest";
import type { DemoChain } from "../../claude-demo/src/chain.js";
import { DEMO_POLICY } from "../../claude-demo/src/config.js";
import { TOOL } from "../../claude-demo/src/state.js";
import type { AllowanceState } from "../src/budget.js";
import { ALLOWANCE_DIR, type AllowanceConfig } from "../src/config.js";
import { createOwnerSide, type AllowanceDeps } from "../src/main.js";

const OWNER = "CciCZMJsih7NY5pet9kc1siPSj7169WSFZoTTQ5dGezx" as Address;
const OWNER_USDC = "2jPivp36NKaGtT2kYKmJHkaEzdEpMFJftv6UGhEd5a9U";
const home = fileURLToPath(new URL("../.cache/main-test/", import.meta.url));

describe("the owner side", () => {
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("reads the owner's account, funds the client from the allowance, and shows the agent's key as the agent", async () => {
    mkdirSync(home, { recursive: true });
    const config: AllowanceConfig = {
      home,
      dir: join(home, ALLOWANCE_DIR),
      gateUrl: "https://gate.example",
      rpcUrl: "https://node.example",
      policy: DEMO_POLICY,
      owner: OWNER,
      nonce: 2n,
    };
    const seen: { chainFor?: Address; toolsFor?: { signer: KeyPairSigner; owner: Address; nonce: bigint }; readerFor?: Address } = {};
    const chain: DemoChain = { usdcAccount: OWNER_USDC, usdcBalance: async () => 19_896_000n, findClose: async () => undefined };
    const deps: AllowanceDeps = {
      makeChain: async (c) => {
        seen.chainFor = c.owner;
        return chain;
      },
      makeTools: (signer, c) => {
        seen.toolsFor = { signer, owner: c.owner, nonce: c.nonce };
        return { tools: {}, closeAll: async () => ({ closed: [], failed: [] }), closeCode: () => undefined } as unknown as SessionTools;
      },
      makeReader: (agent) => {
        seen.readerFor = agent;
        return async (): Promise<AllowanceReport> => ({ owner: OWNER, delegation: OWNER, ownerBalance: 19_896_000n, delegatedAmount: 0n });
      },
    };
    const side = createOwnerSide(config, () => {}, deps);
    try {
      const handler = await side.becomeOwner();
      const result = await handler(TOOL.demo, {});
      const state = result.structuredContent as unknown as AllowanceState;
      const agent = seen.toolsFor!.signer.address;
      expect(seen.chainFor).toBe(OWNER);
      expect(seen.toolsFor).toMatchObject({ owner: OWNER, nonce: 2n });
      expect(seen.readerFor).toBe(agent);
      expect(state.wallet).toMatchObject({ address: OWNER, usdc: "19896000" });
      expect(state.allowance).toMatchObject({ owner: OWNER, agent, nonce: "2", read: { status: "none" }, stale: false });
    } finally {
      await side.shutdown();
    }
  });
});
```

- [ ] **Step 6: Run it to see it fail**

Run: `pnpm --filter @lxfoundry/stint-claude-demo-allowance test test/main.test.ts`
Expected: FAIL, `Cannot find module '../src/main.js'`.

- [ ] **Step 7: Write `src/main.ts`**

The first demo's `main.ts` (`examples/claude-demo/src/main.ts:20-167`), with its `createOwnerSide` taking this
extension's dependencies:

```ts
import { createNodeRpc, createSessionTools, createStintClient, type AllowanceReport, type SessionTools } from "@lxfoundry/stint-client";
import { USDC_DEVNET, redactUrls } from "@lxfoundry/stint-x402";
import type { Address, KeyPairSigner } from "@solana/kit";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createRpcDemoChain, type DemoChain } from "../../claude-demo/src/chain.js";
import { createDemo, type Demo } from "../../claude-demo/src/demo.js";
import { recordExchanges } from "../../claude-demo/src/exchange.js";
import type { OwnerSide } from "../../claude-demo/src/main.js";
import { createRouter, type CallHandler } from "../../claude-demo/src/owner.js";
import { LAUNCH_AMOUNT, TOOL } from "../../claude-demo/src/state.js";
import { createCallHandler } from "../../claude-demo/src/tools.js";
import { ensureDemoFolder, loadOrCreateWallet } from "../../claude-demo/src/wallet.js";
import { createAllowanceReader, withAllowance } from "./allowance.js";
import { loadConfig, type AllowanceConfig } from "./config.js";
import { createAllowanceServer } from "./server.js";

/** The tools that only read, by the call handler's names: a forwarder may ask again for one whose owner went away. */
export const READ_ONLY: ReadonlySet<string> = new Set([TOOL.demo, TOOL.state]);

/** As the first demo's: the longest the server waits to close the session on its way out. */
const CLOSE_LIMIT_MS = 90_000;

const PREFIX = "stint-claude-demo-allowance: ";

/** One message to stderr (stdout carries the protocol), each URL in it cut to its host and each of its lines prefixed. */
export function log(message: string): void {
  const lines = redactUrls(message).split("\n");
  process.stderr.write(`${lines.map((line) => `${PREFIX}${line}`).join("\n")}\n`);
}

/** What the owner side builds on: replaced in tests. */
export interface AllowanceDeps {
  /** The session tools: the client funded from the owner's allowance, with no node (the chain refuses what it cannot fund). */
  makeTools(signer: KeyPairSigner, config: AllowanceConfig): SessionTools;
  /** The reads of the chain for the owner's account: its balance, the stream's subscription, the wallet log. */
  makeChain(config: AllowanceConfig): Promise<DemoChain>;
  /** The reads of the allowance, on the extension's own node. */
  makeReader(agent: Address, config: AllowanceConfig): () => Promise<AllowanceReport>;
}

export const defaultDeps: AllowanceDeps = {
  makeTools: (signer, config) =>
    createSessionTools(createStintClient({ signer, policy: config.policy, allowance: { owner: config.owner, nonce: config.nonce } })),
  makeChain: (config) => createRpcDemoChain(config.rpcUrl, config.owner),
  makeReader: (agent, config) =>
    createAllowanceReader(createNodeRpc(config.rpcUrl), { owner: config.owner, agent, mint: USDC_DEVNET.mint, nonce: config.nonce }),
};

/** As the first demo's `createOwnerSide`: the owner's account as the demo's wallet, the agent's key as the signer. */
export function createOwnerSide(config: AllowanceConfig, say: (line: string) => void, deps: AllowanceDeps = defaultDeps): OwnerSide {
  const original = globalThis.fetch;
  const built: Demo[] = [];
  const states = new Map<CallHandler, Demo>();
  let leaving = false;
  return {
    becomeOwner: async () => {
      const wallet = await loadOrCreateWallet(config.dir, config.policy, { log: say });
      say(
        `${wallet.created ? "created the agent's key" : "using the agent's key"} ${wallet.signer.address} (${wallet.path}); it holds nothing: the owner ${config.owner} funds it with an allowance`,
      );
      const chain = await deps.makeChain(config);
      const tools = deps.makeTools(wallet.signer, config);
      const inner = createDemo({ address: config.owner, gateUrl: config.gateUrl, tools, chain, log: say });
      const amount = BigInt(LAUNCH_AMOUNT);
      const created = withAllowance(inner, {
        owner: config.owner,
        agent: wallet.signer.address,
        nonce: config.nonce,
        read: deps.makeReader(wallet.signer.address, config),
        amounts: { launch: amount, topUp: amount },
        log: say,
      });
      // Before the client sends anything: it calls the global `fetch` at each request.
      globalThis.fetch = recordExchanges(config.gateUrl, created.sink, original);
      built.push(created);
      if (leaving) await created.shutdown();
      const handler = createCallHandler(created, say);
      states.set(handler, created);
      return handler;
    },
    dropped(handler) {
      void (async () => {
        let demo: Demo | undefined;
        try {
          demo = states.get(await handler);
        } catch {
          return;
        }
        if (!demo) return;
        const outcome = await demo.shutdown();
        for (const sessionId of outcome.closed) say(`closed session ${sessionId} of a state this copy dropped`);
        for (const { sessionId, error } of outcome.failed) say(`could not close session ${sessionId} of a state this copy dropped: ${error}`);
      })().catch((error: unknown) => say(`closing a dropped state failed: ${error instanceof Error ? error.message : String(error)}`));
    },
    async shutdown() {
      leaving = true;
      const outcomes = await Promise.all(built.map((demo) => demo.shutdown()));
      return { closed: outcomes.flatMap((outcome) => outcome.closed), failed: outcomes.flatMap((outcome) => outcome.failed) };
    },
  };
}

async function main(panelHtml: () => Promise<string>): Promise<void> {
  const config = loadConfig(process.env);
  ensureDemoFolder(config.dir, log);
  const side = createOwnerSide(config, log);
  const router = await createRouter({ dir: config.dir, readOnly: READ_ONLY, log, becomeOwner: side.becomeOwner, onStepDown: side.dropped });

  let leaving: Promise<void> | undefined;
  const leave = (): Promise<void> => {
    leaving ??= (async () => {
      const limit = setTimeout(() => {
        log("giving up on closing the session");
        process.exit(1);
      }, CLOSE_LIMIT_MS);
      limit.unref();
      let failed = 0;
      try {
        const outcome = await side.shutdown();
        for (const sessionId of outcome.closed) log(`closed session ${sessionId}`);
        for (const { sessionId, error } of outcome.failed) log(`could not close session ${sessionId}: ${error}`);
        failed = outcome.failed.length;
        await router.close();
      } catch (error) {
        log(`leaving failed: ${error instanceof Error ? error.message : String(error)}`);
        failed++;
      }
      process.exit(failed === 0 ? 0 : 1);
    })();
    return leaving;
  };
  process.stdin.once("end", () => void leave());
  process.stdin.once("close", () => void leave());
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => void leave());

  // After the handlers above, as in the first demo: a signal before them would leave `owner.json` behind.
  log(router.role() === "owner" ? "this copy holds the demo's state" : "forwarding to the copy that holds the demo's state");
  const call: CallHandler = async (name, args) => {
    if (router.role() === "forwarder" && name !== TOOL.state) log(`${name} forwarded`);
    return router.call(name, args);
  };
  const html = await panelHtml();
  serveStdio(() => createAllowanceServer({ html, call, log }));
}

/** Starts the server with the panel's HTML from `panelHtml`; a start that fails says why on stderr and exits 1. */
export function run(panelHtml: () => Promise<string>): void {
  main(panelHtml).catch((error: unknown) => {
    log(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
```

- [ ] **Step 8: Write the bundle's entry point**

`src/cli.ts`:

```ts
import { run } from "./main.js";

/** Set by `scripts/build.ts`: the panel's HTML, its script inlined. */
declare const PANEL_HTML: string;

run(async () => PANEL_HTML);
```

(`src/dev.ts`, which builds the panel from source, comes with the panel's scripts in Task 5.)

- [ ] **Step 9: Write `src/index.ts`**

```ts
// The parts of the example that the copy holding its state composes (`main.ts`), for an end-to-end test that runs
// them against a stack of its own. The bundle's entry point is `cli.ts`, which does not import this.
export { ALLOWANCE_READ_EVERY_MS, createAllowanceReader, isChainRefusal, refusalWords, withAllowance, type AllowanceDemo } from "./allowance.js";
export { budgetLine, grantCommand, launchHint, type AllowanceRead, type AllowanceState, type AllowanceView } from "./budget.js";
export { ALLOWANCE_DIR, loadConfig, type AllowanceConfig } from "./config.js";
export { ALLOWANCE_TOOL, PANEL_URI, TO_HANDLER } from "./names.js";
export { createAllowanceServer, SERVER_INFO } from "./server.js";
```

- [ ] **Step 10: Run the tests and the typecheck**

Run: `pnpm --filter @lxfoundry/stint-claude-demo-allowance test && pnpm --filter @lxfoundry/stint-claude-demo-allowance exec tsc -p tsconfig.json`
Expected: PASS, every file (config, budget, allowance, server, main); the typecheck prints nothing.

- [ ] **Step 11: Commit**

```bash
git add examples/claude-demo-allowance/src examples/claude-demo-allowance/test
git commit -m "Serve the allowance demo: its tool names, its start-up on the owner's account"
```

---

### Task 5: The panel, the bundle and the extension

**Files:**
- Create: `examples/claude-demo-allowance/app/panel.html`, `app/panel.ts` (each from `examples/claude-demo/app/`),
  `scripts/panel.ts`, `scripts/build.ts`, `scripts/pack.ts`, `mcpb/manifest.json`, `src/dev.ts`
- Test: `examples/claude-demo-allowance/test/panel.test.ts`, `test/manifest.test.ts`

**Interfaces:**
- Consumes: Task 2 (`ALLOWANCE_TOOL`, `budgetLine`, `budgetShare`, `grantCommand`, `launchHint`, `AllowanceState`),
  Task 4 (`SERVER_INFO`); `examples/claude-demo/app/model.ts`, `app/poller.ts`, `src/state.ts`.
- Produces: `buildPanelHtml(): Promise<string>` and `PLACEHOLDER` (`scripts/panel.ts`); `dist/claude-demo-allowance.cjs`
  (`build`) and `dist/stint-claude-demo-allowance.mcpb` (`mcpb`).

- [ ] **Step 1: Write the failing tests**

`examples/claude-demo-allowance/test/panel.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PLACEHOLDER, buildPanelHtml } from "../scripts/panel.js";
import { ALLOWANCE_TOOL } from "../src/names.js";

const sourceOf = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

describe("the allowance demo's panel", () => {
  it("writes data as text only, and styles through the CSSOM only", () => {
    const source = sourceOf("../app/panel.ts");
    expect(source).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
    expect(source).not.toMatch(/\.style\.cssText|setAttribute\(\s*["']style["']|\.style\s*=[^=]/);
  });

  it("is one file, its script inlined, with the owner, the agent, the strip and the grant command", async () => {
    const html = await buildPanelHtml();
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).not.toContain(PLACEHOLDER);
    const start = html.indexOf("<script>");
    const end = html.lastIndexOf("</script>");
    expect(html.slice(start + "<script>".length, end)).not.toMatch(/<\/script/i);
    for (const id of ["address", "balance", "agent", "budget", "budget-pulled", "grant", "grant-command", "launch-hint", "launch", "top-up", "close", "ledger", "rows", "links", "error"]) {
      expect(html).toContain(`id="${id}"`);
    }
  });

  it("calls this extension's tools, not the first demo's", async () => {
    const html = await buildPanelHtml();
    for (const name of Object.values(ALLOWANCE_TOOL).filter((name) => name !== ALLOWANCE_TOOL.demo)) expect(html).toContain(name);
  });
});
```

`examples/claude-demo-allowance/test/manifest.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ALLOWANCE_TOOL } from "../src/names.js";
import { SERVER_INFO } from "../src/server.js";

const manifest = JSON.parse(readFileSync(fileURLToPath(new URL("../mcpb/manifest.json", import.meta.url)), "utf8"));

describe("the extension's manifest", () => {
  it("is this extension, at the server's version, running the bundle the build writes", () => {
    expect(manifest).toMatchObject({ name: "stint-claude-demo-allowance", display_name: "Stint allowance demo", version: SERVER_INFO.version });
    expect(manifest.server.entry_point).toBe("server/claude-demo-allowance.cjs");
    expect(manifest.server.mcp_config.args).toEqual(["${__dirname}/server/claude-demo-allowance.cjs"]);
  });

  it("passes each setting to the variable the server reads", () => {
    expect(manifest.server.mcp_config.env).toEqual({
      STINT_DEMO_HOME: "${user_config.wallet_dir}",
      STINT_DEMO_GATE_URL: "${user_config.gate_url}",
      STINT_DEMO_ALLOWANCE_OWNER: "${user_config.owner}",
      STINT_DEMO_ALLOWANCE_NONCE: "${user_config.nonce}",
    });
    expect(manifest.user_config.owner).toMatchObject({ type: "string", required: true });
  });

  it("lists the server's tools by their names", () => {
    expect(manifest.tools.map((tool: { name: string }) => tool.name)).toEqual(Object.values(ALLOWANCE_TOOL));
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @lxfoundry/stint-claude-demo-allowance test test/panel.test.ts test/manifest.test.ts`
Expected: FAIL: `scripts/panel.js` and `mcpb/manifest.json` are missing.

- [ ] **Step 3: Write the scripts**

`scripts/panel.ts`: copy `examples/claude-demo/scripts/panel.ts` unchanged (its paths, `../app/panel.ts` and
`../app/panel.html`, are relative to the script, so they name this package's files).

`src/dev.ts`:

```ts
import { buildPanelHtml } from "../scripts/panel.js";
import { run } from "./main.js";

/** The server from source (`tsx src/dev.ts`), building the panel in memory at start. */
run(buildPanelHtml);
```

`scripts/build.ts`: copy `examples/claude-demo/scripts/build.ts`, and change one line:

```ts
const outfile = at("../dist/claude-demo-allowance.cjs");
```

`scripts/pack.ts`: copy `examples/claude-demo/scripts/pack.ts`, and change these lines:

```ts
const bundle = at("../dist/claude-demo-allowance.cjs");
const output = at("../dist/stint-claude-demo-allowance.mcpb");
// …
copyFileSync(bundle, at("../dist/mcpb/server/claude-demo-allowance.cjs"));
```

- [ ] **Step 4: Write `mcpb/manifest.json`**

```json
{
  "manifest_version": "0.3",
  "name": "stint-claude-demo-allowance",
  "display_name": "Stint allowance demo",
  "version": "0.1.0",
  "description": "Shows a Stint session funded by an owner's allowance on the Subscriptions & Allowances program: rent 100 s of a live Solana account stream over x402 on devnet, pulled from the owner, top it up, close it early with the rest refunded to the owner, and see the chain refuse a launch past the cap.",
  "author": { "name": "LX Foundry" },
  "license": "MIT",
  "icon": "icon.png",
  "server": {
    "type": "node",
    "entry_point": "server/claude-demo-allowance.cjs",
    "mcp_config": {
      "command": "node",
      "args": ["${__dirname}/server/claude-demo-allowance.cjs"],
      "env": {
        "STINT_DEMO_HOME": "${user_config.wallet_dir}",
        "STINT_DEMO_GATE_URL": "${user_config.gate_url}",
        "STINT_DEMO_ALLOWANCE_OWNER": "${user_config.owner}",
        "STINT_DEMO_ALLOWANCE_NONCE": "${user_config.nonce}"
      }
    }
  },
  "tools": [
    { "name": "stint_allowance_demo", "description": "Shows the Stint allowance demo panel" },
    { "name": "stint_allowance_demo_state", "description": "The demo's state, for the panel" },
    { "name": "stint_allowance_demo_launch", "description": "Opens a 100 s session, pulled from the owner's allowance" },
    { "name": "stint_allowance_demo_top_up", "description": "Buys 100 s more, pulled from the owner's allowance" },
    { "name": "stint_allowance_demo_close", "description": "Closes the session now, refunding the rest to the owner" }
  ],
  "user_config": {
    "wallet_dir": {
      "type": "directory",
      "title": "Wallet folder",
      "description": "The agent's devnet key (agent.json) is kept in a stint-demo-allowance folder inside the one you pick, made if missing. It holds nothing: the owner's allowance funds it.",
      "required": true,
      "default": "${HOME}"
    },
    "gate_url": {
      "type": "string",
      "title": "Gate URL",
      "description": "The seller's gate: the example seller deployment by default.",
      "required": false,
      "default": "https://stint-demo.lxfoundry.ai"
    },
    "owner": {
      "type": "string",
      "title": "Owner's address",
      "description": "The address of the owner who grants the agent its allowance with pnpm stint allowance grant.",
      "required": true
    },
    "nonce": {
      "type": "string",
      "title": "Allowance nonce",
      "description": "The --nonce of the grant: leave empty for 0.",
      "required": false,
      "default": ""
    }
  },
  "compatibility": {
    "platforms": ["win32", "darwin", "linux"],
    "runtimes": { "node": ">=22" }
  }
}
```

- [ ] **Step 5: Write `app/panel.html`**

Copy `examples/claude-demo/app/panel.html`, then make these edits:

1. `<title>Stint demo</title>` → `<title>Stint allowance demo</title>`.
2. Before `p { margin: 4px 0; }` in the stylesheet, add:

```css
  #budget-track { height: 8px; margin: 6px 0; border: 1px solid var(--line); border-radius: 999px; overflow: hidden; }
  #budget-pulled { height: 100%; width: 0; background: var(--used); transition: width 0.3s; }
  #grant code { display: block; padding: 6px 8px; border: 1px solid var(--line); border-radius: var(--radius); user-select: all; }
```

3. Replace the first `<section>…</section>` (the "Agent wallet" one) with:

```html
<section>
  <h1>Owner <span class="label">funds the agent from an allowance, on Solana devnet</span></h1>
  <div class="row"><code id="address"></code><button id="copy" type="button">Copy</button></div>
  <div class="row"><span class="label">USDC</span><strong id="balance" class="mono"></strong><span id="needs" class="reason" hidden></span></div>
  <div class="row" id="fund" hidden>
    <button id="faucet" class="link" type="button">Get devnet USDC at Circle's faucet</button>
    <span class="reason">choose Solana Devnet and paste the owner's address, then Refresh</span>
  </div>
  <div class="row"><span class="label">Agent</span><code id="agent"></code><span class="reason">holds no USDC and no SOL</span></div>
</section>
<section>
  <h1>Allowance <span class="label">Subscriptions &amp; Allowances, read from the chain</span></h1>
  <p id="budget" class="mono"></p>
  <div id="budget-track"><div id="budget-pulled"></div></div>
  <div id="grant" hidden>
    <p class="reason">No allowance yet. The owner grants one from the repository (its README, "Allowance funding"):</p>
    <code id="grant-command"></code>
  </div>
  <p id="launch-hint" class="reason"></p>
</section>
```

4. `<h1>Wallet log <span class="label">USDC before, moved, after</span></h1>` →
   `<h1>Owner's USDC log <span class="label">before, moved, after</span></h1>`.

- [ ] **Step 6: Write `app/panel.ts`**

Copy `examples/claude-demo/app/panel.ts`, then make these edits (the first demo's line numbers):

1. Lines 2–12, the import from `"../src/state.js"`: change the path to `"../../claude-demo/src/state.js"`, and remove
   `TOOL,` from the list.
2. Line 26, `} from "./model.js";` → `} from "../../claude-demo/app/model.js";`.
3. Line 27, `import { createPoller } from "./poller.js";` → `import { createPoller } from "../../claude-demo/app/poller.js";`,
   and add after it:

```ts
import { budgetLine, budgetShare, grantCommand, launchHint, type AllowanceState } from "../src/budget.js";
// This extension's names under the first demo's identifier, so that every call below names this server's tools.
import { ALLOWANCE_TOOL as TOOL } from "../src/names.js";
```

4. Line 49: `new App({ name: "Stint demo", version: "0.1.0" })` → `new App({ name: "Stint allowance demo", version: "0.1.0" })`.
5. Line 50: `let state: DemoState | undefined;` → `let state: AllowanceState | undefined;`.
6. Lines 80–84, `isDemoState`, become:

```ts
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
```

7. Line 165, in `tellModel`: `Stint demo panel:` → `Stint allowance demo panel:`, and ` Wallet log: ` → ` Owner's USDC log: `.
8. Line 329: `function renderState(current: DemoState): void {` → `function renderState(current: AllowanceState): void {`,
   and add after line 337 (`element("fund").hidden = !funding;`):

```ts
  const allowance = current.allowance;
  setText("agent", allowance.agent);
  setText("budget", budgetLine(allowance));
  element("budget-pulled").style.width = `${(budgetShare(allowance) * 100).toFixed(2)}%`;
  const none = allowance.read?.status === "none";
  element("grant").hidden = !none;
  setText("grant-command", none ? grantCommand(allowance, current.now) : "");
  setText("launch-hint", isRunning(session) ? "" : (launchHint(allowance, BigInt(LAUNCH_AMOUNT)) ?? ""));
```

Nothing else changes: `canLaunch` and `needsFunding` read `state.wallet`, which is the owner's account here, so Launch
is offered when the owner holds 0.100 USDC, whatever the allowance (the chain decides).

- [ ] **Step 7: Run the tests and the typecheck**

Run: `pnpm --filter @lxfoundry/stint-claude-demo-allowance test && pnpm --filter @lxfoundry/stint-claude-demo-allowance typecheck`
Expected: PASS, every file; both typechecks print nothing.

- [ ] **Step 8: Build the bundle and the extension**

Run: `pnpm --filter @lxfoundry/stint-claude-demo-allowance run build && pnpm --filter @lxfoundry/stint-claude-demo-allowance run mcpb`
Expected: `built …/dist/claude-demo-allowance.cjs`, `mcpb validate` passes, `packed …/dist/stint-claude-demo-allowance.mcpb`.
If `mcpb validate` refuses the `nonce` setting, change its `type` to what the validator names and keep `default` empty.

- [ ] **Step 9: Start the bundle once without its settings**

Run: `node examples/claude-demo-allowance/dist/claude-demo-allowance.cjs < /dev/null`
Expected: exit 1, stderr naming `STINT_DEMO_HOME is required…` and `STINT_DEMO_ALLOWANCE_OWNER is required…`, each line
prefixed `stint-claude-demo-allowance: `.

- [ ] **Step 10: Commit**

```bash
git add examples/claude-demo-allowance
git commit -m "Add the allowance demo's panel, bundle and extension package"
```

---

### Task 6: End to end on the local network

**Files:**
- Modify: `e2e/package.json` (one dependency)
- Create: `e2e/test/claude-demo-allowance.test.ts`

**Interfaces:**
- Consumes: `startLocalStack` (`e2e/src/targets/local.ts`), its context's `allowance` (`AllowanceControl`:
  `grant({ usdc, perPeriod, periodSeconds })`, `revoke(grant)`); `@lxfoundry/stint-claude-demo` (`DEMO_POLICY`,
  `createDemo`, `createRpcDemoChain`, `recordExchanges`, `createCallHandler`); `@lxfoundry/stint-claude-demo-allowance`
  (`withAllowance`, `createAllowanceReader`, `createAllowanceServer`, `ALLOWANCE_TOOL`, `AllowanceState`).

- [ ] **Step 1: Add the dependency**

In `e2e/package.json`, beside `"@lxfoundry/stint-claude-demo": "workspace:*",`, add
`"@lxfoundry/stint-claude-demo-allowance": "workspace:*",`. Run `pnpm install`.

- [ ] **Step 2: Write the test**

`e2e/test/claude-demo-allowance.test.ts`:

```ts
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createSessionTools, createStintClient } from "@lxfoundry/stint-client";
import { DEMO_POLICY, createCallHandler, createDemo, createRpcDemoChain, recordExchanges } from "@lxfoundry/stint-claude-demo";
import {
  ALLOWANCE_TOOL,
  createAllowanceReader,
  createAllowanceServer,
  withAllowance,
  type AllowanceState,
} from "@lxfoundry/stint-claude-demo-allowance";
import type { AllowanceGrant } from "@lxfoundry/stint-conformance";
import { USDC_DEVNET, associatedTokenAddress } from "@lxfoundry/stint-x402";
import type { Address } from "@solana/kit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startLocalStack, type LocalStack } from "../src/targets/local.js";

// The allowance example (`examples/claude-demo-allowance`) as the copy that holds its state runs it, with no Claude: the
// first example's demo on the owner's account, the client funded from a grant made on the local network, and the
// allowance example's wrapper and server. A launch of 20 s costs 20,000 base units at the local stack's rate; the cap is
// 30,000, so the second launch is refused by the chain.

const LAUNCH_SECONDS = 20;
const LAUNCH_COST = 20_000n;

describe("the allowance example on the local stack", () => {
  let stack: LocalStack;
  const realFetch = globalThis.fetch;

  beforeAll(async () => {
    stack = await startLocalStack();
  });

  afterAll(async () => {
    globalThis.fetch = realFetch;
    await stack?.stop();
  });

  const balanceOf = async (account: string) =>
    BigInt((await stack.network.rpc.getTokenAccountBalance(account as Address, { commitment: "confirmed" }).send()).value.amount);

  it("pulls a launch from the owner, refunds the owner at the close, and has the chain refuse a launch past the cap", async () => {
    const control = stack.context().allowance;
    if (!control) throw new Error("the local target grants no allowance");
    const grant: AllowanceGrant = await control.grant({ usdc: 1_000_000n, perPeriod: 30_000n, periodSeconds: 3_600 });
    const owner = grant.owner.signer.address;
    const agent = grant.agent.address;
    const client = new Client({ name: "e2e", version: "1.0.0" });
    let demo: ReturnType<typeof withAllowance> | undefined;
    try {
      const tools = createSessionTools(createStintClient({ signer: grant.agent, policy: DEMO_POLICY, allowance: { owner, nonce: grant.nonce } }));
      const chain = await createRpcDemoChain(stack.network.rpcUrl, owner);
      const gateUrl = stack.stream.url;
      const inner = createDemo({ address: owner, gateUrl, tools, chain, launchSeconds: LAUNCH_SECONDS, log: () => {} });
      demo = withAllowance(inner, {
        owner,
        agent,
        nonce: grant.nonce,
        read: createAllowanceReader(stack.network.rpc, { owner, agent, mint: USDC_DEVNET.mint, nonce: grant.nonce }),
        amounts: { launch: LAUNCH_COST, topUp: LAUNCH_COST },
      });
      globalThis.fetch = recordExchanges(gateUrl, demo.sink, realFetch);
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await createAllowanceServer({ html: "<!doctype html><title>panel</title>", call: createCallHandler(demo, () => {}), log: () => {} }).connect(serverTransport);
      await client.connect(clientTransport);
      const call = async (name: string) => {
        const result = await client.callTool({ name, arguments: {} });
        return { isError: result.isError === true, text: (result.content as { text: string }[])[0]!.text, state: result.structuredContent as unknown as AllowanceState };
      };
      const before = await balanceOf(grant.owner.usdcAccount);

      const launched = await call(ALLOWANCE_TOOL.launch);

      expect(launched.isError, launched.text).toBe(false);
      expect(launched.state.session).toMatchObject({ state: "open", deposited: LAUNCH_COST.toString() });
      expect(launched.state.wallet.address).toBe(owner);
      expect(launched.state.allowance).toMatchObject({ agent, read: { status: "active", pulled: "20000", left: "10000" } });
      expect(await balanceOf(grant.owner.usdcAccount)).toBe(before - LAUNCH_COST);
      // The agent never holds USDC: it has no token account at all.
      const agentUsdc = await associatedTokenAddress(agent, USDC_DEVNET.mint);
      expect((await stack.network.rpc.getAccountInfo(agentUsdc, { commitment: "confirmed" }).send()).value).toBeNull();

      const closed = await call(ALLOWANCE_TOOL.close);

      expect(closed.isError, closed.text).toBe(false);
      const refunded = BigInt(closed.state.session.refunded!);
      expect(refunded).toBeGreaterThan(0n);
      expect(await balanceOf(grant.owner.usdcAccount)).toBe(before - LAUNCH_COST + refunded);
      // A refund does not restore the allowance.
      expect(closed.state.allowance.read).toMatchObject({ pulled: "20000", left: "10000" });

      const refused = await call(ALLOWANCE_TOOL.launch);

      expect(refused.isError).toBe(true);
      expect(refused.text).toMatch(/^Refused on-chain: the allowance for this period is used up \(0\.020 of 0\.030 USDC pulled; the period ends at \d\d:\d\d UTC\)\. The gate refused the payment: /);
      expect(refused.text).toContain("simulation_failed");
      expect(refused.state.error?.message).toMatch(/^Refused on-chain: the allowance for this period is used up .* The gate answered simulation_failed\.$/);
      expect(await balanceOf(grant.owner.usdcAccount)).toBe(before - LAUNCH_COST + refunded);
    } finally {
      await demo?.shutdown();
      await client.close();
      globalThis.fetch = realFetch;
      await control.revoke(grant);
    }
  });
});
```

- [ ] **Step 3: Run it**

Run: `pnpm --filter @lxfoundry/stint-e2e test test/claude-demo-allowance.test.ts`
Expected: PASS (1 test). It starts the local network, Kora and the stack: about a minute.

If the refusal does not come as `simulation_failed` on the local stack, do not change the assertion first: run
scenario 12 (`pnpm e2e:local --only=12`), which checks the same refusal; if it passes and this test does not, the
difference is in this test's composition.

- [ ] **Step 4: Check that it fails without the rewording**

In `examples/claude-demo-allowance/src/allowance.ts`, make `isChainRefusal` return `false`; run the test: FAIL on the
`Refused on-chain` assertion. Restore it; run again: PASS.

- [ ] **Step 5: Commit**

```bash
git add e2e/package.json e2e/test/claude-demo-allowance.test.ts pnpm-lock.yaml
git commit -m "Test the allowance example end to end on the local network"
```

---

### Task 7: The docs

**Files:**
- Create: `examples/claude-demo-allowance/README.md`
- Modify: `docs/live-demo-allowance.md`, `docs/plans/README.md` (after the paragraph on `claude-demo.md`, line 44),
  `docs/specs/stint-system.md` §3.3 (after line 281), `README.md` (section "Examples: a seller deployment, and a
  session in Claude Desktop")

- [ ] **Step 1: Write the package's README**

`examples/claude-demo-allowance/README.md`, in the first example's README's voice (`examples/claude-demo/README.md`):

```markdown
# Example: a Stint session funded by an allowance, in Claude Desktop

The [Claude Desktop example](../claude-demo/README.md), with every open and top-up pulled from an owner's allowance on
the Solana Foundation's Subscriptions & Allowances program instead of the agent's own USDC. Ask Claude to start the
Stint allowance demo: it calls `stint_allowance_demo`, and the panel shows

- **the owner:** its address and USDC, with Circle's faucet link while it holds less than 0.100 USDC;
- **the agent:** its address. It holds no USDC and no SOL;
- **the allowance**, read from the chain: pulled and the cap this period, what is left, and when the period ends. With
  none granted yet, the panel gives the command that grants one, with the agent's address in it;
- **Launch**, **Top up +100 s** and **Close now**, as in the first example: each payment pulled from the owner, each
  refund to the owner, and the owner's USDC log;
- a launch past the cap, sent and refused by the chain, and said in words: "Refused on-chain: the allowance for this
  period is used up (…)".

| Tool | What it does |
|---|---|
| `stint_allowance_demo` | Shows the panel and returns the state, with the allowance |
| `stint_allowance_demo_state` | The state, for the panel's reads. Not offered to the model |
| `stint_allowance_demo_launch` | Opens a 100 s session, 0.100 USDC pulled from the owner's allowance |
| `stint_allowance_demo_top_up` | Buys 100 s more, pulled the same way |
| `stint_allowance_demo_close` | Closes the session now: the seller is paid for the time used, and the rest goes back to the owner |

The tools have names of their own, so both examples can be installed in Claude Desktop at once.

## Install it in Claude Desktop

Build it in WSL or on Linux, from the repository root:

    pnpm --filter @lxfoundry/stint-claude-demo-allowance run build
    pnpm --filter @lxfoundry/stint-claude-demo-allowance run mcpb

They write `examples/claude-demo-allowance/dist/claude-demo-allowance.cjs` and
`examples/claude-demo-allowance/dist/stint-claude-demo-allowance.mcpb`. Open the `.mcpb` with Claude Desktop (Settings →
Extensions → Advanced settings → Install Extension). It asks for:

| Setting | Meaning |
|---|---|
| Wallet folder | The folder in which the server keeps a `stint-demo-allowance` folder of its own, for the agent's key (`agent.json`) and `owner.json`. As in the first example |
| Gate URL | The seller's gate. Default `https://stint-demo.lxfoundry.ai` |
| Owner's address | The owner who grants the agent its allowance. Required |
| Allowance nonce | The grant's `--nonce`; empty for 0 |

Then ask Claude, in a new chat, to start the Stint allowance demo. The panel shows the agent's address and the command
that grants it an allowance: run it from the repository, as [Allowance funding](../../README.md#allowance-funding)
describes, with the owner's keypair. The panel's strip shows the allowance within a few seconds.

Without the extension, run the bundle from `claude_desktop_config.json`, as the first example's
[Run it without the extension](../claude-demo/README.md#run-it-without-the-extension) does, with `STINT_DEMO_HOME`,
`STINT_DEMO_ALLOWANCE_OWNER` and, if the grant named one, `STINT_DEMO_ALLOWANCE_NONCE`.

## How it works

- It runs the first example's code, unchanged: the copy that holds the state and the one that forwards to it, the
  agent's key, the demo's state machine, the x402 exchange recorder, the panel's model. See
  [How it works](../claude-demo/README.md#how-it-works) there.
- The demo's wallet is the **owner's** USDC account: the balance, the faucet link, the log and the stream's messages are
  about the account the money moves from and back to. The agent's key only signs.
- The session tools are the client's, funded with `allowance: { owner, nonce }`, and with no node. So a payment the
  allowance cannot fund is signed and sent: the seller's facilitator simulates it, the Subscriptions & Allowances program
  refuses the pull, and the gate answers `402` with `simulation_failed` (spec §10.3). The extension reads the allowance
  with its own node, for the strip, and words the refusal from a read made after it.
- The extension never holds the owner's key: it cannot grant an allowance, or raise one.
- The policy is the first example's: at most 0.001 USDC a second, 1.000 USDC per session and 2.000 USDC an hour, devnet
  only. The allowance's cap applies on top of it.
```

- [ ] **Step 2: Add the extension's route to `docs/live-demo-allowance.md`**

1. In the intro, replace `Unlike the live demo, it needs a terminal, the repository and Claude Code: the Claude Desktop
   extension pays from its own wallet only.` with: `Unlike the live demo, the owner needs a terminal and the repository,
   to grant the allowance. The agent runs either in Claude Desktop, with the allowance extension (step 5), or in Claude
   Code, with the repository's MCP server (steps 5b to 8).`
2. Insert, before `## 5. Give Claude Code the session tools, funded by the allowance`, a new section:

```markdown
## 5. The agent in Claude Desktop: the allowance extension

1. Download **`stint-claude-demo-allowance.mcpb`** from the allowance extension's release (the release page of
   `claude-demo-allowance-v0.1.0`), and open it with Claude Desktop (Settings → Extensions → Advanced settings →
   Install Extension).
2. Settings: keep the wallet folder and the gate URL; put the owner's address (`echo $OWNER`) in **Owner's address**;
   leave the nonce empty. The extension makes the agent its own key: skip `allowance-agent.json` in step 2.
3. In a new chat, ask: "Start the Stint allowance demo." The panel shows the owner's USDC, the agent's address, and,
   with no allowance yet, the command that grants one, with the agent's address in it.
4. Run that command in the terminal, from the repository, with `STINT_RPC_URL` exported (step 4). The strip then shows
   0.200 USDC per hour, nothing pulled.
5. **Launch**, then **Top up +100 s**: each 0.100 USDC is pulled from the owner, and the strip shows the cap used up.
   **Close now** refunds the owner; the strip still shows 0.200 pulled. **Launch** again: refused on-chain, with the
   reason in words.
6. Clean up with step 9's revoke, giving `--agent` the agent's address from the panel.

The rest of this guide runs the agent in Claude Code instead.
```

3. Rename the next headings: `## 5. Give Claude Code…` → `## 5b. Give Claude Code…`, and keep 6 to 9 as they are.

- [ ] **Step 3: The plans index, the spec's layout and the README**

`docs/plans/README.md`, after the paragraph that starts `[claude-demo.md](claude-demo.md) is not a stage`, add:

```markdown
[claude-demo-allowance.md](claude-demo-allowance.md) is not a stage either: it adds a second Claude Desktop example,
whose sessions are funded by an owner's allowance (section 10 of the specification), on the first example's code.
```

`docs/specs/stint-system.md` §3.3, after the line `examples/claude-demo/      example MCP server that shows a session in Claude Desktop`, add:

```
examples/claude-demo-allowance/  the same, with the session funded by an owner's allowance
```

`README.md`, at the end of the section "Examples: a seller deployment, and a session in Claude Desktop", add:

```markdown
[`examples/claude-demo-allowance`](examples/claude-demo-allowance/README.md) is the same session funded by an owner's
allowance instead of the agent's own USDC.
```

- [ ] **Step 4: Check the links and commit**

Run: `grep -o '](\([^)h#][^)]*\))' examples/claude-demo-allowance/README.md docs/live-demo-allowance.md | sed 's/.*](\(.*\))/\1/' | sort -u`
and check that each path exists relative to its file.

```bash
git add examples/claude-demo-allowance/README.md docs/live-demo-allowance.md docs/plans/README.md docs/specs/stint-system.md README.md
git commit -m "Document the allowance example, and its route in the allowance guide"
```

---

### Task 8: The branch's checks, the run in Claude Desktop, the release

- [ ] **Step 1: The branch level of `CLAUDE.md`'s checks**

Run: `pnpm typecheck && pnpm test && pnpm test:e2e && pnpm e2e:local`
Expected: all green; `e2e:local` with every required scenario passing. Check that nothing under `examples/claude-demo/`,
`packages/`, `apps/`, `programs/` or `conformance/` changed: `git diff --stat origin/main -- examples/claude-demo packages apps programs conformance` prints nothing.

- [ ] **Step 2: The run in Claude Desktop (the person with the keys)**

Build the `.mcpb` (Task 5 Step 8), copy it to Windows, install it, and run the guide's new step 5 against
`stint-demo.lxfoundry.ai`, with an owner funded as in steps 2 and 3. Check, each on the chain
(`solana transaction-history "$OWNER_USDC" --url devnet`): the launch and the top-up pulled from the owner, the close
refunded the owner, the agent holds nothing, and the third launch was refused with "Refused on-chain: the allowance for
this period is used up". Record the Claude Desktop version in the guide's "checked with" line.

- [ ] **Step 3: The pull request**

Push the branch and open the pull request. Its description lists what was built, the checks, and the run in Claude
Desktop.

- [ ] **Step 4: The release, after the merge**

On `main`, after the merge, build the two files from the merge commit (Task 5 Step 8), then:

```bash
git tag claude-demo-allowance-v0.1.0
git push origin claude-demo-allowance-v0.1.0
gh release create claude-demo-allowance-v0.1.0 --latest=false --title "Allowance demo v0.1.0" \
  --notes "A Claude Desktop extension whose Stint session is funded by an owner's allowance. Install it as docs/live-demo-allowance.md describes." \
  examples/claude-demo-allowance/dist/stint-claude-demo-allowance.mcpb examples/claude-demo-allowance/dist/claude-demo-allowance.cjs
```

Then check that the latest release is still `v0.1.0`: `gh release view --json tagName` prints `v0.1.0`, and the
sha256 of `https://github.com/lxfoundry/stint/releases/latest/download/stint-claude-demo.mcpb` is still `60e5e71a…`.
Put the release page's link in the guide's step 5 in place of the release's name, in a docs commit.
