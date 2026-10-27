import { fileURLToPath } from "node:url";
import {
  AccountState,
  TOKEN_PROGRAM_ADDRESS,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  getMintEncoder,
  getMintSize,
  getTokenDecoder,
  getTokenEncoder,
  getTokenSize,
  getTransferCheckedInstruction,
} from "@solana-program/token";
import {
  appendTransactionMessageInstructions,
  blockhash,
  createTransactionMessage,
  generateKeyPairSigner,
  getCompiledTransactionMessageDecoder,
  lamports,
  none,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  some,
  type Address,
  type Instruction,
  type KeyPairSigner,
} from "@solana/kit";
import { FailedTransactionMetadata, LiteSVM } from "litesvm";
import {
  CloseKind,
  STINT_PROGRAM_ADDRESS,
  eventAccounts,
  findSessionPda,
  getCloseInstruction,
  getOpenInstruction,
  getSessionDecoder,
  type ProgramInstruction,
} from "../../src/index.js";

const STINT_SO = fileURLToPath(new URL("../../../../target/deploy/stint.so", import.meta.url));
export const DECIMALS = 6;
const SYSTEM_PROGRAM = "11111111111111111111111111111111" as Address;

export interface Wallet {
  readonly signer: KeyPairSigner;
  /** Its associated token account for the fixture's mint. */
  readonly token: Address;
}

export interface Sent {
  readonly ok: boolean;
  readonly logs: readonly string[];
  /** The custom program error, when the transaction failed with one. */
  readonly errorCode?: number;
  /** Inner instructions with their program address, in order. */
  readonly inner: readonly ProgramInstruction[];
}

export interface OpenOptions {
  readonly authority: Wallet;
  readonly deposit: bigint;
  readonly rate?: bigint;
  readonly minSeconds?: number;
  readonly maxSeconds?: number;
  readonly seed?: bigint;
  readonly receiver?: Address;
  readonly refundOwner?: Address;
  /** The vault account passed to `open`. */
  readonly vault?: Address;
  /** Where the funding transfer goes, when it differs from `vault`. */
  readonly fundedAccount?: Address;
}

export interface CloseOptions {
  readonly session: Address;
  readonly closer: KeyPairSigner;
  readonly kind?: CloseKind;
  readonly vault?: Address;
  readonly receiverToken?: Address;
  readonly refundTo?: Address;
  readonly rentPayer?: Address;
}

export interface Opened {
  readonly session: Address;
  readonly vault: Address;
  readonly sent: Sent;
}

/** Writes an SPL Token account at any address, so tests can also place non-canonical ones. */
function writeTokenAccount(svm: LiteSVM, mint: Address, address: Address, owner: Address, amount: bigint): void {
  const data = getTokenEncoder().encode({
    mint,
    owner,
    amount,
    delegate: none(),
    state: AccountState.Initialized,
    isNative: none(),
    delegatedAmount: 0n,
    closeAuthority: none(),
  });
  svm.setAccount({
    address,
    lamports: lamports(svm.minimumBalanceForRentExemption(BigInt(getTokenSize()))),
    data: Uint8Array.from(data),
    programAddress: TOKEN_PROGRAM_ADDRESS,
    executable: false,
    space: BigInt(getTokenSize()),
  });
}

