import type { ScenarioContext, Target } from "@lxfoundry/stint-conformance";
import type { RunningStream } from "@lxfoundry/stint-example-stream";
import type { RunningFacilitator } from "@lxfoundry/stint-facilitator";
import { newBuyer } from "../fixtures/buyers.js";
import { sendUsdc } from "../fixtures/transfers.js";
import type { KoraProcess } from "../kora/process.js";
import type { LocalNetwork } from "../network/surfnet.js";
import { startLocalChain, type CommonKeys } from "./chain.js";
import { startServices, stopAll } from "./services.js";

export type { CommonKeys } from "./chain.js";

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

/**
 * The `local` target (spec §12.2): the local chain, Kora, the facilitator, and the example stream
 * with its gate. Allowance funding joins its capabilities once the facilitator supports it.
 */
export async function startLocalStack(): Promise<LocalStack> {
  const chain = await startLocalChain();
  const stops: (() => Promise<void> | void)[] = [() => chain.stop()];
  try {
    const services = await startServices({
      rpc: chain.network.rpc,
      rpcUrl: chain.network.rpcUrl,
      rpcWsUrl: chain.network.wsUrl,
      keys: chain.keys,
    });
    stops.unshift(() => services.stop());
    const target: Target = { name: "local", capabilities: new Set(["chain", "stack", "facilitatorApi"]) };
    return {
      target,
      network: chain.network,
      keys: chain.keys,
      kora: services.kora,
      facilitator: services.facilitator,
      facilitatorApiKey: services.facilitatorApiKey,
      stream: services.stream,
      context: () => ({
        target,
        gateUrl: services.stream.url,
        rpc: chain.network.rpc,
        newBuyer: (usdc) => newBuyer(chain.network.rpc, chain.keys.mintAuthority.signer, usdc),
        sendUsdc: (from, to, amount) => sendUsdc(chain.network.rpc, chain.keys.mintAuthority.signer, from, to, amount),
        subscriptionSettleMs: 1_500,
      }),
      stop: () => stopAll(stops),
    };
  } catch (error) {
    await stopAll(stops);
    throw error;
  }
}
