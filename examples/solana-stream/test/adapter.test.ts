import { EventEmitter } from "node:events";
import { generateKeyPairSigner, type RpcSubscriptions, type SolanaRpcSubscriptionsApi } from "@solana/kit";
import { describe, expect, it } from "vitest";
import type { WebSocket } from "ws";
import { MAX_ACCOUNTS, createStreamAdapter, parseClientMessage } from "../src/index.js";

class FakeSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  readonly sent: Record<string, unknown>[] = [];
  send(text: string): void {
    this.sent.push(JSON.parse(text));
  }
}

/** Account subscriptions that yield `notifications` once each, then wait until aborted. */
function fakeSubscriptions(notifications: unknown[]) {
  const signals: AbortSignal[] = [];
  const subscriptions = {
    accountNotifications: () => ({
      subscribe: async ({ abortSignal }: { abortSignal: AbortSignal }) => {
        signals.push(abortSignal);
        return (async function* () {
          yield* notifications;
          await new Promise((resolve) => abortSignal.addEventListener("abort", resolve));
        })();
      },
    }),
  };
  return { subscriptions: subscriptions as unknown as RpcSubscriptions<SolanaRpcSubscriptionsApi>, signals };
}

const info = { session: "11111111111111111111111111111111", authority: "11111111111111111111111111111111", paidUntil: 0n } as never;
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

type Script = "reject" | "end" | "hold";

/**
 * Each `accountNotifications` subscribe consumes the next script: `reject` fails, `end` yields
 * nothing and returns, `hold` waits until aborted. Once the scripts run out, subscribes hold.
 */
function scriptedSubscriptions(scripts: Script[] = []) {
  const signals: AbortSignal[] = [];
  const subscriptions = {
    accountNotifications: () => ({
      subscribe: async ({ abortSignal }: { abortSignal: AbortSignal }) => {
        signals.push(abortSignal);
        const script = scripts.shift() ?? "hold";
        if (script === "reject") throw new Error("boom");
        return (async function* () {
          if (script === "hold") await new Promise((resolve) => abortSignal.addEventListener("abort", resolve));
        })();
      },
    }),
  };
  return { subscriptions: subscriptions as unknown as RpcSubscriptions<SolanaRpcSubscriptionsApi>, signals };
}

describe("stream messages (spec §8)", () => {
  it("parses subscribe and unsubscribe, and refuses anything else", () => {
    const account = "So11111111111111111111111111111111111111112";
    expect(parseClientMessage(JSON.stringify({ op: "subscribe", accounts: [account] }))).toEqual({
      ok: true,
      message: { op: "subscribe", accounts: [account] },
    });
    expect(parseClientMessage("{")).toMatchObject({ ok: false, code: "invalid_json" });
    expect(parseClientMessage(JSON.stringify({ op: "watch", accounts: [] }))).toMatchObject({ ok: false, code: "invalid_message" });
    expect(parseClientMessage(JSON.stringify({ op: "subscribe", accounts: ["nope"] }))).toMatchObject({ ok: false, code: "invalid_address" });
  });
});

