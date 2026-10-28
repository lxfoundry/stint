import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { catalogue, exitCodeFor, renderReport, runScenarios, writeReport, type ScenarioContext, type Target } from "@lxfoundry/stint-conformance";
import { loadDevnetConfig } from "./devnet/config.js";
import { REPO_ROOT, REPORT_DIR } from "./paths.js";
import { cleanDevnet, devnetFunds, startDevnetStack } from "./targets/devnet.js";
import { startLocalStack } from "./targets/local.js";

/**
 * A scenario that runs longer than this fails: a hung run must not hang the person who started it. The
 * scenario's work is not cancelled, so it can still open a session after its time-out; the clean-up finds
 * sessions on the chain, not by what the scenario reported, so it closes that one too.
 */
const SCENARIO_TIMEOUT_MS = 180_000;

interface Running {
  readonly target: Target;
  context(): ScenarioContext;
  stop(): Promise<void>;
  /** Kora's log, kept with the report of a failing run. It can contain the RPC URL, API key included. */
  logs(): string;
}

/** The devnet target's settings from `.env.devnet` (git-ignored; `.env.example` lists the names). */
function devnetSettings() {
  const envFile = join(REPO_ROOT, ".env.devnet");
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  return loadDevnetConfig(process.env);
}

async function start(name: string, forced: boolean): Promise<Running> {
  if (name === "local") {
    const stack = await startLocalStack();
    return { target: stack.target, context: () => stack.context(), stop: () => stack.stop(), logs: () => stack.kora.logs() };
  }
  if (name === "devnet") {
    const config = devnetSettings();
    const stack = await startDevnetStack({ rpcUrl: config.rpcUrl, wsUrl: config.wsUrl, seed: config.seed, force: forced });
    return { target: stack.target, context: () => stack.context(), stop: () => stack.stop(), logs: () => stack.services.kora.logs() };
  }
  throw new Error(`Unknown target "${name}": use local or devnet`);
}

// `pnpm e2e:devnet [mode] [--force]`: the flags are taken out first, so that their position does not matter.
// `--force` goes on when the start-up clean-up fails (see `startDevnetStack`).
const args = process.argv.slice(2);
const force = args.includes("--force");
const [targetName = "local", mode = "run"] = args.filter((arg) => !arg.startsWith("--"));
const MODES = ["run", "funds", "clean"];
if (!MODES.includes(mode)) {
  console.error(`Unknown mode "${mode}": use ${MODES.join(", ")}`);
  process.exit(2);
}
if (force && targetName !== "devnet") {
  console.error("--force exists only for the devnet target");
  process.exit(2);
}

// `pnpm e2e:devnet funds` prints the funding key's address and balances; `pnpm e2e:devnet clean` does the
// clean-up alone. Neither starts a service.
if (mode === "funds" || mode === "clean") {
  if (targetName !== "devnet") {
    console.error(`"${mode}" exists only for the devnet target`);
    process.exit(2);
  }
  const config = devnetSettings();
  if (mode === "funds") {
    console.error(await devnetFunds(config));
    process.exit(0);
  }
  const problems = await cleanDevnet(config);
  console.error(problems.length === 0 ? "clean: nothing is left on the harness's keys" : `clean-up problems\n- ${problems.join("\n- ")}`);
  process.exit(problems.length === 0 ? 0 : 1);
}

// Installed before anything is started or funded. An interrupted run stops its services and cleans up. One
// interrupted while it starts just exits: every key is the seed's, so the next start-up cleans up whatever
// it left. A second signal, during the clean-up, ends the process at once.
let running: Running | undefined;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    if (running) {
      void running.stop().finally(() => process.exit(130));
      return;
    }
    process.exit(130);
  });
}
const stack = (running = await start(targetName, force));

// `pnpm e2e:local` and `pnpm e2e:devnet`: runs every scenario on the target, writes the report, and
// exits 1 when a required scenario fails (spec section 12.2). Kora's logs are kept with a failing run's report.
try {
  const outcomes = await runScenarios(catalogue, stack.target, () => stack.context(), undefined, { timeoutMs: SCENARIO_TIMEOUT_MS });
  writeReport(REPORT_DIR, outcomes);
  process.stdout.write(renderReport(outcomes));
  process.exitCode = exitCodeFor(outcomes);
  if (process.exitCode !== 0) writeFileSync(join(REPORT_DIR, "kora.log"), stack.logs());
} finally {
  await stack.stop();
}
