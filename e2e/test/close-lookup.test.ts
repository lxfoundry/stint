import { findClose } from "@lxfoundry/stint-conformance";
import { CloseKind, fetchMaybeSession } from "@lxfoundry/stint-program-client";
import type { Address } from "@solana/kit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sendSol } from "../src/devnet/funds.js";
import { fundSol, newHarnessKey } from "../src/fixtures/keys.js";
import { waitForNewSlot } from "../src/network/surfnet.js";
import { startLocalStack, type LocalStack } from "../src/targets/local.js";

describe("the lookup of a close, on the local node (spec §7.3)", () => {
  let stack: LocalStack;

  beforeAll(async () => {
    stack = await startLocalStack();
  });

  afterAll(async () => {
    await stack?.stop();
  });

  /** A session opened straight on the program and closed by its buyer. */
  async function closedSession() {
    const context = stack.context();
    const buyer = await context.newBuyer(1_000_000n);
    const opened = await context.direct!.open({ buyer, seconds: 30 });
    const signature = await context.direct!.close(opened, buyer.signer);
    return { buyer, opened, signature };
  }

  /** What the node lists for the address, newest first, at `confirmed`. */
  const listed = (address: Address) => stack.network.rpc.getSignaturesForAddress(address, { commitment: "confirmed" }).send();

  /** Anyone may send lamports to a closed address (S12), which lists the transfer after the close. */
  async function sendLamportsTo(address: Address): Promise<void> {
    const sender = await newHarnessKey();
    fundSol(stack.network, sender.signer.address, 1);
    await waitForNewSlot(stack.network.rpc);
    // Above the rent minimum of an empty account (890,880 lamports), or the transfer would be refused.
    await sendSol(stack.network.rpc, sender.signer, address, 1_000_000n, { pollMs: 100 });
  }

  it("lists a closed session's transactions, the successful close first and its open after it", async () => {
    const { opened, signature } = await closedSession();

    const entries = await listed(opened.session);

    expect((await fetchMaybeSession(stack.network.rpc, opened.session, { commitment: "confirmed" })).exists).toBe(false);
    expect(entries.length).toBeGreaterThanOrEqual(2);
    expect(entries[0]?.signature).toBe(signature);
    expect(entries.every((entry) => entry.err === null)).toBe(true);
  });

  it("lists a later transfer of lamports to the closed address above the close", async () => {
    const { opened, signature } = await closedSession();
    await sendLamportsTo(opened.session);

    const entries = await listed(opened.session);

    expect(entries.length).toBeGreaterThanOrEqual(3);
    expect(entries[0]?.signature).not.toBe(signature);
    expect(entries[1]?.signature).toBe(signature);
  });

  it("finds the close with the helper the scenarios use, below a later transfer", async () => {
    const { buyer, opened, signature } = await closedSession();
    await sendLamportsTo(opened.session);

    const found = await findClose(stack.network.rpc, opened.session, { attempts: 1, delayMs: 0 });

    expect(found?.signature).toBe(signature);
    expect(found?.event).toMatchObject({ session: opened.session, kind: CloseKind.Standard, closedBy: buyer.signer.address });
  });
});
