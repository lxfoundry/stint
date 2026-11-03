import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { HttpError, readJson, sendJson } from "@lxfoundry/stint-x402";

/** In the wallet's folder: which copy of the server holds the demo's state, and how to reach it. */
export const OWNER_FILE = "owner.json";
const PING_TIMEOUT_MS = 1_000;
/** A copy that finds `owner.json` unreadable reads it again after this: the copy that created it may not have written it. */
const REREAD_DELAY_MS = 250;
const MAX_BODY_BYTES = 64 * 1024;

export type CallHandler = (name: string, args: Record<string, unknown>) => Promise<CallToolResult>;

export interface OwnerRecord {
  readonly pid: number;
  readonly port: number;
  /** 32 random bytes, hexadecimal: the Bearer token of the owner's endpoint. */
  readonly token: string;
}

export interface RouterOptions {
  /** The folder `owner.json` is created in (the wallet's), itself created if it is missing. */
  readonly dir: string;
  /** Builds the handler that holds the state, once this copy is the owner. Called once per election this copy wins. */
  readonly becomeOwner: () => Promise<CallHandler>;
  /**
   * The tools that only read: a forwarder asks again for one whose owner went away during it. Any other tool is never
   * sent twice once it may have run. Default: none.
   */
  readonly readOnly?: ReadonlySet<string>;
  readonly log?: (line: string) => void;
}

/** The `code`s of the causes `fetch` fails with when it cannot connect: the request was never sent. */
const CONNECT_FAILURES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "UND_ERR_CONNECT_TIMEOUT"]);
/** The answers with which an endpoint refuses a call before it runs any tool: bad token, no such route, not the owner. */
const REFUSED_BEFORE_RUNNING = new Set([401, 404, 409]);

/** A forwarded call that failed. `ran` is false when the owner surely ran nothing, and undefined when no one can tell. */
class ForwardError extends Error {
  constructor(
    message: string,
    readonly ran: false | undefined,
  ) {
    super(message);
    this.name = "ForwardError";
  }
}

const describe = (error: unknown): string =>
  error instanceof Error ? `${error.message}${error.cause instanceof Error ? `: ${error.cause.message}` : ""}` : String(error);

export interface Router {
  /** Serves a tool call: here when this copy owns the state, through the owner's endpoint otherwise. */
  readonly call: CallHandler;
  role(): "owner" | "forwarder";
  /** Stops this copy's endpoint. The owner then removes `owner.json`, if the file still names it. */
  close(): Promise<void>;
}

type Read = OwnerRecord | "missing" | "unreadable";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const digest = (text: string) => createHash("sha256").update(text, "utf8").digest();
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isOwnerRecord = (value: unknown): value is OwnerRecord =>
  isRecord(value) && Number.isInteger(value.pid) && Number.isInteger(value.port) && typeof value.token === "string" && /^[0-9a-f]{64}$/.test(value.token);

export interface Endpoint {
  readonly port: number;
  readonly token: string;
  close(): Promise<void>;
}

/**
 * `GET /ping` and `POST /call`, on 127.0.0.1 only, each with this copy's Bearer token, compared in constant time over
 * SHA-256 digests. `/call` waits for the owner's handler while it is being built, and answers `409` without one.
 * Exported for the tests of its refusals: a copy that loses the election closes its endpoint before anyone knows its
 * port, so no election reaches the `409`.
 */
export async function startEndpoint(handler: () => Promise<CallHandler> | undefined): Promise<Endpoint> {
  const token = randomBytes(32).toString("hex");
  const expected = digest(`Bearer ${token}`);
  const authorized = (request: IncomingMessage) => timingSafeEqual(digest(request.headers.authorization ?? ""), expected);

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!authorized(request)) return sendJson(response, 401, { error: "unauthorized" });
    if (request.method === "GET" && request.url === "/ping") return sendJson(response, 200, { ok: true, pid: process.pid });
    if (request.method !== "POST" || request.url !== "/call") return sendJson(response, 404, { error: "not_found" });
    const pending = handler();
    if (!pending) return sendJson(response, 409, { error: "not_owner" });
    const body = await readJson(request, MAX_BODY_BYTES);
    if (!isRecord(body) || typeof body.name !== "string" || (body.arguments !== undefined && !isRecord(body.arguments))) {
      return sendJson(response, 400, { error: "invalid_call" });
    }
    const call = await pending;
    sendJson(response, 200, await call(body.name, (body.arguments as Record<string, unknown> | undefined) ?? {}));
  }

  const server = createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      if (response.headersSent) return void response.end();
      if (error instanceof HttpError) sendJson(response, error.status, { error: error.code });
      else sendJson(response, 500, { error: "internal" });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    port: (server.address() as AddressInfo).port,
    token,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** Creates `path` with `record`, or returns false if it exists: the first copy to create it is the owner. */
