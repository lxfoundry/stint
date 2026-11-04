import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { SOLANA_DEVNET, SOLANA_MAINNET } from "@lxfoundry/stint-x402";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IGNORE_FILE, WALLET_FILE, WalletError, allowsDevnetOnly, ensureDemoFolder, loadOrCreateWallet } from "../src/wallet.js";

// Under the package, in a git-ignored directory: `/tmp` can be emptied at any time.
const scratch = fileURLToPath(new URL("../.cache/", import.meta.url));
const DEVNET = { networks: [SOLANA_DEVNET] };

/** Whether this file system keeps a file's mode: a Windows drive mounted in WSL does not. */
function keepsModes(directory: string): boolean {
  const probe = join(directory, "mode-probe");
  writeFileSync(probe, "", { mode: 0o600 });
  const kept = (statSync(probe).mode & 0o777) === 0o600;
  rmSync(probe);
  return kept;
}

describe("the agent's wallet", () => {
  let home: string;
  beforeEach(() => {
    mkdirSync(scratch, { recursive: true });
    home = mkdtempSync(join(scratch, "wallet-"));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("creates its folder and a Solana CLI keypair file once, and loads it from then on", async () => {
    const dir = join(home, "stint-demo");
    const created = await loadOrCreateWallet(dir, DEVNET);
    expect(created).toMatchObject({ created: true, path: join(dir, WALLET_FILE) });
    const bytes = JSON.parse(readFileSync(created.path, "utf8")) as number[];
    expect(bytes).toHaveLength(64);
    expect((await createKeyPairSignerFromBytes(Uint8Array.from(bytes))).address).toBe(created.signer.address);
    const loaded = await loadOrCreateWallet(dir, DEVNET);
    expect(loaded).toMatchObject({ created: false, path: created.path });
    expect(loaded.signer.address).toBe(created.signer.address);
  });

  // Not under the package: `/mnt/<drive>` (a Windows drive in WSL) reports every mode as 777, so this one runs in the
  // home directory. It is skipped only where even the home directory does not keep modes.
  it("writes the key file readable by its owner only", async (context) => {
    const parent = join(homedir(), ".cache");
    mkdirSync(parent, { recursive: true });
    const folder = mkdtempSync(join(parent, "stint-claude-demo-test-"));
    try {
      if (!keepsModes(folder)) context.skip("the home directory does not keep file modes");
      const dir = join(folder, "stint-demo");
      const created = await loadOrCreateWallet(dir, DEVNET);
      expect(statSync(created.path).mode & 0o777).toBe(0o600);
      expect(readdirSync(dir)).toEqual([WALLET_FILE]);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it("makes one key when several copies start at once, and leaves nothing but the key file", async () => {
    const wallets = await Promise.all(Array.from({ length: 8 }, () => loadOrCreateWallet(home, DEVNET)));
    expect(new Set(wallets.map((wallet) => wallet.signer.address)).size).toBe(1);
    expect(wallets.filter((wallet) => wallet.created)).toHaveLength(1);
    expect(readdirSync(home)).toEqual([WALLET_FILE]);
  });

  it("is not blocked by a temporary file that a crashed writer left, and does not take it for the wallet", async () => {
    const other = await loadOrCreateWallet(join(home, "other"), DEVNET);
    const whole = join(home, `${WALLET_FILE}.4242.dead.tmp`);
    const truncated = join(home, `${WALLET_FILE}.4243.dead.tmp`);
    writeFileSync(whole, readFileSync(other.path));
    writeFileSync(truncated, "[12, 34");
    const created = await loadOrCreateWallet(home, DEVNET);
    expect(created.created).toBe(true);
    expect(created.signer.address).not.toBe(other.signer.address);
    expect((await loadOrCreateWallet(home, DEVNET)).signer.address).toBe(created.signer.address);
    expect(readFileSync(whole)).toEqual(readFileSync(other.path));
    expect(readFileSync(truncated, "utf8")).toBe("[12, 34");
  });

  it("waits for a key file that is there but not yet written, as one made by an older version or another tool can be", async () => {
    const source = await loadOrCreateWallet(join(home, "source"), DEVNET);
    const dir = join(home, "slow");
    mkdirSync(dir);
    const path = join(dir, WALLET_FILE);
    writeFileSync(path, "");
    const fill = setTimeout(() => writeFileSync(path, readFileSync(source.path)), 150);
    try {
      const loaded = await loadOrCreateWallet(dir, DEVNET);
      expect(loaded).toMatchObject({ created: false, path });
      expect(loaded.signer.address).toBe(source.signer.address);
    } finally {
      clearTimeout(fill);
    }
  });

  it("never overwrites a file that is not a key, and quotes none of it", async () => {
    const path = join(home, WALLET_FILE);
    writeFileSync(path, "[1, 2, 3] secret words");
    const error = await loadOrCreateWallet(home, DEVNET).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(WalletError);
    expect((error as Error).message).not.toMatch(/secret words/);
    expect(readFileSync(path, "utf8")).toBe("[1, 2, 3] secret words");
  });

  it("keeps a failed removal of its temporary file from failing the start, and says so", async () => {
    const lines: string[] = [];
    const removed: string[] = [];
    const remove = (path: string) => {
      removed.push(path);
      throw Object.assign(new Error(`EBUSY: resource busy or locked, unlink '${path}'`), { code: "EBUSY" });
    };
    const created = await loadOrCreateWallet(home, DEVNET, { log: (line) => void lines.push(line), remove });
    expect(created).toMatchObject({ created: true, path: join(home, WALLET_FILE) });
    expect(removed).toHaveLength(1);
    expect(removed[0]).toMatch(/agent\.json\.\d+\..+\.tmp$/);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/could not remove .*\.tmp: EBUSY/);
    // The key file is whole, and the next start loads it.
    expect((await loadOrCreateWallet(home, DEVNET)).signer.address).toBe(created.signer.address);
    // A removal that fails with no one to tell is not an error either.
    const quiet = await loadOrCreateWallet(join(home, "quiet"), DEVNET, { remove });
    expect(quiet.created).toBe(true);
  });

  it("makes no key for a policy that allows a network other than devnet", async () => {
    expect(allowsDevnetOnly({})).toBe(true);
    expect(allowsDevnetOnly({ networks: [SOLANA_DEVNET, SOLANA_MAINNET] })).toBe(false);
    expect(allowsDevnetOnly({ networks: [] })).toBe(false);
    await expect(loadOrCreateWallet(home, { networks: [SOLANA_MAINNET] })).rejects.toThrow(/none is made/);
    expect(() => readFileSync(join(home, WALLET_FILE))).toThrow();
  });
});

describe("the demo's folder", () => {
  let home: string;
  beforeEach(() => {
    mkdirSync(scratch, { recursive: true });
    home = mkdtempSync(join(scratch, "folder-"));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("creates the folder with a .gitignore that ignores everything in it, so that a repository around it never commits the key", () => {
    const dir = join(home, "not", "yet", "stint-demo");
    ensureDemoFolder(dir);
    expect(readFileSync(join(dir, IGNORE_FILE), "utf8")).toBe("*\n");
    expect(readdirSync(dir)).toEqual([IGNORE_FILE]);
  });

  it("writes one into a folder that has none, and leaves one that is there alone", () => {
    const bare = join(home, "bare");
    mkdirSync(bare);
    ensureDemoFolder(bare);
    expect(readFileSync(join(bare, IGNORE_FILE), "utf8")).toBe("*\n");
    const own = join(home, "own");
    mkdirSync(own);
    writeFileSync(join(own, IGNORE_FILE), "agent.json\n");
    ensureDemoFolder(own);
    ensureDemoFolder(own);
    expect(readFileSync(join(own, IGNORE_FILE), "utf8")).toBe("agent.json\n");
  });

  it("logs a .gitignore it cannot write, with each URL in the message cut to its host, and still creates the folder", () => {
    const dir = join(home, "stint-demo");
    const lines: string[] = [];
    const write = () => {
      throw new Error("EACCES: permission denied (https://rpc.example/v2?api-key=secret-marker)");
    };
    expect(() => ensureDemoFolder(dir, (line) => void lines.push(line), write)).not.toThrow();
    expect(readdirSync(dir)).toEqual([]);
    expect(lines).toEqual([`could not write ${join(dir, IGNORE_FILE)}: EACCES: permission denied (https://rpc.example)`]);
  });
});
