import { getTransferSolInstruction } from "@solana-program/system";
import {
  findAssociatedTokenPda,
  getCloseAccountInstruction,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getTokenDecoder,
  getTransferCheckedInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import {
  fetchEncodedAccounts,
  getBase64Encoder,
  type Address,
  type Instruction,
  type KeyPairSigner,
  type Rpc,
  type SolanaRpcApi,
} from "@solana/kit";
import { describeError } from "@lxfoundry/stint-conformance";
import {
  CloseKind,
  STINT_PROGRAM_ADDRESS,
  eventAccounts,
  fetchMaybeSession,
  getCloseInstruction,
  getSessionDecoder,
  getSessionSize,
} from "@lxfoundry/stint-program-client";
import { associatedTokenAddress } from "@lxfoundry/stint-x402";
import { USDC_DECIMALS, USDC_DEVNET_MINT } from "../fixtures/usdc.js";
import { sendInstructions, type SendOptions } from "../network/transactions.js";

/** The key the harness funds everything from, and its USDC account (spec §12.6). */
export interface Funding {
  readonly signer: KeyPairSigner;
  readonly usdcAccount: Address;
}

/** The fee of a transaction with one signature. */
const FEE = 5_000n;
/** The most accounts that one `getMultipleAccounts` reads. */
const BATCH = 100;

/** Sends SOL; the sender pays the fee. */
export async function sendSol(rpc: Rpc<SolanaRpcApi>, from: KeyPairSigner, to: Address, lamports: bigint, options: SendOptions): Promise<void> {
  await sendInstructions(rpc, from, [getTransferSolInstruction({ source: from, destination: to, amount: lamports })], options);
}

/** Creates the owner's USDC account, paid by the funding key, and funds it with `amount`. Returns the account. */
export async function fundUsdcAccount(rpc: Rpc<SolanaRpcApi>, funding: Funding, owner: Address, amount: bigint, options: SendOptions): Promise<Address> {
  const [account] = await findAssociatedTokenPda({ owner, mint: USDC_DEVNET_MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  const instructions: Instruction[] = [
    await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: funding.signer, owner, mint: USDC_DEVNET_MINT }),
  ];
  if (amount > 0n) {
    instructions.push(
      getTransferCheckedInstruction({
        source: funding.usdcAccount,
        mint: USDC_DEVNET_MINT,
        destination: account,
        authority: funding.signer,
        amount,
        decimals: USDC_DECIMALS,
      }),
    );
  }
  await sendInstructions(rpc, funding.signer, instructions, options);
  return account;
}

/** What one key holds: its SOL, and its USDC account's balance, or `undefined` when it has no such account. */
export interface Held {
  readonly owner: Address;
  readonly lamports: bigint;
  readonly usdcAccount: Address;
  readonly usdc: bigint | undefined;
}

async function readAll(rpc: Rpc<SolanaRpcApi>, addresses: readonly Address[]) {
  const accounts = [];
  for (let from = 0; from < addresses.length; from += BATCH) {
    accounts.push(...(await fetchEncodedAccounts(rpc, addresses.slice(from, from + BATCH), { commitment: "confirmed" })));
  }
  return accounts;
}

/** What each of `owners` holds, in a few batched reads: a start-up must not cost one request per key. */
export async function scanHolders(rpc: Rpc<SolanaRpcApi>, owners: readonly Address[]): Promise<Held[]> {
  const usdcAccounts = await Promise.all(owners.map((owner) => associatedTokenAddress(owner, USDC_DEVNET_MINT)));
  const wallets = await readAll(rpc, owners);
  const tokens = await readAll(rpc, usdcAccounts);
  const decoder = getTokenDecoder();
  // An address that only received lamports after its account was closed is System-owned and holds no token data (S12):
  // it is not a USDC account, and must not stop the scan of the others.
  const balanceOf = (account: (typeof tokens)[number]): bigint | undefined => {
    if (!account.exists || account.programAddress !== TOKEN_PROGRAM_ADDRESS) return undefined;
    try {
      return decoder.decode(account.data).amount;
    } catch {
      return undefined;
    }
  };
  return owners.map((owner, position) => {
    const wallet = wallets[position]!;
    return {
      owner,
      lamports: wallet.exists ? wallet.lamports : 0n,
      usdcAccount: usdcAccounts[position]!,
      usdc: balanceOf(tokens[position]!),
    };
  });
}

/** Moves `amount` base units from a USDC account back to the funding key's, then closes it so that its rent returns too. */
export async function returnUsdc(
  rpc: Rpc<SolanaRpcApi>,
  funding: Funding,
  owner: KeyPairSigner,
  account: Address,
  amount: bigint,
  options: SendOptions,
): Promise<void> {
  const instructions: Instruction[] = [];
  if (amount > 0n) {
    instructions.push(
      getTransferCheckedInstruction({
        source: account,
        mint: USDC_DEVNET_MINT,
        destination: funding.usdcAccount,
        authority: owner,
        amount,
        decimals: USDC_DECIMALS,
      }),
    );
  }
  instructions.push(getCloseAccountInstruction({ account, destination: funding.signer.address, owner }));
  await sendInstructions(rpc, funding.signer, instructions, options);
}

/**
 * `returnUsdc` for an amount that may be stale: a node that lags can report a smaller balance than the account
 * holds, and then closing the account fails. If the first attempt fails, the balance is read again, after a
 * pause, and the return is tried once more with it.
 */
export async function returnUsdcRetrying(
  rpc: Rpc<SolanaRpcApi>,
  funding: Funding,
  owner: KeyPairSigner,
  account: Address,
  amount: bigint,
  options: SendOptions,
): Promise<void> {
  try {
    await returnUsdc(rpc, funding, owner, account, amount, options);
  } catch {
    await new Promise((resolve) => setTimeout(resolve, (options.pollMs ?? 400) * 2));
    const [now] = await scanHolders(rpc, [owner.address]);
    if (now?.usdc === undefined) return; // the account is gone: the first attempt landed after all
    await returnUsdc(rpc, funding, owner, account, now.usdc, options);
  }
}

/** Sends `lamports`, less the key's own fee, back to the funding key. */
export async function returnSol(rpc: Rpc<SolanaRpcApi>, funding: Funding, from: KeyPairSigner, lamports: bigint, options: SendOptions): Promise<void> {
  if (lamports > FEE) await sendSol(rpc, from, funding.signer.address, lamports - FEE, options);
}

/** The sessions that name a held key: those the clean-up acts on, and those of another mint, which it leaves alone. */
export interface FoundSessions {
  /** Sessions of the configured USDC mint. */
  readonly sessions: Address[];
  /** Sessions of any other mint: the harness never opens one, closing it would create accounts it cannot recover, and it is not its to fix. */
  readonly otherMint: Address[];
}

/**
 * The sessions on the program that one of `owners` opened, receives or paid the rent of. The clean-up
 * finds sessions here, on the chain, and not in the gate's log: a session whose open was answered
 * `settlement_pending` is on the chain too, and a start-up has no log at all. Only sessions of the USDC mint
 * are for the clean-up to close; those of another mint are set apart, to be reported and left alone.
 */
export async function findOpenSessions(rpc: Rpc<SolanaRpcApi>, owners: ReadonlySet<Address>): Promise<FoundSessions> {
  const accounts = await rpc
    .getProgramAccounts(STINT_PROGRAM_ADDRESS, { commitment: "confirmed", encoding: "base64", filters: [{ dataSize: BigInt(getSessionSize()) }] })
    .send();
  const decoder = getSessionDecoder();
  const base64 = getBase64Encoder();
  const found: FoundSessions = { sessions: [], otherMint: [] };
  for (const { pubkey, account } of accounts) {
    const session = decoder.decode(base64.encode(account.data[0]));
    if (!owners.has(session.authority) && !owners.has(session.receiver) && !owners.has(session.rentPayer)) continue;
    (session.mint === USDC_DEVNET_MINT ? found.sessions : found.otherMint).push(pubkey);
  }
  return found;
}

export interface CloseOutcome {
  readonly closed: Address[];
  readonly failed: { readonly session: Address; readonly error: string }[];
}

/**
 * Closes each session that is still open with a `Standard` close (spec §4.3). The signer is the session's
 * authority when `signers` holds that key, and otherwise its `receiver_authorizer`: before `paid_until`
 * the program accepts either, and from `paid_until` anyone. When the harness holds neither, the funding key
 * tries, which succeeds only from `paid_until` on; before that the session is reported. The funding key pays
 * the fee: a buyer holds no SOL. The two accounts the close pays are created first, in the same transaction,
 * if they are gone (spec §12.6; S7): a transaction is atomic (S13), so nothing is half done. The refund account
 * is created even when nothing is owed to it; for an owner outside the pool (the example agent) whose account
 * had been closed, that donates its rent, about 0.002 SOL.
 */
export async function closeSessions(
  rpc: Rpc<SolanaRpcApi>,
  funding: Funding,
  sessions: readonly Address[],
  signers: ReadonlyMap<Address, KeyPairSigner>,
  options: SendOptions,
): Promise<CloseOutcome> {
  const outcome: { closed: Address[]; failed: { session: Address; error: string }[] } = { closed: [], failed: [] };
  for (const session of new Set(sessions)) {
    let held = true;
    try {
      const account = await fetchMaybeSession(rpc, session, { commitment: "confirmed" });
      if (!account.exists) continue;
      const stored = account.data;
      const heldCloser = signers.get(stored.authority) ?? signers.get(stored.receiverAuthorizer);
      held = heldCloser !== undefined;
      const closer = heldCloser ?? funding.signer;
      const instructions: Instruction[] = [
        await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: funding.signer, owner: stored.receiver, mint: stored.mint }),
        await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: funding.signer, owner: stored.refundOwner, mint: stored.mint }),
        getCloseInstruction({
          closer,
          session,
          vault: await associatedTokenAddress(session, stored.mint),
          receiverToken: await associatedTokenAddress(stored.receiver, stored.mint),
          refundTo: await associatedTokenAddress(stored.refundOwner, stored.mint),
          rentPayer: stored.rentPayer,
          ...(await eventAccounts()),
          kind: CloseKind.Standard,
        }),
      ];
      await sendInstructions(rpc, funding.signer, instructions, options);
      outcome.closed.push(session);
    } catch (error) {
      const hint = held ? "" : " (the harness holds neither the authority nor the receiver authorizer, so if the program refused, the session can only be closed from its paid time on)";
      outcome.failed.push({ session, error: `${describeError(error)}${hint}` });
    }
  }
  return outcome;
}

