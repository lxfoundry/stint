import { fetchMaybeToken } from "@solana-program/token";
import { createSolanaRpc, type Rpc, type SolanaRpcApi } from "@solana/kit";
import { describeError, type ScenarioContext, type StackControl, type Target } from "@lxfoundry/stint-conformance";
import { associatedTokenAddress } from "@lxfoundry/stint-x402";
import { assertDevnet, assertProgramDeployed } from "../devnet/config.js";
import { cleanUp, fundUsdcAccount, sendSol, type Funding } from "../devnet/funds.js";
import { KEY_INDEX, deriveKey, deriveKeys, type DevnetKeys } from "../devnet/keys.js";
import { sendUsdc } from "../fixtures/transfers.js";
import { USDC_DEVNET_MINT } from "../fixtures/usdc.js";
import { createDirectChain } from "./direct.js";
import { TEST_TERMS, startServices, type ServiceKeys, type Services } from "./services.js";

/** What the funding key must hold to start: fees and rent for the stack, and the buyers' USDC. */
const MINIMUM_FUNDS = { lamports: 500_000_000n, usdc: 5_000_000n };
/** What each key of the stack that spends SOL is given: Kora's fee payer and the rent payer. */
const STACK_LAMPORTS = 50_000_000n;
/**
 * How long a scenario waits after subscribing before it causes the change it expects to hear about.
 * A provider's WebSocket can take seconds to register a subscription, which the stream does not
 * acknowledge; this is a measured value, not a guarantee: raise it if a provider is slower.
 */
const SUBSCRIPTION_SETTLE_MS = 5_000;
/** How a scenario reads the chain for what its own transaction did: the services' read retry, since the same node answers. */
const READ_RETRY = { attempts: 20, delayMs: 500 };
/**
 * What the rent payer of sessions opened straight on the program is given: the rent of a session account and its vault, about
 * 4.7 million lamports, for a few sessions at once, with the rent-exempt minimum left on the key. The clean-up returns what is left.
 */
const DIRECT_RENT_LAMPORTS = 20_000_000n;

export interface DevnetStackOptions {
  readonly rpcUrl: string;
  readonly wsUrl: string;
  /** Where the clean-up lists the program's accounts, if `rpcUrl` refuses that (a provider's free tier may). Default `rpcUrl`. */
  readonly scanRpcUrl?: string;
  /** The seed that every key derives from (`deriveKeys`), the funding key included. */
  readonly seed: Uint8Array;
  /** Check the genesis hash, the deployed program and the funds before starting. Default true. */
  readonly preflight?: boolean;
  /** Milliseconds between status reads. Default 400: devnet's public endpoint is rate-limited. */
  readonly pollMs?: number;
  /** How many buyer keys the run may hand out. Default `BUYER_POOL`. */
  readonly buyerPool?: number;
  /** Go on when the start-up clean-up fails, after reporting it: for a session that cannot be closed yet. Default false. */
  readonly force?: boolean;
}

export interface DevnetStack {
  readonly target: Target;
  readonly rpc: Rpc<SolanaRpcApi>;
  readonly keys: ServiceKeys;
  readonly services: Services;
  context(): ScenarioContext;
  /** Stops the services, then cleans up. Never throws; idempotent. */
  stop(): Promise<void>;
}

/**
 * The endpoint that lists the program's accounts: `rpc`, or the scan endpoint when one is named. A scan endpoint
 * decides which sessions the clean-up closes, so with `preflight` it must be devnet's too.
 */
async function scanRpcOf(rpc: Rpc<SolanaRpcApi>, scanRpcUrl: string | undefined, preflight: boolean): Promise<Rpc<SolanaRpcApi>> {
  if (!scanRpcUrl) return rpc;
  const scanRpc = createSolanaRpc(scanRpcUrl);
  if (preflight) await assertDevnet(scanRpc);
  return scanRpc;
}

async function fundingOf(keys: Pick<DevnetKeys, "funding">): Promise<Funding> {
  return { signer: keys.funding.signer, usdcAccount: await associatedTokenAddress(keys.funding.signer.address, USDC_DEVNET_MINT) };
}

/** What the funding key holds: lamports, and USDC base units in its token account (none when the account does not exist). */
async function readFunds(rpc: Rpc<SolanaRpcApi>, funding: Funding): Promise<{ lamports: bigint; usdc: bigint }> {
  const lamports = (await rpc.getBalance(funding.signer.address, { commitment: "confirmed" }).send()).value;
  const token = await fetchMaybeToken(rpc, funding.usdcAccount, { commitment: "confirmed" });
  return { lamports, usdc: token.exists ? token.data.amount : 0n };
}

const holdsLine = (funding: Funding, held: { lamports: bigint; usdc: bigint }): string =>
  `funding key ${funding.signer.address} holds ${held.lamports} lamports and ${held.usdc} USDC base units`;

