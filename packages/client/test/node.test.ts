import type { RpcTransport } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { createNodeRpc, hideNodeUrl, isNodeUrl } from "../src/node.js";

/** A node URL with a key in its path and one in its query, as providers give them. */
const KEYED = "https://node.example/v2/PATHKEY123?api-key=QUERYKEY123";

/** What a failed call gives its caller: its message and its stack, where Node prints the message again. */
async function failure(call: Promise<unknown>): Promise<string> {
  const error = await call.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(Error);
  return `${(error as Error).message}\n${(error as Error).stack}`;
}

describe("the node's URL (spec §9.1)", () => {
  it("is an http or https URL that parses, and nothing fetch would refuse or that names another scheme", () => {
    expect(isNodeUrl("https://api.devnet.solana.com")).toBe(true);
    expect(isNodeUrl("http://127.0.0.1:8899")).toBe(true);
    for (const value of ["", "https://node example/?api-key=SECRET", "node.example/?api-key=SECRET", "ftp://node.example/SECRET"]) {
      expect(isNodeUrl(value), value).toBe(false);
    }
  });

  it("hides what may be the URL's key wherever a text repeats it, and keeps the host", () => {
    const hidden = hideNodeUrl(KEYED, `JSON-RPC error: invalid api key QUERYKEY123 (PATHKEY123); request to ${KEYED} failed`);
    expect(hidden).not.toMatch(/QUERYKEY123|PATHKEY123/);
    expect(hidden).toContain("https://node.example");
    const unparsed = "https://node example/?api-key=SECRET";
    expect(hideNodeUrl(unparsed, `Failed to parse URL from ${unparsed}`)).not.toContain("SECRET");
  });

  it("gives no caller the key, whether the node answers it in an error or the transport throws it", async () => {
    const answering = (async () => ({ jsonrpc: "2.0", id: "0", error: { code: -32602, message: "invalid api key QUERYKEY123" } })) as unknown as RpcTransport;
    expect(await failure(createNodeRpc(KEYED, answering).getGenesisHash().send())).not.toContain("QUERYKEY123");
    const throwing = (async () => {
      const error = new Error(`request to ${KEYED} failed`);
      void error.stack; // formatted now, with the key in it, as when a logger has read it
      throw error;
    }) as unknown as RpcTransport;
    expect(await failure(createNodeRpc(KEYED, throwing).getGenesisHash().send())).not.toMatch(/QUERYKEY123|PATHKEY123/);
  });
});
