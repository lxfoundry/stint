import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { catalogue, exitCodeFor, renderReport, runScenarios, writeReport } from "@lxfoundry/stint-conformance";
import { REPORT_DIR } from "./paths.js";
import { startLocalStack } from "./targets/local.js";

// `pnpm e2e:local`: runs every scenario on the local target, writes the report, and exits 1 when
// a required scenario fails (spec section 12.2). Kora's logs are kept with a failing run's report.
const stack = await startLocalStack();
// An interrupted run still stops Kora and the local network, so no child process outlives it.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void stack.stop().finally(() => process.exit(130));
  });
}
try {
  const outcomes = await runScenarios(catalogue, stack.target, () => stack.context());
  writeReport(REPORT_DIR, outcomes);
  process.stdout.write(renderReport(outcomes));
  process.exitCode = exitCodeFor(outcomes);
  if (process.exitCode !== 0) writeFileSync(join(REPORT_DIR, "kora.log"), stack.kora.logs());
} finally {
  await stack.stop();
}
