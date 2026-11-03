import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SessionTools, Tool } from "@lxfoundry/stint-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig, type DemoConfig } from "../src/config.js";
import { createOwnerSide, log, READ_ONLY } from "../src/main.js";
import { OWNER_FILE, createRouter, type Router } from "../src/owner.js";
import { TOOL } from "../src/state.js";
import { FEE_PAYER, GATE, SELLER, SESSION } from "./fixtures.js";

const scratch = fileURLToPath(new URL("../.cache/", import.meta.url));
const realFetch = globalThis.fetch;

/** A port that nothing listens on any more. */
const deadPort = () =>
  new Promise<number>((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });

const tool = <I, O>(run: (input: I) => Promise<O>): Tool<I, O> => ({ name: "fake", description: "fake", inputSchema: {}, run });

/**
 * The session tools of one owner state: an open sends the request the real client sends (one POST to the gate's open
 * route, through the global `fetch`), and `closeAll` answers for the one session this state holds.
 */
function fakeTools(sessionId: string): SessionTools {
  return {
    tools: {
      stint_open_session: tool(async () => {
        await fetch(`${GATE}/sessions?seconds=100`, { method: "POST" });
        return { sessionId, paidUntil: Math.floor(Date.now() / 1000) + 100, cost: "100000", remainingBudget: "0" };
      }),
      stint_session_status: tool(async () => {
        throw new Error("not used by the demo");
      }),
      stint_top_up: tool(async () => {
        throw new Error("not used by this test");
      }),
      stint_send: tool(async () => ({ ok: true as const })),
      stint_receive: tool(async () => ({ messages: [], timedOut: true })),
      stint_close_session: tool(async () => {
        throw new Error("not used by this test");
      }),
    },
    closeCode: () => undefined,
    closeAll: async () => ({ closed: [sessionId], failed: [] }),
  };
}

