import { getCreateAssociatedTokenIdempotentInstructionAsync, getTransferCheckedInstruction } from "@solana-program/token";
import { generateKeyPairSigner, type Address, type KeyPairSigner, type Rpc, type SolanaRpcApi } from "@solana/kit";
import { readUntil, type DirectChain } from "@lxfoundry/stint-conformance";
import {
  CloseKind,
  eventAccounts,
  fetchMaybeSession,
  findSessionPda,
  getCloseInstruction,
  getOpenInstruction,
  paidUntil,
} from "@lxfoundry/stint-program-client";
import { associatedTokenAddress, randomSeed, type RetryOptions, type Terms } from "@lxfoundry/stint-x402";
import { USDC_DECIMALS, USDC_DEVNET_MINT } from "../fixtures/usdc.js";
import { sendInstructions, type SendOptions } from "../network/transactions.js";

export interface DirectChainOptions {
  readonly rpc: Rpc<SolanaRpcApi>;
  /** The seller's offer: the rate every session is opened at, and the shortest and longest it may be. */
  readonly terms: Terms;
  /** The session's receiver, and the token account that a close pays. */
  readonly seller: { readonly wallet: Address; readonly usdcAccount: Address };
  /** Pays the fee of every transaction the chain sends, so that no other key's balance changes by it. */
  readonly feePayer: KeyPairSigner;
  /**
   * The key that pays the rent of every session the chain opens, and gets it back at the close. Called once, at the
   * first open: a target that makes keys when it starts returns its key, and one that draws keys as it goes draws one and
   * gives it enough SOL for a session account and its vault. It must not be the facilitator's, and it must not be the fee payer.
   */
  readonly rentPayer: () => Promise<KeyPairSigner>;
  /** How patiently the chain reads a session it has just opened. */
  readonly readRetry: RetryOptions;
  readonly send?: SendOptions;
}

interface Parties {
  readonly rentPayer: KeyPairSigner;
  readonly receiverAuthorizer: Address;
}

/**
 * Sessions opened and closed straight on the program, for the scenarios that need one that no gate, facilitator or
 * sweeper holds (spec §12.2). The open is the layout of spec §5.3 with real signers: the rent payer creates the vault,
 * the buyer funds it, and the program opens the session. The receiver authorizer is a throwaway key whose secret is
 * dropped: only the buyer can close the session before its paid time, and anyone from then on.
 */
export function createDirectChain(options: DirectChainOptions): DirectChain {
  const { rpc, terms, seller, feePayer, readRetry, send } = options;
  let parties: Promise<Parties> | undefined;
  const partiesOnce = (): Promise<Parties> =>
    (parties ??= (async () => ({
      rentPayer: await options.rentPayer(),
      receiverAuthorizer: (await generateKeyPairSigner()).address,
    }))().catch((error: unknown) => {
      parties = undefined;
      throw error;
    }));

  return {
    async open({ buyer, seconds, remainder = 0n }) {
      if (!Number.isInteger(seconds) || seconds < terms.minSeconds || seconds > terms.maxSeconds) {
        throw new Error(`A session lasts a whole number of seconds between ${terms.minSeconds} and ${terms.maxSeconds}: got ${seconds}`);
      }
      if (remainder < 0n || remainder >= terms.rate) {
        throw new Error(`A remainder is a number of base units below the rate (${terms.rate}): got ${remainder}`);
      }
      // The program refuses a deposit above the cost of the longest session.
      if (remainder > 0n && seconds === terms.maxSeconds) {
        throw new Error(`The longest session takes no remainder (${terms.maxSeconds} s is the most the offer sells): got ${remainder}`);
      }
      const { rentPayer, receiverAuthorizer } = await partiesOnce();
      const deposit = terms.rate * BigInt(seconds) + remainder;
      const seed = randomSeed();
      const [session] = await findSessionPda(buyer.signer.address, seed);
      const vault = await associatedTokenAddress(session, USDC_DEVNET_MINT);
      await sendInstructions(
        rpc,
        feePayer,
        [
          await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: rentPayer, owner: session, mint: USDC_DEVNET_MINT }),
          getTransferCheckedInstruction({
            source: buyer.usdcAccount,
            mint: USDC_DEVNET_MINT,
            destination: vault,
            authority: buyer.signer,
            amount: deposit,
            decimals: USDC_DECIMALS,
          }),
          getOpenInstruction({
            authority: buyer.signer,
            rentPayer,
            session,
            mint: USDC_DEVNET_MINT,
            vault,
            receiver: seller.wallet,
            receiverAuthorizer,
            refundOwner: buyer.signer.address,
            ...(await eventAccounts()),
            seed,
            rate: terms.rate,
            minSeconds: terms.minSeconds,
            maxSeconds: terms.maxSeconds,
          }),
        ],
        send,
      );
      const opened = await readUntil(readRetry, () => fetchMaybeSession(rpc, session, { commitment: "confirmed" }), (read) => read.exists);
      if (!opened.exists) throw new Error(`The session ${session} is not on the chain after its open was confirmed`);
      return {
        session,
        vault,
        rentPayer: rentPayer.address,
        receiverToken: seller.usdcAccount,
        refundTo: buyer.usdcAccount,
        deposit,
        startedAt: opened.data.startedAt,
        paidUntil: paidUntil(opened.data),
      };
    },

    async close(opened, closer) {
      return sendInstructions(
        rpc,
        feePayer,
        [
          getCloseInstruction({
            closer,
            session: opened.session,
            vault: opened.vault,
            receiverToken: opened.receiverToken,
            refundTo: opened.refundTo,
            rentPayer: opened.rentPayer,
            ...(await eventAccounts()),
            kind: CloseKind.Standard,
          }),
        ],
        send,
      );
    },

    newKey: () => generateKeyPairSigner(),
  };
}
