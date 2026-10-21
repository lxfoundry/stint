import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const STINT_SO_PATH = join(REPO_ROOT, "target/deploy/stint.so");
export const SUBSCRIPTIONS_SO_PATH = join(REPO_ROOT, "e2e/.cache/subscriptions.so");
export const SUBSCRIPTIONS_PIN_PATH = join(REPO_ROOT, "e2e/fixtures/subscriptions.sha256");
export const REPORT_DIR = join(REPO_ROOT, "e2e/report");
