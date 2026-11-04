import { describe, expect, it } from "vitest";
import { SellerConfigError, loadSeed, loadSellerConfig } from "../src/config.js";

const SEED = "ab".repeat(32);
/** BIP-39's published test phrase, and the seed it gives with no passphrase. */
const PHRASE = `${"abandon ".repeat(11)}about`;
const PHRASE_SEED =
  "5eb00bbddcf069084889a8ab9155568165f5c453ccb85e70811aaed6f6da5fc19a5ac40b389cd370d086206dec8aa6c43daea6690f20ad3d8d48b2d2ce9e38e4";
const valid = {
  STINT_SELLER_SEED: SEED,
  STINT_SELLER_RPC_URL: "https://devnet.example/?api-key=secret",
  PUBLIC_ORIGIN: "https://stream.example/",
};

function problemsOf(env: Record<string, string>): string[] {
  try {
    loadSellerConfig(env);
  } catch (error) {
    if (error instanceof SellerConfigError) return [...error.problems];
    throw error;
  }
  throw new Error("expected a configuration error");
}

describe("the seller's configuration", () => {
  it("reads the seed, the endpoint, and the public origin, with the defaults for the rest", () => {
    const config = loadSellerConfig(valid);
    expect(Buffer.from(config.seed).toString("hex")).toBe(SEED);
    expect(config).toMatchObject({
      rpcUrl: "https://devnet.example/?api-key=secret",
      wsUrl: "wss://devnet.example/?api-key=secret",
      host: "0.0.0.0",
      port: 8080,
      publicOrigin: "https://stream.example",
    });
    expect(config.scanRpcUrl).toBeUndefined();
  });

  it("takes the WebSocket and scan endpoints, the host and the port when they are given", () => {
    const config = loadSellerConfig({
      ...valid,
      STINT_SELLER_WS_URL: "wss://ws.devnet.example",
      STINT_SELLER_SCAN_RPC_URL: "https://api.devnet.solana.com",
      HOST: "127.0.0.1",
      PORT: "0",
    });
    expect(config).toMatchObject({ wsUrl: "wss://ws.devnet.example", scanRpcUrl: "https://api.devnet.solana.com", host: "127.0.0.1", port: 0 });
  });

  it("lists every missing variable at once", () => {
    expect(problemsOf({})).toEqual([
      "STINT_SELLER_SEED is required: a recovery phrase of 12 to 24 words, or 64 hexadecimal characters (openssl rand -hex 32)",
      "STINT_SELLER_RPC_URL is required",
      "PUBLIC_ORIGIN is required: the http or https origin buyers reach the stream at, such as https://stream.example.com",
    ]);
  });

  it("refuses malformed values, and quotes neither the seed nor an endpoint", () => {
    const problems = problemsOf({
      STINT_SELLER_SEED: "not-a-seed",
      STINT_SELLER_RPC_URL: "ftp://user:pw@devnet.example",
      STINT_SELLER_WS_URL: "https://devnet.example",
      STINT_SELLER_SCAN_RPC_URL: "nope",
      PORT: "80a",
      PUBLIC_ORIGIN: "https://stream.example/path",
    });
    expect(problems).toHaveLength(6);
    expect(problems.join("\n")).not.toMatch(/not-a-seed|user:pw|devnet\.example|nope/);
  });

  it("reads the seed alone, for the keys command", () => {
    expect(Buffer.from(loadSeed({ STINT_SELLER_SEED: SEED })).toString("hex")).toBe(SEED);
    expect(() => loadSeed({})).toThrow(SellerConfigError);
  });

  it("turns a recovery phrase into its 64-byte BIP-39 seed, whatever its case and spacing", () => {
    expect(Buffer.from(loadSeed({ STINT_SELLER_SEED: PHRASE })).toString("hex")).toBe(PHRASE_SEED);
    expect(Buffer.from(loadSeed({ STINT_SELLER_SEED: `  ${PHRASE.toUpperCase().replaceAll(" ", "   ")} ` })).toString("hex")).toBe(PHRASE_SEED);
  });

  it("refuses a phrase of a length BIP-39 does not use, without quoting it", () => {
    let problems: readonly string[] = [];
    try {
      loadSeed({ STINT_SELLER_SEED: `${PHRASE} zoo` });
    } catch (error) {
      if (error instanceof SellerConfigError) problems = error.problems;
    }
    expect(problems).toEqual(["STINT_SELLER_SEED must be a recovery phrase of 12 to 24 words, or 64 hexadecimal characters"]);
  });
});
