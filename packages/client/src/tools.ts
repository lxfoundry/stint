import type { WebSocket } from "ws";
import type { StintClient, StintSession } from "./client.js";

export class ToolError extends Error {
  override name = "ToolError";
}

export interface Tool<I, O> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  run(input: I): Promise<O>;
}

export interface OpenInput {
  readonly url: string;
  readonly seconds?: number;
  readonly reason: string;
}
export interface OpenOutput {
  readonly sessionId: string;
  readonly paidUntil: number;
  readonly cost: string;
  readonly remainingBudget: string;
}
export interface SendInput {
  readonly sessionId: string;
  readonly message: unknown;
}
export interface ReceiveInput {
  readonly sessionId: string;
  readonly max?: number;
  readonly timeoutSeconds: number;
  readonly match?: Record<string, unknown>;
}
export interface ReceiveOutput {
  readonly messages: unknown[];
  readonly timedOut: boolean;
}
export interface CloseInput {
  readonly sessionId: string;
}
/** `paid` and `refunded` are absent when the close is confirmed but its amounts could not be read. */
export interface CloseOutput {
  readonly paid?: string;
  readonly refunded?: string;
  readonly transaction: string;
}

export interface StatusInput {
  readonly sessionId: string;
}
/** `spent` is what closing the session now would pay the seller, the minimum included; `refundable` is what it would return. */
export interface StatusOutput {
  readonly paidUntil: number;
  readonly timeLeftSeconds: number;
  readonly spent: string;
  readonly refundable: string;
}
export interface CloseAllOutput {
  readonly closed: string[];
  readonly failed: { readonly sessionId: string; readonly error: string }[];
}

export interface SessionTools {
  readonly tools: {
    readonly stint_open_session: Tool<OpenInput, OpenOutput>;
    readonly stint_session_status: Tool<StatusInput, StatusOutput>;
    readonly stint_send: Tool<SendInput, { ok: true }>;
    readonly stint_receive: Tool<ReceiveInput, ReceiveOutput>;
    readonly stint_close_session: Tool<CloseInput, CloseOutput>;
  };
  /** The close code of the session's connection, once it has closed. */
  closeCode(sessionId: string): number | undefined;
  /** Closes every session still open, for a runtime that is shutting down; none can be opened afterwards. A failure is reported, never thrown. */
  closeAll(): Promise<CloseAllOutput>;
}

interface Live {
  readonly session: StintSession;
  socket?: WebSocket;
  /** The connection in progress, shared by concurrent callers. */
  connecting?: Promise<WebSocket>;
  readonly inbox: unknown[];
  readonly waiters: Set<() => void>;
  closeCode?: number;
  closed: boolean;
}

