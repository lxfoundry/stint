import {
  createKeyPairSignerFromPrivateKeyBytes,
  generateKeyPairSigner,
  getAddressEncoder,
  getSolanaErrorFromJsonRpcError,
  type Instruction,
  type Rpc,
  type SolanaRpcApi,
} from "@solana/kit";
import { describe, expect, it } from "vitest";
import { SubscriptionsInstruction, identifySubscriptionsInstruction } from "@lxfoundry/stint-subscriptions-client";
import { DEVNET_GENESIS_HASH, runAllowanceCommand } from "../src/allowance-command.js";
import { accountsRpc } from "./accounts-rpc.js";

async function ownerFile(): Promise<{ readonly json: string; readonly address: string }> {
  const seed = crypto.getRandomValues(new Uint8Array(32));
  const signer = await createKeyPairSignerFromPrivateKeyBytes(seed);
  return { json: JSON.stringify([...seed, ...getAddressEncoder().encode(signer.address)]), address: signer.address };
}

function harness(genesis = DEVNET_GENESIS_HASH) {
  const sent: Instruction[][] = [];
  const printed: string[] = [];
  const rpc = accountsRpc(new Map(), { genesis });
  return {
    sent,
    printed,
    deps: (json: string) => ({
      rpc: rpc as Rpc<SolanaRpcApi>,
      readKeyFile: () => json,
      send: async (_payer: unknown, instructions: readonly Instruction[]) => (sent.push([...instructions]), "signature"),
      print: (line: string) => printed.push(line),
    }),
  };
}

