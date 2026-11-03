import { randomUUID } from "node:crypto";
import {
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  fetchEncodedAccount,
  type Address,
  type KeyPairSigner,
  type Rpc,
  type SolanaRpcApi,
} from "@solana/kit";
import { startStream, type StreamConfig } from "@lxfoundry/stint-example-stream";
import { startFacilitator } from "@lxfoundry/stint-facilitator";
import { createFacilitatorClient, createRpcChain } from "@lxfoundry/stint-gate";
import { STINT_PROGRAM_ADDRESS } from "@lxfoundry/stint-program-client";
import { SOLANA_DEVNET, USDC_DEVNET, associatedTokenAddress, redactUrls, type RetryOptions, type Terms } from "@lxfoundry/stint-x402";
import { assertDevnet, assertProgramDeployed, closeLeftSessions, ensureTokenAccount, fundingNeeded, lamportsToSend, topUpSol } from "./chain.js";
import type { SellerConfig } from "./config.js";
import { deriveSellerKeys, type SellerKeys } from "./keys.js";
import { KORA_ALLOWED_PROGRAMS, SUBSCRIPTIONS_PROGRAM_ADDRESS, startKora } from "./kora.js";

/** 1000 base units of devnet USDC a second (0.001 USDC/s), from 5 s to 300 s. */
export const SELLER_TERMS: Terms = { rate: 1_000n, minSeconds: 5, maxSeconds: 300 };
/** What a request that names no duration is offered. */
export const SELLER_DURATIONS = [100] as const;
/** A session nobody connects to for this long is closed by the gate (spec §7.5). */
export const IDLE_CLOSE_SECONDS = 60;
/** Between the sweeper's listings of the program's sessions; within a public endpoint's rate limits. */
export const SWEEPER_INTERVAL_MS = 10_000;
/** What Kora's fee payer and the rent payer are topped up to at each start: 0.05 SOL. */
export const STACK_LAMPORTS = 50_000_000n;
/** A public node can lag: reads of what a transaction just did are tried for up to 10 s. */
const READ_RETRY: RetryOptions = { attempts: 20, delayMs: 500 };
/** Devnet's blockhashes last about a minute: an offer may not outlast its own (spec §5.1). */
const MAX_TIMEOUT_SECONDS = 30;

export type Log = (entry: Record<string, unknown>) => void;

/** One JSON line per entry on stdout, every URL cut to its scheme and host: an RPC URL can carry an API key. */
export const jsonLog: Log = (entry) => console.log(redactUrls(JSON.stringify({ at: new Date().toISOString(), ...entry })));

/** The gate's settings but its facilitator, its chain and its log: the offer this example sells. */
export function sellerGateSettings(keys: { readonly seller: Address; readonly receiverAuthorizer: KeyPairSigner }): Omit<StreamConfig["gate"], "facilitator" | "chain" | "log"> {
  return {
    network: SOLANA_DEVNET,
    asset: USDC_DEVNET,
    payTo: keys.seller,
    receiverAuthorizer: keys.receiverAuthorizer,
    terms: SELLER_TERMS,
    durations: SELLER_DURATIONS,
    idleCloseSeconds: IDLE_CLOSE_SECONDS,
    maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
    readRetry: READ_RETRY,
  };
}

export interface RunningSeller {
  /** Where the stream listens. */
  readonly url: string;
  /** Where buyers reach it. */
  readonly origin: string;
  readonly keys: SellerKeys;
  /**
   * Settles, with why, if Kora exits while the seller runs: payments and closes then fail, so whoever runs the seller
   * stops it and starts it again (the entry point exits non-zero, and Fly.io restarts the machine).
   */
  readonly failed: Promise<string>;
  /** Stops the stream and its gate, the facilitator and its sweeper, then Kora. */
  stop(): Promise<void>;
}

/**
 * Tops Kora's fee payer and the rent payer up from the funding key, and creates the seller's USDC account. The funding
 * key's balance is checked first whenever it has anything to pay, the seller's missing token account included, so that
 * a short key is named with what it needs rather than found by a failed transaction.
 */
