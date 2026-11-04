import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { HttpError, readJson, sendJson } from "@lxfoundry/stint-x402";

/** In the wallet's folder: which copy of the server holds the demo's state, and how to reach it. */
export const OWNER_FILE = "owner.json";
const MAX_BODY_BYTES = 64 * 1024;

export type CallHandler = (name: string, args: Record<string, unknown>) => Promise<CallToolResult>;

export interface OwnerRecord {
  readonly pid: number;
  readonly port: number;
  /** 32 random bytes, hexadecimal: the Bearer token of the owner's endpoint. */
  readonly token: string;
}

/** What a ping found: the owner itself, something else (or nothing) at that port, or no answer in time. */
export type PingVerdict = "owner" | "other" | "silent";

/**
 * The waits and the probes of a router. The defaults are the real ones; tests replace them, to run on a clock of their
 * own and to answer for the network and for the process table.
 */
export interface Tuning {
  /** How long a ping waits for an answer. */
  readonly pingTimeoutMs: number;
  /**
   * How long a copy keeps asking a silent owner whose process still exists, before taking over. A busy owner is not a
   * dead one; a process that is gone is taken over at once.
   */
  readonly takeoverGraceMs: number;
  /** The pause between two pings of a silent owner. */
  readonly pingRetryDelayMs: number;
  /** A copy that finds `owner.json` unreadable reads it again after this: the copy that created it may not have written it. */
  readonly rereadDelayMs: number;
  /** How long a forwarded call that changes something (a launch, top-up or close) waits for the owner's answer. */
  readonly mutatingCallTimeoutMs: number;
  /** The same for a tool that only reads. */
  readonly readCallTimeoutMs: number;
  ping(record: OwnerRecord, timeoutMs: number): Promise<PingVerdict>;
  processExists(pid: number): boolean;
  now(): number;
  sleep(ms: number): Promise<void>;
}

/** A launch, top-up or close waits for the chain, so for a long time; a read does not. */
export const MUTATING_CALL_TIMEOUT_MS = 120_000;
export const READ_CALL_TIMEOUT_MS = 15_000;

export interface RouterOptions {
  /** The folder `owner.json` is created in (the wallet's), itself created if it is missing. */
  readonly dir: string;
  /** Builds the handler that holds the state, once this copy is the owner. Called once per election this copy wins. */
  readonly becomeOwner: () => Promise<CallHandler>;
  /**
   * Told of the state this copy drops when `owner.json` names another copy (what `becomeOwner` gave, or is still
   * building), once per state: no new call reaches that state, so whatever it holds open is for its owner to end.
   */
  readonly onStepDown?: (dropped: Promise<CallHandler>) => void;
  /**
   * The tools that only read: a forwarder asks again for one whose owner went away during it, and gives it the shorter
   * timeout. Any other tool is never sent twice once it may have run. Default: none.
   */
  readonly readOnly?: ReadonlySet<string>;
  readonly log?: (line: string) => void;
  /** Replaces some of the waits and probes; for tests. */
  readonly tuning?: Partial<Tuning>;
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
    /** The owner did not answer in time (it may be busy, not gone). */
    readonly timedOut = false,
  ) {
    super(message);
    this.name = "ForwardError";
  }
}

const describe = (error: unknown): string =>
  error instanceof Error ? `${error.message}${error.cause instanceof Error ? `: ${error.cause.message}` : ""}` : String(error);
const isTimeout = (error: unknown): boolean => error instanceof Error && error.name === "TimeoutError";

export interface Router {
  /**
   * Serves a tool call: here when this copy owns the state, through the owner's endpoint otherwise. A copy that finds
   * it no longer owns the state (another copy holds `owner.json`) never runs the call: it steps down and forwards.
   * After `close()`, a call is refused.
   */
  readonly call: CallHandler;
  role(): "owner" | "forwarder";
  /** Stops this copy's endpoint. The owner then removes `owner.json`, if the file still names it. */
  close(): Promise<void>;
}

