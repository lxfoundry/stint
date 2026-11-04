import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { generateKeyPairSigner, type Address } from "@solana/kit";
import { verifySessionToken } from "@lxfoundry/stint-x402";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { closeCodeOf, closeWith, connectWith, tokenFor } from "../src/tokens.js";

describe("tokens, connects and closes of a scenario's own", () => {
  let server: Server;
  let url: string;
  /** The `Authorization` header of each request the server saw. */
  let seen: (string | undefined)[];

  beforeEach(async () => {
    seen = [];
    const sockets = new WebSocketServer({ noServer: true });
    server = createServer((request, response) => {
      seen.push(request.headers.authorization);
      response.writeHead(request.headers.authorization ? 200 : 401, { "content-type": "application/json" });
      response.end(JSON.stringify({ paid: "5000", refunded: "15000", transaction: "sig" }));
    });
    // Accepts an upgrade with a bearer token, and refuses one without with 401, before the upgrade.
    server.on("upgrade", (request: IncomingMessage, socket, head) => {
      seen.push(request.headers.authorization);
      if (!request.headers.authorization) {
        socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
        return;
      }
      // Closed a moment after the upgrade, so that the test's listener is attached first.
      sockets.handleUpgrade(request, socket, head, (ws) => setTimeout(() => ws.close(4410, "session closed"), 50));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  const someSession = async (): Promise<Address> => (await generateKeyPairSigner()).address;

  it("signs a token for the gate's origin that the gate's check accepts, and one for another audience when asked", async () => {
    const signer = await generateKeyPairSigner();
    const session = await someSession();
    const expected = { authority: signer.address, session, purpose: "connect" as const, nowMs: Date.now() };

    const token = await tokenFor(signer, `${url}/`, session, "connect");
    expect(await verifySessionToken(token, { ...expected, audience: url })).toMatchObject({ ok: true });

    const elsewhere = await tokenFor(signer, url, session, "connect", { audience: "https://elsewhere.invalid" });
    expect(await verifySessionToken(elsewhere, { ...expected, audience: url })).toEqual({ ok: false, reason: "wrong audience" });

    const old = await tokenFor(signer, url, session, "connect", { nowMs: Date.now() - 200_000 });
    expect(await verifySessionToken(old, { ...expected, audience: url })).toEqual({ ok: false, reason: "expired" });
  });

  it("connects with the token as a bearer, and returns the open socket on 101", async () => {
    const answer = await connectWith(url, await someSession(), "a-token");

    expect(answer.status).toBe(101);
    expect(seen).toEqual(["Bearer a-token"]);
    expect(await closeCodeOf(answer.socket!)).toBe(4410);
  });

  it("returns the status an upgrade is refused with, and no socket", async () => {
    const answer = await connectWith(url, await someSession());

    expect(answer).toEqual({ status: 401 });
  });

  it("asks the gate to close with the token as a bearer, and returns its status and body", async () => {
    const session = await someSession();

    expect(await closeWith(url, session, "a-token")).toEqual({
      status: 200,
      body: { paid: "5000", refunded: "15000", transaction: "sig" },
    });
    expect(seen).toEqual(["Bearer a-token"]);
  });
});
