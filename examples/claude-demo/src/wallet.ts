import { existsSync, linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createKeyPairSignerFromBytes, createKeyPairSignerFromPrivateKeyBytes, getAddressEncoder, type KeyPairSigner } from "@solana/kit";
import type { Policy } from "@lxfoundry/stint-client";
import { SOLANA_DEVNET } from "@lxfoundry/stint-x402";

/** The agent's key, in the `stint-demo` folder of `STINT_DEMO_HOME`: a Solana CLI keypair file, a JSON array of 64 bytes. */
export const WALLET_FILE = "agent.json";
/** A key file that is not yet complete (one made by an older version or another tool) is read a few times before it is called invalid. */
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
 * Makes `path` hold `contents`, whole and readable by its owner only, unless the name is taken: true when this call
 * made it, false when another did. The contents go to a temporary file beside `path` (a name unique to this call, mode
 * 0600 from its creation), which is then linked to `path`: the link fails if the name exists, and the name appears with
 * everything in it at once. The temporary file is removed in every case. After a crash, a `*.tmp` file may remain.
 */
function publish(path: string, contents: string): boolean {
  const temp = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    writeFileSync(temp, contents, { mode: 0o600, flag: "wx" });
    try {
      linkSync(temp, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
    return true;
  } finally {
    rmSync(temp, { force: true });
  }
}

/**
 * The agent's key at `dir/agent.json` (`dir` is `STINT_DEMO_HOME/stint-demo`), the folder created if it is missing. A
 * file that is there is used, and never overwritten, even one that is not a key: that is an error. With none, a fresh
 * key is made, and only for a policy that allows devnet alone.
 *
 * What is guaranteed. The name `agent.json` never exists half written: the key is written whole to a private temporary
 * file in the same folder (mode 0600 from its creation), which is then linked to `agent.json` (the link fails if the
 * name is taken). A crash or a kill can leave an `agent.json.*.tmp` file (a full disk leaves none), never a truncated
 * `agent.json`, and a leftover `*.tmp` file is neither read as the key nor in the way. Copies that start at once make
 * one key: the one whose link succeeds keeps it, and the others read its file. A key file that is there but not yet complete (one made
 * by an older version or another tool) is read a few times, about 0.4 s in all, before it is called invalid.
 */
export async function loadOrCreateWallet(dir: string, policy: Pick<Policy, "networks">): Promise<Wallet> {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, WALLET_FILE);
  if (existsSync(path)) return { signer: await readWhenWritten(path), path, created: false };
  if (!allowsDevnetOnly(policy)) {
    throw new WalletError(`There is no key at ${path}, and none is made for a policy that allows a network other than devnet`);
  }
  const privateKey = crypto.getRandomValues(new Uint8Array(32));
  const signer = await createKeyPairSignerFromPrivateKeyBytes(privateKey);
  const bytes = [...privateKey, ...getAddressEncoder().encode(signer.address)];
  if (!publish(path, JSON.stringify(bytes))) return { signer: await readWhenWritten(path), path, created: false };
  return { signer, path, created: true };
}