function tryCreate(path: string, record: OwnerRecord): boolean {
  let fd: number;
  try {
    fd = openSync(path, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  try {
    writeSync(fd, JSON.stringify(record));
  } finally {
    closeSync(fd);
  }
  return true;
}

function readOnce(path: string): Read {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isOwnerRecord(value) ? value : "unreadable";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable";
  }
}

async function readRecord(path: string): Promise<Read> {
  const first = readOnce(path);
  if (first !== "unreadable") return first;
  await sleep(REREAD_DELAY_MS);
  return readOnce(path);
}

async function ping(record: OwnerRecord): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${record.port}/ping`, {
      headers: { authorization: `Bearer ${record.token}` },
      signal: AbortSignal.timeout(PING_TIMEOUT_MS),
    });
    await response.body?.cancel();
    return response.status === 200;
  } catch {
    return false;
  }
}

const sameRead = (a: Read, b: Read) => (typeof a === "object" && typeof b === "object" ? a.token === b.token : a === b);

/** Removes `path` if it still holds what was read: a newer owner's file stays. */
function removeStale(path: string, seen: Read): void {
  if (!sameRead(readOnce(path), seen)) return;
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/**
 * Elects the copy that holds the state (one `owner.json` per wallet folder) and routes every call to it. A copy starts
 * its endpoint, then tries to create `owner.json` naming it. If the file exists and its copy answers `/ping`, this copy
 * forwards; if not (a dead copy, a stale or unreadable file), it removes the file and tries once more. A forwarder whose
 * owner cannot be reached elects again, once per call, and may become the owner, with a state of its own. It then sends
 * the call again only if the owner surely ran nothing, or if the tool only reads; otherwise it answers with a tool error.
 */
export async function createRouter(options: RouterOptions): Promise<Router> {
  // Before anything else: `openSync(…, "wx")` cannot create a file in a folder that does not exist.
  mkdirSync(options.dir, { recursive: true });
  const path = join(options.dir, OWNER_FILE);
  const log = options.log ?? (() => {});
  const readOnly = options.readOnly ?? new Set<string>();
  let role: "owner" | "forwarder" = "forwarder";
  let endpoint: Endpoint | undefined;
  let peer: OwnerRecord | undefined;
  let handler: Promise<CallHandler> | undefined;
  let electing: Promise<void> | undefined;

  const removeOurs = (token: string) => {
    const now = readOnce(path);
    if (typeof now === "object" && now.pid === process.pid && now.token === token) removeStale(path, now);
  };

  async function elect(): Promise<void> {
    for (let attempt = 1; attempt <= 2; attempt++) {
      const mine = await startEndpoint(() => handler);
      let created: boolean;
      try {
        created = tryCreate(path, { pid: process.pid, port: mine.port, token: mine.token });
      } catch (error) {
        await mine.close();
        throw error;
      }
      if (created) {
        endpoint = mine;
        role = "owner";
        peer = undefined;
        // An async wrapper, so that a `becomeOwner` that throws before it returns fails the same way as one that rejects.
        handler = (async () => options.becomeOwner())();
        try {
          await handler;
        } catch (error) {
          handler = undefined;
          role = "forwarder";
          endpoint = undefined;
          await mine.close();
          removeOurs(mine.token);
          throw error;
        }
        return;
      }
      await mine.close();
      const seen = await readRecord(path);
      if (typeof seen === "object" && (await ping(seen))) {
        role = "forwarder";
        peer = seen;
        return;
      }
      if (seen !== "missing") {
        log(`${path} names no copy that answers: taking it over`);
        removeStale(path, seen);
      }
    }
    throw new Error(`Could not settle which copy of the server holds the demo's state (${path})`);
  }

  /**
   * One election at a time, shared by every call that fails together. A call that fails after this copy has won one (it was
   * sent to the old owner before) does not hold another: it would find its own `owner.json` and take its own endpoint for
   * a peer.
   */
  const reelect = (): Promise<void> => {
    if (electing) return electing;
    if (role === "owner") return Promise.resolve();
    return (electing = elect().finally(() => {
      electing = undefined;
    }));
  };

  /**
   * Sends the call to the owner. A failure says whether the owner surely ran nothing (it could not be reached, or it
   * refused the call first) or whether no one can tell (the connection dropped once the call was sent, or the answer
   * was not one), which a reused connection to an owner that has just gone can also give.
   */
  async function forward(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    const target = peer;
    if (!target) throw new ForwardError("no owner to forward to", false);
    let response: Response;
    try {
      response = await fetch(`http://127.0.0.1:${target.port}/call`, {
        method: "POST",
        headers: { authorization: `Bearer ${target.token}`, "content-type": "application/json" },
        body: JSON.stringify({ name, arguments: args }),
      });
    } catch (error) {
      const code = String(((error as Error).cause as { code?: unknown } | undefined)?.code);
      throw new ForwardError(`the owner copy cannot be reached (${describe(error)})`, CONNECT_FAILURES.has(code) ? false : undefined);
    }
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new ForwardError(`the owner copy answered ${response.status}`, REFUSED_BEFORE_RUNNING.has(response.status) ? false : undefined);
    }
    try {
      return (await response.json()) as CallToolResult;
    } catch (error) {
      throw new ForwardError(`the owner copy's answer was cut short (${describe(error)})`, undefined);
    }
  }

  const call: CallHandler = async (name, args) => {
    if (role === "owner" && handler) return (await handler)(name, args);
    try {
      return await forward(name, args);
    } catch (error) {
      if (!(error instanceof ForwardError)) throw error;
      log(`${error.message}: electing again`);
      await reelect();
      // A launch, top-up or close may have run before the owner went: sent again, it could pay twice.
      if (error.ran === undefined && !readOnly.has(name)) {
        const text = `The copy of the server that held the demo's state went away during ${name}: it may or may not have happened. Check the panel before trying again.`;
        return { isError: true, content: [{ type: "text", text }] };
      }
      if (role === "owner" && handler) return (await handler)(name, args);
      return forward(name, args);
    }
  };

  await reelect();
  return {
    call,
    role: () => role,
    async close() {
      const mine = endpoint;
      endpoint = undefined;
      await mine?.close();
      if (role === "owner" && mine) removeOurs(mine.token);
    },
  };
}
