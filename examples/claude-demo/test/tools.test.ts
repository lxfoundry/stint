import type { CloseAllOutput } from "@lxfoundry/stint-client";
import { describe, expect, it } from "vitest";
import type { Demo } from "../src/demo.js";
import { FAUCET_URL, TOOL, type DemoState } from "../src/state.js";
import { createCallHandler } from "../src/tools.js";

const STATE: DemoState = {
  wallet: { address: "AgentWallet", usdc: "100000", checkedAt: 1 },
  gateUrl: "https://gate.example",
  faucetUrl: FAUCET_URL,
  session: { state: "none", topUpMarginSeconds: 10, frames: 0, links: { topUps: [] } },
  exchange: { current: [] },
  now: 1,
};

function fakeDemo(overrides: Partial<Demo> = {}): { demo: Demo; reads: unknown[] } {
  const reads: unknown[] = [];
  const demo: Demo = {
    sink: { row: () => {}, offer: () => {}, settled: () => {} },
    state: async (options) => {
      reads.push(options ?? {});
      return STATE;
    },
    launch: async () => STATE,
    topUp: async () => STATE,
    close: async () => STATE,
    shutdown: async (): Promise<CloseAllOutput> => ({ closed: [], failed: [] }),
    ...overrides,
  };
  return { demo, reads };
}
const text = (result: { content?: unknown }) => (result.content as { text: string }[])[0]!.text;

describe("the owner's tool handler", () => {
  it("answers each tool with the state, as JSON text and as structured content", async () => {
    const call = createCallHandler(fakeDemo().demo, () => {});
    for (const name of Object.values(TOOL)) {
      const result = await call(name, {});
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toEqual(STATE);
      expect(JSON.parse(text(result))).toEqual(STATE);
    }
  });

  it("reads the balance again when the panel asks", async () => {
    const { demo, reads } = fakeDemo();
    const call = createCallHandler(demo, () => {});
    await call(TOOL.state, { refreshBalance: true });
    await call(TOOL.demo, {});
    expect(reads).toEqual([{ refreshBalance: true }, {}]);
  });

  it("answers a failure as a tool error with its message and the state", async () => {
    const { demo } = fakeDemo({
      launch: async () => {
        throw new Error("Policy refuses the offer: rate 2000 exceeds maxRate 1000");
      },
    });
    const result = await createCallHandler(demo, () => {})(TOOL.launch, {});
    expect(result.isError).toBe(true);
    expect(text(result)).toBe("Policy refuses the offer: rate 2000 exceeds maxRate 1000");
    expect(result.structuredContent).toEqual(STATE);
  });

  it("logs one line per call, but none for a state read that succeeds: the panel reads the state every 2 s", async () => {
    const lines: string[] = [];
    const { demo } = fakeDemo({
      launch: async () => {
        throw new Error("Policy refuses the offer");
      },
      state: async (options) => {
        if (options?.refreshBalance) throw new Error("rpc down");
        return STATE;
      },
    });
    const call = createCallHandler(demo, (line) => lines.push(line));
    await call(TOOL.launch, {});
    await call(TOOL.state, {});
    await call(TOOL.state, { refreshBalance: true });
    await call(TOOL.demo, {});
    expect(lines.map((line) => line.replace(/\d+ ms$/, "N ms"))).toEqual([
      "stint_demo_launch error in N ms",
      "stint_demo_state error in N ms",
      "stint_demo ok in N ms",
    ]);
  });

  it("answers an unknown tool as an error", async () => {
    const result = await createCallHandler(fakeDemo().demo, () => {})("stint_other", {});
    expect(result.isError).toBe(true);
    expect(text(result)).toBe("Unknown tool stint_other");
  });

  it("answers an unknown tool as an error even when the state cannot be read", async () => {
    const { demo } = fakeDemo({
      state: async () => {
        throw new Error("rpc down");
      },
    });
    const result = await createCallHandler(demo, () => {})("stint_other", {});
    expect(result.isError).toBe(true);
    expect(text(result)).toBe("Unknown tool stint_other");
    expect(result.structuredContent).toBeUndefined();
  });

  it("answers a failure with no state to attach as a tool error alone", async () => {
    const { demo } = fakeDemo({
      topUp: async () => {
        throw new Error("The session has ended");
      },
      state: async () => {
        throw new Error("rpc down");
      },
    });
    const result = await createCallHandler(demo, () => {})(TOOL.topUp, {});
    expect(result.isError).toBe(true);
    expect(text(result)).toBe("The session has ended");
    expect(result.structuredContent).toBeUndefined();
  });

  it("cuts every URL in a failure to its host, in the result", async () => {
    const lines: string[] = [];
    const { demo } = fakeDemo({
      close: async () => {
        throw new Error("request to https://rpc.example/v2/secret-key?api=1 failed");
      },
    });
    const result = await createCallHandler(demo, (line) => lines.push(line))(TOOL.close, {});
    expect(text(result)).toBe("request to https://rpc.example failed");
    expect(JSON.stringify(result)).not.toContain("secret-key");
    expect(lines.join("\n")).not.toContain("secret-key");
  });

  it("does not fail a call because its log line cannot be written, and keeps that line to one line", async () => {
    const throwing = await createCallHandler(fakeDemo().demo, () => {
      throw new Error("EPIPE");
    })(TOOL.launch, {});
    expect(throwing.isError).toBeFalsy();
    expect(throwing.structuredContent).toEqual(STATE);
    const lines: string[] = [];
    await createCallHandler(fakeDemo().demo, (line) => lines.push(line))("stint_other\nhttps://rpc.example/key-1", {});
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toMatch(/\n|key-1/);
  });

  it("answers a thrown value that is not an Error as a tool error", async () => {
    const { demo } = fakeDemo({
      launch: async () => {
        throw "plain text";
      },
    });
    const result = await createCallHandler(demo, () => {})(TOOL.launch, {});
    expect(result.isError).toBe(true);
    expect(text(result)).toBe("plain text");
  });
});
