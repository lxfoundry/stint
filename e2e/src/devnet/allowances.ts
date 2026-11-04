import type { Address, Base58EncodedBytes, KeyPairSigner, Rpc, SolanaRpcApi } from "@solana/kit";
import {
  SUBSCRIPTIONS_PROGRAM_ADDRESS,
  findSubscriptionAuthorityPda,
  getCloseSubscriptionAuthorityInstruction,
  getRecurringDelegationEncoder,
  revokeInstructions,
} from "@lxfoundry/stint-subscriptions-client";
import { describeError } from "@lxfoundry/stint-conformance";
import { sendInstructions, type SendOptions } from "../network/transactions.js";
import { USDC_DEVNET_MINT } from "../fixtures/usdc.js";

/** Where a delegation's header holds its delegator: after a one-byte discriminator, version and bump. */
const DELEGATOR_OFFSET = 3n;

/**
 * Revokes every recurring delegation a held key granted for USDC, and closes its Subscription Authority, so that their rent
 * returns to the key before the clean-up empties it (spec §12.6). An earlier run that stopped half-way leaves them. Each
 * key's authority is found by its address. Its delegations are found by a `getProgramAccounts` filtered on the delegator,
 * on `scanRpc`, the endpoint that answers that method. An authority for which the scan finds no delegation is left in place
 * and reported (a scan that lags behind the chain), so that the next clean-up finds it again. The fee is the funding key's
 * (`feePayer`); the held key signs. Returns the problems, as the rest of the clean-up does.
 */
export async function revokeHeldAllowances(
  rpc: Rpc<SolanaRpcApi>,
  scanRpc: Rpc<SolanaRpcApi>,
  feePayer: KeyPairSigner,
  holders: ReadonlyMap<Address, KeyPairSigner>,
  send: SendOptions,
): Promise<string[]> {
  const problems: string[] = [];
  const keys = [...holders.keys()];
  const authorities = await Promise.all(
    keys.map(async (owner) => (await findSubscriptionAuthorityPda({ user: owner, tokenMint: USDC_DEVNET_MINT }))[0]),
  );
  const found: { owner: Address; authority: Address }[] = [];
  for (let start = 0; start < keys.length; start += 100) {
    const batch = authorities.slice(start, start + 100);
    const { value } = await rpc.getMultipleAccounts(batch, { encoding: "base64", commitment: "confirmed" }).send();
    value.forEach((account, offset) => {
      if (account) found.push({ owner: keys[start + offset]!, authority: batch[offset]! });
    });
  }
  for (const { owner, authority } of found) {
    const signer = holders.get(owner)!;
    try {
      const delegations = await scanRpc
        .getProgramAccounts(SUBSCRIPTIONS_PROGRAM_ADDRESS, {
          encoding: "base64",
          commitment: "confirmed",
          filters: [
            // The IDL gives no size: the encoder's fixed size is the account's, 211 bytes.
            { dataSize: BigInt(getRecurringDelegationEncoder().fixedSize) },
            // An address is the base58 text of its 32 bytes.
            { memcmp: { offset: DELEGATOR_OFFSET, bytes: owner as unknown as Base58EncodedBytes, encoding: "base58" } },
          ],
        })
        .send();
      // This harness creates an authority and its delegation in one transaction and closes them in one. An authority that
      // exists with no delegation found means that the scan is behind: closing the authority alone would leave the delegation,
      // and its rent, for good, since a later clean-up looks only at the owners whose authority exists.
      if (delegations.length === 0) {
        problems.push(
          `revoking the allowances of ${owner}: the scan found no delegation for its Subscription Authority, which is left for the next clean-up`,
        );
        continue;
      }
      // `closeSubscriptionAuthority` and not `revokeSubscriptionAuthority`, which also reads the owner's token account: an
      // earlier run may have closed it already, and this clean-up closes it afterwards anyway, which drops its delegate.
      const instructions = [
        ...delegations.flatMap(({ pubkey }) => revokeInstructions({ owner: signer, delegation: pubkey })),
        getCloseSubscriptionAuthorityInstruction({ user: signer, subscriptionAuthority: authority }),
      ];
      // The fee is the funding key's: the held key may hold no SOL by now, and its rent comes back to it.
      await sendInstructions(rpc, feePayer, instructions, send);
    } catch (error) {
      problems.push(`revoking the allowances of ${owner}: ${describeError(error)}`);
    }
  }
  return problems;
}
