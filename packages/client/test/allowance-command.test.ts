import { createKeyPairSignerFromPrivateKeyBytes, generateKeyPairSigner, getAddressEncoder, type Instruction, type Rpc, type SolanaRpcApi } from "@solana/kit";
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
});