describe("what a copy of the server builds when it becomes the owner", () => {
  let home: string;
  let config: DemoConfig;
  let lines: string[];
  /** The URLs that reached the `fetch` that was global before the copy wrapped it. */
  let reached: string[];
  const routers: Router[] = [];
  /** One address per state the copy builds, in order: the session that state's launch opens. */
  const SESSIONS = [SESSION, SELLER, FEE_PAYER];
  let built: number;
  const makeTools = () => fakeTools(SESSIONS[built++]!);

  beforeEach(() => {
    mkdirSync(scratch, { recursive: true });
    home = mkdtempSync(join(scratch, "main-"));
    // Nothing listens on port 9: the balance read fails at once and leaves the network alone.
    config = loadConfig({ STINT_DEMO_HOME: home, STINT_DEMO_GATE_URL: GATE, STINT_DEMO_RPC_URL: "http://127.0.0.1:9" });
    lines = [];
    reached = [];
    built = 0;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      reached.push(url);
      return url.startsWith(GATE) ? new Response("no offer", { status: 402 }) : realFetch(input, init);
    }) as typeof fetch;
  });
  afterEach(async () => {
    for (const router of routers.splice(0)) await router.close();
    globalThis.fetch = realFetch;
    rmSync(home, { recursive: true, force: true });
  });

  const record = (line: string) => void lines.push(line);
  const routerOn = async (side: ReturnType<typeof createOwnerSide>): Promise<Router> => {
    const router = await createRouter({ dir: config.dir, readOnly: READ_ONLY, log: record, becomeOwner: side.becomeOwner });
    routers.push(router);
    return router;
  };
  const exchangeOf = (result: { structuredContent?: unknown }) =>
    (result.structuredContent as { exchange: { current: { label: string }[]; last?: { rows: { label: string }[] } } }).exchange;

  describe("the wallet", () => {
    it("is created by the copy that wins the election, and logged with its address", async () => {
      const side = createOwnerSide(config, record, makeTools);
      expect(existsSync(join(config.dir, "agent.json"))).toBe(false);
      await side.becomeOwner();
      expect(existsSync(join(config.dir, "agent.json"))).toBe(true);
      expect(lines.join("\n")).toMatch(/created the agent's wallet [1-9A-HJ-NP-Za-km-z]{32,44}/);
    });

    it("is never loaded or created by a copy that forwards, however many calls it forwards", async () => {
      // The copy that holds the state has no wallet of its own to make: `agent.json` stays absent while it holds.
      const holder = await createRouter({
        dir: config.dir,
        becomeOwner: async () => async () => ({ content: [{ type: "text", text: "holder" }] }),
      });
      routers.push(holder);
      const side = createOwnerSide(config, record, makeTools);
      const forwarder = await routerOn(side);
      expect(forwarder.role()).toBe("forwarder");
      expect((await forwarder.call(TOOL.demo, {})).content).toEqual([{ type: "text", text: "holder" }]);
      expect(existsSync(join(config.dir, "agent.json"))).toBe(false);
      expect(built).toBe(0);
      expect(lines.join("\n")).not.toMatch(/wallet/);
    });
  });

  describe("the recorder of the gate's exchanges", () => {
    it("is not stacked when a copy becomes the owner again: a request is recorded in the state that is current, and in no other", async () => {
      const side = createOwnerSide(config, record, makeTools);
      const first = await side.becomeOwner();
      const second = await side.becomeOwner();
      const launched = await second(TOOL.launch, {});
      expect(launched.isError).toBeUndefined();
      expect(exchangeOf(launched).last?.rows.map((row) => row.label)).toEqual(["POST /sessions?seconds=100", "402 Payment Required"]);
      // The first state is dropped. A wrapper left on top of it would still record into it.
      expect(exchangeOf(await first(TOOL.state, {})).current).toEqual([]);
      // And the request reached the original `fetch` once, not once per wrapper.
      expect(reached.filter((url) => url.startsWith(GATE))).toHaveLength(1);
    });

    it("does not record the router's own requests, a forwarded call and a ping", async () => {
      const side = createOwnerSide(config, record, makeTools);
      const owner = await routerOn(side);
      const forwarder = await routerOn(createOwnerSide(config, record, makeTools));
      expect([owner.role(), forwarder.role()]).toEqual(["owner", "forwarder"]);
      const state = await forwarder.call(TOOL.demo, {});
      // A forwarded call and the ping before it went through the wrapped `fetch`...
      expect(reached.some((url) => url.endsWith("/ping"))).toBe(true);
      expect(reached.some((url) => url.endsWith("/call"))).toBe(true);
      // ...and left no row.
      expect(exchangeOf(state)).toEqual({ current: [] });
    });
  });

  describe("the sessions at shutdown", () => {
    const launch = async (handler: (name: string, args: Record<string, unknown>) => Promise<unknown>) =>
      (await handler(TOOL.launch, {})) as { isError?: boolean; content: { text: string }[] };

    it("are those of every state the copy built, not only the latest", async () => {
      const side = createOwnerSide(config, record, makeTools);
      const first = await side.becomeOwner();
      await launch(first);
      const second = await side.becomeOwner();
      await launch(second);
      const outcome = await side.shutdown();
      expect(outcome.closed.sort()).toEqual([SESSION, SELLER].sort());
      expect(outcome.failed).toEqual([]);
      // Nothing opens afterwards, in either state.
      for (const handler of [first, second]) {
        const refused = await launch(handler);
        expect(refused.isError).toBe(true);
        expect(refused.content[0]!.text).toMatch(/shutting down/);
      }
    });

    it("are those of the state a router dropped when owner.json named another copy, and of the one that replaced it", async () => {
      const side = createOwnerSide(config, record, makeTools);
      const router = await routerOn(side);
      await router.call(TOOL.launch, {});
      // The file now names a copy that is gone: this copy steps down at its next call, then wins again, with a state of its own.
      writeFileSync(join(config.dir, OWNER_FILE), JSON.stringify({ pid: 4242, port: await deadPort(), token: "b".repeat(64) }));
      await router.call(TOOL.demo, {});
      expect(built).toBe(2);
      expect(lines.join("\n")).toMatch(/no longer names this copy/);
      await router.call(TOOL.launch, {});
      const outcome = await side.shutdown();
      expect(outcome.closed.sort()).toEqual([SESSION, SELLER].sort());
      await router.close();
      expect(existsSync(join(config.dir, OWNER_FILE))).toBe(false);
    });

    it("are closed for a state that is built after the shutdown began, which opens nothing", async () => {
      const side = createOwnerSide(config, record, makeTools);
      await side.shutdown();
      const late = await side.becomeOwner();
      const refused = await launch(late);
      expect(refused.isError).toBe(true);
      expect(refused.content[0]!.text).toMatch(/shutting down/);
    });

    it("are none when no state was ever built, as in a copy that only forwards", async () => {
      const side = createOwnerSide(config, record, makeTools);
      expect(await side.shutdown()).toEqual({ closed: [], failed: [] });
    });
  });
});

describe("the server's log", () => {
  afterEach(() => vi.restoreAllMocks());

  it("writes one line to stderr, with the server's prefix, and cuts every URL in it to its host", () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    log("the node at https://user:pass@rpc.example/v2?api-key=secret-marker failed; also http://127.0.0.1:8899/x?token=t");
    expect(write).toHaveBeenCalledTimes(1);
    const written = String(write.mock.calls[0]![0]);
    expect(written).toBe("stint-claude-demo: the node at https://rpc.example failed; also http://127.0.0.1:8899\n");
  });

  it("starts every line of a message that spans several with the prefix", () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    log("Invalid configuration:\n- STINT_DEMO_HOME is required");
    expect(String(write.mock.calls[0]![0])).toBe("stint-claude-demo: Invalid configuration:\nstint-claude-demo: - STINT_DEMO_HOME is required\n");
  });
});
