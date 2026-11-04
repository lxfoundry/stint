import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createFacilitatorClient } from "../src/index.js";

describe("the facilitator client", () => {
  const servers: Server[] = [];

  afterEach(async () => {
    for (const server of servers.splice(0)) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  /** A server that takes every request and answers none. */
  async function silent(): Promise<string> {
    const server = createServer(() => {});
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it("gives up a request that gets no answer within its time limit", async () => {
    const client = createFacilitatorClient(await silent(), "key", { timeoutMs: 50 });
    await expect(client.supported()).rejects.toThrow("Facilitator /supported: no answer within 50 ms");
  });
});
