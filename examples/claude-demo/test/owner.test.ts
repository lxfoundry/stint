import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer, type AddressInfo, type Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_TUNING,
  MUTATING_CALL_TIMEOUT_MS,
  OWNER_FILE,
  READ_CALL_TIMEOUT_MS,
  createRouter,
  ownerAnswers,
  startEndpoint,
  type CallHandler,
  type OwnerRecord,
  type PingVerdict,
  type Router,
  type Tuning,
} from "../src/owner.js";

const scratch = fileURLToPath(new URL("../.cache/", import.meta.url));

/** A handler that answers with who it is, and what it was asked. */
const answering =
  (who: string): CallHandler =>
  async (name, args) => ({ content: [{ type: "text", text: who }], structuredContent: { who, name, args } });

const text = (result: { content?: unknown }) => (result.content as { text: string }[])[0]!.text;

/** A port that nothing listens on any more. */
const deadPort = () =>
  new Promise<number>((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });

/** Whether this file system keeps a file's mode: a Windows drive mounted in WSL does not. */
function keepsModes(directory: string): boolean {
  const probe = join(directory, "mode-probe");
  writeFileSync(probe, "", { mode: 0o600 });
  const kept = (statSync(probe).mode & 0o777) === 0o600;
  rmSync(probe);
  return kept;
}

