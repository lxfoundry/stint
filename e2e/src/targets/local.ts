import { randomUUID } from "node:crypto";
import { STINT_PROGRAM_ADDRESS } from "@lxfoundry/stint-program-client";
import type { Target } from "@lxfoundry/stint-conformance";
import { startFacilitator, type RunningFacilitator } from "@lxfoundry/stint-facilitator";
import { SOLANA_DEVNET } from "@lxfoundry/stint-x402";
import { SUBSCRIPTIONS_PROGRAM_ADDRESS } from "../fixtures/programs.js";
import { USDC_DEVNET_MINT } from "../fixtures/usdc.js";
import { KORA_ALLOWED_PROGRAMS } from "../kora/config.js";
import { startKora, type KoraProcess } from "../kora/process.js";
import type { LocalNetwork } from "../network/surfnet.js";
import { startLocalChain, type CommonKeys } from "./chain.js";

export type { CommonKeys } from "./chain.js";

export interface LocalStack {
  readonly target: Target;
  readonly network: LocalNetwork;
  readonly keys: CommonKeys;
  readonly kora: KoraProcess;
  readonly facilitator: RunningFacilitator;
  readonly facilitatorApiKey: string;
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
 * The `local` target (spec §12.2): the local chain, Kora and the facilitator. Allowance funding
 * joins its capabilities once the facilitator supports it.
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

    const target: Target = { name: "local", capabilities: new Set(["chain", "stack", "facilitatorApi"]) };
    return {
      target,
      network: chain.network,
      keys: chain.keys,
      kora,
      facilitator,
      facilitatorApiKey,
      stop: () => stopAll(stops),
    };
  } catch (error) {
    await stopAll(stops);
    throw error;
  }
}
