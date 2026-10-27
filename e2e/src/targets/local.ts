import { randomUUID } from "node:crypto";
import { STINT_PROGRAM_ADDRESS } from "@lxfoundry/stint-program-client";
import type { ScenarioContext, Target } from "@lxfoundry/stint-conformance";
import { startStream, type RunningStream } from "@lxfoundry/stint-example-stream";
import { startFacilitator, type RunningFacilitator } from "@lxfoundry/stint-facilitator";
import { createFacilitatorClient, createRpcChain } from "@lxfoundry/stint-gate";
import { SOLANA_DEVNET, USDC_DEVNET, type Terms } from "@lxfoundry/stint-x402";
import { newBuyer } from "../fixtures/buyers.js";
import { SUBSCRIPTIONS_PROGRAM_ADDRESS } from "../fixtures/programs.js";
import { USDC_DEVNET_MINT } from "../fixtures/usdc.js";
import { KORA_ALLOWED_PROGRAMS } from "../kora/config.js";
import { startKora, type KoraProcess } from "../kora/process.js";
import type { LocalNetwork } from "../network/surfnet.js";
import { startLocalChain, type CommonKeys } from "./chain.js";

export type { CommonKeys } from "./chain.js";

/** The test offer of spec §12.6: a minimum of 5 s or less, and a short idle close. */
export const LOCAL_TERMS: Terms = { rate: 1_000n, minSeconds: 5, maxSeconds: 120 };
export const LOCAL_DURATIONS = [30] as const;
export const LOCAL_IDLE_CLOSE_SECONDS = 10;

export interface LocalStack {
  readonly target: Target;
  readonly network: LocalNetwork;
  readonly keys: CommonKeys;
  readonly kora: KoraProcess;
  readonly facilitator: RunningFacilitator;
  readonly facilitatorApiKey: string;
  readonly stream: RunningStream;
  context(): ScenarioContext;
  stop(): Promise<void>;
}

/** Stops each service in turn, and the network last, even when one of them fails to stop. */
async function stopAll(stops: readonly (() => Promise<void> | void)[]): Promise<void> {
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
 * The `local` target (spec §12.2): the local chain, Kora, the facilitator, and the example stream
 * with its gate. Allowance funding joins its capabilities once the facilitator supports it.
 */
export async function startLocalStack(): Promise<LocalStack> {
  const chain = await startLocalChain();
  const stops: (() => Promise<void> | void)[] = [() => chain.stop()];
  try {
    const kora = await startKora({
      rpcUrl: chain.network.rpcUrl,
      config: {
        allowedPrograms: [...KORA_ALLOWED_PROGRAMS, STINT_PROGRAM_ADDRESS, SUBSCRIPTIONS_PROGRAM_ADDRESS],
        allowedTokens: [USDC_DEVNET_MINT],
        maxAllowedLamports: 1_000_000,
      },
      feePayerSecretKey: chain.keys.koraFeePayer.secretKey,
      apiKey: randomUUID(),
    });
    stops.unshift(() => kora.stop());
    const facilitatorApiKey = randomUUID();
    const facilitator = await startFacilitator({
      rpcUrl: chain.network.rpcUrl,
      network: SOLANA_DEVNET,
      kora: { url: kora.url, apiKey: kora.apiKey },
      rentPayerSecretKey: chain.keys.rentPayer.secretKey,
      apiKeys: [facilitatorApiKey],
    });
    stops.unshift(() => facilitator.stop());
    const stream = await startStream({
      rpcWsUrl: chain.network.wsUrl,
      gate: {
        network: SOLANA_DEVNET,
        asset: USDC_DEVNET,
        payTo: chain.keys.seller.signer.address,
        receiverAuthorizer: chain.keys.receiverAuthorizer.signer,
        terms: LOCAL_TERMS,
        durations: LOCAL_DURATIONS,
        idleCloseSeconds: LOCAL_IDLE_CLOSE_SECONDS,
        facilitator: createFacilitatorClient(facilitator.url, facilitatorApiKey),
        chain: createRpcChain(chain.network.rpc),
      },
    });
    stops.unshift(() => stream.stop());

    const target: Target = { name: "local", capabilities: new Set(["chain", "stack", "facilitatorApi"]) };
    return {
      target,
      network: chain.network,
      keys: chain.keys,
      kora,
      facilitator,
      facilitatorApiKey,
      stream,
      context: () => ({
        target,
        gateUrl: stream.url,
        rpc: chain.network.rpc,
        newBuyer: (usdc) => newBuyer(chain.network.rpc, chain.keys.mintAuthority.signer, usdc),
      }),
      stop: () => stopAll(stops),
    };
  } catch (error) {
    await stopAll(stops);
    throw error;
  }
}
