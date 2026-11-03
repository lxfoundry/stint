import { generateKeyPairSigner } from "@solana/kit";
import type { FacilitatorClient, GateChain } from "@lxfoundry/stint-gate";
import { HEADERS, SOLANA_DEVNET, USDC_DEVNET, decodePaymentRequiredHeader } from "@lxfoundry/stint-x402";
import { afterEach, describe, expect, it } from "vitest";
import { startStream, type RunningStream, type StreamConfig } from "../src/index.js";

/** The Stint program: the gate offers sessions only through a facilitator that supports it. */
const PROGRAM = "5iCYPqLjCWw5KzQTU6NBUhR2hxg5SWGmS1ctUn3qESvr";
/** Nothing listens here: the stream's subscriptions connect only when a buyer subscribes, and none does. */
const NO_NODE = "ws://127.0.0.1:9";

async function gateConfig(): Promise<StreamConfig["gate"]> {
  const [feePayer, rentPayer, seller, receiverAuthorizer] = await Promise.all([
    generateKeyPairSigner(),
    generateKeyPairSigner(),
    generateKeyPairSigner(),
    generateKeyPairSigner(),
  ]);
  const facilitator: FacilitatorClient = {
    supported: async () => ({
      kinds: [
        {
          x402Version: 2,
          scheme: "elapsed",
          network: SOLANA_DEVNET,
          extra: { feePayer: feePayer.address, rentPayer: rentPayer.address, programId: PROGRAM, closeUrl: "http://127.0.0.1:9/close" },
        },
      ],
      extensions: [],
      signers: {},
    }),
    verify: async () => {
      throw new Error("no payment in these tests");
    },
    settle: async () => {
      throw new Error("no payment in these tests");
    },
  };
  const chain: GateChain = {
    latestBlockhash: async () => ({ blockhash: "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N", lastValidBlockHeight: 100n }),
    readSession: async () => undefined,
    closedEvent: async () => undefined,
  };
  return {
    network: SOLANA_DEVNET,
    asset: USDC_DEVNET,
    payTo: seller.address,
    receiverAuthorizer,
    terms: { rate: 1_000n, minSeconds: 5, maxSeconds: 300 },
    durations: [100],
    facilitator,
    chain,
  };
}

/** The `resource.url` of the 402 that the stream's gate answers a first open with. */
async function offeredAt(stream: RunningStream): Promise<string | undefined> {
  const response = await fetch(`${stream.url}/sessions?seconds=100`, { method: "POST" });
  expect(response.status).toBe(402);
  const header = response.headers.get(HEADERS.paymentRequired);
  expect(header).not.toBeNull();
  return decodePaymentRequiredHeader(header!).resource?.url;
}

describe("the origin the stream announces to its gate", () => {
  let stream: RunningStream | undefined;
  afterEach(async () => {
    await stream?.stop();
    stream = undefined;
  });

  it("is the public origin it is given, whatever address it listens on, and /health still answers", async () => {
    stream = await startStream({ rpcWsUrl: NO_NODE, origin: "https://stream.example/", gate: await gateConfig() });
    expect(await offeredAt(stream)).toBe("https://stream.example/sessions");
    expect((await fetch(`${stream.url}/health`)).status).toBe(200);
  });

  it("is the address it listens on when it is given none", async () => {
    stream = await startStream({ rpcWsUrl: NO_NODE, gate: await gateConfig() });
    expect(await offeredAt(stream)).toBe(`${stream.url}/sessions`);
  });

  it("refuses an origin that does not parse, before it listens", async () => {
    const started = startStream({ rpcWsUrl: NO_NODE, origin: "not a url", gate: await gateConfig() });
    // Before the change, the stream starts: it is stopped, so that the failing run leaves nothing listening.
    started.then((leaked) => leaked.stop(), () => undefined);
    await expect(started).rejects.toThrow(/Invalid URL/);
  });
});