/** What `owner.json` held when it was read. An unreadable file carries an identity: the file that was read, not its name. */
type Read =
  | { readonly kind: "record"; readonly record: OwnerRecord }
  | { readonly kind: "missing" }
  | { readonly kind: "unreadable"; readonly id: string }
  /** Unreadable, and a different file each time it was read: someone is writing it. */
  | { readonly kind: "changing" };

const MISSING: Read = { kind: "missing" };
const digest = (text: string) => createHash("sha256").update(text, "utf8").digest();
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isOwnerRecord = (value: unknown): value is OwnerRecord =>
  isRecord(value) &&
  Number.isInteger(value.pid) &&
  (value.pid as number) > 0 &&
  Number.isInteger(value.port) &&
  (value.port as number) > 0 &&
  (value.port as number) < 65_536 &&
  typeof value.token === "string" &&
  /^[0-9a-f]{64}$/.test(value.token);

export interface Endpoint {
  readonly port: number;
  readonly token: string;
  /** Stops listening and drops every connection, calls in progress included. */
  close(): Promise<void>;
  /** Stops listening and lets the calls in progress finish: for a copy that steps down while it answers one. */
  retire(): void;
}

export interface EndpointOptions {
  /** The owner's handler, while it is being built or once it is; none for a copy that is not the owner. */
  readonly handler: () => Promise<CallHandler> | undefined;
  /** Asked when the call is read and the handler built, just before the tool would run: `false` answers 409. */
  readonly fence?: () => Promise<boolean>;
  /** Receives the message of an error that failed a call, with the token taken out. */
  readonly log?: (line: string) => void;
}

/**
 * `GET /ping` and `POST /call`, on 127.0.0.1 only, each with this copy's Bearer token, compared in constant time over
 * SHA-256 digests. `/call` waits for the owner's handler while it is being built, answers `409` without one, and
 * answers `409` as well when the fence says the copy no longer owns the state. Exported for the tests of its refusals:
 * a copy that loses the election closes its endpoint before anyone knows its port, so no election reaches the first `409`.
 */
