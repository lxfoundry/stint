import { fetchSysvarClock } from "@solana/sysvars";
import type { KeyPairSigner, Rpc, SolanaRpcApi } from "@solana/kit";
import type { AllowanceControl, AllowanceGrant, Buyer } from "@lxfoundry/stint-conformance";
import { allowanceAccounts, grantInstructions, revokeInstructions } from "@lxfoundry/stint-subscriptions-client";
import { sendInstructions, type SendOptions } from "../network/transactions.js";
import { USDC_DEVNET_MINT } from "./usdc.js";

/** What an owner needs in SOL for its grant: 3,993,080 lamports were measured (two accounts' rent and the fee), and its revoke's fee. */
export const GRANT_LAMPORTS = 5_000_000n;
/** How long a harness grant lasts: a run is far shorter. */
const GRANT_SECONDS = 86_400n;

export interface AllowanceFixtureOptions {
  readonly rpc: Rpc<SolanaRpcApi>;
  /** A new owner key holding `usdc` in its USDC account and `GRANT_LAMPORTS` in SOL. */
  newOwner(usdc: bigint): Promise<Buyer>;
  /** A new key that holds nothing, which the target's clean-up covers. */
  newAgent(): Promise<KeyPairSigner>;
  readonly send?: SendOptions;
}

/** Grants and revokes on the network the target runs on. The owner signs and pays, as a person granting an allowance does. */
export function createAllowanceControl(options: AllowanceFixtureOptions): AllowanceControl {
  return {
    async grant({ usdc, perPeriod, periodSeconds }): Promise<AllowanceGrant> {
      const owner = await options.newOwner(usdc);
      const agent = await options.newAgent();
      const clock = await fetchSysvarClock(options.rpc, { commitment: "confirmed" });
      const nonce = 0n;
      const instructions = await grantInstructions({
        owner: owner.signer,
        agent: agent.address,
        mint: USDC_DEVNET_MINT,
        perPeriod,
        periodSeconds: BigInt(periodSeconds),
        expiresAt: BigInt(clock.unixTimestamp) + GRANT_SECONDS,
        nonce,
      });
      await sendInstructions(options.rpc, owner.signer, instructions, options.send);
      const { delegation } = await allowanceAccounts({ owner: owner.signer.address, agent: agent.address, mint: USDC_DEVNET_MINT, nonce });
      return { owner, agent, nonce, delegation, perPeriod, periodSeconds };
    },
    async revoke(grant) {
      const { subscriptionAuthority } = await allowanceAccounts({
        owner: grant.owner.signer.address,
        agent: grant.agent.address,
        mint: USDC_DEVNET_MINT,
        nonce: grant.nonce,
      });
      const instructions = revokeInstructions({ owner: grant.owner.signer, delegation: grant.delegation, closeAuthority: subscriptionAuthority });
      await sendInstructions(options.rpc, grant.owner.signer, instructions, options.send);
    },
  };
}
