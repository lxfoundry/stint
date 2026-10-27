import type { Address } from "@solana/kit";
import { fundSol, newHarnessKey, type HarnessKey } from "../fixtures/keys.js";
import { deployStintProgram, deploySubscriptionsProgram } from "../fixtures/programs.js";
import { createUsdcAccount, writeUsdcMint } from "../fixtures/usdc.js";
import { startLocalNetwork, waitForNewSlot, type LocalNetwork } from "../network/surfnet.js";

/** The common stack's keys (spec §12.3). */
export interface CommonKeys {
  readonly mintAuthority: HarnessKey;
  readonly freezeAuthority: HarnessKey;
  readonly koraFeePayer: HarnessKey;
  readonly rentPayer: HarnessKey;
  readonly receiverAuthorizer: HarnessKey;
  readonly seller: HarnessKey;
  readonly sellerUsdcAccount: Address;
}

export interface LocalChain {
  readonly network: LocalNetwork;
  readonly keys: CommonKeys;
  stop(): void;
}

/** Surfpool, offline and embedded, with the fixtures of spec §12.3 and the common keys. */
export async function startLocalChain(): Promise<LocalChain> {
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
    const keys = { mintAuthority, freezeAuthority, koraFeePayer, rentPayer, receiverAuthorizer, seller, sellerUsdcAccount };
    return { network, keys, stop: () => network.stop() };
  } catch (error) {
    network.stop();
    throw error;
  }
}
