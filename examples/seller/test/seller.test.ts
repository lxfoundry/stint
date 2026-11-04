import { generateKeyPairSigner } from "@solana/kit";
import { startStream, type RunningStream } from "@lxfoundry/stint-example-stream";
import type { FacilitatorClient, GateChain } from "@lxfoundry/stint-gate";
import { HEADERS, SOLANA_DEVNET, decodePaymentRequiredHeader, readElapsedRequirements } from "@lxfoundry/stint-x402";
import { afterEach, describe, expect, it } from "vitest";
import { IDLE_CLOSE_SECONDS, SELLER_TERMS, sellerGateSettings } from "../src/seller.js";

const PROGRAM = "5iCYPqLjCWw5KzQTU6NBUhR2hxg5SWGmS1ctUn3qESvr";

async function fakes(): Promise<{ facilitator: FacilitatorClient; chain: GateChain }> {
  const [feePayer, rentPayer] = await Promise.all([generateKeyPairSigner(), generateKeyPairSigner()]);
  return {
    facilitator: {
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
        throw new Error("no payment in this test");
      },
      settle: async () => {
        throw new Error("no payment in this test");
      },
    },
    chain: {
      latestBlockhash: async () => ({ blockhash: "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N", lastValidBlockHeight: 100n }),
      readSession: async () => undefined,
      closedEvent: async () => undefined,
    },
  };
}

describe("the seller's offer", () => {
  let stream: RunningStream | undefined;
  afterEach(async () => {
    await stream?.stop();
    stream = undefined;
  });

  it("is 100 s at 0.001 USDC a second, from 5 s to 300 s, at the public origin, with a 60 s idle close", async () => {
    const seller = (await generateKeyPairSigner()).address;
    const receiverAuthorizer = await generateKeyPairSigner();
    stream = await startStream({
      rpcWsUrl: "ws://127.0.0.1:9",
      origin: "https://seller.example",
      gate: { ...sellerGateSettings({ seller, receiverAuthorizer }), ...(await fakes()) },
    });

    const response = await fetch(`${stream.url}/sessions`, { method: "POST" });
    expect(response.status).toBe(402);
    const required = decodePaymentRequiredHeader(response.headers.get(HEADERS.paymentRequired)!);
    expect(required.resource?.url).toBe("https://seller.example/sessions");
    expect(required.accepts).toHaveLength(1);
    const offer = readElapsedRequirements(required.accepts[0]);
    expect(offer).toMatchObject({ amount: "100000", payTo: seller, maxTimeoutSeconds: 30 });
    expect(offer?.extra).toMatchObject({
      action: "open",
      rate: "1000",
      seconds: 100,
      minSeconds: 5,
      maxSeconds: 300,
      receiverAuthorizer: receiverAuthorizer.address,
      idleCloseSeconds: IDLE_CLOSE_SECONDS,
    });
    expect(SELLER_TERMS).toEqual({ rate: 1_000n, minSeconds: 5, maxSeconds: 300 });
  });
});
