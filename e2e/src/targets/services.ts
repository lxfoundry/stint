import { randomUUID } from "node:crypto";
import type { Rpc, SolanaRpcApi } from "@solana/kit";
import { STINT_PROGRAM_ADDRESS } from "@lxfoundry/stint-program-client";
import { startStream, type RunningStream, type StreamConfig } from "@lxfoundry/stint-example-stream";
import { startFacilitator, type RunningFacilitator } from "@lxfoundry/stint-facilitator";
import { createFacilitatorClient, createRpcChain } from "@lxfoundry/stint-gate";
import { SOLANA_DEVNET, USDC_DEVNET, type RetryOptions, type Terms } from "@lxfoundry/stint-x402";
import type { HarnessKey } from "../fixtures/keys.js";
import { SUBSCRIPTIONS_PROGRAM_ADDRESS } from "../fixtures/programs.js";
import { USDC_DEVNET_MINT } from "../fixtures/usdc.js";
import { KORA_ALLOWED_PROGRAMS } from "../kora/config.js";
import { startKora, type KoraProcess } from "../kora/process.js";

/** The test offer of spec §12.6: a minimum of 5 s or less, and a short idle close. */
export const TEST_TERMS: Terms = { rate: 1_000n, minSeconds: 5, maxSeconds: 120 };
export const TEST_DURATIONS = [30] as const;
export const TEST_IDLE_CLOSE_SECONDS = 10;
/** How often the facilitator's sweeper runs in a test stack (spec §12.4): often enough that a session nobody closed ends within a scenario's patience. */
export const TEST_SWEEPER_INTERVAL_MS = 2_000;
/** How many times a restart of the gate tries a port that something still holds, and how long it waits between tries. */
const GATE_RESTART_ATTEMPTS = 10;
const GATE_RESTART_DELAY_MS = 200;

/** The keys the services run with. */
export interface ServiceKeys {
  readonly koraFeePayer: HarnessKey;
  readonly rentPayer: HarnessKey;
  readonly receiverAuthorizer: HarnessKey;
  readonly seller: HarnessKey;
}

export interface ServicesOptions {
  readonly rpc: Rpc<SolanaRpcApi>;
  readonly rpcUrl: string;
  readonly rpcWsUrl: string;
  readonly keys: ServiceKeys;
  /** The longest an offer asks a buyer to take; at most the time its blockhash has left (spec §5.1). Default 60. */
  readonly maxTimeoutSeconds?: number;
  /** How the gate and the facilitator re-read what a node does not return yet. */
  readonly readRetry?: RetryOptions;
  /** Milliseconds between the facilitator's sweeps. Default `TEST_SWEEPER_INTERVAL_MS`. */
  readonly sweeperIntervalMs?: number;
  /** An endpoint that lists the program's accounts for the sweeper, if `rpcUrl` refuses that (a provider's free tier may). Default `rpcUrl`. */
  readonly scanRpcUrl?: string;
}

export interface Services {
  readonly kora: KoraProcess;
  readonly facilitator: RunningFacilitator;
  readonly facilitatorApiKey: string;
  /** The gate and the example stream that are current: after `stopGate()` and `startGate()`, the new ones, at the same URL. */
  readonly stream: RunningStream;
  /** Stops the gate and its connections; the facilitator, its sweeper and Kora keep running. Safe to repeat. */
  stopGate(): Promise<void>;
  /**
   * Starts the gate again on the port it had. The new gate has no memory of earlier sessions. Safe to repeat. It does nothing
   * once `stop()` has been called: a gate started then would be one that nothing stops.
   */
  startGate(): Promise<void>;
  /** Stops everything that is running, a stopped gate included. Safe to repeat. */
  stop(): Promise<void>;
}