const strict = (properties: Record<string, unknown>, required: string[]) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const sessionIdSchema = { type: "string", description: "The session's address, from stint_open_session" };
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/** The session tools of spec §9.5, sharing one runtime. */
export function createSessionTools(client: StintClient): SessionTools {
  const live = new Map<string, Live>();
  const opens = new Set<Promise<unknown>>();
  const closes = new Set<Promise<unknown>>();
  let closing = false;

  const get = (sessionId: unknown): Live => {
    const state = typeof sessionId === "string" ? live.get(sessionId) : undefined;
    if (!state) throw new ToolError(`Unknown session ${String(sessionId)}: open one with stint_open_session`);
    return state;
  };
  const wake = (state: Live) => {
    for (const waiter of state.waiters) waiter();
    state.waiters.clear();
  };

  async function connect(state: Live): Promise<WebSocket> {
    const socket = await state.session.connect();
    socket.on("message", (data) => {
      const text = String(data);
      let message: unknown;
      try {
        message = JSON.parse(text);
      } catch {
        message = text;
      }
      state.inbox.push(message);
      wake(state);
    });
    socket.on("close", (code) => {
      state.closeCode = code;
      wake(state);
    });
    state.socket = socket;
    return socket;
  }

  function connected(state: Live): Promise<WebSocket> {
    if (state.socket && state.socket.readyState === state.socket.OPEN) return Promise.resolve(state.socket);
    if (state.closed) return Promise.reject(new ToolError("The session is closed"));
    if (state.connecting) return state.connecting;
    const attempt = connect(state);
    state.connecting = attempt;
    // Cleared once settled, so that a failed attempt can be retried.
    const clear = () => {
      if (state.connecting === attempt) state.connecting = undefined;
    };
    attempt.then(clear, clear);
    return attempt;
  }

  const matches = (message: unknown, match: Record<string, unknown> | undefined) =>
    !match || (isRecord(message) && Object.entries(match).every(([key, value]) => message[key] === value));

  return {
    closeCode: (sessionId) => live.get(sessionId)?.closeCode,
    async closeAll() {
      const outcome: { closed: string[]; failed: { sessionId: string; error: string }[] } = { closed: [], failed: [] };
      // No open starts from here on; one still in flight registers its session when it ends: wait for it, or its deposit is orphaned.
      closing = true;
      await Promise.allSettled([...opens]);
      // A close still in flight would race a second one for the same session: wait for it, and close only what it left open.
      await Promise.allSettled([...closes]);
      const open = [...live.entries()].filter(([, state]) => !state.closed);
      await Promise.all(
        open.map(async ([sessionId, state]) => {
          try {
            await state.session.close();
            state.closed = true;
            outcome.closed.push(sessionId);
          } catch (error) {
            outcome.failed.push({ sessionId, error: error instanceof Error ? error.message : String(error) });
          }
        }),
      );
      return outcome;
    },
    tools: {
      stint_open_session: {
        name: "stint_open_session",
        description:
          "Opens a paid, time-boxed session on a seller's resource. The deposit is held in escrow; only the time used is paid. Close it with stint_close_session as soon as your task is done.",
        inputSchema: strict(
          {
            url: { type: "string", description: "The seller's gate URL" },
            seconds: { type: "integer", minimum: 1, description: "How long to buy; omit to take the seller's default" },
            reason: { type: "string", description: "Why the session is needed" },
          },
          ["url", "reason"],
        ),
        async run(input) {
          if (closing) throw new ToolError("The session runtime is shutting down: no new session can be opened");
          // Tracked until its session is registered, so that `closeAll` can wait for an open that is in flight.
          const work = (async () => {
            const session = await client.open(input.url, input.seconds === undefined ? {} : { seconds: input.seconds });
            live.set(session.id, { session, inbox: [], waiters: new Set(), closed: false });
            return {
              sessionId: session.id,
              paidUntil: session.paidUntil,
              cost: session.cost.toString(),
              remainingBudget: client.remainingBudget().toString(),
            };
          })();
          opens.add(work);
          return work.finally(() => opens.delete(work));
        },
      },
      stint_session_status: {
        name: "stint_session_status",
        description:
          "Reports how much time a session has left, what closing it now would pay the seller (spent, the minimum charge included) and what it would refund. The figures are estimates on the seller's clock; the chain's clock decides the final amounts.",
        inputSchema: strict({ sessionId: sessionIdSchema }, ["sessionId"]),
        async run(input) {
          const state = get(input.sessionId);
          if (state.closed) throw new ToolError("The session is closed");
          const status = await state.session.status();
          return {
            paidUntil: status.paidUntil,
            timeLeftSeconds: status.timeLeft,
            spent: status.due,
            refundable: status.refundable,
          };
        },
      },
      stint_send: {
        name: "stint_send",
        description: "Sends one message to the session's resource over its connection, connecting first if needed.",
        inputSchema: strict(
          { sessionId: sessionIdSchema, message: { description: "A JSON value, or a string sent as is" } },
          ["sessionId", "message"],
        ),
        async run(input) {
          const socket = await connected(get(input.sessionId));
          socket.send(typeof input.message === "string" ? input.message : JSON.stringify(input.message));
          return { ok: true };
        },
      },
      stint_receive: {
        name: "stint_receive",
        description:
          "Waits for messages from the session's resource and returns up to `max` of them. With `match`, returns only messages whose top-level fields equal it; others stay queued.",
        inputSchema: strict(
          {
            sessionId: sessionIdSchema,
            max: { type: "integer", minimum: 1, description: "Default 10" },
            timeoutSeconds: { type: "number", minimum: 0 },
            match: { type: "object", description: "Top-level fields a message must equal" },
          },
          ["sessionId", "timeoutSeconds"],
        ),
        async run(input) {
          const state = get(input.sessionId);
          const max = input.max ?? 10;
          const deadline = Date.now() + input.timeoutSeconds * 1000;
          for (;;) {
            const taken: unknown[] = [];
            for (let index = 0; index < state.inbox.length && taken.length < max; ) {
              if (matches(state.inbox[index], input.match)) taken.push(state.inbox.splice(index, 1)[0]);
              else index++;
            }
            if (taken.length > 0) return { messages: taken, timedOut: false };
            const left = deadline - Date.now();
            if (left <= 0) return { messages: [], timedOut: true };
            await new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, left);
              state.waiters.add(() => {
                clearTimeout(timer);
                resolve();
              });
            });
          }
        },
      },
      stint_close_session: {
        name: "stint_close_session",
        description:
          "Closes the session as soon as your task is done: the seller is paid for the time used and the rest of the deposit is refunded.",
        inputSchema: strict({ sessionId: sessionIdSchema }, ["sessionId"]),
        async run(input) {
          const state = get(input.sessionId);
          // Marked closed within the promise that closeAll waits for, so that closeAll then sees it closed.
          const close = state.session.close().then((receipt) => {
            state.closed = true;
            return receipt;
          });
          closes.add(close);
          const receipt = await close.finally(() => closes.delete(close));
          return {
            ...(receipt.paid === undefined ? {} : { paid: receipt.paid.toString() }),
            ...(receipt.refunded === undefined ? {} : { refunded: receipt.refunded.toString() }),
            transaction: receipt.transaction,
          };
        },
      },
    },
  };
}
