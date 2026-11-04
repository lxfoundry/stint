import { readFileSync } from "node:fs";
import {
  appendTransactionMessageInstructions,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Instruction,
  type Rpc,
  type SolanaRpcApi,
  type TransactionSigner,
} from "@solana/kit";
import { runAllowanceCommand } from "./allowance-command.js";
import { createNodeRpc, hideNodeUrl, isNodeUrl } from "./node.js";

/** Builds, signs and sends a version 0 transaction (spec §3.5), then waits for `confirmed`, for up to 60 s. */
async function send(rpc: Rpc<SolanaRpcApi>, payer: TransactionSigner, instructions: readonly Instruction[]): Promise<string> {
  const { value: lifetime } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(payer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(lifetime, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  const transaction = await signTransactionMessageWithSigners(message);
  const signature = getSignatureFromTransaction(transaction);
  await rpc.sendTransaction(getBase64EncodedWireTransaction(transaction), { encoding: "base64", preflightCommitment: "confirmed" }).send();
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const { value } = await rpc.getSignatureStatuses([signature]).send();
    const status = value[0];
    if (status?.err) throw new Error(`Transaction ${signature} failed: ${JSON.stringify(status.err, (_, v) => (typeof v === "bigint" ? v.toString() : v))}`);
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") return signature;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`Transaction ${signature} was not confirmed within 60 s`);
}

const [command, ...rest] = process.argv.slice(2);
if (command !== "allowance") {
  console.error("Usage: stint allowance grant | revoke | status …");
  process.exit(2);
}
// From the environment, not the command line: an RPC URL may carry an API key, and pnpm echoes the command line.
const rpcUrl = process.env.STINT_RPC_URL?.trim() ?? "";
if (!isNodeUrl(rpcUrl)) {
  // The value is not quoted, for the same reason.
  console.error("STINT_RPC_URL must be set to an http or https URL: the node the command reads from and sends through");
  process.exit(2);
}
// Its errors carry no part of the URL that may be a key, so neither does anything the command prints.
const rpc = createNodeRpc(rpcUrl);
process.exitCode = await runAllowanceCommand(rest, {
  rpc,
  readKeyFile: (path) => readFileSync(path, "utf8"),
  send: (payer, instructions) => send(rpc, payer, instructions),
  // Every line goes through `hideNodeUrl`, so that none of the URL's user info, path, query or fragment is printed.
  print: (line) => console.log(hideNodeUrl(rpcUrl, line)),
});
