import { Surfnet } from "@solana/surfpool";
import { createSolanaRpc, type Rpc, type SolanaRpcApi } from "@solana/kit";

/** Slot time of the local network (spec section 12.3). */
export const SLOT_TIME_MS = 400;

/**
 * Feature gate `disable_sbpf_v0_v1_v2_deployment`, disabled so that a program built for an older
 * SBPF version, such as the Subscriptions program copied from devnet, can be deployed.
 */
export const DISABLE_SBPF_V0_V1_V2_DEPLOYMENT = "B8JJXCy5amZyWG9r7EnUYLwzXSXTxG7GZ1qZ1qggo83g";

export interface LocalNetwork {
  readonly rpcUrl: string;
  readonly wsUrl: string;
  readonly rpc: Rpc<SolanaRpcApi>;
  readonly surfnet: Surfnet;
  stop(): void;
}

/**
 * Starts Surfpool offline, in this process, producing blocks on a clock (spec section 12.3, T3).
 * Its ports are picked by binding and releasing them, so a start can lose a race for a port: it is
 * retried, as Kora's own harness does.
 */
export function startLocalNetwork(attempts = 5): LocalNetwork {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const surfnet = Surfnet.startWithConfig({
        offline: true,
        blockProductionMode: "clock",
        slotTimeMs: SLOT_TIME_MS,
        disableFeatures: [DISABLE_SBPF_V0_V1_V2_DEPLOYMENT],
      });
      return {
        rpcUrl: surfnet.rpcUrl,
        wsUrl: surfnet.wsUrl,
        rpc: createSolanaRpc(surfnet.rpcUrl),
        surfnet,
        stop: () => surfnet.stop(),
      };
    } catch (error) {
      lastError = error;
      if (!String(error).includes("Address already in use")) throw error;
    }
  }
  throw lastError;
}

/** Cheatcodes race with transactions (T5): wait for a new slot after any of them. */
export async function waitForNewSlot(rpc: Rpc<SolanaRpcApi>, timeoutMs = 5_000): Promise<bigint> {
  const start = await rpc.getSlot({ commitment: "confirmed" }).send();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, SLOT_TIME_MS / 4));
    const slot = await rpc.getSlot({ commitment: "confirmed" }).send();
    if (slot > start) return slot;
  }
  throw new Error(`No new slot within ${timeoutMs} ms`);
}
