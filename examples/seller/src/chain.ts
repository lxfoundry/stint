import { getTransferSolInstruction } from "@solana-program/system";
import { getCreateAssociatedTokenIdempotentInstructionAsync } from "@solana-program/token";
import {
  appendTransactionMessageInstructions,
  createTransactionMessage,
  fetchEncodedAccount,
  getBase58Decoder,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type Base58EncodedBytes,
  type Instruction,
  type KeyPairSigner,
  type Rpc,
  type Signature,
  type SolanaRpcApi,
} from "@solana/kit";
import {
  CloseKind,
  SESSION_DISCRIMINATOR,
  STINT_PROGRAM_ADDRESS,
  eventAccounts,
  fetchMaybeSession,
  getCloseInstruction,
  getSessionDecoder,
  getSessionSize,
  paidUntil,
  type Session,
} from "@lxfoundry/stint-program-client";
import { associatedTokenAddress, redactUrls } from "@lxfoundry/stint-x402";
import { fetchSysvarClock } from "@solana/sysvars";

/** Devnet's genesis hash: the network identifier `solana:EtWT…` is its first 32 characters (spec §5.1). */
export const DEVNET_GENESIS_HASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
/** Where a session account stores `rent_payer` (`programs/stint/src/state.rs`; the sweeper filters on it too). */
const RENT_PAYER_OFFSET = 178n;

const json = (value: unknown) => JSON.stringify(value, (_, inner) => (typeof inner === "bigint" ? inner.toString() : inner));

/** Refuses to go on unless the RPC is devnet's: nothing this process sends may reach another network. */
export async function assertDevnet(rpc: Rpc<SolanaRpcApi>): Promise<void> {
  const genesis = await rpc.getGenesisHash().send();
  if (genesis !== DEVNET_GENESIS_HASH) throw new Error(`The RPC reports genesis hash ${genesis}, which is not devnet's: refusing to start`);
}

export async function assertProgramDeployed(rpc: Rpc<SolanaRpcApi>): Promise<void> {
  const account = await rpc.getAccountInfo(STINT_PROGRAM_ADDRESS, { encoding: "base64" }).send();
  if (!account.value?.executable) throw new Error(`The Stint program ${STINT_PROGRAM_ADDRESS} is not deployed on this network`);
}

