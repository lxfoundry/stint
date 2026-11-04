import { getCreateAccountInstruction } from "@solana-program/system";
import {
  TOKEN_PROGRAM_ADDRESS,
  fetchMaybeMint,
  fetchMaybeToken,
  getBurnCheckedInstruction,
  getCloseAccountInstruction,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getInitializeMint2Instruction,
  getMintSize,
  getMintToCheckedInstruction,
  getTransferCheckedInstruction,
} from "@solana-program/token";
import { generateKeyPairSigner, type Address, type Instruction, type KeyPairSigner, type Rpc, type SolanaRpcApi } from "@solana/kit";
import { readUntil, type DirectChain, type OtherMint } from "@lxfoundry/stint-conformance";
import {
  CloseKind,
  eventAccounts,
  fetchMaybeSession,
  findSessionPda,
  getCloseInstruction,
  getOpenInstruction,
  getTopUpInstruction,
  paidUntil,
} from "@lxfoundry/stint-program-client";
import { associatedTokenAddress, randomSeed, type RetryOptions, type Terms } from "@lxfoundry/stint-x402";
import { USDC_DECIMALS, USDC_DEVNET_MINT } from "../fixtures/usdc.js";
import { sendInstructions, type SendOptions } from "../network/transactions.js";

/** How long `OtherMint.reclaim` waits before it reads a balance again that a node may have shown stale. */
const RECLAIM_RETRY_MS = 2_000;

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
  /**
   * The keypair of the harness's second mint (spec §12.6), which is also its mint authority. Called once, at the first
   * `otherMint()`. Default: a fresh key. The devnet target derives it from the seed, so that every run finds the same mint.
   */
  readonly otherMint?: () => Promise<KeyPairSigner>;
}

interface Parties {
  readonly rentPayer: KeyPairSigner;
  readonly receiverAuthorizer: Address;
}

/**
 * Sessions opened, topped up and closed straight on the program, for the scenarios that need one that no gate, facilitator
 * or sweeper holds, or a top-up that none of them makes (spec §12.2). The open is the layout of spec §5.3 with real
 * signers: the rent payer creates the vault,
 * the buyer funds it, and the program opens the session. The receiver authorizer is a throwaway key whose secret is
 * dropped, unless `open` names another: only the buyer can then close the session before its paid time, and anyone from
 * then on. A session in the second mint (`otherMint`) has a mint other than the offer's asset (S5).
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

  /** What the second mint lets the harness do, with `key` as both the mint and its authority. */
  const otherMintOf = (key: KeyPairSigner): OtherMint => ({
    mint: key.address,
    async fund(owner, amount) {
      const account = await associatedTokenAddress(owner, key.address);
      const instructions: Instruction[] = [await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: feePayer, owner, mint: key.address })];
      if (amount > 0n) {
        instructions.push(getMintToCheckedInstruction({ mint: key.address, token: account, mintAuthority: key, amount, decimals: USDC_DECIMALS }));
      }
      await sendInstructions(rpc, feePayer, instructions, send);
      return account;
    },
    async reclaim(owner) {
      const account = await associatedTokenAddress(owner.address, key.address);
      // A node that lags can show an older balance than the account holds, right after the close that refunded it, and
      // then closing the account fails: the balance is read again, after a pause, and the reclaim tried once more.
      for (let attempt = 1; ; attempt++) {
        const held = await fetchMaybeToken(rpc, account, { commitment: "confirmed" });
        if (!held.exists) return;
        const instructions: Instruction[] = [];
        if (held.data.amount > 0n) {
          instructions.push(getBurnCheckedInstruction({ account, mint: key.address, authority: owner, amount: held.data.amount, decimals: USDC_DECIMALS }));
        }
        instructions.push(getCloseAccountInstruction({ account, destination: feePayer.address, owner }));
        try {
          await sendInstructions(rpc, feePayer, instructions, send);
          return;
        } catch (error) {
          if (attempt >= 2) throw error;
          await new Promise((resolve) => setTimeout(resolve, RECLAIM_RETRY_MS));
        }
      }
    },
  });
  let otherMint: Promise<OtherMint> | undefined;
  /** The second mint, created the first time if its account does not exist yet: on devnet, an earlier run made it. */
  const otherMintOnce = (): Promise<OtherMint> =>
    (otherMint ??= (async () => {
      const key = await (options.otherMint ?? generateKeyPairSigner)();
      if (!(await fetchMaybeMint(rpc, key.address, { commitment: "confirmed" })).exists) {
        const space = BigInt(getMintSize());
        const lamports = await rpc.getMinimumBalanceForRentExemption(space).send();
        await sendInstructions(
          rpc,
          feePayer,
          [
            getCreateAccountInstruction({ payer: feePayer, newAccount: key, lamports, space, programAddress: TOKEN_PROGRAM_ADDRESS }),
            getInitializeMint2Instruction({ mint: key.address, decimals: USDC_DECIMALS, mintAuthority: key.address }),
          ],
          send,
        );
      }
      return otherMintOf(key);
    })().catch((error: unknown) => {
      otherMint = undefined;
      throw error;
    }));

  return {
    async open({ buyer, seconds, remainder = 0n, receiverAuthorizer, mint = USDC_DEVNET_MINT }) {
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
      const parties = await partiesOnce();
      const deposit = terms.rate * BigInt(seconds) + remainder;
      const seed = randomSeed();
      const [session] = await findSessionPda(buyer.signer.address, seed);
      const vault = await associatedTokenAddress(session, mint);
      // USDC comes from the buyer's USDC account and pays the seller's; another mint, from and to their accounts for it.
      const usdc = mint === USDC_DEVNET_MINT;
      const source = usdc ? buyer.usdcAccount : await associatedTokenAddress(buyer.signer.address, mint);
      const receiverToken = usdc ? seller.usdcAccount : await associatedTokenAddress(seller.wallet, mint);
      await sendInstructions(
        rpc,
        feePayer,
        [
          await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: parties.rentPayer, owner: session, mint }),
          getTransferCheckedInstruction({
            source,
            mint,
            destination: vault,
            authority: buyer.signer,
            amount: deposit,
            decimals: USDC_DECIMALS,
          }),
          getOpenInstruction({
            authority: buyer.signer,
            rentPayer: parties.rentPayer,
            session,
            mint,
            vault,
            receiver: seller.wallet,
            receiverAuthorizer: receiverAuthorizer ?? parties.receiverAuthorizer,
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
        mint,
        rentPayer: parties.rentPayer.address,
        receiverToken,
        refundTo: source,
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

    async topUp({ buyer, session, seconds }) {
      if (!Number.isInteger(seconds) || seconds < 1) throw new Error(`A top-up buys a whole number of seconds, at least 1: got ${seconds}`);
      const vault = await associatedTokenAddress(session, USDC_DEVNET_MINT);
      return sendInstructions(
        rpc,
        feePayer,
        [
          getTransferCheckedInstruction({
            source: buyer.usdcAccount,
            mint: USDC_DEVNET_MINT,
            destination: vault,
            authority: buyer.signer,
            amount: terms.rate * BigInt(seconds),
            decimals: USDC_DECIMALS,
          }),
          getTopUpInstruction({ authority: buyer.signer, session, vault, ...(await eventAccounts()) }),
        ],
        send,
      );
    },

    newKey: () => generateKeyPairSigner(),

    otherMint: otherMintOnce,
  };
}