/** Stops each in turn, the last registered first, even when one of them fails to stop. */
export async function stopAll(stops: readonly (() => Promise<void> | void)[]): Promise<void> {
  let failure: unknown;
  for (const stop of stops) {
    try {
      await stop();
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure !== undefined) throw failure;
}

/**
 * Starts the example stream on `port`. A gate that has just stopped may still hold its port for a moment, so a port that is
 * in use is tried again a few times.
 */
async function startStreamOn(config: StreamConfig, port: number): Promise<RunningStream> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await startStream({ ...config, port });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE" || attempt >= GATE_RESTART_ATTEMPTS) throw error;
      await new Promise((resolve) => setTimeout(resolve, GATE_RESTART_DELAY_MS));
    }
  }
}

/** Kora, the facilitator with its sweeper, and the example stream with its gate, against the network at `rpcUrl`. */
export async function startServices(options: ServicesOptions): Promise<Services> {
  const stops: (() => Promise<void> | void)[] = [];
  try {
    const kora = await startKora({
      rpcUrl: options.rpcUrl,
      config: {
        allowedPrograms: [...KORA_ALLOWED_PROGRAMS, STINT_PROGRAM_ADDRESS, SUBSCRIPTIONS_PROGRAM_ADDRESS],
        allowedTokens: [USDC_DEVNET_MINT],
        maxAllowedLamports: 1_000_000,
      },
      feePayerSecretKey: options.keys.koraFeePayer.secretKey,
      apiKey: randomUUID(),
    });
    stops.unshift(() => kora.stop());
    const facilitatorApiKey = randomUUID();
    const facilitator = await startFacilitator({
      rpcUrl: options.rpcUrl,
      network: SOLANA_DEVNET,
      kora: { url: kora.url, apiKey: kora.apiKey },
      rentPayerSecretKey: options.keys.rentPayer.secretKey,
      apiKeys: [facilitatorApiKey],
      readRetry: options.readRetry,
      sweeper: { intervalMs: options.sweeperIntervalMs ?? TEST_SWEEPER_INTERVAL_MS, scanRpcUrl: options.scanRpcUrl },
    });
    stops.unshift(() => facilitator.stop());
    const streamConfig: StreamConfig = {
      rpcWsUrl: options.rpcWsUrl,
      gate: {
        network: SOLANA_DEVNET,
        asset: USDC_DEVNET,
        payTo: options.keys.seller.signer.address,
        receiverAuthorizer: options.keys.receiverAuthorizer.signer,
        terms: TEST_TERMS,
        durations: TEST_DURATIONS,
        idleCloseSeconds: TEST_IDLE_CLOSE_SECONDS,
        maxTimeoutSeconds: options.maxTimeoutSeconds,
        readRetry: options.readRetry,
        facilitator: createFacilitatorClient(facilitator.url, facilitatorApiKey),
        chain: createRpcChain(options.rpc),
      },
    };
    let running: RunningStream | undefined = await startStream(streamConfig);
    let latest: RunningStream = running;
    // A restarted gate takes the port it had, so that the URL a scenario holds stays valid.
    const port = Number(new URL(running.url).port);
    const stopGate = async (): Promise<void> => {
      const current = running;
      running = undefined;
      await current?.stop();
      // A client's keep-alive socket to the old gate is seen to be closed only when the event loop polls for I/O. One has to run
      // between the old gate's sockets being destroyed and the next request, or that request goes out on the dead socket once the
      // gate is back on the same port. Two hops through the check phase always have a poll between them; a timer does not.
      for (let hop = 0; hop < 2; hop++) await new Promise((resolve) => setImmediate(resolve));
    };
    let stopped = false;
    const startGate = async (): Promise<void> => {
      if (running || stopped) return;
      latest = running = await startStreamOn(streamConfig, port);
    };
    stops.unshift(stopGate);
    let stopping: Promise<void> | undefined;
    return {
      kora,
      facilitator,
      facilitatorApiKey,
      get stream() {
        return latest;
      },
      stopGate,
      startGate,
      stop: () => ((stopped = true), (stopping ??= stopAll(stops))),
    };
  } catch (error) {
    await stopAll(stops);
    throw error;
  }
}