/** A new key with 1 SOL, and its associated token account holding `amount`. */
async function newWallet(svm: LiteSVM, mint: Address, amount: bigint): Promise<Wallet> {
  const signer = await generateKeyPairSigner();
  svm.airdrop(signer.address, lamports(1_000_000_000n));
  const [token] = await findAssociatedTokenPda({ owner: signer.address, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  writeTokenAccount(svm, mint, token, signer.address, amount);
  return { signer, token };
}

/** A LiteSVM instance with the Stint program, a mint, a seller and a rent payer. */
export class Fixture {
  private constructor(
    readonly svm: LiteSVM,
    readonly payer: KeyPairSigner,
    readonly mint: Address,
    readonly rentPayer: KeyPairSigner,
    readonly seller: Wallet,
    readonly receiverAuthorizer: KeyPairSigner,
  ) {}

  static async create(): Promise<Fixture> {
    const svm = new LiteSVM();
    svm.addProgramFromFile(STINT_PROGRAM_ADDRESS, STINT_SO);
    const payer = await generateKeyPairSigner();
    const rentPayer = await generateKeyPairSigner();
    const receiverAuthorizer = await generateKeyPairSigner();
    for (const key of [payer, rentPayer, receiverAuthorizer]) svm.airdrop(key.address, lamports(10_000_000_000n));
    const mint = (await generateKeyPairSigner()).address;
    const mintData = getMintEncoder().encode({
      mintAuthority: some(payer.address),
      supply: 0n,
      decimals: DECIMALS,
      isInitialized: true,
      freezeAuthority: none(),
    });
    svm.setAccount({
      address: mint,
      lamports: lamports(svm.minimumBalanceForRentExemption(BigInt(getMintSize()))),
      data: Uint8Array.from(mintData),
      programAddress: TOKEN_PROGRAM_ADDRESS,
      executable: false,
      space: BigInt(getMintSize()),
    });
    const seller = await newWallet(svm, mint, 0n);
    return new Fixture(svm, payer, mint, rentPayer, seller, receiverAuthorizer);
  }

  wallet(amount: bigint): Promise<Wallet> {
    return newWallet(this.svm, this.mint, amount);
  }

  writeTokenAccount(address: Address, owner: Address, amount: bigint, mint: Address = this.mint): void {
    writeTokenAccount(this.svm, mint, address, owner, amount);
  }

  /** Removes an account as closing it does: it then reads as an empty System-owned one (spec S12). */
  removeAccount(address: Address): void {
    this.svm.setAccount({
      address,
      lamports: lamports(0n),
      data: new Uint8Array(),
      programAddress: SYSTEM_PROGRAM,
      executable: false,
      space: 0n,
    });
  }

  /** The token amount at an address, or undefined when no token account is there. */
  tokenAmount(address: Address): bigint | undefined {
    const account = this.svm.getAccount(address);
    if (!account.exists || account.programAddress !== TOKEN_PROGRAM_ADDRESS) return undefined;
    return getTokenDecoder().decode(account.data).amount;
  }

  lamportsOf(address: Address): bigint {
    return this.svm.getBalance(address) ?? 0n;
  }

  exists(address: Address): boolean {
    return this.svm.getAccount(address).exists;
  }

  now(): bigint {
    return this.svm.getClock().unixTimestamp;
  }

  setNow(unixTimestamp: bigint): void {
    const clock = this.svm.getClock();
    clock.unixTimestamp = unixTimestamp;
    this.svm.setClock(clock);
  }

  async ata(owner: Address): Promise<Address> {
    const [token] = await findAssociatedTokenPda({ owner, mint: this.mint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    return token;
  }

  /** Sends a version 0 transaction paid by the fixture's payer, then expires the blockhash. */
  async send(instructions: readonly Instruction[]): Promise<Sent> {
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(this.payer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: blockhash(this.svm.latestBlockhash()), lastValidBlockHeight: 0n }, m),
      (m) => appendTransactionMessageInstructions(instructions, m),
    );
    const transaction = await signTransactionMessageWithSigners(message);
    const { staticAccounts } = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
    const result = this.svm.sendTransaction(transaction);
    // Identical transactions are refused while their blockhash is valid: always start afresh.
    this.svm.expireBlockhash();
    const failed = result instanceof FailedTransactionMetadata;
    const meta = failed ? result.meta() : result;
    const inner = meta
      .innerInstructions()
      .flat()
      .map((entry) => ({
        programAddress: staticAccounts[entry.instruction().programIdIndex()]!,
        data: entry.instruction().data(),
      }));
    const errorCode = failed
      ? (result.err() as { err?: () => { code?: number } }).err?.()?.code
      : undefined;
    return { ok: !failed, logs: meta.logs(), inner, ...(errorCode === undefined ? {} : { errorCode }) };
  }

  /** The transaction layout of spec §5.3: create the vault, fund it, then `open`. */
  async open(options: OpenOptions): Promise<Opened> {
    const seed = options.seed ?? BigInt(Math.floor(Math.random() * 2 ** 48));
    const [session] = await findSessionPda(options.authority.signer.address, seed);
    const canonicalVault = await this.ata(session);
    const vault = options.vault ?? canonicalVault;
    const fund: Instruction[] = [
      getCreateAssociatedTokenIdempotentInstruction({
        payer: this.rentPayer,
        ata: canonicalVault,
        owner: session,
        mint: this.mint,
      }),
      getTransferCheckedInstruction({
        source: options.authority.token,
        mint: this.mint,
        destination: options.fundedAccount ?? vault,
        authority: options.authority.signer,
        amount: options.deposit,
        decimals: DECIMALS,
      }),
    ];
    const open = getOpenInstruction({
      authority: options.authority.signer,
      rentPayer: this.rentPayer,
      session,
      mint: this.mint,
      vault,
      receiver: options.receiver ?? this.seller.signer.address,
      receiverAuthorizer: this.receiverAuthorizer.address,
      refundOwner: options.refundOwner ?? options.authority.signer.address,
      ...(await eventAccounts()),
      seed,
      rate: options.rate ?? 1_000n,
      minSeconds: options.minSeconds ?? 5,
      maxSeconds: options.maxSeconds ?? 120,
    });
    const sent = await this.send([...fund, open]);
    return { session, vault, sent };
  }

  /** `close`, with each account derived from the stored session unless overridden. */
  async close(options: CloseOptions): Promise<Sent> {
    const account = this.svm.getAccount(options.session);
    if (!account.exists) throw new Error(`no session at ${options.session}`);
    const stored = getSessionDecoder().decode(account.data);
    const instruction = getCloseInstruction({
      closer: options.closer,
      session: options.session,
      vault: options.vault ?? (await this.ata(options.session)),
      receiverToken: options.receiverToken ?? (await this.ata(stored.receiver)),
      refundTo: options.refundTo ?? (await this.ata(stored.refundOwner)),
      rentPayer: options.rentPayer ?? stored.rentPayer,
      ...(await eventAccounts()),
      kind: options.kind ?? CloseKind.Standard,
    });
    return this.send([instruction]);
  }
}
