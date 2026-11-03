import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import { createServer, type AddressInfo, type Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OWNER_FILE, createRouter, startEndpoint, type CallHandler, type Router } from "../src/owner.js";

const scratch = fileURLToPath(new URL("../.cache/", import.meta.url));

/** A handler that answers with who it is, and what it was asked. */
const answering =
  (who: string): CallHandler =>
  async (name, args) => ({ content: [{ type: "text", text: who }], structuredContent: { who, name, args } });

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
      const endpoint = await startEndpoint(() => {
        asked.push("handler");
        return undefined;
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
    async function failingOwner(status: number): Promise<void> {
      const server = createHttpServer((request, response) => {
        request.resume();
        if (request.url === "/ping") {
          response.writeHead(200, { "content-type": "application/json" });
          return void response.end(JSON.stringify({ ok: true, pid: 1 }));
        }
        rmSync(join(home, OWNER_FILE), { force: true });
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "refused" }));
      });
      servers.push(server);
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const { port } = server.address() as { port: number };
      writeFileSync(join(home, OWNER_FILE), JSON.stringify({ pid: 1, port, token: "c".repeat(64) }));
    }
    const forwarder = async (calls: string[]): Promise<Router> => {
      const router = await createRouter({
        dir: home,
        readOnly: READ_ONLY,
        becomeOwner: async () => async (name, args) => {
          calls.push(name);
          return answering("new")(name, args);
        },
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