describe("stream adapter", () => {
  it("forwards account notifications, with u64 values as decimal strings", async () => {
    const account = (await generateKeyPairSigner()).address;
    const { subscriptions } = fakeSubscriptions([
      {
        context: { slot: 42n },
        value: { lamports: 2_039_280n, owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", data: { parsed: { info: { tokenAmount: { amount: "5" } } } } },
      },
    ]);
    const socket = new FakeSocket();
    createStreamAdapter(subscriptions).attach(info, socket as unknown as WebSocket, null);
    socket.emit("message", JSON.stringify({ op: "subscribe", accounts: [account] }));
    await tick();
    expect(socket.sent).toEqual([
      {
        type: "account",
        address: account,
        slot: "42",
        lamports: "2039280",
        owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
        encoding: "jsonParsed",
        data: { parsed: { info: { tokenAmount: { amount: "5" } } } },
      },
    ]);
  });

  it("refuses more than 10 accounts on a connection", async () => {
    const { subscriptions } = fakeSubscriptions([]);
    const socket = new FakeSocket();
    createStreamAdapter(subscriptions).attach(info, socket as unknown as WebSocket, null);
    const accounts = await Promise.all(Array.from({ length: MAX_ACCOUNTS + 1 }, async () => (await generateKeyPairSigner()).address));
    socket.emit("message", JSON.stringify({ op: "subscribe", accounts }));
    expect(socket.sent).toEqual([{ type: "error", code: "too_many_accounts", message: "at most 10 accounts per connection" }]);
  });

  it("ends every subscription when the connection closes", async () => {
    const { subscriptions, signals } = fakeSubscriptions([]);
    const socket = new FakeSocket();
    createStreamAdapter(subscriptions).attach(info, socket as unknown as WebSocket, null);
    const account = (await generateKeyPairSigner()).address;
    socket.emit("message", JSON.stringify({ op: "subscribe", accounts: [account] }));
    await tick();
    socket.emit("close");
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });

  it("a rejected subscription frees its slot, so a re-subscribe of the same account succeeds", async () => {
    const account = (await generateKeyPairSigner()).address;
    const { subscriptions, signals } = scriptedSubscriptions(["reject", "hold"]);
    const socket = new FakeSocket();
    createStreamAdapter(subscriptions).attach(info, socket as unknown as WebSocket, null);
    socket.emit("message", JSON.stringify({ op: "subscribe", accounts: [account] }));
    await tick();
    expect(socket.sent).toEqual([{ type: "error", code: "subscription_failed", message: `${account}: boom` }]);
    socket.emit("message", JSON.stringify({ op: "subscribe", accounts: [account] }));
    await tick();
    expect(socket.sent).toHaveLength(1);
    expect(signals).toHaveLength(2);
  });

  it("an iterator that ends without an abort sends subscription_failed and frees the slot", async () => {
    const account = (await generateKeyPairSigner()).address;
    const { subscriptions, signals } = scriptedSubscriptions(["end", "hold"]);
    const socket = new FakeSocket();
    createStreamAdapter(subscriptions).attach(info, socket as unknown as WebSocket, null);
    socket.emit("message", JSON.stringify({ op: "subscribe", accounts: [account] }));
    await tick();
    expect(socket.sent).toEqual([{ type: "error", code: "subscription_failed", message: `${account}: notifications ended` }]);
    socket.emit("message", JSON.stringify({ op: "subscribe", accounts: [account] }));
    await tick();
    expect(socket.sent).toHaveLength(1);
    expect(signals).toHaveLength(2);
  });

  it("allows exactly MAX_ACCOUNTS accounts on a connection", async () => {
    const { subscriptions } = scriptedSubscriptions();
    const socket = new FakeSocket();
    createStreamAdapter(subscriptions).attach(info, socket as unknown as WebSocket, null);
    const accounts = await Promise.all(Array.from({ length: MAX_ACCOUNTS }, async () => (await generateKeyPairSigner()).address));
    socket.emit("message", JSON.stringify({ op: "subscribe", accounts }));
    await tick();
    expect(socket.sent).toEqual([]);
  });

  it("unsubscribe frees a slot", async () => {
    const { subscriptions } = scriptedSubscriptions();
    const socket = new FakeSocket();
    createStreamAdapter(subscriptions).attach(info, socket as unknown as WebSocket, null);
    const accounts = await Promise.all(Array.from({ length: MAX_ACCOUNTS }, async () => (await generateKeyPairSigner()).address));
    socket.emit("message", JSON.stringify({ op: "subscribe", accounts }));
    socket.emit("message", JSON.stringify({ op: "unsubscribe", accounts: [accounts[0]] }));
    const extra = (await generateKeyPairSigner()).address;
    socket.emit("message", JSON.stringify({ op: "subscribe", accounts: [extra] }));
    await tick();
    expect(socket.sent).toEqual([]);
  });
});
