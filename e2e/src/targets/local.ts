import { randomUUID } from "node:crypto";
import { STINT_PROGRAM_ADDRESS } from "@lxfoundry/stint-program-client";
import type { Target } from "@lxfoundry/stint-conformance";
import type { Address } from "@solana/kit";
import { fundSol, newHarnessKey, type HarnessKey } from "../fixtures/keys.js";
import { SUBSCRIPTIONS_PROGRAM_ADDRESS, deployStintProgram, deploySubscriptionsProgram } from "../fixtures/programs.js";
import { USDC_DEVNET_MINT, createUsdcAccount, writeUsdcMint } from "../fixtures/usdc.js";
import { KORA_ALLOWED_PROGRAMS } from "../kora/config.js";
import { startKora, type KoraProcess } from "../kora/process.js";
import { startLocalNetwork, waitForNewSlot, type LocalNetwork } from "../network/surfnet.js";

/** The common stack's keys (spec section 12.3). */
export interface CommonKeys {
  readonly mintAuthority: HarnessKey;
  readonly freezeAuthority: HarnessKey;
  readonly koraFeePayer: HarnessKey;
  readonly rentPayer: HarnessKey;
  readonly receiverAuthorizer: HarnessKey;
  readonly seller: HarnessKey;
  readonly sellerUsdcAccount: Address;
}

export interface LocalStack {
  readonly target: Target;
  readonly network: LocalNetwork;
  readonly keys: CommonKeys;
  readonly kora: KoraProcess;
  stop(): Promise<void>;
}

/**
 * The `local` target (spec section 12.2): Surfpool, offline and embedded, with the fixtures of
 * spec section 12.3, and Kora. Allowance funding joins its capabilities once the facilitator
 * supports it.
 */
export async function startLocalStack(): Promise<LocalStack> {
  const network = startLocalNetwork();
  try {
    const mintAuthority = await newHarnessKey();
    const freezeAuthority = await newHarnessKey();
    const koraFeePayer = await newHarnessKey();
    const rentPayer = await newHarnessKey();
    const receiverAuthorizer = await newHarnessKey();
    const seller = await newHarnessKey();
    for (const key of [mintAuthority, koraFeePayer, rentPayer, receiverAuthorizer, seller]) {
      fundSol(network, key.signer.address, 10);
    }
    await writeUsdcMint(network, {
      mintAuthority: mintAuthority.signer.address,
      freezeAuthority: freezeAuthority.signer.address,
    });
    deployStintProgram(network);
    deploySubscriptionsProgram(network);
    await waitForNewSlot(network.rpc);

    const sellerUsdcAccount = await createUsdcAccount(network.rpc, mintAuthority.signer, seller.signer.address);
    const kora = await startKora({
      rpcUrl: network.rpcUrl,
      config: {
        allowedPrograms: [...KORA_ALLOWED_PROGRAMS, STINT_PROGRAM_ADDRESS, SUBSCRIPTIONS_PROGRAM_ADDRESS],
        allowedTokens: [USDC_DEVNET_MINT],
        maxAllowedLamports: 1_000_000,
      },
      feePayerSecretKey: koraFeePayer.secretKey,
      apiKey: randomUUID(),
    });

    const keys: CommonKeys = {
      mintAuthority,
      freezeAuthority,
      koraFeePayer,
      rentPayer,
      receiverAuthorizer,
      seller,
      sellerUsdcAccount,
    };
    const target: Target = { name: "local", capabilities: new Set(["chain", "stack", "facilitatorApi"]) };
    return {
      target,
      network,
      keys,
      kora,
      stop: async () => {
        await kora.stop();
        network.stop();
      },
    };
  } catch (error) {
    network.stop();
    throw error;
  }
}
