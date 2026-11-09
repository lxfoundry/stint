import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AllowanceReport, SessionTools } from "@lxfoundry/stint-client";
import type { Address, KeyPairSigner } from "@solana/kit";
import { afterEach, describe, expect, it } from "vitest";
import type { DemoChain } from "../../claude-demo/src/chain.js";
import { DEMO_POLICY } from "../../claude-demo/src/config.js";
import { TOOL } from "../../claude-demo/src/state.js";
import type { AllowanceState } from "../src/budget.js";
import { ALLOWANCE_DIR, type AllowanceConfig } from "../src/config.js";
import { createOwnerSide, type AllowanceDeps } from "../src/main.js";

const OWNER = "CciCZMJsih7NY5pet9kc1siPSj7169WSFZoTTQ5dGezx" as Address;
const OWNER_USDC = "2jPivp36NKaGtT2kYKmJHkaEzdEpMFJftv6UGhEd5a9U";
const home = fileURLToPath(new URL("../.cache/main-test/", import.meta.url));

describe("the owner side", () => {
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("reads the owner's account, funds the client from the allowance, and shows the agent's key as the agent", async () => {
    mkdirSync(home, { recursive: true });
    const config: AllowanceConfig = {
      home,
      dir: join(home, ALLOWANCE_DIR),
      gateUrl: "https://gate.example",
      rpcUrl: "https://node.example",
      policy: DEMO_POLICY,
      owner: OWNER,
      nonce: 2n,
    };
    const seen: { chainFor?: Address; toolsFor?: { signer: KeyPairSigner; owner: Address; nonce: bigint }; readerFor?: Address } = {};
    const chain: DemoChain = { usdcAccount: OWNER_USDC, usdcBalance: async () => 19_896_000n, findClose: async () => undefined };
    const deps: AllowanceDeps = {
      makeChain: async (c) => {
        seen.chainFor = c.owner;
        return chain;
      },
      makeTools: (signer, c) => {
        seen.toolsFor = { signer, owner: c.owner, nonce: c.nonce };
        return { tools: {}, closeAll: async () => ({ closed: [], failed: [] }), closeCode: () => undefined } as unknown as SessionTools;
      },
      makeReader: (agent) => {
        seen.readerFor = agent;
        return async (): Promise<AllowanceReport> => ({ owner: OWNER, delegation: OWNER, ownerBalance: 19_896_000n, delegatedAmount: 0n });
      },
    };
    const realFetch = globalThis.fetch;
    const side = createOwnerSide(config, () => {}, deps);
    try {
      const handler = await side.becomeOwner();
      const result = await handler(TOOL.demo, {});
      const state = result.structuredContent as unknown as AllowanceState;
      const agent = seen.toolsFor!.signer.address;
      expect(seen.chainFor).toBe(OWNER);
      expect(seen.toolsFor).toMatchObject({ owner: OWNER, nonce: 2n });
      expect(seen.readerFor).toBe(agent);
      expect(state.wallet).toMatchObject({ address: OWNER, usdc: "19896000" });
      expect(state.allowance).toMatchObject({ owner: OWNER, agent, nonce: "2", read: { status: "none" }, stale: false });
    } finally {
      globalThis.fetch = realFetch;
      await side.shutdown();
    }
  });
});
