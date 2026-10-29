import { afterEach, describe, expect, it, vi } from "vitest";
import { createKoraClient } from "../src/kora.js";

const KEYED = "https://rpc.example/v2/SECRETKEY?api-key=SECRETKEY";

afterEach(() => vi.unstubAllGlobals());

const answer = (status: number, body: string) =>
  vi.stubGlobal("fetch", async () => new Response(body, { status, statusText: status === 200 ? "OK" : "Error" }));

describe("createKoraClient errors", () => {
  it("keeps the key of an RPC URL that Kora quotes out of a JSON-RPC error", async () => {
    answer(200, JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: `error sending request for url (${KEYED})` } }));
    const error = await createKoraClient("http://localhost:8080", "k").getPayerSigner().catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("rpc.example");
    expect((error as Error).message).not.toContain("SECRETKEY");
  });

  it("keeps the key out of an HTTP error that is not JSON", async () => {
    answer(502, `bad gateway for ${KEYED}`);
    const error = await createKoraClient("http://localhost:8080", "k").getPayerSigner().catch((e: Error) => e);
    expect((error as Error).message).toContain("rpc.example");
    expect((error as Error).message).not.toContain("SECRETKEY");
  });
});
