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

  it.each([
    ["does not parse", "not a url", /Invalid URL/],
    // A host and a port without a scheme parses, with the host as its protocol and "null" as its origin.
    ["has no scheme", "stream.example.com:8080", /http or https/],
    ["is not http or https", "ftp://stream.example.com", /http or https/],
    ["has no origin", "file:///srv/stream", /http or https/],
  ])("refuses an origin that %s, before it listens", async (_case, origin, message) => {
    const started = startStream({ rpcWsUrl: NO_NODE, origin, gate: await gateConfig() });
    // Without the check, the stream starts: it is stopped, so that the failing run leaves nothing listening.
    started.then((leaked) => leaked.stop(), () => undefined);
    await expect(started).rejects.toThrow(message);
  });
});

describe("the home page", () => {
  let stream: RunningStream | undefined;
  afterEach(async () => {
    await stream?.stop();
    stream = undefined;
  });

  it("is answered to GET / as HTML that loads nothing from elsewhere, and to HEAD / without its body", async () => {
    const home = "<!doctype html><title>Seller</title><p>Sessions by the second.</p>";
    stream = await startStream({ rpcWsUrl: NO_NODE, gate: await gateConfig(), home });
    const page = await fetch(`${stream.url}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(page.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await page.text()).toBe(home);
    const head = await fetch(`${stream.url}/`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String(Buffer.byteLength(home)));
    expect(await head.text()).toBe("");
  });

  it("leaves every other path and method as it was: the gate's routes, /health, and a 404", async () => {
    stream = await startStream({ rpcWsUrl: NO_NODE, gate: await gateConfig(), home: "<p>home</p>" });
    expect(await offeredAt(stream)).toBe(`${stream.url}/sessions`);
    expect((await fetch(`${stream.url}/health`)).status).toBe(200);
    expect((await fetch(`${stream.url}/?x=1`)).status).toBe(404);
    expect((await fetch(`${stream.url}/`, { method: "POST" })).status).toBe(404);
    expect((await fetch(`${stream.url}/index.html`)).status).toBe(404);
  });

  it("is a 404 when the stream is given none", async () => {
    stream = await startStream({ rpcWsUrl: NO_NODE, gate: await gateConfig() });
    const response = await fetch(`${stream.url}/`);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
  });
});