describe("which copy owns the demo's state", () => {
  let home: string;
  const routers: Router[] = [];
  const servers: Server[] = [];
  const closers: (() => Promise<void>)[] = [];
  beforeEach(() => {
    mkdirSync(scratch, { recursive: true });
    home = mkdtempSync(join(scratch, "owner-"));
  });
  afterEach(async () => {
    for (const router of routers.splice(0)) await router.close();
    for (const close of closers.splice(0)) await close();
    for (const server of servers.splice(0)) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    rmSync(home, { recursive: true, force: true });
  });
  const start = async (who: string): Promise<Router> => {
    const router = await createRouter({ dir: home, becomeOwner: async () => answering(who) });
    routers.push(router);
    return router;
  };
  const READ_ONLY = new Set(["stint_demo", "stint_demo_state"]);
  /**
   * An owner whose handler goes away in the middle of a call (it closes its own endpoint, which drops the connection
   * before any answer), and a forwarder; `calls` records which copy ran what.
   */
  async function ownerThatGoesAway(log?: (line: string) => void): Promise<{ second: Router; calls: string[] }> {
    const calls: string[] = [];
    let first: Router | undefined;
    first = await createRouter({
      dir: home,
      readOnly: READ_ONLY,
      becomeOwner: async () => async (name) => {
        calls.push(`first ${name}`);
        await first!.close();
        return answering("first")(name, {});
      },
    });
    routers.push(first);
    const second = await createRouter({
      dir: home,
      readOnly: READ_ONLY,
      log,
      becomeOwner: async () => async (name, args) => {
        calls.push(`second ${name}`);
        return answering("second")(name, args);
      },
    });
    routers.push(second);
    return { second, calls };
  }
  const record = () => JSON.parse(readFileSync(join(home, OWNER_FILE), "utf8")) as { pid: number; port: number; token: string };
  /** A stand-in for a copy of the server, on a real port of 127.0.0.1. */
  async function listen(onRequest: (request: IncomingMessage, response: ServerResponse) => void): Promise<number> {
    const server = createHttpServer(onRequest);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return (server.address() as AddressInfo).port;
  }
  const answerPing = (response: ServerResponse, pid: number) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, pid }));
  };

  it("makes the first copy the owner and the second a forwarder, whose calls the owner answers", async () => {
    const first = await start("first");
    const second = await start("second");
    expect([first.role(), second.role()]).toEqual(["owner", "forwarder"]);
    expect(record()).toMatchObject({ pid: process.pid });
    const result = await second.call("stint_demo_state", { refreshBalance: true });
    expect(result.structuredContent).toEqual({ who: "first", name: "stint_demo_state", args: { refreshBalance: true } });
  });

  it("takes over an owner.json that names a copy no longer running", async () => {
    writeFileSync(join(home, OWNER_FILE), JSON.stringify({ pid: 1, port: await deadPort(), token: "a".repeat(64) }));
    expect((await start("new")).role()).toBe("owner");
    expect(record().token).not.toBe("a".repeat(64));
  });

  it("takes over an owner.json that cannot be read, once it has had time to be written", async () => {
    writeFileSync(join(home, OWNER_FILE), "{");
    expect((await start("new")).role()).toBe("owner");
  });

  it("refuses a call or a ping without the owner's token", async () => {
    await start("owner");
    const { port, token } = record();
    const call = (authorization?: string) =>
      fetch(`http://127.0.0.1:${port}/call`, {
        method: "POST",
        headers: authorization ? { authorization } : {},
        body: JSON.stringify({ name: "stint_demo_state", arguments: {} }),
      });
    expect((await call()).status).toBe(401);
    expect((await call(`Bearer ${"b".repeat(64)}`)).status).toBe(401);
    expect((await fetch(`http://127.0.0.1:${port}/ping`)).status).toBe(401);
    expect((await fetch(`http://127.0.0.1:${port}/ping`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(200);
    expect((await call(`Bearer ${token}`)).status).toBe(200);
  });

  it("lets a forwarder become the owner, with a state of its own, once the owner has gone", async () => {
    const first = await start("first");
    const second = await start("second");
    await first.close();
    expect(existsSync(join(home, OWNER_FILE))).toBe(false);
    const result = await second.call("stint_demo_state", {});
    expect(result.structuredContent).toMatchObject({ who: "second" });
    expect(second.role()).toBe("owner");
  });

  it("removes its owner.json when the owner cannot start", async () => {
    await expect(
      createRouter({
        dir: home,
        becomeOwner: async () => {
          throw new Error("no wallet");
        },
      }),
    ).rejects.toThrow("no wallet");
    expect(existsSync(join(home, OWNER_FILE))).toBe(false);
  });

  it("removes its owner.json when the owner throws before it returns a promise", async () => {
    await expect(
      createRouter({
        dir: home,
        becomeOwner: () => {
          throw new Error("no wallet");
        },
      }),
    ).rejects.toThrow("no wallet");
    expect(existsSync(join(home, OWNER_FILE))).toBe(false);
  });

  it("creates the folder it is given when it is missing", async () => {
    const dir = join(home, "not", "yet");
    const router = await createRouter({ dir, becomeOwner: async () => answering("new") });
    routers.push(router);
    expect(router.role()).toBe("owner");
    expect(existsSync(join(dir, OWNER_FILE))).toBe(true);
  });

  it("never runs again an action whose owner went away during it, and says so", async () => {
    const { second, calls } = await ownerThatGoesAway();
    const result = await second.call("stint_demo_launch", {});
    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0]!.text).toMatch(/went away during stint_demo_launch: it may or may not have happened/);
    expect(calls).toEqual(["first stint_demo_launch"]);
    expect(second.role()).toBe("owner");
  });

  it("asks its own state again for a read whose owner went away during it", async () => {
    const { second, calls } = await ownerThatGoesAway();
    const result = await second.call("stint_demo_state", {});
    expect(result.structuredContent).toMatchObject({ who: "second", name: "stint_demo_state" });
    expect(calls).toEqual(["first stint_demo_state", "second stint_demo_state"]);
  });

  describe("what the owner's endpoint refuses", () => {
    /** A real owner on 127.0.0.1 whose handler records every tool it is asked to run. */
    async function recordingOwner(ran: string[]): Promise<{ port: number; token: string }> {
      const router = await createRouter({
        dir: home,
        becomeOwner: async () => async (name, args) => {
          ran.push(name);
          return answering("owner")(name, args);
        },
      });
      routers.push(router);
      return record();
    }
    const send = (port: number, token: string, path: string, init: { method?: string; body?: string } = {}) =>
      fetch(`http://127.0.0.1:${port}${path}`, { method: init.method ?? "POST", headers: { authorization: `Bearer ${token}` }, body: init.body });
    /** The answer's status and error code, once it is known not to echo the token. */
    async function refusal(response: Response, token: string): Promise<{ status: number; error: unknown }> {
      const text = await response.text();
      expect(text).not.toContain(token);
      return { status: response.status, error: (JSON.parse(text) as { error?: unknown }).error };
    }

    it("answers 400 to a body that is not a call, and runs no tool", async () => {
      const ran: string[] = [];
      const { port, token } = await recordingOwner(ran);
      const refused = async (body: string) => refusal(await send(port, token, "/call", { body }), token);
      expect(await refused("{")).toEqual({ status: 400, error: "invalid_json" });
      expect(await refused("")).toEqual({ status: 400, error: "invalid_json" });
      expect(await refused("{}")).toEqual({ status: 400, error: "invalid_call" });
      expect(await refused("null")).toEqual({ status: 400, error: "invalid_call" });
      expect(await refused("[]")).toEqual({ status: 400, error: "invalid_call" });
      expect(await refused(JSON.stringify({ name: 7, arguments: {} }))).toEqual({ status: 400, error: "invalid_call" });
      expect(await refused(JSON.stringify({ name: "stint_demo_state", arguments: [] }))).toEqual({ status: 400, error: "invalid_call" });
      expect(ran).toEqual([]);
      // A call without `arguments` is a call with none.
      const accepted = await send(port, token, "/call", { body: JSON.stringify({ name: "stint_demo_state" }) });
      expect(((await accepted.json()) as { structuredContent: unknown }).structuredContent).toEqual({ who: "owner", name: "stint_demo_state", args: {} });
      expect(ran).toEqual(["stint_demo_state"]);
    });

    it("answers 404 to any other route or method, and runs no tool", async () => {
      const ran: string[] = [];
      const { port, token } = await recordingOwner(ran);
      const body = JSON.stringify({ name: "stint_demo_state", arguments: {} });
      expect(await refusal(await send(port, token, "/nowhere", { body }), token)).toEqual({ status: 404, error: "not_found" });
      expect(await refusal(await send(port, token, "/call/extra", { body }), token)).toEqual({ status: 404, error: "not_found" });
      expect(await refusal(await send(port, token, "/ping", { body }), token)).toEqual({ status: 404, error: "not_found" });
      expect(await refusal(await send(port, token, "/call", { method: "GET" }), token)).toEqual({ status: 404, error: "not_found" });
      expect(await refusal(await send(port, token, "/", { method: "GET" }), token)).toEqual({ status: 404, error: "not_found" });
      // The token is checked first: without it, a route that exists and one that does not look alike.
      const bare = await fetch(`http://127.0.0.1:${port}/nowhere`, { method: "POST", body });
      expect(await refusal(bare, token)).toEqual({ status: 401, error: "unauthorized" });
      expect(ran).toEqual([]);
    });

    it("passes the name of a tool it does not know to its handler, which is the one to refuse it", async () => {
      const ran: string[] = [];
      const { port, token } = await recordingOwner(ran);
      const response = await send(port, token, "/call", { body: JSON.stringify({ name: "no_such_tool", arguments: {} }) });
      expect(response.status).toBe(200);
      expect(ran).toEqual(["no_such_tool"]);
    });

    it("answers 409 from a copy that does not hold the state, before it reads the body, and runs no tool", async () => {
      const asked: string[] = [];
      const endpoint = await startEndpoint({
        handler: () => {
          asked.push("handler");
          return undefined;
        },
      });
      closers.push(endpoint.close);
      const body = JSON.stringify({ name: "stint_demo_launch", arguments: {} });
      expect(await refusal(await send(endpoint.port, endpoint.token, "/call", { body }), endpoint.token)).toEqual({ status: 409, error: "not_owner" });
      // Not even a malformed body gets another answer: the copy is asked nothing it could run.
      expect(await refusal(await send(endpoint.port, endpoint.token, "/call", { body: "{" }), endpoint.token)).toEqual({ status: 409, error: "not_owner" });
      expect(asked).toEqual(["handler", "handler"]);
      // Without the token, the answer is still 401; and the copy still answers a ping.
      const bare = await fetch(`http://127.0.0.1:${endpoint.port}/call`, { method: "POST", body });
      expect(await refusal(bare, endpoint.token)).toEqual({ status: 401, error: "unauthorized" });
      expect((await send(endpoint.port, endpoint.token, "/ping", { method: "GET" })).status).toBe(200);
    });

    it("answers 413 to a body above 64 KiB, and runs no tool", async () => {
      const ran: string[] = [];
      const { port, token } = await recordingOwner(ran);
      /** A valid call of exactly `bytes` bytes. */
      const callOf = (bytes: number) => {
        const frame = JSON.stringify({ name: "stint_demo_state", arguments: { pad: "" } });
        return frame.replace(`"pad":""`, `"pad":"${"x".repeat(bytes - Buffer.byteLength(frame))}"`);
      };
      const cap = 64 * 1024;
      expect(Buffer.byteLength(callOf(cap + 1))).toBe(cap + 1);
      expect(await refusal(await send(port, token, "/call", { body: callOf(cap + 1) }), token)).toEqual({ status: 413, error: "body_too_large" });
      expect(await refusal(await send(port, token, "/call", { body: callOf(8 * cap) }), token)).toEqual({ status: 413, error: "body_too_large" });
      expect(ran).toEqual([]);
      // The cap is on the size: a call of exactly 64 KiB is still served.
      const accepted = await send(port, token, "/call", { body: callOf(cap) });
      expect(accepted.status).toBe(200);
      expect(ran).toEqual(["stint_demo_state"]);
    });
  });

  describe("an owner that refuses or fails the call it was forwarded", () => {
    /**
     * A stand-in for the owner: it answers a ping, then answers its first call with `status` and no tool run, and goes
     * away, removing its owner.json (before the answer, so that the forwarder finds it gone).
     */
    async function failingOwner(status: number | number[], { keepFile = false } = {}): Promise<void> {
      const statuses = [status].flat();
      let calls = 0;
      const server = createHttpServer((request, response) => {
        request.resume();
        if (request.url === "/ping") {
          response.writeHead(200, { "content-type": "application/json" });
          return void response.end(JSON.stringify({ ok: true, pid: 1 }));
        }
        if (!keepFile) rmSync(join(home, OWNER_FILE), { force: true });
        response.writeHead(statuses[Math.min(calls++, statuses.length - 1)]!, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "refused" }));
      });
      servers.push(server);
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const { port } = server.address() as { port: number };
      writeFileSync(join(home, OWNER_FILE), JSON.stringify({ pid: 1, port, token: "c".repeat(64) }));
    }
    const forwarder = async (calls: string[], becomeOwner?: () => Promise<CallHandler>, log?: (line: string) => void): Promise<Router> => {
      const router = await createRouter({
        dir: home,
        readOnly: READ_ONLY,
        log,
        becomeOwner:
          becomeOwner ??
          (async () => async (name, args) => {
            calls.push(name);
            return answering("new")(name, args);
          }),
      });
      routers.push(router);
      return router;
    };

    it.each([401, 404, 409])("sends a launch again after an answer of %i, which ran nothing", async (status) => {
      await failingOwner(status);
      const calls: string[] = [];
      const router = await forwarder(calls);
      expect(router.role()).toBe("forwarder");
      const result = await router.call("stint_demo_launch", {});
      expect(result.structuredContent).toMatchObject({ who: "new", name: "stint_demo_launch" });
      expect(calls).toEqual(["stint_demo_launch"]);
      expect(router.role()).toBe("owner");
    });

    it("never sends a launch again after an answer of 500, which may come after it ran, and says so", async () => {
      await failingOwner(500);
      const calls: string[] = [];
      const router = await forwarder(calls);
      const result = await router.call("stint_demo_launch", {});
      expect(result.isError).toBe(true);
      expect((result.content as { text: string }[])[0]!.text).toMatch(/may or may not have happened/);
      expect(calls).toEqual([]);
    });

    it("asks again for a read after an answer of 500", async () => {
      await failingOwner(500);
      const calls: string[] = [];
      const router = await forwarder(calls);
      expect((await router.call("stint_demo_state", {})).structuredContent).toMatchObject({ who: "new" });
      expect(calls).toEqual(["stint_demo_state"]);
    });

    it("still says a launch may have happened when the election that follows it fails", async () => {
      await failingOwner(500);
      const lines: string[] = [];
      const router = await forwarder(
        [],
        async () => {
          throw new Error("no wallet");
        },
        (line) => lines.push(line),
      );
      const result = await router.call("stint_demo_launch", {});
      expect(result.isError).toBe(true);
      expect(text(result)).toMatch(/went away during stint_demo_launch: it may or may not have happened/);
      expect(lines.some((line) => line.includes("electing again failed: no wallet"))).toBe(true);
      expect(router.role()).toBe("forwarder");
      expect(existsSync(join(home, OWNER_FILE))).toBe(false);
    });

    it.each([
      ["a read whose owner went away during it", "stint_demo_state", 500],
      ["a launch that its owner surely did not run", "stint_demo_launch", 409],
    ])("fails %s with the election's own error when the election fails", async (_label, tool, status) => {
      await failingOwner(status);
      const router = await forwarder([], async () => {
        throw new Error("no wallet");
      });
      await expect(router.call(tool, {})).rejects.toThrow("no wallet");
    });

    it("answers with a tool error, not a failure, when the owner it asks again refuses the call too", async () => {
      await failingOwner(409, { keepFile: true });
      const calls: string[] = [];
      const router = await forwarder(calls);
      const result = await router.call("stint_demo_launch", {});
      expect(result.isError).toBe(true);
      expect(text(result)).toMatch(/could not be reached for stint_demo_launch, which changed nothing/);
      expect(calls).toEqual([]);
    });

    it("says a launch may have happened when the owner it asks again fails it after running it", async () => {
      await failingOwner([409, 500], { keepFile: true });
      const calls: string[] = [];
      const router = await forwarder(calls);
      const result = await router.call("stint_demo_launch", {});
      expect(result.isError).toBe(true);
      expect(text(result)).toMatch(/may or may not have happened/);
      expect(calls).toEqual([]);
    });
  });

  describe("a copy that is no longer the owner", () => {
    /** An owner in `home`, a rival owner in `home/rival`, and then the rival's record in the place of the owner's. */
    async function replacedOwner(log?: (line: string) => void, onStepDown?: (dropped: Promise<CallHandler>) => void) {
      const ran: string[] = [];
      const deposed = await createRouter({
        dir: home,
        log,
        onStepDown,
        becomeOwner: async () => async (name, args) => {
          ran.push(name);
          return answering("deposed")(name, args);
        },
      });
      routers.push(deposed);
      const former = record();
      const rival = await createRouter({ dir: join(home, "rival"), becomeOwner: async () => answering("rival") });
      routers.push(rival);
      writeFileSync(join(home, OWNER_FILE), readFileSync(join(home, "rival", OWNER_FILE)));
      return { deposed, ran, former };
    }

    it("steps down at its next call and forwards it, and runs no tool", async () => {
      const lines: string[] = [];
      const { deposed, ran, former } = await replacedOwner((line) => lines.push(line));
      expect(deposed.role()).toBe("owner");
      const result = await deposed.call("stint_demo_launch", { amount: "1" });
      expect(result.structuredContent).toEqual({ who: "rival", name: "stint_demo_launch", args: { amount: "1" } });
      expect(ran).toEqual([]);
      expect(deposed.role()).toBe("forwarder");
      // It no longer listens, and says why without quoting its token.
      await expect(fetch(`http://127.0.0.1:${former.port}/ping`, { headers: { authorization: `Bearer ${former.token}` } })).rejects.toThrow();
      expect(lines.join("\n")).toMatch(/no longer names this copy/);
      expect(lines.join("\n")).not.toContain(former.token);
      // The calls after it go straight to the rival.
      expect((await deposed.call("stint_demo_state", {})).structuredContent).toMatchObject({ who: "rival" });
      expect(ran).toEqual([]);
    });

    it("hands the state it drops to onStepDown, once, as it steps down", async () => {
      const dropped: CallHandler[] = [];
      const { deposed, ran } = await replacedOwner(undefined, (handler) => void handler.then((built) => dropped.push(built)));
      await deposed.call("stint_demo_launch", {});
      await vi.waitFor(() => expect(dropped).toHaveLength(1));
      // It is the state the deposed copy built: running it runs that copy's tool.
      await dropped[0]!("stint_demo", {});
      expect(ran).toEqual(["stint_demo"]);
      await deposed.call("stint_demo_state", {});
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(dropped).toHaveLength(1);
    });

    it("answers a call that was forwarded to it with 409, and runs no tool", async () => {
      const { deposed, ran, former } = await replacedOwner();
      const response = await fetch(`http://127.0.0.1:${former.port}/call`, {
        method: "POST",
        headers: { authorization: `Bearer ${former.token}` },
        body: JSON.stringify({ name: "stint_demo_launch", arguments: {} }),
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: "not_owner" });
      expect(ran).toEqual([]);
      expect(deposed.role()).toBe("forwarder");
    });

    it("takes owner.json back, with the state it has, when the file is gone and no one else has created it", async () => {
      const ran: string[] = [];
      const router = await createRouter({
        dir: home,
        becomeOwner: async () => async (name, args) => {
          ran.push(name);
          return answering("owner")(name, args);
        },
      });
      routers.push(router);
      const before = readFileSync(join(home, OWNER_FILE), "utf8");
      rmSync(join(home, OWNER_FILE));
      expect((await router.call("stint_demo_launch", {})).structuredContent).toMatchObject({ who: "owner" });
      expect(ran).toEqual(["stint_demo_launch"]);
      expect(router.role()).toBe("owner");
      expect(readFileSync(join(home, OWNER_FILE), "utf8")).toBe(before);
    });

    it("keeps one state when several calls find owner.json gone at the same time", async () => {
      const lines: string[] = [];
      let builds = 0;
      const router = await createRouter({
        dir: home,
        log: (line) => lines.push(line),
        becomeOwner: async () => {
          const state = ++builds;
          return async (name) => ({ content: [{ type: "text", text: `${name}@state${state}` }] });
        },
      });
      routers.push(router);
      const before = readFileSync(join(home, OWNER_FILE), "utf8");
      rmSync(join(home, OWNER_FILE));
      // Both checks read the file before either has created it again: the second one's `wx` finds the first one's file.
      const results = await Promise.all([router.call("a", {}), router.call("b", {})]);
      expect(results.map(text)).toEqual(["a@state1", "b@state1"]);
      expect(builds).toBe(1);
      expect(router.role()).toBe("owner");
      expect(readFileSync(join(home, OWNER_FILE), "utf8")).toBe(before);
      expect(lines.join("\n")).not.toMatch(/stops serving/);
    });

    it("does not run on a state that was dropped while the call was still arriving", async () => {
      const ran: string[] = [];
      let states = 0;
      const router = await createRouter({
        dir: home,
        becomeOwner: async () => {
          const state = ++states;
          return async (name, args) => {
            ran.push(`${name}@state${state}`);
            return answering(`state${state}`)(name, args);
          };
        },
      });
      routers.push(router);
      const first = record();
      // A call that the first state's endpoint has taken, and whose body is not sent yet. With `Expect: 100-continue` the
      // server answers 100 after its handler has taken the call, so the client knows when that is without waiting.
      const body = JSON.stringify({ name: "stint_demo_launch", arguments: {} });
      const arriving = httpRequest({
        host: "127.0.0.1",
        port: first.port,
        method: "POST",
        path: "/call",
        headers: { authorization: `Bearer ${first.token}`, "content-length": Buffer.byteLength(body), expect: "100-continue" },
      });
      const answer = new Promise<{ status: number; body: string }>((resolve, reject) => {
        arriving.on("error", reject);
        arriving.on("response", (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
        });
      });
      await new Promise<void>((resolve) => arriving.once("continue", resolve));
      // The file now names a copy that is gone: this copy steps down, then wins the election again, with a state of its own.
      writeFileSync(join(home, OWNER_FILE), JSON.stringify({ pid: 4242, port: await deadPort(), token: "b".repeat(64) }));
      expect((await router.call("stint_demo_state", {})).structuredContent).toMatchObject({ who: "state2" });
      expect(states).toBe(2);
      // Then the body of the call arrives, for the state that is gone.
      arriving.end(body);
      const { status, body: answered } = await answer;
      expect(status).toBe(409);
      expect(answered).not.toContain(first.token);
      expect(ran).toEqual(["stint_demo_state@state2"]);
    });

    it("refuses calls once it is closed, and does not bring owner.json back", async () => {
      const router = await start("owner");
      await router.close();
      await expect(router.call("stint_demo_state", {})).rejects.toThrow(/shut down/);
      expect(existsSync(join(home, OWNER_FILE))).toBe(false);
    });

    it("does not remove an owner.json that is a different file each time it is read", async () => {
      const rival = await createRouter({ dir: join(home, "rival"), becomeOwner: async () => answering("rival") });
      routers.push(rival);
      const theirs = readFileSync(join(home, "rival", OWNER_FILE), "utf8");
      const path = join(home, OWNER_FILE);
      writeFileSync(path, "{");
      let pauses = 0;
      const router = await createRouter({
        dir: home,
        becomeOwner: async () => answering("new"),
        tuning: {
          // While the copy waits to read the file again, another one replaces it: first with one that is not written yet,
          // then with the same one, written.
          sleep: async () => {
            pauses += 1;
            rmSync(path);
            writeFileSync(path, pauses === 1 ? "{{" : theirs);
          },
        },
      });
      routers.push(router);
      expect(router.role()).toBe("forwarder");
      expect(pauses).toBe(2);
      expect(readFileSync(path, "utf8")).toBe(theirs);
    });
  });

  describe("an owner that does not answer a ping", () => {
    /** A stand-in at `owner.json`; `onPing` decides what each ping gets (nothing, to leave it waiting). */
    async function standInOwner(pid: number, onPing: (count: number, response: ServerResponse) => void) {
      let pings = 0;
      const port = await listen((request, response) => {
        request.resume();
        if (request.url !== "/ping") return void response.writeHead(404).end();
        pings += 1;
        onPing(pings, response);
      });
      writeFileSync(join(home, OWNER_FILE), JSON.stringify({ pid, port, token: "f".repeat(64) }));
      return { pings: () => pings };
    }
    const quick = { pingTimeoutMs: 100, pingRetryDelayMs: 5 };
    const router = async (tuning: Partial<Tuning>) => {
      const created = await createRouter({ dir: home, becomeOwner: async () => answering("new"), tuning: { ...quick, ...tuning } });
      routers.push(created);
      return created;
    };

    it("is not taken over while its process exists and it answers within the grace", async () => {
      const owner = await standInOwner(process.pid, (count, response) => {
        if (count >= 3) answerPing(response, process.pid);
      });
      const created = await router({ takeoverGraceMs: 30_000, processExists: () => true });
      expect(created.role()).toBe("forwarder");
      // Three pings at least: a third one that comes late is asked for again, and answered too.
      expect(owner.pings()).toBeGreaterThanOrEqual(3);
      expect(readFileSync(join(home, OWNER_FILE), "utf8")).toContain("f".repeat(64));
    });

    it("is taken over at once when its process is gone", async () => {
      const owner = await standInOwner(4242, () => {});
      const asked: number[] = [];
      const created = await router({
        takeoverGraceMs: 30_000,
        processExists: (pid) => {
          asked.push(pid);
          return false;
        },
      });
      expect(created.role()).toBe("owner");
      expect(owner.pings()).toBe(1);
      expect(asked).toEqual([4242]);
    });

    it("is taken over once it has stayed silent for the whole grace", async () => {
      const owner = await standInOwner(process.pid, () => {});
      const created = await router({ takeoverGraceMs: 600, processExists: () => true });
      expect(created.role()).toBe("owner");
      expect(owner.pings()).toBeGreaterThanOrEqual(2);
    });

    it.each([
      ["a body without its pid", JSON.stringify({ ok: true, pid: 2 })],
      ["a body that does not answer a ping", JSON.stringify({ hello: "world" })],
      ["a body that is not JSON", "pong"],
    ])("does not take a 200 with %s for the owner", async (_label, body) => {
      const port = await listen((request, response) => {
        request.resume();
        response.writeHead(200).end(body);
      });
      writeFileSync(join(home, OWNER_FILE), JSON.stringify({ pid: 1, port, token: "a".repeat(64) }));
      expect((await start("new")).role()).toBe("owner");
      expect(record().token).not.toBe("a".repeat(64));
    });
  });

  describe("a forwarded call that the owner does not answer", () => {
    /** A stand-in owner that answers a ping and holds every call without an answer. */
    async function hungOwner(): Promise<{ held: () => number }> {
      let held = 0;
      const port = await listen((request, response) => {
        request.resume();
        if (request.url === "/ping") return answerPing(response, 1);
        held += 1;
      });
      writeFileSync(join(home, OWNER_FILE), JSON.stringify({ pid: 1, port, token: "9".repeat(64) }));
      return { held: () => held };
    }
    const forwarder = async (calls: string[]): Promise<Router> => {
      const router = await createRouter({
        dir: home,
        readOnly: READ_ONLY,
        tuning: { mutatingCallTimeoutMs: 1_500, readCallTimeoutMs: 100 },
        becomeOwner: async () => async (name, args) => {
          calls.push(name);
          return answering("new")(name, args);
        },
      });
      routers.push(router);
      return router;
    };

    it("waits the long timeout for a launch, then says it may have happened and does not send it again", async () => {
      const owner = await hungOwner();
      const calls: string[] = [];
      const router = await forwarder(calls);
      const started = Date.now();
      const result = await router.call("stint_demo_launch", {});
      expect(Date.now() - started).toBeGreaterThanOrEqual(1_200);
      expect(result.isError).toBe(true);
      expect(text(result)).toMatch(/did not answer stint_demo_launch in time: it may or may not have happened/);
      expect(owner.held()).toBe(1);
      expect(calls).toEqual([]);
      expect(router.role()).toBe("forwarder");
    });

    it("waits the short timeout for a read, asks again once, and then answers with a tool error", async () => {
      const owner = await hungOwner();
      const calls: string[] = [];
      const router = await forwarder(calls);
      const started = Date.now();
      const result = await router.call("stint_demo_state", {});
      // Two waits of the short timeout: far from the 1 500 ms of the long one, which two would make 3 000.
      expect(Date.now() - started).toBeLessThan(1_200);
      expect(result.isError).toBe(true);
      expect(text(result)).toMatch(/could not be reached for stint_demo_state/);
      expect(owner.held()).toBe(2);
      expect(calls).toEqual([]);
    });

    it("waits 120 s for a launch, top-up or close and 15 s for the tools that only read", () => {
      expect([MUTATING_CALL_TIMEOUT_MS, READ_CALL_TIMEOUT_MS]).toEqual([120_000, 15_000]);
      expect([DEFAULT_TUNING.mutatingCallTimeoutMs, DEFAULT_TUNING.readCallTimeoutMs]).toEqual([120_000, 15_000]);
    });
  });

  describe("what the endpoint logs", () => {
    it("logs the message of an error that failed a call, with neither the token nor the call", async () => {
      const lines: string[] = [];
      const router = await createRouter({
        dir: home,
        log: (line) => lines.push(line),
        becomeOwner: async () => async () => {
          throw new Error("the chain said no");
        },
      });
      routers.push(router);
      const { port, token } = record();
      const response = await fetch(`http://127.0.0.1:${port}/call`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ name: "stint_demo_launch", arguments: { memo: "call-argument-marker" } }),
      });
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: "internal" });
      expect(lines.join("\n")).toContain("the chain said no");
      expect(lines.join("\n")).not.toContain(token);
      expect(lines.join("\n")).not.toContain("call-argument-marker");
    });

    it("takes its token out of an error message that has it", async () => {
      let token = "";
      const lines: string[] = [];
      const endpoint = await startEndpoint({
        handler: () =>
          Promise.resolve(async () => {
            throw new Error(`refused for Bearer ${token}`);
          }),
        log: (line) => lines.push(line),
      });
      token = endpoint.token;
      closers.push(endpoint.close);
      const response = await fetch(`http://127.0.0.1:${endpoint.port}/call`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ name: "stint_demo_launch", arguments: {} }),
      });
      expect(response.status).toBe(500);
      expect(lines.join("\n")).toContain("refused for Bearer [token]");
      expect(lines.join("\n")).not.toContain(token);
    });
  });

  it("stays the owner when a call it forwarded before it won the election fails after it has won", async () => {
    // A stand-in owner that answers a ping and holds every call without answering it, until the test cuts its connection.
    const held: Socket[] = [];
    const server = createHttpServer((request, response) => {
      request.resume();
      if (request.url !== "/ping") return void held.push(request.socket);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, pid: 1 }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    writeFileSync(join(home, OWNER_FILE), JSON.stringify({ pid: 1, port: (server.address() as AddressInfo).port, token: "e".repeat(64) }));
    const calls: string[] = [];
    const router = await createRouter({
      dir: home,
      readOnly: READ_ONLY,
      becomeOwner: async () => async (name, args) => {
        calls.push(name);
        return answering("new")(name, args);
      },
    });
    routers.push(router);
    expect(router.role()).toBe("forwarder");
    const early = router.call("stint_demo_state", {});
    const late = router.call("stint_demo", {});
    await vi.waitFor(() => expect(held).toHaveLength(2));
    // The owner goes: its file is removed, and one of the two calls sees the connection cut. That copy wins the election.
    rmSync(join(home, OWNER_FILE));
    held[0]!.destroy();
    expect((await early).structuredContent).toMatchObject({ who: "new" });
    expect(router.role()).toBe("owner");
    // The other call sees it only now: it must not take its own endpoint for another owner.
    held[1]!.destroy();
    expect((await late).structuredContent).toMatchObject({ who: "new" });
    expect(router.role()).toBe("owner");
    expect(calls).toHaveLength(2);
    await router.close();
    expect(existsSync(join(home, OWNER_FILE))).toBe(false);
  });

  it("leaves an owner.json that now names another copy when it closes", async () => {
    const router = await start("owner");
    const other = JSON.stringify({ pid: 1, port: 1, token: "d".repeat(64) });
    writeFileSync(join(home, OWNER_FILE), other);
    await router.close();
    expect(readFileSync(join(home, OWNER_FILE), "utf8")).toBe(other);
  });

  it("quotes no token in what it logs", async () => {
    const lines: string[] = [];
    const { second } = await ownerThatGoesAway((line) => lines.push(line));
    const before = record().token;
    await second.call("stint_demo_launch", {});
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("\n")).not.toContain(before);
    expect(lines.join("\n")).not.toContain(record().token);
  });

  // Not under the package: `/mnt/<drive>` (a Windows drive in WSL) reports every mode as 777, so this one runs in the
  // home directory. It is skipped only where even the home directory does not keep modes.
  it("writes owner.json readable by its owner only", async (context) => {
    const parent = join(homedir(), ".cache");
    mkdirSync(parent, { recursive: true });
    const folder = mkdtempSync(join(parent, "stint-claude-demo-test-"));
    let router: Router | undefined;
    try {
      if (!keepsModes(folder)) context.skip("the home directory does not keep file modes");
      router = await createRouter({ dir: folder, becomeOwner: async () => answering("owner") });
      expect(statSync(join(folder, OWNER_FILE)).mode & 0o777).toBe(0o600);
    } finally {
      await router?.close();
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it("stops its endpoint and says why when owner.json cannot be created", async (context) => {
    const parent = join(homedir(), ".cache");
    mkdirSync(parent, { recursive: true });
    const folder = mkdtempSync(join(parent, "stint-claude-demo-test-"));
    try {
      if (!keepsModes(folder) || process.getuid?.() === 0) context.skip("this user can write to a read-only folder, or its files keep no modes");
      chmodSync(folder, 0o500);
      const listening = () => process.getActiveResourcesInfo().filter((resource) => resource === "TCPServerWrap").length;
      // A closed server leaves the list a moment after it reports itself closed: those of the tests before this one too.
      await vi.waitFor(() => expect(listening()).toBe(0));
      await expect(createRouter({ dir: folder, becomeOwner: async () => answering("owner") })).rejects.toThrow(/EACCES/);
      await vi.waitFor(() => expect(listening()).toBe(0));
    } finally {
      chmodSync(folder, 0o700);
      rmSync(folder, { recursive: true, force: true });
    }
  });
});

describe("whether an owner that does not answer is a dead one", () => {
  const owner: OwnerRecord = { pid: 4242, port: 1234, token: "a".repeat(64) };
  const START = 1_000_000;
  /** A clock of its own: a silent ping takes its whole timeout, and a pause takes its length. */
  function fake(verdicts: PingVerdict[], alive: boolean) {
    let time = START;
    const pingsAt: number[] = [];
    const slept: number[] = [];
    const tuning: Tuning = {
      ...DEFAULT_TUNING,
      now: () => time,
      sleep: async (ms) => {
        slept.push(ms);
        time += ms;
      },
      ping: async (_record, timeoutMs) => {
        pingsAt.push(time - START);
        const verdict = verdicts.shift() ?? "silent";
        if (verdict === "silent") time += timeoutMs;
        return verdict;
      },
      processExists: () => alive,
    };
    return { tuning, pingsAt, slept, elapsed: () => time - START };
  }

  it("keeps asking a silent owner whose process exists for the whole grace, and then gives it up", async () => {
    const { tuning, pingsAt, elapsed } = fake([], true);
    expect(await ownerAnswers(owner, tuning)).toBe(false);
    expect(pingsAt.length).toBeGreaterThanOrEqual(4);
    expect(elapsed()).toBeGreaterThanOrEqual(tuning.takeoverGraceMs);
    // Every ping but the last was asked before the grace was over.
    expect(pingsAt.slice(0, -1).every((at) => at < tuning.takeoverGraceMs)).toBe(true);
  });

  it("takes an owner that answers on a later ping for alive", async () => {
    const { tuning, pingsAt, elapsed } = fake(["silent", "silent", "owner"], true);
    expect(await ownerAnswers(owner, tuning)).toBe(true);
    expect(pingsAt).toHaveLength(3);
    expect(elapsed()).toBeLessThan(tuning.takeoverGraceMs);
  });

  it("gives up a silent owner at once when its process is gone", async () => {
    const { tuning, pingsAt, slept } = fake(["silent"], false);
    expect(await ownerAnswers(owner, tuning)).toBe(false);
    expect(pingsAt).toHaveLength(1);
    expect(slept).toEqual([]);
  });

  it("gives up at once on a port where something else answers, whether or not the process exists", async () => {
    const { tuning, pingsAt, slept } = fake(["other"], true);
    expect(await ownerAnswers(owner, tuning)).toBe(false);
    expect(pingsAt).toHaveLength(1);
    expect(slept).toEqual([]);
  });
});
