import { fetchMaybeToken } from "@solana-program/token";
import { createSolanaRpc, type Rpc, type SolanaRpcApi } from "@solana/kit";
import { describeError, type ScenarioContext, type Target } from "@lxfoundry/stint-conformance";
import { associatedTokenAddress } from "@lxfoundry/stint-x402";
import { assertDevnet, assertProgramDeployed } from "../devnet/config.js";
import { cleanUp, fundUsdcAccount, sendSol, type Funding } from "../devnet/funds.js";
import { KEY_INDEX, deriveKey, deriveKeys, type DevnetKeys } from "../devnet/keys.js";
import { sendUsdc } from "../fixtures/transfers.js";
import { USDC_DEVNET_MINT } from "../fixtures/usdc.js";
import { startServices, type ServiceKeys, type Services } from "./services.js";

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

export interface DevnetStackOptions {
  readonly rpcUrl: string;
  readonly wsUrl: string;
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

async function fundingOf(keys: Pick<DevnetKeys, "funding">): Promise<Funding> {
  return { signer: keys.funding.signer, usdcAccount: await associatedTokenAddress(keys.funding.signer.address, USDC_DEVNET_MINT) };
}

async function assertFunds(rpc: Rpc<SolanaRpcApi>, funding: Funding): Promise<void> {
  const lamports = (await rpc.getBalance(funding.signer.address, { commitment: "confirmed" }).send()).value;
  const token = await fetchMaybeToken(rpc, funding.usdcAccount, { commitment: "confirmed" });
  const usdc = token.exists ? token.data.amount : 0n;
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
    const lamports = (await rpc.getBalance(funding.signer.address, { commitment: "confirmed" }).send()).value;
    const token = await fetchMaybeToken(rpc, funding.usdcAccount, { commitment: "confirmed" });
    return `funding key ${funding.signer.address} holds ${lamports} lamports and ${token.exists ? token.data.amount : 0n} USDC base units`;
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
  const left = await cleanUp(rpc, funding, keys.holders, send);
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
      readRetry: { attempts: 20, delayMs: 500 },
    });
  } catch (error) {
    report(await cleanUp(rpc, funding, keys.holders, send));
    throw error;
  }

  const target: Target = { name: "devnet", capabilities: new Set(["stack", "facilitatorApi"]) };
  let nextBuyer = 0;
  let stopping: Promise<void> | undefined;
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
        const key = keys.buyers[nextBuyer++];
        if (!key) throw new Error(`The run used all ${keys.buyers.length} buyer keys: raise BUYER_POOL in e2e/src/devnet/keys.ts`);
        const usdcAccount = await fundUsdcAccount(rpc, funding, key.signer.address, usdc, send);
        return { signer: key.signer, usdcAccount };
      },
      sendUsdc: (from, to, amount) => sendUsdc(rpc, funding.signer, from, to, amount, send),
      subscriptionSettleMs: SUBSCRIPTION_SETTLE_MS,
    }),
    stop: () => {
      stopping ??= (async () => {
        const problems: string[] = [];
        try {
          await services.stop();
        } catch (error) {
          problems.push(`stopping the services: ${describeError(error)}`);
        }
        problems.push(...(await cleanUp(rpc, funding, keys.holders, send)));
        if (options.preflight !== false) console.error(`after clean-up, ${await fundsLine(rpc, funding)}`);
        report(problems);
      })();
      return stopping;
    },
  };
}

export interface CleanOptions {
  readonly rpcUrl: string;
  readonly seed: Uint8Array;
  readonly preflight?: boolean;
  readonly pollMs?: number;
  readonly buyerPool?: number;
}

/** The clean-up on its own (`pnpm e2e:devnet clean`). Returns what went wrong. */
export async function cleanDevnet(options: CleanOptions): Promise<string[]> {
  const rpc = createSolanaRpc(options.rpcUrl);
  if (options.preflight !== false) await assertDevnet(rpc);
  const keys = await deriveKeys(options.seed, options.buyerPool);
  const funding = await fundingOf(keys);
  const problems = await cleanUp(rpc, funding, keys.holders, { pollMs: options.pollMs ?? 400 });
  if (options.preflight !== false) console.error(`after clean-up, ${await fundsLine(rpc, funding)}`);
  return problems;
}

/** The funding key's address and balances, and what a run needs there (`pnpm e2e:devnet funds`). */
export async function devnetFunds(options: Pick<CleanOptions, "rpcUrl" | "seed">): Promise<string> {
  const rpc = createSolanaRpc(options.rpcUrl);
  await assertDevnet(rpc);
  const funding = await fundingOf({ funding: await deriveKey(options.seed, KEY_INDEX.funding) });
  return `${await fundsLine(rpc, funding)}\nA run needs at least ${MINIMUM_FUNDS.lamports} lamports and ${MINIMUM_FUNDS.usdc} USDC base units there: fund ${funding.signer.address} from the SOL and USDC faucets.`;
}
