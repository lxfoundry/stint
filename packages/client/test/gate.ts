import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { generateKeyPairSigner, type Address } from "@solana/kit";
import { CloseKind, type ClosedEvent, type Session } from "@lxfoundry/stint-program-client";
import { createGate, type Gate } from "@lxfoundry/stint-gate";
import { USDC_DEVNET, type PaymentPayload } from "@lxfoundry/stint-x402";
import type { WebSocket } from "ws";

export interface TestGate {
  readonly url: string;
  readonly payments: PaymentPayload[];
  /** Rejections that escaped `handleRequest`: the gate must contain its own errors. */
  readonly escaped: unknown[];
  /** While set, the chain cannot return the `Closed` event of a confirmed close. */
  hideClosedEvent: boolean;
  stop(): Promise<void>;
}

/** A gate selling 1,000 per second, 5 to 120 s, whose chain holds one session per buyer. */
export async function startTestGate(buyer: Address, onAttach: (socket: WebSocket) => void = () => {}): Promise<TestGate> {
  const authorizer = await generateKeyPairSigner();
  const seller = (await generateKeyPairSigner()).address;
  const feePayer = (await generateKeyPairSigner()).address;
  const rentPayer = (await generateKeyPairSigner()).address;
  const payments: PaymentPayload[] = [];
  const escaped: unknown[] = [];
  const now = Date.now();
  const server: Server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const gate: Gate = createGate({
    origin: url,
    network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
    asset: USDC_DEVNET,
    payTo: seller,
    receiverAuthorizer: authorizer,
    terms: { rate: 1_000n, minSeconds: 5, maxSeconds: 120 },
    durations: [30, 60],
    readRetry: { attempts: 2, delayMs: 1 },
    facilitator: {
      supported: async () => ({
        kinds: [
          {
            x402Version: 2,
            scheme: "elapsed",
            network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
            extra: { feePayer, rentPayer, programId: "5iCYPqLjCWw5KzQTU6NBUhR2hxg5SWGmS1ctUn3qESvr", closeUrl: `${url}/close` },
          },
        ],
        extensions: [],
        signers: {},
      }),
      verify: async () => ({ isValid: true }),
      settle: async (payload) => {
        payments.push(payload);
        return { success: true, transaction: "sig", network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" };
      },
    },
    chain: {
      latestBlockhash: async () => ({ blockhash: "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N", lastValidBlockHeight: 100n }),
      readSession: async () =>
        ({
          authority: buyer,
          mint: USDC_DEVNET.mint,
          receiver: seller,
          receiverAuthorizer: authorizer.address,
          refundOwner: buyer,
          rentPayer,
          rate: 1_000n,
          minSeconds: 5,
          maxSeconds: 120,
          startedAt: BigInt(Math.floor(now / 1000)),
          deposited: 30_000n,
          claimed: 0n,
        }) as Session,
      closedEvent: async () =>
        testGate.hideClosedEvent
          ? undefined
          : ({ claimed: 0n, owed: 8_000n, refunded: 22_000n, redirected: 0n, kind: CloseKind.Standard } as ClosedEvent),
    },
    adapter: {
      provision: async () => null,
      attach: (_, socket) => onAttach(socket),
      teardown: async () => {},
    },
  });
  server.on("request", (req, res) => {
    gate.handleRequest(req, res).then(
      (handled) => {
        if (!handled) res.writeHead(404).end();
      },
      (error: unknown) => {
        escaped.push(error);
        res.writeHead(500).end();
      },
    );
  });
  server.on("upgrade", (req, socket, head) => {
    if (!gate.handleUpgrade(req, socket, head)) socket.destroy();
  });
  const testGate: TestGate = {
    url,
    payments,
    escaped,
    hideClosedEvent: false,
    stop: async () => {
      await gate.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
  return testGate;
}