async function assertFunds(rpc: Rpc<SolanaRpcApi>, funding: Funding): Promise<void> {
  const { lamports, usdc } = await readFunds(rpc, funding);
  const short: string[] = [];
  if (lamports < MINIMUM_FUNDS.lamports) {
    short.push(`${funding.signer.address} holds ${lamports} lamports and needs ${MINIMUM_FUNDS.lamports}: use a devnet SOL faucet`);
  }
  if (usdc < MINIMUM_FUNDS.usdc) {
    short.push(`its USDC account ${funding.usdcAccount} holds ${usdc} base units and needs ${MINIMUM_FUNDS.usdc}: use Circle's devnet faucet`);
  }
  if (short.length > 0) throw new Error(`The funding key is short:\n- ${short.join("\n- ")}`);
}

/** One line for the log: what the funding key holds, so that a run's start and end can be compared. Never throws. */
async function fundsLine(rpc: Rpc<SolanaRpcApi>, funding: Funding): Promise<string> {
  try {
    return holdsLine(funding, await readFunds(rpc, funding));
  } catch (error) {
    return `funding key ${funding.signer.address}: balances unavailable (${describeError(error)})`;
  }
}

function report(problems: readonly string[]): void {
  if (problems.length > 0) {
    console.error(`devnet target: clean-up problems\n- ${problems.join("\n- ")}\nThe next run's start-up repeats the clean-up; "pnpm e2e:devnet clean" does it now.`);
  }
}

/**
 * The `devnet` target (spec §12.2): Kora, the facilitator and the example stream with its gate, run
 * against a network that is not ours, with the deployed program. Every key derives from one seed, the
 * funding key included, which is never used in a scenario. The run begins by cleaning up whatever any
 * earlier run, or none, left on the seed's keys, and does not start if that fails, unless `force` is set; it ends with the same
 * clean-up, which the next start repeats if this one fails (spec §12.6).
 */
export async function startDevnetStack(options: DevnetStackOptions): Promise<DevnetStack> {
  const rpc = createSolanaRpc(options.rpcUrl);
  const keys = await deriveKeys(options.seed, options.buyerPool);
  const funding = await fundingOf(keys);
  const send = { pollMs: options.pollMs ?? 400 };
  if (options.preflight !== false) {
    await assertDevnet(rpc);
    await assertProgramDeployed(rpc);
  }
  const scanRpc = await scanRpcOf(rpc, options.scanRpcUrl, options.preflight !== false);
  const left = await cleanUp(rpc, funding, keys.holders, send, scanRpc);
  if (left.length > 0) {
    const problems = `Cleaning up what earlier runs left failed:\n- ${left.join("\n- ")}`;
    if (!options.force) {
      throw new Error(`${problems}\nThis run does not start. Anyone may close a session from its paid time on, so fix the cause or wait, and run again; or go on regardless (\`force\`; \`--force\` on the command line).`);
    }
    console.error(`${problems}\n--force: going on regardless`);
  }
  if (options.preflight !== false) {
    await assertFunds(rpc, funding);
    console.error(await fundsLine(rpc, funding));
  }

  let services: Services;
  try {
    await sendSol(rpc, funding.signer, keys.stack.koraFeePayer.signer.address, STACK_LAMPORTS, send);
    await sendSol(rpc, funding.signer, keys.stack.rentPayer.signer.address, STACK_LAMPORTS, send);
    await fundUsdcAccount(rpc, funding, keys.stack.seller.signer.address, 0n, send);
    services = await startServices({
      rpc,
      rpcUrl: options.rpcUrl,
      rpcWsUrl: options.wsUrl,
      keys: keys.stack,
      // Devnet's blockhashes last about 36 s: an offer may not outlast its own (spec §5.1).
      maxTimeoutSeconds: 30,
      readRetry: READ_RETRY,
      // The sweeper lists the program's accounts where the clean-up does.
      scanRpcUrl: options.scanRpcUrl,
      // Keeps the sweeper's `getProgramAccounts` within the public endpoint's rate limits.
      sweeperIntervalMs: 5_000,
    });
  } catch (error) {
    report(await cleanUp(rpc, funding, keys.holders, send, scanRpc));
    throw error;
  }

  const target: Target = { name: "devnet", capabilities: new Set(["stack", "facilitatorApi"]) };
  let nextBuyer = 0;
  let stopping: Promise<void> | undefined;
  /** What the run has lent its buyers from the funding key. It comes back only at the clean-up, so it must fit in what a start-up requires. */
  let lent = 0n;
  /** The next key of the pool. Buyers and the rent payer of direct sessions draw from it alike, so that the clean-up covers every one. */
  const takeKey = () => {
    const key = keys.buyers[nextBuyer++];
    if (!key) throw new Error(`The run used all ${keys.buyers.length} buyer keys: raise BUYER_POOL in e2e/src/devnet/keys.ts`);
    return key;
  };
  const control: StackControl = {
    rentPayer: services.facilitator.rentPayer,
    stopGate: () => services.stopGate(),
    startGate: () => services.startGate(),
  };
  const sellerWallet = keys.stack.seller.signer.address;
  const direct = createDirectChain({
    rpc,
    terms: TEST_TERMS,
    seller: { wallet: sellerWallet, usdcAccount: await associatedTokenAddress(sellerWallet, USDC_DEVNET_MINT) },
    // The funding key pays the fee of the harness's own transactions (spec §12.6), so the rent payer's balance changes by rent only.
    feePayer: funding.signer,
    rentPayer: async () => {
      const key = takeKey();
      await sendSol(rpc, funding.signer, key.signer.address, DIRECT_RENT_LAMPORTS, send);
      return key.signer;
    },
    readRetry: READ_RETRY,
    send,
  });
  return {
    target,
    rpc,
    keys: keys.stack,
    services,
    context: () => ({
      target,
      gateUrl: services.stream.url,
      rpc,
      newBuyer: async (usdc) => {
        // Checked and counted before anything is awaited, so that buyers made at the same time cannot all pass.
        if (lent + usdc > MINIMUM_FUNDS.usdc) {
          throw new Error(
            `The run has lent ${lent} USDC base units and this buyer asks for ${usdc} more: a run must stay within ${MINIMUM_FUNDS.usdc}, the least that a start-up requires. Fund a buyer with what its session costs.`,
          );
        }
        lent += usdc;
        const key = takeKey();
        const usdcAccount = await fundUsdcAccount(rpc, funding, key.signer.address, usdc, send);
        return { signer: key.signer, usdcAccount };
      },
      sendUsdc: (from, to, amount) => sendUsdc(rpc, funding.signer, from, to, amount, send),
      subscriptionSettleMs: SUBSCRIPTION_SETTLE_MS,
      readRetry: READ_RETRY,
      stack: control,
      direct,
    }),
    stop: () => {
      stopping ??= (async () => {
        const problems: string[] = [];
        try {
          await services.stop();
        } catch (error) {
          problems.push(`stopping the services: ${describeError(error)}`);
        }
        problems.push(...(await cleanUp(rpc, funding, keys.holders, send, scanRpc)));
        if (options.preflight !== false) console.error(`after clean-up, ${await fundsLine(rpc, funding)}`);
        report(problems);
      })();
      return stopping;
    },
  };
}

