import type { DirectChain, ScenarioContext, StackControl, Target } from "@lxfoundry/stint-conformance";
import type { RunningStream } from "@lxfoundry/stint-example-stream";
import type { RunningFacilitator } from "@lxfoundry/stint-facilitator";
import { newBuyer } from "../fixtures/buyers.js";
import { fundSol, newHarnessKey } from "../fixtures/keys.js";
import { sendUsdc } from "../fixtures/transfers.js";
import type { KoraProcess } from "../kora/process.js";
import { waitForNewSlot, type LocalNetwork } from "../network/surfnet.js";
import { startLocalChain, type CommonKeys, type LocalChain } from "./chain.js";
import { createDirectChain } from "./direct.js";
import { TEST_TERMS, startServices, stopAll } from "./services.js";

export type { CommonKeys } from "./chain.js";

/** One attempt: the node is ours, so a read right after a write is not answered from behind (spec §12.2). */
const READ_RETRY = { attempts: 1, delayMs: 0 };

/**
 * The chain's side of sessions opened straight on the program: two fresh keys with SOL, one that pays the fees and one that
 * pays the sessions' rent. Neither is one of the stack's, so nothing of the stack touches what they open.
 */
async function directChainOf(chain: LocalChain): Promise<DirectChain> {
  const feePayer = await newHarnessKey();
  const rentPayer = await newHarnessKey();
  fundSol(chain.network, feePayer.signer.address, 10);
  fundSol(chain.network, rentPayer.signer.address, 10);
  await waitForNewSlot(chain.network.rpc);
  return createDirectChain({
    rpc: chain.network.rpc,
    terms: TEST_TERMS,
    seller: { wallet: chain.keys.seller.signer.address, usdcAccount: chain.keys.sellerUsdcAccount },
    feePayer: feePayer.signer,
    rentPayer: async () => rentPayer.signer,
    readRetry: READ_RETRY,
  });
}

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
    const direct = await directChainOf(chain);
    const control: StackControl = {
      rentPayer: services.facilitator.rentPayer,
      stopGate: () => services.stopGate(),
      startGate: () => services.startGate(),
    };
    const target: Target = { name: "local", capabilities: new Set(["chain", "stack", "facilitatorApi"]) };
    return {
      target,
      network: chain.network,
      keys: chain.keys,
      kora: services.kora,
      facilitator: services.facilitator,
      facilitatorApiKey: services.facilitatorApiKey,
      get stream() {
        return services.stream;
      },
      context: () => ({
        target,
        gateUrl: services.stream.url,
        rpc: chain.network.rpc,
        newBuyer: (usdc) => newBuyer(chain.network.rpc, chain.keys.mintAuthority.signer, usdc),
        sendUsdc: (from, to, amount) => sendUsdc(chain.network.rpc, chain.keys.mintAuthority.signer, from, to, amount),
        subscriptionSettleMs: 1_500,
        readRetry: READ_RETRY,
        stack: control,
        direct,
      }),
      stop: () => stopAll(stops),
    };
  } catch (error) {
    await stopAll(stops);
    throw error;
  }
}
