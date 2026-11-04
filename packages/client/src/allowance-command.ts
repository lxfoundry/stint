import { parseArgs } from "node:util";
import {
  isAddress,
  type Address,
  type Instruction,
  type KeyPairSigner,
  type Rpc,
  type SolanaRpcApi,
  type TransactionSigner,
} from "@solana/kit";
import {
  allowanceAccounts,
  fetchMaybeSubscriptionAuthority,
  grantInstructions,
  revokeInstructions,
} from "@lxfoundry/stint-subscriptions-client";
import { USDC_DEVNET, redactUrls } from "@lxfoundry/stint-x402";
import { readAllowance } from "./allowance.js";
import { parseKeyFile } from "./keypair.js";

/** Devnet's genesis hash: the command sends nothing to any other network. */
export const DEVNET_GENESIS_HASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

export interface CommandDeps {
  readonly rpc: Rpc<SolanaRpcApi>;
  readKeyFile(path: string): string;
  /** Sends `instructions` in one transaction whose fee `payer` pays, and returns its signature once `confirmed`. */
  send(payer: TransactionSigner, instructions: readonly Instruction[]): Promise<string>;
  print(line: string): void;
}

const USAGE = [
  "stint allowance grant  --keypair <owner keypair file> --agent <address> --per-period <base units> --period <seconds> --expires <ISO 8601 date> [--nonce <n>]",
  "stint allowance revoke --keypair <owner keypair file> --agent <address> [--nonce <n>] [--close-authority]",
  "stint allowance status --owner <address> --agent <address> [--nonce <n>]",
  "The node is STINT_RPC_URL, an http or https URL.",
  "Give the keypair file's absolute path: the command runs in packages/client. The owner's USDC account must exist.",
].join("\n");

/** The longest period the program accepts: a year (its `MAX_DELEGATION_PERIOD_SECS`). */
const MAX_PERIOD_SECONDS = 31_536_000n;

async function readKeypair(deps: CommandDeps, path: string): Promise<KeyPairSigner> {
  try {
    return await parseKeyFile(deps.readKeyFile(path));
  } catch {
    // Nothing is taken from the error: a parser's message quotes the start of the text it was given.
    throw new Error(`--keypair ${path}: the file cannot be read, or does not hold a keypair as a JSON array of 64 bytes`);
  }
}

/** The most causes followed: a chain is short, and the bound keeps a cycle from running for ever. */
const MAX_CAUSES = 8;

/**
 * Why a call failed, a line each: the error's message, then the message of each cause in turn, then the logs of a
 * simulation. Kit reports a refused transaction as "Transaction simulation failed", and keeps the program's error in
 * the cause and the program's logs in the context.
 */
function describeFailure(error: unknown): string[] {
  const lines: string[] = [];
  const logs: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth <= MAX_CAUSES; depth++) {
    const prefix = depth === 0 ? "" : "caused by: ";
    if (current instanceof Error) {
      lines.push(`${prefix}${current.message}`);
      const found = (current as { context?: { logs?: unknown } }).context?.logs;
      if (Array.isArray(found)) logs.push(...found.filter((line): line is string => typeof line === "string"));
      current = current.cause;
    } else {
      if (depth === 0 || typeof current === "string") lines.push(`${prefix}${String(current)}`);
      break;
    }
  }
  return logs.length === 0 ? lines : [...lines, "logs:", ...logs.map((line) => `  ${line}`)];
}

/**
 * `stint allowance grant | revoke | status` (spec §10.1). Devnet only: it checks the node's genesis hash before it sends
 * anything. The owner signs and pays the fee and the rent of the grant's accounts. Returns the exit code; problems are
 * printed, never a key's contents or the node's URL.
 */