describe("stint allowance (spec §10.1)", () => {
  it("grants in one transaction, creating the owner's authority, and prints the delegation", async () => {
    const owner = await ownerFile();
    const agent = (await generateKeyPairSigner()).address;
    const h = harness();
    const code = await runAllowanceCommand(
      ["grant", "--keypair", "/k/owner.json", "--agent", agent, "--per-period", "300000", "--period", "3600", "--expires", "2030-01-01T00:00:00Z"],
      h.deps(owner.json),
    );
    expect(code).toBe(0);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.map((ix) => identifySubscriptionsInstruction(ix as never))).toEqual([
      SubscriptionsInstruction.InitSubscriptionAuthority,
      SubscriptionsInstruction.CreateRecurringDelegation,
    ]);
    expect(h.printed.join("\n")).toMatch(/delegation/);
    expect(h.printed.join("\n")).not.toContain(owner.json);
  });

  it("refuses any network but devnet, before sending", async () => {
    const owner = await ownerFile();
    const h = harness("5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d");
    const code = await runAllowanceCommand(
      ["grant", "--keypair", "/k/owner.json", "--agent", owner.address, "--per-period", "1", "--period", "60", "--expires", "2030-01-01T00:00:00Z"],
      h.deps(owner.json),
    );
    expect(code).not.toBe(0);
    expect(h.sent).toHaveLength(0);
    expect(h.printed.join("\n")).toMatch(/devnet/);
  });

  it("refuses an expiry in the past, a period of zero and a malformed address, naming each", async () => {
    const owner = await ownerFile();
    const h = harness();
    const code = await runAllowanceCommand(
      ["grant", "--keypair", "/k/owner.json", "--agent", "nope", "--per-period", "1", "--period", "0", "--expires", "2000-01-01T00:00:00Z"],
      h.deps(owner.json),
    );
    expect(code).not.toBe(0);
    expect(h.sent).toHaveLength(0);
    const out = h.printed.join("\n");
    expect(out).toMatch(/--agent/);
    expect(out).toMatch(/--period/);
    expect(out).toMatch(/--expires/);
  });

  it("prints no URL from a node's error", async () => {
    const owner = await ownerFile();
    const printed: string[] = [];
    const failing = {
      getGenesisHash: () => ({
        send: async () => {
          throw new Error("request to https://node.example/?api-key=SECRET failed");
        },
      }),
    } as unknown as Rpc<SolanaRpcApi>;
    const code = await runAllowanceCommand(["status", "--owner", owner.address, "--agent", owner.address], {
      rpc: failing,
      readKeyFile: () => owner.json,
      send: async () => "signature",
      print: (line) => printed.push(line),
    });
    expect(code).toBe(1);
    expect(printed.join("\n")).not.toContain("SECRET");
  });

  it("revokes the delegation, and closes the authority only when asked", async () => {
    const owner = await ownerFile();
    const agent = (await generateKeyPairSigner()).address;
    const h = harness();
    await runAllowanceCommand(["revoke", "--keypair", "/k/owner.json", "--agent", agent], h.deps(owner.json));
    await runAllowanceCommand(["revoke", "--keypair", "/k/owner.json", "--agent", agent, "--close-authority"], h.deps(owner.json));
    expect(h.sent.map((ixs) => ixs.map((ix) => identifySubscriptionsInstruction(ix as never)))).toEqual([
      [SubscriptionsInstruction.RevokeDelegation],
      [SubscriptionsInstruction.RevokeDelegation, SubscriptionsInstruction.CloseSubscriptionAuthority],
    ]);
  });

  it("refuses a key file that is not JSON, or whose bytes are not all from 0 to 255, without printing any of it", async () => {
    const owner = await ownerFile();
    const agent = (await generateKeyPairSigner()).address;
    // A Uint8Array wraps 256 to 0, so this file would read as a valid keypair if its bytes were coerced.
    const bytes = JSON.parse(owner.json) as number[];
    const wrapped = JSON.stringify([bytes[0]! + 256, ...bytes.slice(1)]);
    for (const contents of [wrapped, "MARKER-hunter2 is not JSON"]) {
      const h = harness();
      const code = await runAllowanceCommand(["revoke", "--keypair", "/k/owner.json", "--agent", agent], h.deps(contents));
      expect(code).toBe(1);
      expect(h.sent).toHaveLength(0);
      const out = h.printed.join("\n");
      expect(out).toMatch(/--keypair \/k\/owner\.json/);
      expect(out).not.toContain(contents);
      expect(out).not.toMatch(/MARKER|hunter2/);
    }
  });

  it("prints why a transaction was refused: the program's error in its cause, and the logs of its simulation", async () => {
    const owner = await ownerFile();
    const agent = (await generateKeyPairSigner()).address;
    const refused = getSolanaErrorFromJsonRpcError({
      code: -32002,
      message: "Transaction simulation failed: Error processing Instruction 1: custom program error: 0x190",
      data: {
        accounts: null,
        err: { InstructionError: [1, { Custom: 400 }] },
        innerInstructions: null,
        loadedAccountsDataSize: null,
        logs: ["Program De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44 invoke [1]", "Program De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44 failed: custom program error: 0x190"],
        replacementBlockhash: null,
        returnData: null,
        unitsConsumed: 1_200n,
      },
    });
    const h = harness();
    const code = await runAllowanceCommand(
      ["grant", "--keypair", "/k/owner.json", "--agent", agent, "--per-period", "1", "--period", "60", "--expires", "2030-01-01T00:00:00Z"],
      { ...h.deps(owner.json), send: async () => { throw refused; } },
    );
    expect(code).toBe(1);
    const out = h.printed.join("\n");
    expect(out).toContain(refused.message);
    expect(out).toContain((refused.cause as Error).message);
    expect(out).toContain("failed: custom program error: 0x190");
  });

  it("reduces every URL in what it prints of a failure: its message, its causes and its logs", async () => {
    const owner = await ownerFile();
    const agent = (await generateKeyPairSigner()).address;
    const failed = Object.assign(new Error("send failed", { cause: new Error("fetch failed", { cause: new Error("connect to https://node.example/?api-key=SECRET refused") }) }), {
      context: { logs: ["Program log: via https://node.example/v2/SECRET"] },
    });
    const h = harness();
    const code = await runAllowanceCommand(["revoke", "--keypair", "/k/owner.json", "--agent", agent], {
      ...h.deps(owner.json),
      send: async () => {
        throw failed;
      },
    });
    expect(code).toBe(1);
    const out = h.printed.join("\n");
    expect(out).toContain("send failed");
    expect(out).toContain("fetch failed");
    expect(out).toContain("connect to https://node.example");
    expect(out).toContain("Program log: via https://node.example");
    expect(out).not.toContain("SECRET");
  });
});