/** Builds, signs and sends a version 0 transaction (spec §3.5), then waits for `confirmed`; throws if it failed. */
export async function sendInstructions(
  rpc: Rpc<SolanaRpcApi>,
  feePayer: KeyPairSigner,
  instructions: readonly Instruction[],
  pollMs = 400,
  timeoutMs = 30_000,
): Promise<Signature> {
  const { value: lifetime } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(lifetime, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  const transaction = await signTransactionMessageWithSigners(message);
  const signature = getSignatureFromTransaction(transaction);
  await rpc.sendTransaction(getBase64EncodedWireTransaction(transaction), { encoding: "base64", preflightCommitment: "confirmed" }).send();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { value } = await rpc.getSignatureStatuses([signature]).send();
    const status = value[0];
    if (status?.err) throw new Error(`Transaction ${signature} failed: ${json(status.err)}`);
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") return signature;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error(`Transaction ${signature} was not confirmed within ${timeoutMs} ms`);
}

/** What brings `balance` up to `target`: nothing when it holds as much or more. */
export const lamportsToSend = (balance: bigint, target: bigint): bigint => (balance < target ? target - balance : 0n);

/**
 * What the funding key holds on top of what it sends at a start: the rent of the seller's token account (2,039,280
 * lamports) and of the token accounts the clean-up may create, and the start-up's fees.
 */
export const FUNDING_MARGIN_LAMPORTS = 10_000_000n;

/**
 * What the funding key must hold for a start: what it owes the stack's keys and the margin, whenever it has anything to
 * pay, the seller's missing token account included; nothing when it has nothing to pay.
 */
export const fundingNeeded = (owed: bigint, needsAccount: boolean): bigint =>
  owed > 0n || needsAccount ? owed + FUNDING_MARGIN_LAMPORTS : 0n;

/** Tops `to` up to `target` lamports from `from`, which pays the fee. Returns what it sent. */
export async function topUpSol(rpc: Rpc<SolanaRpcApi>, from: KeyPairSigner, to: Address, target: bigint): Promise<bigint> {
  const { value: balance } = await rpc.getBalance(to, { commitment: "confirmed" }).send();
  const amount = lamportsToSend(balance, target);
  if (amount > 0n) await sendInstructions(rpc, from, [getTransferSolInstruction({ source: from, destination: to, amount })]);
  return amount;
}

/** The owner's associated token account for `mint`, created by `payer` if it does not exist yet. */
export async function ensureTokenAccount(rpc: Rpc<SolanaRpcApi>, payer: KeyPairSigner, owner: Address, mint: Address): Promise<Address> {
  const account = await associatedTokenAddress(owner, mint);
  if ((await fetchEncodedAccount(rpc, account, { commitment: "confirmed" })).exists) return account;
  await sendInstructions(rpc, payer, [await getCreateAssociatedTokenIdempotentInstructionAsync({ payer, owner, mint })]);
  return account;
}

export interface ListedSession {
  readonly address: Address;
  readonly stored: Session;
}

/**
 * The sessions a start-up closes: those this deployment opened (its rent payer) for its gate (its receiver authorizer)
 * whose paid time has not run out. The receiver authorizer may close them before `paid_until` (spec §4.3); from then on
 * the sweeper closes them, as it closes any expired session naming the facilitator's rent payer (spec §6.4).
 */
export function closableAtStart(
  sessions: readonly ListedSession[],
  keys: { readonly rentPayer: Address; readonly receiverAuthorizer: Address },
  nowSeconds: bigint,
): Address[] {
  return sessions
    .filter(({ stored }) => stored.rentPayer === keys.rentPayer && stored.receiverAuthorizer === keys.receiverAuthorizer && paidUntil(stored) > nowSeconds)
    .map(({ address }) => address);
}

/** The program's sessions whose rent `rentPayer` paid. */
export async function listSessionsOf(rpc: Rpc<SolanaRpcApi>, rentPayer: Address): Promise<ListedSession[]> {
  const accounts = await rpc
    .getProgramAccounts(STINT_PROGRAM_ADDRESS, {
      commitment: "confirmed",
      encoding: "base64",
      filters: [
        { dataSize: BigInt(getSessionSize()) },
        { memcmp: { offset: 0n, bytes: getBase58Decoder().decode(SESSION_DISCRIMINATOR) as Base58EncodedBytes, encoding: "base58" } },
        { memcmp: { offset: RENT_PAYER_OFFSET, bytes: rentPayer as string as Base58EncodedBytes, encoding: "base58" } },
      ],
    })
    .send();
  const decoder = getSessionDecoder();
  const base64 = getBase64Encoder();
  return accounts.map(({ pubkey, account }) => ({ address: pubkey, stored: decoder.decode(base64.encode(account.data[0])) }));
}

export interface CleanUpReport {
  readonly closed: Address[];
  readonly failed: { readonly session: Address; readonly error: string }[];
}

/** The chain's clock, in Unix seconds, from the Clock sysvar: the program decides by it, not by this machine's. */
async function chainNow(rpc: Rpc<SolanaRpcApi>): Promise<bigint> {
  return (await fetchSysvarClock(rpc, { commitment: "confirmed" })).unixTimestamp;
}

/**
 * Closes the sessions an earlier process left open (`closableAtStart`, on the chain's clock), each with a `Standard`
 * close signed by the receiver authorizer, its fee paid by the funding key: the seller is paid for the time used, the
 * buyer refunded the rest. Each is read again on `rpc` first, since `scanRpc` may be another node. Before `paid_until`
 * the close needs the buyer's refund account, and it always needs the receiver's: the same transaction first creates
 * both if they are gone, paid by the funding key, so nothing is half done (a transaction is atomic). A close that fails
 * is reported, and the session is left to the sweeper at its paid time. Never throws for one session.
 */
export async function closeLeftSessions(
  rpc: Rpc<SolanaRpcApi>,
  scanRpc: Rpc<SolanaRpcApi>,
  funding: KeyPairSigner,
  keys: { readonly rentPayer: Address; readonly receiverAuthorizer: KeyPairSigner },
): Promise<CleanUpReport> {
  const mine = { rentPayer: keys.rentPayer, receiverAuthorizer: keys.receiverAuthorizer.address };
  const report: { closed: Address[]; failed: { session: Address; error: string }[] } = { closed: [], failed: [] };
  for (const session of closableAtStart(await listSessionsOf(scanRpc, keys.rentPayer), mine, await chainNow(rpc))) {
    try {
      const current = await fetchMaybeSession(rpc, session, { commitment: "confirmed" });
      // Read just before the close is built: a session read as paid for that lands after `paid_until` only creates the
      // refund account for nothing, but one read as expired is the sweeper's.
      if (!current.exists || closableAtStart([{ address: session, stored: current.data }], mine, await chainNow(rpc)).length === 0) continue;
      const stored = current.data;
      await sendInstructions(rpc, funding, [
        await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: funding, owner: stored.receiver, mint: stored.mint }),
        await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: funding, owner: stored.refundOwner, mint: stored.mint }),
        getCloseInstruction({
          closer: keys.receiverAuthorizer,
          session,
          vault: await associatedTokenAddress(session, stored.mint),
          receiverToken: await associatedTokenAddress(stored.receiver, stored.mint),
          refundTo: await associatedTokenAddress(stored.refundOwner, stored.mint),
          rentPayer: stored.rentPayer,
          ...(await eventAccounts()),
          kind: CloseKind.Standard,
        }),
      ]);
      report.closed.push(session);
    } catch (error) {
      report.failed.push({ session, error: redactUrls(error instanceof Error ? error.message : String(error)) });
    }
  }
  return report;
}