export async function runAllowanceCommand(argv: readonly string[], deps: CommandDeps): Promise<number> {
  const [action, ...rest] = argv;
  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({
      args: [...rest],
      options: {
        keypair: { type: "string" },
        owner: { type: "string" },
        agent: { type: "string" },
        "per-period": { type: "string" },
        period: { type: "string" },
        expires: { type: "string" },
        nonce: { type: "string" },
        "close-authority": { type: "boolean" },
      },
      strict: true,
    }));
  } catch (error) {
    deps.print(`${(error as Error).message}\n${USAGE}`);
    return 2;
  }
  const problems: string[] = [];
  const text = (name: string): string | undefined => (typeof values[name] === "string" ? (values[name] as string) : undefined);
  const needAddress = (name: string): Address | undefined => {
    const value = text(name);
    if (value === undefined || !isAddress(value)) problems.push(`--${name} must be an address`);
    return value !== undefined && isAddress(value) ? value : undefined;
  };
  const whole = (name: string, min: bigint, fallback?: bigint): bigint | undefined => {
    const value = text(name);
    if (value === undefined && fallback !== undefined) return fallback;
    if (value === undefined || !/^\d+$/.test(value) || BigInt(value) < min) {
      problems.push(`--${name} must be a whole number of at least ${min}`);
      return undefined;
    }
    return BigInt(value);
  };
  if (!["grant", "revoke", "status"].includes(action ?? "")) {
    deps.print(USAGE);
    return 2;
  }
  const agent = needAddress("agent");
  const nonce = whole("nonce", 0n, 0n);
  const mint = USDC_DEVNET.mint;
  let perPeriod: bigint | undefined;
  let period: bigint | undefined;
  let expiresAt: bigint | undefined;
  if (action === "grant") {
    perPeriod = whole("per-period", 1n);
    period = whole("period", 1n);
    if (period !== undefined && period > MAX_PERIOD_SECONDS) problems.push(`--period may be at most ${MAX_PERIOD_SECONDS} s, the program's limit`);
    const expires = Date.parse(text("expires") ?? "");
    if (Number.isNaN(expires) || expires <= Date.now()) problems.push("--expires must be an ISO 8601 date in the future");
    else expiresAt = BigInt(Math.floor(expires / 1000));
  }
  const ownerAddress = action === "status" ? needAddress("owner") : undefined;
  if (action !== "status" && text("keypair") === undefined) problems.push("--keypair is required");
  if (problems.length > 0) {
    deps.print(`${problems.join("\n")}\n${USAGE}`);
    return 2;
  }
  try {
    const genesis = await deps.rpc.getGenesisHash().send();
    if (genesis !== DEVNET_GENESIS_HASH) {
      deps.print(`The node reports genesis hash ${genesis}, which is not devnet's: nothing is sent`);
      return 1;
    }
    if (action === "status") {
      const report = await readAllowance(deps.rpc, { owner: ownerAddress!, agent: agent!, mint, nonce: nonce! });
      const p = report.period;
      deps.print(`delegation ${report.delegation}`);
      deps.print(p ? `${p.status}: ${p.pulled} of ${p.perPeriod} pulled this period, ${p.available} left; the period ends at ${p.periodEnd}${p.expiresAt === 0n ? "" : `; expires at ${p.expiresAt}`}` : "no such allowance");
      deps.print(`the owner holds ${report.ownerBalance}`);
      return 0;
    }
    const owner = await readKeypair(deps, text("keypair")!);
    const accounts = await allowanceAccounts({ owner: owner.address, agent: agent!, mint, nonce: nonce! });
    if (action === "grant") {
      const authority = await fetchMaybeSubscriptionAuthority(deps.rpc, accounts.subscriptionAuthority, { commitment: "confirmed" });
      const instructions = await grantInstructions({
        owner,
        agent: agent!,
        mint,
        perPeriod: perPeriod!,
        periodSeconds: period!,
        expiresAt: expiresAt!,
        nonce: nonce!,
        ...(authority.exists ? { existingInitId: authority.data.initId } : {}),
      });
      const signature = await deps.send(owner, instructions);
      deps.print(`granted: delegation ${accounts.delegation}, ${perPeriod} base units every ${period} s until ${new Date(Number(expiresAt) * 1000).toISOString()}`);
      deps.print(`transaction ${signature}`);
      return 0;
    }
    const closeAuthority =
      values["close-authority"] === true ? { subscriptionAuthority: accounts.subscriptionAuthority, ownerToken: accounts.ownerToken, mint } : undefined;
    const signature = await deps.send(owner, revokeInstructions({ owner, delegation: accounts.delegation, ...(closeAuthority ? { closeAuthority } : {}) }));
    deps.print(
      `revoked: delegation ${accounts.delegation}${closeAuthority ? ", and the owner's Subscription Authority closed, with its approval on the owner's USDC account" : ""}`,
    );
    deps.print(`transaction ${signature}`);
    return 0;
  } catch (error) {
    // A node's error can quote its URL, which may carry an API key: every URL is reduced to its scheme and host.
    for (const line of describeFailure(error)) deps.print(redactUrls(line));
    return 1;
  }
}
