import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createKeyPairSignerFromBytes, createKeyPairSignerFromPrivateKeyBytes, getAddressEncoder, type KeyPairSigner } from "@solana/kit";
import type { Policy } from "@lxfoundry/stint-client";
import { SOLANA_DEVNET } from "@lxfoundry/stint-x402";

/** The agent's key, in the `stint-demo` folder of `STINT_DEMO_HOME`: a Solana CLI keypair file, a JSON array of 64 bytes. */
export const WALLET_FILE = "agent.json";
/** A copy that finds the file another has just created reads it a few times while it may be half written. */
const READ_ATTEMPTS = 5;
const READ_DELAY_MS = 100;

export class WalletError extends Error {
  override name = "WalletError";
}

export interface Wallet {
  readonly signer: KeyPairSigner;
  readonly path: string;
  readonly created: boolean;
}

/** Whether `policy` allows devnet and nothing else (the client's default is devnet). */
export function allowsDevnetOnly(policy: Pick<Policy, "networks">): boolean {
  const networks = policy.networks ?? [SOLANA_DEVNET];
  return networks.length > 0 && networks.every((network) => network === SOLANA_DEVNET);
}

/** Nothing from the file reaches a message: a parser's error quotes the text it was given. */
async function readWallet(path: string): Promise<KeyPairSigner> {
  let bytes: unknown;
  try {
    bytes = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new WalletError(`${path} cannot be read, or is not JSON`);
  }
  if (!Array.isArray(bytes) || bytes.length !== 64 || !bytes.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)) {
    throw new WalletError(`${path} does not hold a keypair: a JSON array of 64 bytes`);
  }
  try {
    return await createKeyPairSignerFromBytes(Uint8Array.from(bytes as number[]));
  } catch {
    throw new WalletError(`${path} does not hold a keypair: its public half is not its private half's`);
  }
}

async function readWhenWritten(path: string): Promise<KeyPairSigner> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await readWallet(path);
    } catch (error) {
      if (attempt >= READ_ATTEMPTS) throw error;
      await new Promise((resolve) => setTimeout(resolve, READ_DELAY_MS));
    }
  }
}

/**
 * The agent's key at `dir/agent.json` (`dir` is `STINT_DEMO_HOME/stint-demo`), the folder created if it is missing. A
 * file that is there is used, and never overwritten, even one that is not a key: that is an error. With none, a fresh
 * key is written, readable by its owner only, and only for a policy that allows devnet alone. Two copies that start at
 * once make one key: the second finds the first's file.
 */
export async function loadOrCreateWallet(dir: string, policy: Pick<Policy, "networks">): Promise<Wallet> {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, WALLET_FILE);
  if (existsSync(path)) return { signer: await readWallet(path), path, created: false };
  if (!allowsDevnetOnly(policy)) {
    throw new WalletError(`There is no key at ${path}, and none is made for a policy that allows a network other than devnet`);
  }
  const privateKey = crypto.getRandomValues(new Uint8Array(32));
  const signer = await createKeyPairSignerFromPrivateKeyBytes(privateKey);
  const bytes = [...privateKey, ...getAddressEncoder().encode(signer.address)];
  try {
    writeFileSync(path, JSON.stringify(bytes), { mode: 0o600, flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return { signer: await readWhenWritten(path), path, created: false };
  }
  return { signer, path, created: true };
}
