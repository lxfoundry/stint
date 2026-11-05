// The parts of the example that the copy holding its state composes (`main.ts`), for an end-to-end test that runs
// them against a stack of its own. The bundle's entry point is `cli.ts`, which does not import this.
export { ALLOWANCE_READ_EVERY_MS, createAllowanceReader, isChainRefusal, refusalWords, withAllowance, type AllowanceDemo } from "./allowance.js";
export { budgetLine, grantCommand, launchHint, type AllowanceRead, type AllowanceState, type AllowanceView } from "./budget.js";
export { ALLOWANCE_DIR, loadConfig, type AllowanceConfig } from "./config.js";
export { ALLOWANCE_TOOL, PANEL_URI, TO_HANDLER } from "./names.js";
export { createAllowanceServer, SERVER_INFO } from "./server.js";
export { defaultDeps, type AllowanceDeps } from "./main.js";