/**
 * Brings everything the `holders` keys have on the chain back to the funding key: closes their sessions,
 * then returns their USDC and SOL. Safe to run at any time and any number of times, after any run or
 * none. Sessions of a mint other than USDC that name a held key are reported as a note and left alone: they
 * do not stop a start, and closing one would create accounts for a mint the harness does not hold. A USDC
 * balance that was read stale is read again once. Returns what went wrong; throws nothing.
 */
export async function cleanUp(
  rpc: Rpc<SolanaRpcApi>,
  funding: Funding,
  holders: ReadonlyMap<Address, KeyPairSigner>,
  options: SendOptions,
): Promise<string[]> {
  const problems: string[] = [];
  const attempt = async (what: string, work: () => Promise<unknown>) => {
    try {
      await work();
    } catch (error) {
      problems.push(`${what}: ${describeError(error)}`);
    }
  };
  await attempt("closing sessions", async () => {
    const { sessions, otherMint } = await findOpenSessions(rpc, new Set(holders.keys()));
    if (otherMint.length > 0) {
      console.error(`devnet target: note: ${otherMint.length} session(s) of another mint name a held key and are left alone: ${otherMint.join(", ")}`);
    }
    const outcome = await closeSessions(rpc, funding, sessions, holders, options);
    for (const failure of outcome.failed) problems.push(`closing session ${failure.session}: ${failure.error}`);
  });
  let held: Held[] = [];
  await attempt("reading what the keys hold", async () => {
    held = await scanHolders(rpc, [...holders.keys()]);
  });
  for (const { owner, usdcAccount, usdc } of held) {
    if (usdc === undefined) continue;
    await attempt(`returning the USDC of ${owner}`, () => returnUsdcRetrying(rpc, funding, holders.get(owner)!, usdcAccount, usdc, options));
  }
  for (const { owner, lamports } of held) {
    await attempt(`returning the SOL of ${owner}`, () => returnSol(rpc, funding, holders.get(owner)!, lamports, options));
  }
  return problems;
}
