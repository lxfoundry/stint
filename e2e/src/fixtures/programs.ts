import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { STINT_PROGRAM_ADDRESS } from "@lxfoundry/stint-program-client";
import { address } from "@solana/kit";
import { STINT_SO_PATH, SUBSCRIPTIONS_PIN_PATH, SUBSCRIPTIONS_SO_PATH } from "../paths.js";
import type { LocalNetwork } from "../network/surfnet.js";

/** The Subscriptions & Allowances program, at its devnet address (spec section 10). */
export const SUBSCRIPTIONS_PROGRAM_ADDRESS = address("De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44");

/** Deploys the Stint program, built by `anchor build`, at its program ID. */
export function deployStintProgram(network: LocalNetwork): void {
  if (!existsSync(STINT_SO_PATH)) throw new Error(`${STINT_SO_PATH} is missing: run anchor build`);
  network.surfnet.deploy({ programId: STINT_PROGRAM_ADDRESS, soPath: STINT_SO_PATH });
}

/** Deploys the cached devnet copy of the Subscriptions program, after checking its pinned hash. */
export function deploySubscriptionsProgram(network: LocalNetwork): void {
  if (!existsSync(SUBSCRIPTIONS_SO_PATH)) {
    throw new Error(`${SUBSCRIPTIONS_SO_PATH} is missing: run scripts/fetch-subscriptions-program.sh`);
  }
  const actual = createHash("sha256").update(readFileSync(SUBSCRIPTIONS_SO_PATH)).digest("hex");
  const expected = readFileSync(SUBSCRIPTIONS_PIN_PATH, "utf8").trim();
  if (actual !== expected) {
    throw new Error(`The Subscriptions program copy (${actual}) does not match the pinned hash (${expected})`);
  }
  network.surfnet.deploy({ programId: SUBSCRIPTIONS_PROGRAM_ADDRESS, soPath: SUBSCRIPTIONS_SO_PATH });
}
