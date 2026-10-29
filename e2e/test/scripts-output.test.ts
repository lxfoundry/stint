import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REPO_ROOT } from "../src/paths.js";

const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const KEYED_URL = "http://127.0.0.1:9/?api-key=FAKEKEY123";
const PROGRAM_ID = /^stint *= *"(.*)"$/m.exec(
  readFileSync(join(REPO_ROOT, "Anchor.toml"), "utf8").split("[programs.devnet]")[1] ?? "",
)?.[1];

/**
 * A stand-in `solana` that reports a genesis hash (devnet's, unless `FAKE_GENESIS` names another) and a funded
 * payer, then fails the way the real CLI does when a request cannot be sent: it names the URL it was given, and
 * the WebSocket URL it derives from it, key included, on stderr.
 */
const FAKE_SOLANA = `#!/usr/bin/env bash
url=""
for ((i = 1; i <= $#; i++)); do
  if [[ "\${!i}" == "--url" ]]; then j=$((i + 1)); url="\${!j}"; fi
done
case "$1 $2" in
  "genesis-hash "*) echo "\${FAKE_GENESIS:-${DEVNET_GENESIS}}" ;;
  "balance "*) echo "3000000000 lamports" ;;
  *)
    echo "Buffer: BufferAddressForTheTest" >&2
    echo "Error: error sending request for url ($url/)" >&2
    echo "status line from $url" >&2
    echo "websocket error from \${url/http/ws}" >&2
    exit 1
    ;;
esac
`;
/** A stand-in \`solana-keygen pubkey <file>\`: each test keypair file holds its own public key as text. */
const FAKE_KEYGEN = `#!/usr/bin/env bash
cat "$2"
`;

/** The first 64 bytes of a BPF ELF64 file with SBPF v3 flags: all the deploy script reads. */
function sbpfV3Header(): Buffer {
  const bytes = Buffer.alloc(64);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
  bytes.writeUInt16LE(247, 18);
  bytes.writeUInt32LE(3, 48);
  return bytes;
}

describe("the deployment scripts' output", () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;

  beforeAll(() => {
    mkdirSync(join(REPO_ROOT, "e2e/.cache"), { recursive: true });
    dir = mkdtempSync(join(REPO_ROOT, "e2e/.cache/scripts-"));
    for (const [name, text] of [["solana", FAKE_SOLANA], ["solana-keygen", FAKE_KEYGEN]] as const) {
      writeFileSync(join(dir, name), text);
      chmodSync(join(dir, name), 0o755);
    }
    writeFileSync(join(dir, "payer.json"), "PayerKey1111111111111111111111111111111111");
    writeFileSync(join(dir, "program.so"), sbpfV3Header());
    writeFileSync(join(dir, "program-keypair.json"), PROGRAM_ID ?? "");
    // A home of its own, so that the Solana CLI's default wallet is a test file and never the real one.
    mkdirSync(join(dir, "home/.config/solana"), { recursive: true });
    writeFileSync(join(dir, "home/.config/solana/id.json"), "DefaultWa11et111111111111111111111111111111");
    env = { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}`, HOME: join(dir, "home") };
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const deploy = (args: string[], extra: NodeJS.ProcessEnv = {}) =>
    spawnSync(
      "bash",
      ["scripts/deploy-devnet.sh", "--program", join(dir, "program.so"), "--program-keypair", join(dir, "program-keypair.json"), ...args],
      { cwd: REPO_ROOT, env: { ...env, ...extra }, encoding: "utf8" },
    );

  it("deploy refuses an RPC that is not devnet, before it sends anything", () => {
    const run = deploy(["--payer", join(dir, "payer.json"), "--url", KEYED_URL, "--dry-run"], { FAKE_GENESIS: MAINNET_GENESIS });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(`reports genesis hash ${MAINNET_GENESIS}, which is not devnet's`);
    expect(run.stdout).not.toContain("dry run");
  });

  it("deploy refuses a copy of the Solana CLI's default wallet as payer", () => {
    // Another path, the same key.
    writeFileSync(join(dir, "copy-of-id.json"), "DefaultWa11et111111111111111111111111111111");
    const run = deploy(["--payer", join(dir, "copy-of-id.json"), "--url", KEYED_URL, "--dry-run"]);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("the Solana CLI's default wallet");
    expect(run.stdout).not.toContain("dry run");
  });

  it("deploy keeps a failed deployment's messages and exits non-zero, without the RPC URL's key", () => {
    const run = spawnSync(
      "bash",
      [
        "scripts/deploy-devnet.sh",
        "--payer", join(dir, "payer.json"),
        "--program", join(dir, "program.so"),
        "--program-keypair", join(dir, "program-keypair.json"),
        "--url", KEYED_URL,
      ],
      { cwd: REPO_ROOT, env, encoding: "utf8" },
    );
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("Buffer: BufferAddressForTheTest");
    expect(run.stderr).toContain("error sending request for url (http://127.0.0.1:9)");
    expect(run.stderr).toContain("websocket error from ws://127.0.0.1:9");
    expect(run.stdout + run.stderr).not.toContain("FAKEKEY123");
  });

  it("verify does not print the RPC URL's key when the dump fails", () => {
    const run = spawnSync(
      "bash",
      ["scripts/verify-deployment.sh", join(dir, "program.so"), PROGRAM_ID ?? "", KEYED_URL],
      { cwd: REPO_ROOT, env, encoding: "utf8" },
    );
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("cannot dump");
    expect(run.stdout + run.stderr).not.toContain("FAKEKEY123");
  });
});
