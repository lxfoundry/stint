import {
  appendTransactionMessageInstructions,
  blockhash,
  createNoopSigner,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  partiallySignTransactionMessageWithSigners,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Instruction,
  type KeyPairSigner,
} from "@solana/kit";
import { inspectTransaction } from "../src/index.js";

export async function rebuild(
  wire: string,
  signer: KeyPairSigner,
  change: (instructions: readonly Instruction[]) => readonly Instruction[],
): Promise<string> {
  const tx = inspectTransaction(wire)!;
  // Re-attach the signer to every account meta it appears in, so signing finds it.
  const instructions = change(tx.instructions).map((instruction) => ({
    ...instruction,
    accounts: instruction.accounts?.map((meta) =>
      meta.address === signer.address ? { ...meta, signer } : tx.signers.includes(meta.address) ? { ...meta, signer: createNoopSigner(meta.address) } : meta,
    ),
  }));
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(tx.feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: blockhash(tx.blockhash), lastValidBlockHeight: 0n }, m),
    (m) => appendTransactionMessageInstructions(instructions as Instruction[], m),
  );
  return getBase64EncodedWireTransaction(await partiallySignTransactionMessageWithSigners(message));
}
