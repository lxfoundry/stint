import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { address, generateKeyPairSigner, type Address } from "@solana/kit";
import { CloseKind, STINT_PROGRAM_ADDRESS, type ClosedEvent, type Session, type SessionArgs } from "@lxfoundry/stint-program-client";
import { createGate, type Gate } from "@lxfoundry/stint-gate";
import {
  USDC_DEVNET,
  readElapsedPayload,
  readJson,
  sendJson,
  storedSessionFields,
  type CloseInfo,
  type PaymentPayload,
  type SettleResponse,
  type SponsoredCloseResponse,
  type VerifyResponse,
} from "@lxfoundry/stint-x402";
import type { WebSocket } from "ws";

export const NETWORK = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const BLOCKHASH = "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N";

export interface TestGate {
  readonly url: string;
  /** The facilitator's fee payer: offers name it, and so does `GET /close`. */
  readonly feePayer: Address;
  /** The session the fake chain holds for the buyer, as the program stores it. */
  readonly stored: SessionArgs;
  readonly payments: PaymentPayload[];
  /** Rejections that escaped `handleRequest`: the gate must contain its own errors. */
  readonly escaped: unknown[];
  /** While set, the chain cannot return the `Closed` event of a confirmed close. */
  hideClosedEvent: boolean;
  /** What the facilitator answers `/verify` with. Default `{ isValid: true }`. */
  verifyAnswer: VerifyResponse;
  /** What the facilitator answers the settlement of the gate's close with. Default: confirmed, `sig`. */
  closeSettlement: SettleResponse;
  /** While false, the chain holds no session: the gate's status answers `404`, and so does `GET /close?session=`. */
  sessionOpen: boolean;
  /** When set, what `GET /close?session=` goes by in place of `sessionOpen`: the facilitator's node can disagree with the gate's. */
  facilitatorSessionOpen?: boolean;
  /** While set, the gate's routes drop each request unanswered, as a host that cannot be reached does. */
  gateDown: boolean;
  /** While set, the facilitator's `/close` routes drop each request unanswered. */
  facilitatorDown: boolean;
  /** While set, the gate's routes take each request and never answer it. */
  gateSilent: boolean;
  /** While set, the facilitator's `/close` routes take each request and never answer it. */
  facilitatorSilent: boolean;
  /** While set, the gate's status route (`GET /sessions/:id`) takes each request and never answers it. */
  statusSilent: boolean;
  /** While set, `POST /close` takes each request and never answers it; `GET /close` still answers. */
  sponsoredSilent: boolean;
  /** While set, `POST /close` takes the close, starts its answer and never finishes it. */
  sponsoredStalls: boolean;
  /** The transactions posted to `closeUrl`, in order. */
  readonly sponsored: string[];
  /** What `POST /close` answers. Default: closed, `sponsored-sig`, 8,000 paid and 22,000 refunded. */
  sponsoredAnswer: SponsoredCloseResponse;
  stop(): Promise<void>;
}

/**
 * A gate selling 1,000 per second, 5 to 120 s, whose chain holds one session per buyer, and on the same server the
 * facilitator's buyer endpoints, `GET /close` and `POST /close` (spec §6.1), which its offers name as `closeUrl`.
 */
export async function startTestGate(buyer: Address, onAttach: (socket: WebSocket) => void = () => {}): Promise<TestGate> {
  const authorizer = await generateKeyPairSigner();
  const seller = (await generateKeyPairSigner()).address;
  const feePayer = (await generateKeyPairSigner()).address;
  const rentPayer = (await generateKeyPairSigner()).address;
  const payments: PaymentPayload[] = [];
  const escaped: unknown[] = [];
  const now = Date.now();
  const stored: SessionArgs = {
    version: 1,
    bump: 255,
    authority: buyer,
    seed: 7n,
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
  };
  const server: Server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const gate: Gate = createGate({
    origin: url,
    network: NETWORK,
    asset: USDC_DEVNET,
    payTo: seller,
    receiverAuthorizer: authorizer,
    terms: { rate: 1_000n, minSeconds: 5, maxSeconds: 120 },
    durations: [30, 60],
    readRetry: { attempts: 2, delayMs: 1 },
    facilitator: {
      supported: async () => ({
        kinds: [{ x402Version: 2, scheme: "elapsed", network: NETWORK, extra: { feePayer, rentPayer, programId: STINT_PROGRAM_ADDRESS, closeUrl: `${url}/close` } }],
        extensions: [],
        signers: {},
      }),
      verify: async () => testGate.verifyAnswer,
      settle: async (payload) => {
        payments.push(payload);
        if (readElapsedPayload(payload)?.type === "close") return testGate.closeSettlement;
        return { success: true, transaction: "sig", network: NETWORK };
      },
    },
    chain: {
      latestBlockhash: async () => ({ blockhash: BLOCKHASH, lastValidBlockHeight: 100n }),
      readSession: async () => (testGate.sessionOpen ? (stored as unknown as Session) : undefined),
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

  /** The facilitator's buyer endpoints (spec §6.1): `GET /close`, with or without `?session=`, and `POST /close`. */
  async function serveClose(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    if (req.method === "GET") {
      const session = new URL(req.url ?? "/", url).searchParams.get("session");
      if (session !== null && !(testGate.facilitatorSessionOpen ?? testGate.sessionOpen)) {
        sendJson(res, 404, { error: "unknown_session" });
        return true;
      }
      const info: CloseInfo = {
        feePayer,
        recentBlockhash: BLOCKHASH,
        lastValidBlockHeight: "100",
        blockHeight: "90",
        programId: STINT_PROGRAM_ADDRESS,
        ...(session === null ? {} : { session: storedSessionFields(address(session), stored as unknown as Session) }),
      };
      sendJson(res, 200, info);
      return true;
    }
    const body = (await readJson(req)) as { transaction?: unknown } | undefined;
    testGate.sponsored.push(String(body?.transaction));
    if (testGate.sponsoredStalls) {
      // Headers and a first byte, then nothing: `stop` closes the connection.
      res.writeHead(200, { "content-type": "application/json" }).write("{");
      return true;
    }
    sendJson(res, 200, testGate.sponsoredAnswer);
    return true;
  }

  server.on("request", (req, res) => {
    const toFacilitator = new URL(req.url ?? "/", url).pathname === "/close";
    if (toFacilitator ? testGate.facilitatorDown : testGate.gateDown) return void req.socket.destroy();
    // A request left unanswered: `stop` closes its connection.
    if (toFacilitator ? testGate.facilitatorSilent : testGate.gateSilent) return;
    if (toFacilitator ? req.method === "POST" && testGate.sponsoredSilent : req.method === "GET" && testGate.statusSilent) return;
    (toFacilitator ? serveClose(req, res) : gate.handleRequest(req, res)).then(
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
    if (testGate.gateDown || !gate.handleUpgrade(req, socket, head)) socket.destroy();
  });
  const testGate: TestGate = {
    url,
    feePayer,
    stored,
    payments,
    escaped,
    hideClosedEvent: false,
    verifyAnswer: { isValid: true },
    closeSettlement: { success: true, transaction: "sig", network: NETWORK },
    sessionOpen: true,
    gateDown: false,
    facilitatorDown: false,
    gateSilent: false,
    facilitatorSilent: false,
    statusSilent: false,
    sponsoredSilent: false,
    sponsoredStalls: false,
    sponsored: [],
    sponsoredAnswer: { success: true, transaction: "sponsored-sig", paid: "8000", refunded: "22000" },
    stop: async () => {
      await gate.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
  return testGate;
}
