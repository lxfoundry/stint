import {
  appendTransactionMessageInstructions,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type Instruction,
  type Rpc,
  type Signature,
  type SolanaRpcApi,
  type TransactionSigner,
} from "@solana/kit";

const json = (value: unknown) =>
  JSON.stringify(value, (_, inner) => (typeof inner === "bigint" ? inner.toString() : inner));

export interface SendOptions {
  /** Milliseconds between status reads while waiting for `confirmed`. Default 100: raise it on a shared network. */
  readonly pollMs?: number;
}

/** Builds, signs and sends a version 0 transaction (spec section 3.5), then waits for `confirmed`. */
export async function sendInstructions(
  rpc: Rpc<SolanaRpcApi>,
  feePayer: TransactionSigner,
  instructions: readonly Instruction[],
  options: SendOptions = {},
): Promise<Signature> {
  const { value: latestBlockhash } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  const transaction = await signTransactionMessageWithSigners(message);
  const signature = getSignatureFromTransaction(transaction);
  await rpc.sendTransaction(getBase64EncodedWireTransaction(transaction), { encoding: "base64", preflightCommitment: "confirmed" }).send();
  await confirmSignature(rpc, signature, 15_000, options.pollMs);
  return signature;
}

/** Waits until a transaction is `confirmed`, and throws if it failed. */
export async function confirmSignature(
  rpc: Rpc<SolanaRpcApi>,
  signature: Signature,
  timeoutMs = 15_000,
  pollMs = 100,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { value } = await rpc.getSignatureStatuses([signature]).send();
    const status = value[0];
    if (status?.err) throw new Error(`Transaction ${signature} failed: ${json(status.err)}`);
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") return;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error(`Transaction ${signature} was not confirmed within ${timeoutMs} ms`);
}

/**
 * Simulates one instruction with no accounts and eight 0xff bytes of data, which no program
 * accepts, and returns the logs. Used to check that a program runs at all.
 */
export async function simulateInstruction(
  rpc: Rpc<SolanaRpcApi>,
  feePayer: TransactionSigner,
  programAddress: Address,
): Promise<{ logs: readonly string[] }> {
  const { value: latestBlockhash } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
    (m) => appendTransactionMessageInstructions([{ programAddress, data: new Uint8Array(8).fill(0xff) }], m),
  );
  const transaction = await signTransactionMessageWithSigners(message);
  const { value } = await rpc
    .simulateTransaction(getBase64EncodedWireTransaction(transaction), {
      encoding: "base64",
      commitment: "confirmed",
    })
    .send();
  return { logs: value.logs ?? [] };
}