export interface CleanOptions {
  readonly rpcUrl: string;
  /** Where the program's accounts are listed, if `rpcUrl` refuses that. Default `rpcUrl`. */
  readonly scanRpcUrl?: string;
  readonly seed: Uint8Array;
  readonly preflight?: boolean;
  readonly pollMs?: number;
  readonly buyerPool?: number;
}

/** The clean-up on its own (`pnpm e2e:devnet clean`). Returns what went wrong. */
export async function cleanDevnet(options: CleanOptions): Promise<string[]> {
  const rpc = createSolanaRpc(options.rpcUrl);
  if (options.preflight !== false) await assertDevnet(rpc);
  const scanRpc = await scanRpcOf(rpc, options.scanRpcUrl, options.preflight !== false);
  const keys = await deriveKeys(options.seed, options.buyerPool);
  const funding = await fundingOf(keys);
  const problems = await cleanUp(rpc, funding, keys.holders, { pollMs: options.pollMs ?? 400 }, scanRpc);
  if (options.preflight !== false) console.error(`after clean-up, ${await fundsLine(rpc, funding)}`);
  return problems;
}

/**
 * The funding key's address and balances (`pnpm e2e:devnet funds`), then "✓ Funded" when it holds the minimum
 * that a run needs of both SOL and USDC, or else what it needs and where to get it.
 */
export async function devnetFunds(options: Pick<CleanOptions, "rpcUrl" | "seed" | "preflight">): Promise<string> {
  const rpc = createSolanaRpc(options.rpcUrl);
  if (options.preflight !== false) await assertDevnet(rpc);
  const funding = await fundingOf({ funding: await deriveKey(options.seed, KEY_INDEX.funding) });
  const held = await readFunds(rpc, funding);
  const funded = held.lamports >= MINIMUM_FUNDS.lamports && held.usdc >= MINIMUM_FUNDS.usdc;
  return `${holdsLine(funding, held)}\n${
    funded
      ? "✓ Funded"
      : `A run needs at least ${MINIMUM_FUNDS.lamports} lamports and ${MINIMUM_FUNDS.usdc} USDC base units there: fund ${funding.signer.address} from the SOL and USDC faucets.`
  }`;
}
