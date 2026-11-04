import { redactUrls } from "@lxfoundry/stint-x402";
import { SellerConfigError, loadSeed, loadSellerConfig } from "./config.js";
import { deriveSellerKeys, describeKeys } from "./keys.js";
import { startSeller } from "./seller.js";

/** How long a process that is leaving, a seller still starting included, has before it ends anyway. */
const STOP_DEADLINE_MS = 15_000;

const describeError = (error: unknown) => redactUrls(error instanceof Error ? (error.stack ?? error.message) : String(error));

/**
 * `tsx src/main.ts keys` prints the deployment's addresses from `STINT_SELLER_SEED` alone, with no network; with no
 * argument, it starts the seller and stops it on SIGINT or SIGTERM, with status 0. If Kora exits while it runs, or an
 * error nobody handles ends the run, it stops the rest and exits with status 1, so that the platform starts it again.
 */
async function main(): Promise<void> {
  if (process.argv[2] === "keys") {
    process.stdout.write(`${describeKeys(await deriveSellerKeys(loadSeed(process.env)))}\n`);
    return;
  }
  const starting = startSeller(loadSellerConfig(process.env));
  // Kora outlives a process that ends without stopping it, so every way out goes through here, the start-up's included:
  // a seller that is still starting is stopped as soon as it has started, and one whose start fails has stopped itself.
  let leaving = false;
  const leave = (status: number) => {
    if (leaving) return;
    leaving = true;
    process.exitCode = status;
    // A stop that hangs must not keep a failed seller alive: the platform restarts it only when it ends.
    setTimeout(() => process.exit(status), STOP_DEADLINE_MS).unref();
    starting.then(
      (seller) =>
        seller.stop().then(
          () => process.exit(status),
          () => process.exit(1),
        ),
      () => {}, // `main`'s catch reports it.
    );
  };
  process.once("SIGINT", () => leave(0));
  process.once("SIGTERM", () => leave(0));
  process.on("uncaughtException", (error) => {
    console.error(describeError(error));
    leave(1);
  });
  const seller = await starting;
  void seller.failed.then((reason) => {
    console.error(reason);
    leave(1);
  });
}

main().catch((error: unknown) => {
  console.error(error instanceof SellerConfigError ? error.message : describeError(error));
  process.exit(1);
});
