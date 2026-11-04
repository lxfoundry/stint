import { getBase64Decoder, type Address, type Rpc, type SolanaRpcApi } from "@solana/kit";

/** Devnet's genesis hash, which the fake reports unless told otherwise. */
const DEVNET = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

/** A node that answers `getAccountInfo` from `accounts`, as `fetchEncodedAccount` reads them, and `getGenesisHash`. */
export function accountsRpc(
  accounts: ReadonlyMap<Address, { readonly owner: Address; readonly data: Uint8Array }>,
  options: { readonly genesis?: string } = {},
): Rpc<SolanaRpcApi> {
  const getAccountInfo = (target: Address) => ({
    send: async () => {
      const account = accounts.get(target);
      if (!account) return { value: null };
      return {
        value: {
          data: [getBase64Decoder().decode(account.data), "base64"],
          executable: false,
          lamports: 1_000_000n,
          owner: account.owner,
          space: BigInt(account.data.length),
        },
      };
    },
  });
  const getGenesisHash = () => ({ send: async () => options.genesis ?? DEVNET });
  return { getAccountInfo, getGenesisHash } as unknown as Rpc<SolanaRpcApi>;
}
