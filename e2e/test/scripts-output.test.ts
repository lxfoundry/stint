import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REPO_ROOT } from "../src/paths.js";

const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const KEYED_URL = "http://127.0.0.1:9/?api-key=FAKEKEY123";
const PROGRAM_ID = /^stint *= *"(.*)"$/m.exec(
  readFileSync(join(REPO_ROOT, "Anchor.toml"), "utf8").split("[programs.devnet]")[1] ?? "",
)?.[1];

/**
 * A stand-in `solana` that reports devnet's genesis hash and a funded payer, then fails the way the real
 * CLI does when a request cannot be sent: it names the URL it was given, key included, on stderr.
 */
const FAKE_SOLANA = `#!/usr/bin/env bash
url=""
for ((i = 1; i <= $#; i++)); do
  if [[ "\${!i}" == "--url" ]]; then j=$((i + 1)); url="\${!j}"; fi
done
case "$1 $2" in
  "genesis-hash "*) echo "${DEVNET_GENESIS}" ;;
  "balance "*) echo "3000000000 lamports" ;;
  *)
    echo "Buffer: BufferAddressForTheTest" >&2
    echo "Error: error sending request for url ($url/)" >&2
    echo "status line from $url" >&2
    exit 1
    ;;
esac
`;
const FAKE_KEYGEN = `#!/usr/bin/env bash
echo "${PROGRAM_ID}"
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
    writeFileSync(join(dir, "payer.json"), "[]");
    writeFileSync(join(dir, "program.so"), sbpfV3Header());
    writeFileSync(join(dir, "program-keypair.json"), "[]");
    env = { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}` };
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

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
