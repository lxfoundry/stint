import { describe, expect, it } from "vitest";
import { DEVNET_GENESIS_HASH, DevnetConfigError, assertDevnet, assertProgramDeployed, loadDevnetConfig } from "../src/devnet/config.js";

const SEED = "ab".repeat(32);

const fakeRpc = (overrides: { genesis?: string; account?: { executable: boolean } | null }) =>
  ({
    getGenesisHash: () => ({ send: async () => overrides.genesis ?? DEVNET_GENESIS_HASH }),
    getAccountInfo: () => ({ send: async () => ({ value: overrides.account ?? null }) }),
  }) as never;

describe("loadDevnetConfig", () => {
  it("reads the endpoint and the seed, and derives the WebSocket URL", () => {
    const config = loadDevnetConfig({ STINT_DEVNET_RPC_URL: "https://devnet.example/?api-key=k", STINT_DEVNET_SEED: SEED });
    expect(config.rpcUrl).toBe("https://devnet.example/?api-key=k");
    expect(config.wsUrl).toBe("wss://devnet.example/?api-key=k");
    expect(Buffer.from(config.seed).toString("hex")).toBe(SEED);
    expect(loadDevnetConfig({ STINT_DEVNET_RPC_URL: "http://localhost:8899", STINT_DEVNET_SEED: SEED }).wsUrl).toBe("ws://localhost:8899");
  });

  it("takes an explicit WebSocket URL over the derived one", () => {
    const config = loadDevnetConfig({ STINT_DEVNET_RPC_URL: "https://a.example", STINT_DEVNET_WS_URL: "wss://b.example", STINT_DEVNET_SEED: SEED });
    expect(config.wsUrl).toBe("wss://b.example");
  });

  it("takes the seed of a recovery phrase as BIP-39 does, without checking its words, and ignores case and spacing", () => {
    const phrase = `${"abandon ".repeat(23)}art`;
    const config = loadDevnetConfig({ STINT_DEVNET_RPC_URL: "https://a.example", STINT_DEVNET_SEED: phrase });
    expect(Buffer.from(config.seed).toString("hex")).toBe(
      "408b285c123836004f4b8842c89324c1f01382450c0d439af345ba7fc49acf705489c6fc77dbd4e3dc1dd8cc6bc9f043db8ada1e243c4a0eafb290d399480840",
    );
    const untidy = `  ${phrase.toUpperCase().replaceAll(" ", "  ")}\n`;
    expect(loadDevnetConfig({ STINT_DEVNET_RPC_URL: "https://a.example", STINT_DEVNET_SEED: untidy }).seed).toEqual(config.seed);
  });

  it("names every problem at once", () => {
    try {
      loadDevnetConfig({ STINT_DEVNET_RPC_URL: "ftp://x" });
      throw new Error("accepted");
    } catch (error) {
      expect(error).toBeInstanceOf(DevnetConfigError);
      expect((error as DevnetConfigError).problems).toEqual([
        "STINT_DEVNET_RPC_URL must be an http or https URL",
        "STINT_DEVNET_SEED is required: a recovery phrase of 12 to 24 words, or 64 hexadecimal characters (openssl rand -hex 32)",
      ]);
      // The URL may carry an API key: it is never echoed.
      expect((error as DevnetConfigError).message).not.toContain("ftp://x");
    }
  });

  it("refuses a seed that is neither a recovery phrase nor 64 hexadecimal characters, without quoting it", () => {
    for (const seed of ["hunter2-looks-like-a-secret", "ab".repeat(31), "zz".repeat(32), "abandon ".repeat(13).trim()]) {
      const error = (() => {
        try {
          loadDevnetConfig({ STINT_DEVNET_RPC_URL: "https://a.example", STINT_DEVNET_SEED: seed });
        } catch (caught) {
          return caught as DevnetConfigError;
        }
        throw new Error("accepted");
      })();
      expect(error.problems).toEqual(["STINT_DEVNET_SEED must be a recovery phrase of 12 to 24 words, or 64 hexadecimal characters"]);
      expect(error.message).not.toContain(seed);
    }
  });
});

describe("assertDevnet", () => {
  it("accepts devnet's genesis hash", async () => {
    await expect(assertDevnet(fakeRpc({}))).resolves.toBeUndefined();
  });

  it("refuses any other network, naming its hash", async () => {
    await expect(assertDevnet(fakeRpc({ genesis: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d" }))).rejects.toThrow(
      /5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d.*not devnet's/,
    );
  });
});

describe("assertProgramDeployed", () => {
  it("accepts an executable program account, and refuses a missing or non-executable one", async () => {
    await expect(assertProgramDeployed(fakeRpc({ account: { executable: true } }))).resolves.toBeUndefined();
    await expect(assertProgramDeployed(fakeRpc({ account: null }))).rejects.toThrow(/scripts\/deploy-devnet\.sh/);
    await expect(assertProgramDeployed(fakeRpc({ account: { executable: false } }))).rejects.toThrow(/not deployed/);
  });
});

describe("loadDevnetConfig, malformed URLs", () => {
  const problemsOf = (env: Record<string, string>) => {
    try {
      loadDevnetConfig({ STINT_DEVNET_SEED: SEED, ...env });
    } catch (caught) {
      return caught as DevnetConfigError;
    }
    throw new Error("accepted");
  };

  it("refuses a URL that does not parse, without quoting any of it", () => {
    const error = problemsOf({ STINT_DEVNET_RPC_URL: "https://host:abc/?api-key=k" });
    expect(error.problems).toEqual(["STINT_DEVNET_RPC_URL must be an http or https URL"]);
    expect(error.message).not.toContain("api-key");
    expect(error.message).not.toContain("host:abc");
  });

  it("refuses a URL with credentials, without quoting any of it", () => {
    const error = problemsOf({ STINT_DEVNET_RPC_URL: "https://user:pass@host.example/KEYKEY?api-key=k" });
    expect(error.problems).toEqual(["STINT_DEVNET_RPC_URL must be an http or https URL"]);
    expect(error.message).not.toContain("KEYKEY");
    expect(error.message).not.toContain("pass");
  });

  it("requires a ws or wss URL for the WebSocket endpoint, without quoting it", () => {
    for (const ws of ["https://b.example/?api-key=k", "wss://b.example:abc/?api-key=k", "b.example"]) {
      const error = problemsOf({ STINT_DEVNET_RPC_URL: "https://a.example", STINT_DEVNET_WS_URL: ws });
      expect(error.problems).toEqual(["STINT_DEVNET_WS_URL must be a ws or wss URL"]);
      expect(error.message).not.toContain("api-key");
    }
  });

  it("refuses a derived WebSocket URL that does not parse", () => {
    expect(problemsOf({ STINT_DEVNET_RPC_URL: "https://host:abc/?api-key=k" }).problems).toHaveLength(1);
  });
});