async function fundStack(rpc: Rpc<SolanaRpcApi>, keys: SellerKeys): Promise<void> {
  const funding = keys.funding.signer;
  const balanceOf = async (owner: Address) => (await rpc.getBalance(owner, { commitment: "confirmed" }).send()).value;
  const owed =
    lamportsToSend(await balanceOf(keys.koraFeePayer.signer.address), STACK_LAMPORTS) +
    lamportsToSend(await balanceOf(keys.rentPayer.signer.address), STACK_LAMPORTS);
  const sellerUsdc = await associatedTokenAddress(keys.seller.signer.address, USDC_DEVNET.mint);
  const needsAccount = !(await fetchEncodedAccount(rpc, sellerUsdc, { commitment: "confirmed" })).exists;
  const needed = fundingNeeded(owed, needsAccount);
  const held = await balanceOf(funding.address);
  if (held < needed) {
    throw new Error(`The funding key ${funding.address} holds ${held} lamports and needs ${needed}: send it devnet SOL`);
  }
  await topUpSol(rpc, funding, keys.koraFeePayer.signer.address, STACK_LAMPORTS);
  await topUpSol(rpc, funding, keys.rentPayer.signer.address, STACK_LAMPORTS);
  await ensureTokenAccount(rpc, funding, keys.seller.signer.address, USDC_DEVNET.mint);
}

/**
 * The example seller (spec §6, §7, §8): Kora behind its API key, the facilitator with its sweeper on 127.0.0.1, and
 * the stream with its gate on `config.host:config.port`, announcing `config.publicOrigin`. It starts only on devnet,
 * with the program deployed, once its keys hold their SOL and the sessions an earlier process left open are closed.
 */
export async function startSeller(config: SellerConfig, log: Log = jsonLog): Promise<RunningSeller> {
  const rpc = createSolanaRpc(config.rpcUrl);
  const scanRpc = config.scanRpcUrl ? createSolanaRpc(config.scanRpcUrl) : rpc;
  const keys = await deriveSellerKeys(config.seed);
  await assertDevnet(rpc);
  // The scan endpoint decides which sessions the start-up closes: it must be devnet's too.
  if (scanRpc !== rpc) await assertDevnet(scanRpc);
  await assertProgramDeployed(rpc);
  await fundStack(rpc, keys);
  const cleaned = await closeLeftSessions(rpc, scanRpc, keys.funding.signer, {
    rentPayer: keys.rentPayer.signer.address,
    receiverAuthorizer: keys.receiverAuthorizer.signer,
  });
  log({ event: "start_clean_up", closed: cleaned.closed, failed: cleaned.failed });

  // Filled as each service starts, the last started first: the stops run in that order.
  const stops: (() => Promise<void>)[] = [];
  const stop = async (): Promise<void> => {
    for (const next of stops.splice(0)) {
      try {
        await next();
      } catch (error) {
        log({ event: "stop_error", error: error instanceof Error ? error.message : String(error) });
      }
    }
  };
  try {
    const kora = await startKora({
      rpcUrl: config.rpcUrl,
      config: {
        allowedPrograms: [...KORA_ALLOWED_PROGRAMS, STINT_PROGRAM_ADDRESS, SUBSCRIPTIONS_PROGRAM_ADDRESS],
        allowedTokens: [USDC_DEVNET.mint],
        maxAllowedLamports: 1_000_000,
      },
      feePayerSecretKey: keys.koraFeePayer.secretKey,
      apiKey: randomUUID(),
    });
    let stopping = false;
    stops.unshift(async () => {
      stopping = true;
      await kora.stop();
    });
    // Kora's exit is the seller's failure, unless the seller is stopping it.
    const failed = kora.exit.then(async (code) => {
      if (stopping) return new Promise<string>(() => {});
      const reason = `Kora exited (status ${code ?? "none: a signal ended it"})`;
      log({ event: "kora_exited", code, output: kora.logs() });
      return reason;
    });
    const facilitatorApiKey = randomUUID();
    const facilitator = await startFacilitator({
      rpcUrl: config.rpcUrl,
      network: SOLANA_DEVNET,
      kora: { url: kora.url, apiKey: kora.apiKey },
      rentPayerSecretKey: keys.rentPayer.secretKey,
      apiKeys: [facilitatorApiKey],
      readRetry: READ_RETRY,
      sweeper: { intervalMs: SWEEPER_INTERVAL_MS, scanRpcUrl: config.scanRpcUrl },
      log,
    });
    stops.unshift(() => facilitator.stop());
    const stream = await startStream({
      host: config.host,
      port: config.port,
      origin: config.publicOrigin,
      rpcWsUrl: config.wsUrl,
      gate: {
        ...sellerGateSettings({ seller: keys.seller.signer.address, receiverAuthorizer: keys.receiverAuthorizer.signer }),
        facilitator: createFacilitatorClient(facilitator.url, facilitatorApiKey),
        // The gate follows each session's account over the node's WebSocket (spec §7.3).
        chain: createRpcChain(rpc, createSolanaRpcSubscriptions(config.wsUrl)),
        log,
      },
    });
    stops.unshift(() => stream.stop());
    log({ event: "ready", url: stream.url, origin: config.publicOrigin, seller: keys.seller.signer.address });
    return { url: stream.url, origin: config.publicOrigin, keys, failed, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
