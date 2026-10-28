import { randomUUID } from "node:crypto";
import type { Rpc, SolanaRpcApi } from "@solana/kit";
import { STINT_PROGRAM_ADDRESS } from "@lxfoundry/stint-program-client";
import { startStream, type RunningStream } from "@lxfoundry/stint-example-stream";
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
}

export interface Services {
  readonly kora: KoraProcess;
  readonly facilitator: RunningFacilitator;
  readonly facilitatorApiKey: string;
  readonly stream: RunningStream;
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

/** Kora, the facilitator, and the example stream with its gate, against the network at `rpcUrl`. */
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
    });
    stops.unshift(() => facilitator.stop());
    const stream = await startStream({
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
    });
    stops.unshift(() => stream.stop());
    return { kora, facilitator, facilitatorApiKey, stream, stop: () => stopAll(stops) };
  } catch (error) {
    await stopAll(stops);
    throw error;
  }
}