export async function startEndpoint(options: EndpointOptions): Promise<Endpoint> {
  const log = options.log ?? (() => {});
  const token = randomBytes(32).toString("hex");
  const expected = digest(`Bearer ${token}`);
  const authorized = (request: IncomingMessage) => timingSafeEqual(digest(request.headers.authorization ?? ""), expected);

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!authorized(request)) return sendJson(response, 401, { error: "unauthorized" });
    if (request.method === "GET" && request.url === "/ping") return sendJson(response, 200, { ok: true, pid: process.pid });
    if (request.method !== "POST" || request.url !== "/call") return sendJson(response, 404, { error: "not_found" });
    const pending = options.handler();
    if (!pending) return sendJson(response, 409, { error: "not_owner" });
    const body = await readJson(request, MAX_BODY_BYTES);
    if (!isRecord(body) || typeof body.name !== "string" || (body.arguments !== undefined && !isRecord(body.arguments))) {
      return sendJson(response, 400, { error: "invalid_call" });
    }
    const call = await pending;
    if (options.fence && !(await options.fence())) return sendJson(response, 409, { error: "not_owner" });
    sendJson(response, 200, await call(body.name, (body.arguments as Record<string, unknown> | undefined) ?? {}));
  }

  const server = createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      if (!(error instanceof HttpError)) log(`a call failed in the endpoint: ${describe(error).split(token).join("[token]")}`);
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
    retire: () => void server.close(),
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
  let id: string;
  try {
    const stat = statSync(path, { bigint: true });
    id = `${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? MISSING : { kind: "unreadable", id: "unknown" };
  }
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isOwnerRecord(value) ? { kind: "record", record: value } : { kind: "unreadable", id };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? MISSING : { kind: "unreadable", id };
  }
}

/**
 * Reads `owner.json`. A file that cannot be read is read again after a pause, because the copy that created it may not
 * have written it yet; one is reported `unreadable` only when it is the same file, unreadable throughout. A file that is
 * a different one each time is `changing`: it is being written, and is not stale.
 */
async function readRecord(path: string, tuning: Tuning): Promise<Read> {
  let seen = readOnce(path);
  for (let round = 0; round < 2 && seen.kind === "unreadable"; round++) {
    await tuning.sleep(tuning.rereadDelayMs);
    const next = readOnce(path);
    if (next.kind !== "unreadable" || next.id === seen.id) return next;
    seen = next;
  }
  return seen.kind === "unreadable" ? { kind: "changing" } : seen;
}

async function httpPing(record: OwnerRecord, timeoutMs: number): Promise<PingVerdict> {
  try {
    const response = await fetch(`http://127.0.0.1:${record.port}/ping`, {
      headers: { authorization: `Bearer ${record.token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status !== 200) {
      await response.body?.cancel();
      return "other";
    }
    // The owner says who it is: another server on a port the owner once had answers 200 too.
    const body: unknown = await response.json();
    return isRecord(body) && body.ok === true && body.pid === record.pid ? "owner" : "other";
  } catch (error) {
    return isTimeout(error) ? "silent" : "other";
  }
}

function processExists(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export const DEFAULT_TUNING: Tuning = {
  pingTimeoutMs: 1_000,
  takeoverGraceMs: 5_000,
  pingRetryDelayMs: 250,
  rereadDelayMs: 250,
  mutatingCallTimeoutMs: MUTATING_CALL_TIMEOUT_MS,
  readCallTimeoutMs: READ_CALL_TIMEOUT_MS,
  ping: httpPing,
  processExists,
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * Whether the copy `owner.json` names is alive. It is when it says so with its own pid. Nothing at that port, another
 * answer, or an owner whose process is gone, is a copy to take over from at once. A silent owner whose process exists
 * may only be busy: it is asked again for `takeoverGraceMs` before it is given up.
 */
export async function ownerAnswers(record: OwnerRecord, tuning: Tuning): Promise<boolean> {
  const deadline = tuning.now() + tuning.takeoverGraceMs;
  for (;;) {
    const verdict = await tuning.ping(record, tuning.pingTimeoutMs);
    if (verdict === "owner") return true;
    if (verdict === "other" || !tuning.processExists(record.pid) || tuning.now() >= deadline) return false;
    await tuning.sleep(tuning.pingRetryDelayMs);
  }
}

/**
 * Removes `path` if it still holds what was read: a newer owner's file stays. Read and unlink are two calls, so this
 * narrows a race and does not close it: the owner's fence (see `createRouter`) is what stops two owners from running.
 */
function removeStale(path: string, seen: Read): void {
  if (seen.kind !== "record" && seen.kind !== "unreadable") return;
  const now = readOnce(path);
  const same =
    seen.kind === "record" ? now.kind === "record" && now.record.token === seen.record.token : now.kind === "unreadable" && now.id === seen.id;
  if (!same) return;
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
 *
 * The owner checks, before it runs any call, that `owner.json` still names it. If another copy's record is there, it is
 * no longer the owner: it stops serving, drops its handler and forwards the call. If the file is gone, it creates it
 * again, which succeeds only while no other copy has. A copy that was taken for dead and replaced while it held a
 * session cannot be rescued by this: it only stops a second state from running calls.
 */
export async function createRouter(options: RouterOptions): Promise<Router> {
  // Before anything else: `openSync(…, "wx")` cannot create a file in a folder that does not exist.
  mkdirSync(options.dir, { recursive: true });
  const path = join(options.dir, OWNER_FILE);
  const log = options.log ?? (() => {});
  const readOnly = options.readOnly ?? new Set<string>();
  const tuning: Tuning = { ...DEFAULT_TUNING, ...options.tuning };
  let role: "owner" | "forwarder" = "forwarder";
  let endpoint: Endpoint | undefined;
  /** The record this copy created as the owner: what `owner.json` must still hold for it to run a call. */
  let ours: OwnerRecord | undefined;
  /** The endpoints of the owners this copy has been, which stopped listening and are closed for good with the router. */
  const retired: Endpoint[] = [];
  let peer: OwnerRecord | undefined;
  let handler: Promise<CallHandler> | undefined;
  let electing: Promise<void> | undefined;
  let closed = false;

  const removeOurs = (token: string) => {
    const now = readOnce(path);
    if (now.kind === "record" && now.record.pid === process.pid && now.record.token === token) removeStale(path, now);
  };

  /** This copy is not the owner any more: no new call is served here, and the state it had is dropped. */
  function stepDown(): void {
    log(`${path} no longer names this copy: it stops serving calls`);
    const old = endpoint;
    const dropped = handler;
    endpoint = undefined;
    handler = undefined;
    ours = undefined;
    peer = undefined;
    role = "forwarder";
    if (old) {
      old.retire();
      retired.push(old);
    }
    if (dropped) options.onStepDown?.(dropped);
  }

  const names = (read: Read, term: OwnerRecord) => read.kind === "record" && read.record.pid === term.pid && read.record.token === term.token;

  /**
   * Whether this copy may run a call for the state of `term` (the record it created when it won the election that built
   * that state): `owner.json` still names it. If not, it steps down; if it is gone, it takes it back. A call that took the
   * state of an earlier term is refused once there is a later one, even if the later one's file is there.
   */
  async function stillOwner(term: OwnerRecord): Promise<boolean> {
    if (closed) throw new Error("This copy of the server has shut down");
    if (role !== "owner" || ours !== term) return false;
    const seen = await readRecord(path, tuning);
    if (role !== "owner" || ours !== term) return false;
    if (names(seen, term)) return true;
    if (seen.kind === "missing") {
      // Nobody has the file: the first to create it holds the state, and that may still be this copy.
      if (tryCreate(path, term)) return true;
      // Someone created it since it was read. If it is this copy (another call checked at the same time, and was first), nothing changed.
      if (names(readOnce(path), term)) return true;
    }
    stepDown();
    return false;
  }

  async function elect(): Promise<void> {
    for (let attempt = 1; attempt <= 2; attempt++) {
      // The endpoint serves the state of the term it was started for, and checks the file for that term only.
      const term: { record?: OwnerRecord } = {};
      const mine = await startEndpoint({
        handler: () => (term.record && ours === term.record ? handler : undefined),
        fence: () => (term.record ? stillOwner(term.record) : Promise.resolve(false)),
        log,
      });
      let created: boolean;
      const record: OwnerRecord = (term.record = { pid: process.pid, port: mine.port, token: mine.token });
      try {
        created = tryCreate(path, record);
      } catch (error) {
        await mine.close();
        throw error;
      }
      if (created) {
        endpoint = mine;
        ours = record;
        role = "owner";
        peer = undefined;
        // An async wrapper, so that a `becomeOwner` that throws before it returns fails the same way as one that rejects.
        handler = (async () => options.becomeOwner())();
        try {
          await handler;
        } catch (error) {
          handler = undefined;
          ours = undefined;
          role = "forwarder";
          endpoint = undefined;
          await mine.close();
          removeOurs(mine.token);
          throw error;
        }
        return;
      }
      await mine.close();
      const seen = await readRecord(path, tuning);
      if (seen.kind === "record" && (await ownerAnswers(seen.record, tuning))) {
        role = "forwarder";
        peer = seen.record;
        return;
      }
      if (seen.kind === "record" || seen.kind === "unreadable") {
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
   * refused the call first) or whether no one can tell (the connection dropped once the call was sent, the answer
   * was not one, or none came in time), which a reused connection to an owner that has just gone can also give.
   */
  async function forward(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    const target = peer;
    if (!target) throw new ForwardError("no owner to forward to", false);
    const signal = AbortSignal.timeout(readOnly.has(name) ? tuning.readCallTimeoutMs : tuning.mutatingCallTimeoutMs);
    let response: Response;
    try {
      response = await fetch(`http://127.0.0.1:${target.port}/call`, {
        method: "POST",
        headers: { authorization: `Bearer ${target.token}`, "content-type": "application/json" },
        body: JSON.stringify({ name, arguments: args }),
        signal,
      });
    } catch (error) {
      const code = String(((error as Error).cause as { code?: unknown } | undefined)?.code);
      const timedOut = isTimeout(error);
      throw new ForwardError(
        timedOut ? "the owner copy did not answer in time" : `the owner copy cannot be reached (${describe(error)})`,
        timedOut || !CONNECT_FAILURES.has(code) ? undefined : false,
        timedOut,
      );
    }
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new ForwardError(`the owner copy answered ${response.status}`, REFUSED_BEFORE_RUNNING.has(response.status) ? false : undefined);
    }
    try {
      return (await response.json()) as CallToolResult;
    } catch (error) {
      const timedOut = isTimeout(error);
      throw new ForwardError(
        timedOut ? "the owner copy did not finish its answer in time" : `the owner copy's answer was cut short (${describe(error)})`,
        undefined,
        timedOut,
      );
    }
  }

  /** Runs the call here, if this copy is the owner and `owner.json` still says so; `undefined` otherwise. */
  async function runHere(name: string, args: Record<string, unknown>): Promise<CallToolResult | undefined> {
    const term = ours;
    if (role !== "owner" || !term || !handler) return undefined;
    const run = await handler;
    return (await stillOwner(term)) ? run(name, args) : undefined;
  }

  const unknownOutcome = (name: string, failure: ForwardError): CallToolResult => {
    const what = failure.timedOut ? `did not answer ${name} in time` : `went away during ${name}`;
    const text = `The copy of the server that held the demo's state ${what}: it may or may not have happened. Check the panel before trying again.`;
    return { isError: true, content: [{ type: "text", text }] };
  };

  /** The owner failed the call, or was not there to be asked: elect again, then run the call again if that is safe. */
  async function afterFailure(name: string, args: Record<string, unknown>, failure: ForwardError): Promise<CallToolResult> {
    log(`${failure.message}: electing again`);
    // A launch, top-up or close may have run before the owner went: sent again, it could pay twice. Whatever the election
    // does, the caller is told it may have happened.
    const unknown = failure.ran === undefined && !readOnly.has(name);
    try {
      await reelect();
    } catch (error) {
      log(`electing again failed: ${describe(error)}`);
      if (unknown) return unknownOutcome(name, failure);
      throw error;
    }
    if (unknown) return unknownOutcome(name, failure);
    const here = await runHere(name, args);
    if (here) return here;
    try {
      return await forward(name, args);
    } catch (error) {
      if (!(error instanceof ForwardError)) throw error;
      log(`${error.message}: giving up`);
      if (error.ran === undefined && !readOnly.has(name)) return unknownOutcome(name, error);
      const text = `The copy of the server that holds the demo's state could not be reached for ${name}, which changed nothing. Try again in a moment.`;
      return { isError: true, content: [{ type: "text", text }] };
    }
  }

  const call: CallHandler = async (name, args) => {
    if (closed) throw new Error("This copy of the server has shut down");
    const here = await runHere(name, args);
    if (here) return here;
    try {
      return await forward(name, args);
    } catch (error) {
      if (!(error instanceof ForwardError)) throw error;
      return afterFailure(name, args, error);
    }
  };

  await reelect();
  return {
    call,
    role: () => role,
    async close() {
      closed = true;
      const mine = endpoint;
      const record = ours;
      endpoint = undefined;
      await Promise.all([mine?.close(), ...retired.splice(0).map((old) => old.close())]);
      if (role === "owner" && record) removeOurs(record.token);
    },
  };
}
