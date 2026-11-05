import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createSessionTools, createStintClient } from "@lxfoundry/stint-client";
import { DEMO_POLICY, createCallHandler, createDemo, createRpcDemoChain, recordExchanges } from "@lxfoundry/stint-claude-demo";
import {
  ALLOWANCE_TOOL,
  createAllowanceReader,
  createAllowanceServer,
  withAllowance,
  type AllowanceState,
} from "@lxfoundry/stint-claude-demo-allowance";
import type { AllowanceGrant } from "@lxfoundry/stint-conformance";
import { USDC_DEVNET, associatedTokenAddress } from "@lxfoundry/stint-x402";
import type { Address } from "@solana/kit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startLocalStack, type LocalStack } from "../src/targets/local.js";

// The allowance example (`examples/claude-demo-allowance`) as the copy that holds its state runs it, with no Claude: the
// first example's demo on the owner's account, the client funded from a grant made on the local network, and the
// allowance example's wrapper and server. A launch of 20 s costs 20,000 base units at the local stack's rate; the cap is
// 30,000, so the second launch is refused by the chain.

const LAUNCH_SECONDS = 20;
const LAUNCH_COST = 20_000n;

describe("the allowance example on the local stack", () => {
  let stack: LocalStack;
  const realFetch = globalThis.fetch;

  beforeAll(async () => {
    stack = await startLocalStack();
  });

  afterAll(async () => {
    globalThis.fetch = realFetch;
    await stack?.stop();
  });

  const balanceOf = async (account: string) =>
    BigInt((await stack.network.rpc.getTokenAccountBalance(account as Address, { commitment: "confirmed" }).send()).value.amount);

  it("pulls a launch from the owner, refunds the owner at the close, and has the chain refuse a launch past the cap", async () => {
    const control = stack.context().allowance;
    if (!control) throw new Error("the local target grants no allowance");
    const grant: AllowanceGrant = await control.grant({ usdc: 1_000_000n, perPeriod: 30_000n, periodSeconds: 3_600 });
    const owner = grant.owner.signer.address;
    const agent = grant.agent.address;
    const client = new Client({ name: "e2e", version: "1.0.0" });
    let demo: ReturnType<typeof withAllowance> | undefined;
    try {
      const tools = createSessionTools(createStintClient({ signer: grant.agent, policy: DEMO_POLICY, allowance: { owner, nonce: grant.nonce } }));
      const chain = await createRpcDemoChain(stack.network.rpcUrl, owner);
      const gateUrl = stack.stream.url;
      const inner = createDemo({ address: owner, gateUrl, tools, chain, launchSeconds: LAUNCH_SECONDS, log: () => {} });
      demo = withAllowance(inner, {
        owner,
        agent,
        nonce: grant.nonce,
        read: createAllowanceReader(stack.network.rpc, { owner, agent, mint: USDC_DEVNET.mint, nonce: grant.nonce }),
        amounts: { launch: LAUNCH_COST, topUp: LAUNCH_COST },
      });
      globalThis.fetch = recordExchanges(gateUrl, demo.sink, realFetch);
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await createAllowanceServer({ html: "<!doctype html><title>panel</title>", call: createCallHandler(demo, () => {}), log: () => {} }).connect(serverTransport);
      await client.connect(clientTransport);
      const call = async (name: string) => {
        const result = await client.callTool({ name, arguments: {} });
        return { isError: result.isError === true, text: (result.content as { text: string }[])[0]!.text, state: result.structuredContent as unknown as AllowanceState };
      };
      const before = await balanceOf(grant.owner.usdcAccount);

      const launched = await call(ALLOWANCE_TOOL.launch);

      expect(launched.isError, launched.text).toBe(false);
      expect(launched.state.session).toMatchObject({ state: "open", deposited: LAUNCH_COST.toString() });
      expect(launched.state.wallet.address).toBe(owner);
      expect(launched.state.allowance).toMatchObject({ agent, read: { status: "active", pulled: "20000", left: "10000" } });
      expect(await balanceOf(grant.owner.usdcAccount)).toBe(before - LAUNCH_COST);
      // The agent never holds USDC: it has no token account at all.
      const agentUsdc = await associatedTokenAddress(agent, USDC_DEVNET.mint);
      expect((await stack.network.rpc.getAccountInfo(agentUsdc, { commitment: "confirmed" }).send()).value).toBeNull();

      const closed = await call(ALLOWANCE_TOOL.close);

      expect(closed.isError, closed.text).toBe(false);
      const refunded = BigInt(closed.state.session.refunded!);
      expect(refunded).toBeGreaterThan(0n);
      expect(await balanceOf(grant.owner.usdcAccount)).toBe(before - LAUNCH_COST + refunded);
      // A refund does not restore the allowance.
      expect(closed.state.allowance.read).toMatchObject({ pulled: "20000", left: "10000" });

      const refused = await call(ALLOWANCE_TOOL.launch);

      expect(refused.isError).toBe(true);
      expect(refused.text).toMatch(/^Refused on-chain: the allowance for this period is used up \(0\.020 of 0\.030 USDC pulled; the period ends at \d\d:\d\d UTC\)\. The gate refused the payment: /);
      expect(refused.text).toContain("simulation_failed");
      expect(refused.state.error?.message).toMatch(/^Refused on-chain: the allowance for this period is used up .* The gate answered simulation_failed\.$/);
      expect(await balanceOf(grant.owner.usdcAccount)).toBe(before - LAUNCH_COST + refunded);
    } finally {
      await demo?.shutdown();
      await client.close();
      globalThis.fetch = realFetch;
      await control.revoke(grant);
    }
  });
});
