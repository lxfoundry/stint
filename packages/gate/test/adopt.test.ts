import { generateKeyPairSigner, type Address } from "@solana/kit";
import type { Session } from "@lxfoundry/stint-program-client";
import { createSessionToken, inspectTransaction, readElapsedPayload } from "@lxfoundry/stint-x402";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { NOW_MS, helpers, startHarness, type Harness } from "./harness.js";

describe("the gate's adoption of a session it does not track (spec §7.3)", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await startHarness();
  });

  afterEach(async () => {
    expect(h.escaped).toEqual([]);
    await h.gate.close();
    h.server.closeAllConnections();
    await new Promise((resolve) => h.server.close(resolve));
  });

  const { open, send, prepareOpen, closeWith, connect, token, settleDown } = helpers(() => h);

  /**
   * A session on the fake chain that this gate never settled: opened directly on the program with the gate's terms, mint
   * and receiver authorizer, and a harness key as rent payer, then `change`. Paid for 30 s from `NOW_MS`.
   */
  async function onChain(change: Partial<Session> = {}): Promise<Address> {
    const { session } = await prepareOpen();
    const rentPayer = (await generateKeyPairSigner()).address;
    h.sessions.set(session, { ...h.sessions.get(session)!, rentPayer, ...change });
    return session;
  }

  it("adopts a session opened on-chain when its buyer connects: provisions it once, follows it, and sets its end timer", async () => {
    const session = await onChain();

    const { socket } = await connect(session, await token(session, "connect"));

    expect(socket).toBeDefined();
    expect(h.calls.provision).toEqual([{ session, authority: h.buyer.address, paidUntil: BigInt(NOW_MS / 1000 + 30) }]);
    expect(h.calls.attach).toHaveLength(1);
    expect(h.calls.watch).toEqual([session]);
    expect(h.calls.verify).toEqual([]);
    expect(h.calls.settle).toEqual([]);
    expect(h.logs).toContainEqual({ event: "adopt", session });
    // The connection is live, so the idle timer is off; the end timer is set for paid_until.
    expect(h.timers.pending.map((timer) => timer.dueMs)).toEqual([NOW_MS + 30_000]);
    socket!.close();
  });

  it("closes an adopted session on the buyer's request as one it opened: signed by its receiver authorizer, the rent to the session's own rent payer, then 4410", async () => {
    const session = await onChain();
    const rentPayer = h.sessions.get(session)!.rentPayer;
    const { socket } = await connect(session, await token(session, "connect"));
    const closed = new Promise<number>((resolve) => socket!.once("close", (code) => resolve(code)));

    const response = await closeWith(session);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ paid: "8000", refunded: "22000", transaction: "sig" });
    expect(await closed).toBe(4410);
    expect(h.calls.teardown).toEqual(["closed"]);
    const tx = inspectTransaction(readElapsedPayload(h.calls.settle.at(-1)!)!.transaction)!;
    expect([...tx.signed]).toEqual([h.authorizer.address]);
    expect(tx.accounts).toContain(rentPayer);
  });

  it.each<[string, (other: Address) => Partial<Session>]>([
    ["in another mint", (other) => ({ mint: other })],
    ["naming another receiver authorizer", (other) => ({ receiverAuthorizer: other })],
    ["at another rate", () => ({ rate: 2_000n, deposited: 60_000n })],
  ])("refuses a session on-chain %s with 403, and adopts nothing", async (_, change) => {
    const session = await onChain(change((await generateKeyPairSigner()).address));

    expect((await connect(session, await token(session, "connect"))).status).toBe(403);
    expect((await connect(session, await token(session, "connect"))).status).toBe(403);

    expect(h.calls.provision).toEqual([]);
    expect(h.calls.watch).toEqual([]);
    expect(h.timers.pending).toEqual([]);
    expect((await closeWith(session)).status).toBe(404);
    expect((await fetch(`${h.url}/sessions/${session}`)).status).toBe(404);
  });

  it("refuses a connect without a token with 401 before it reads the chain", async () => {
    const session = await onChain();

    expect((await connect(session)).status).toBe(401);

    expect(h.reads.session).toBe(0);
    expect(h.calls.provision).toEqual([]);
  });

  it.each<[string, (session: Address) => Promise<string>]>([
    ["with a close token", (session) => token(session, "close")],
    ["with a token for another audience", (session) => token(session, "connect", "http://elsewhere")],
    [
      "with an expired token",
      (session) => createSessionToken(h.buyer, { session, audience: h.url, purpose: "connect" }, { nowMs: NOW_MS - 200_000 }),
    ],
    [
      "with a token that another key signed",
      async (session) => createSessionToken(await generateKeyPairSigner(), { session, audience: h.url, purpose: "connect" }, { nowMs: NOW_MS }),
    ],
  ])("refuses a connect %s with 401, and adopts nothing", async (_, make) => {
    const session = await onChain();

    expect((await connect(session, await make(session))).status).toBe(401);

    expect(h.calls.provision).toEqual([]);
    expect(h.calls.watch).toEqual([]);
  });

  it("refuses a token used once already for an adopted session, as for any other: 401", async () => {
    const session = await onChain();
    const once = await token(session, "connect");
    (await connect(session, once)).socket!.close();

    expect((await connect(session, once)).status).toBe(401);
    expect(h.calls.provision).toHaveLength(1);
  });

  it.each([
    ["within the margin of its paid_until", 1n],
    ["past its paid_until", -10n],
  ])("refuses a session on-chain %s with 402, and adopts nothing", async (_, left) => {
    // Paid for 30 s from its start: paid until NOW + `left` seconds.
    const session = await onChain({ startedAt: BigInt(NOW_MS / 1000) - 30n + left });

    expect((await connect(session, await token(session, "connect"))).status).toBe(402);

    expect(h.calls.provision).toEqual([]);
  });

  it("answers 404, and adopts nothing, for a session it has ended while the node still shows its account", async () => {
    const { session } = await open();
    expect((await closeWith(session)).status).toBe(200);
    expect(h.sessions.has(session)).toBe(true); // the fake chain keeps the account, as a node that lags does

    expect((await connect(session, await token(session, "connect"))).status).toBe(404);
    expect(h.calls.provision).toHaveLength(1);
  });

  it("answers 404 to an open paid again after it ended the session, while the node still shows the account, and provisions nothing more", async () => {
    const { session, payload } = await prepareOpen();
    expect((await send(payload)).status).toBe(201);
    expect((await closeWith(session)).status).toBe(200);

    const again = await send(payload); // the fake facilitator answers it as a record would: success

    expect(again.status).toBe(404);
    expect(again.body).toEqual({ error: "unknown_session" });
    expect(h.calls.provision).toHaveLength(1);
  });

  it.each<[string, (stored: Session) => Session | undefined]>([
    ["finds the account gone", () => undefined],
    ["finds another session at the address", (stored) => ({ ...stored, startedAt: stored.startedAt + 1n })],
    ["finds the same session on terms the gate does not offer", (stored) => ({ ...stored, rate: stored.rate + 1n })],
  ])("refuses with 404, and adopts nothing, when the second read %s", async (_, later) => {
    const session = await onChain();
    const read = h.chain.readSession.bind(h.chain);
    let reads = 0;
    // The first read, from a node that lags, still shows the session; the second, a moment later, does not.
    h.chain.readSession = async (address) => {
      const stored = await read(address);
      return reads++ === 0 || !stored ? stored : later(stored);
    };

    expect((await connect(session, await token(session, "connect"))).status).toBe(404);

    expect(reads).toBe(2);
    expect(h.calls.provision).toEqual([]);
    expect(h.calls.watch).toEqual([]);
    expect(h.timers.pending).toEqual([]);
  });

  it("reads the account a second time after the gate's bound on a node's lag, before it provisions anything", async () => {
    const session = await onChain();
    const read = h.chain.readSession.bind(h.chain);
    const reads: { atMs: number; provisioned: number; timers: number }[] = [];
    h.chain.readSession = async (address) => {
      reads.push({ atMs: performance.now(), provisioned: h.calls.provision.length, timers: h.timers.pending.length });
      return read(address);
    };

    const { socket } = await connect(session, await token(session, "connect"));

    expect(socket).toBeDefined();
    expect(reads).toHaveLength(2);
    // The harness's bound is 3 reads 5 ms apart, 15 ms; a timer can fire a little early.
    expect(reads[1]!.atMs - reads[0]!.atMs).toBeGreaterThanOrEqual(10);
    // Nothing is provisioned, and no timer is armed, while the connect waits.
    expect(reads[1]).toMatchObject({ provisioned: 0, timers: 0 });
    socket!.close();
  });

  it("refuses with 503, and adopts nothing, a connect whose wait outlasts the gate: it would set no timer to end the session", async () => {
    const session = await onChain();
    const read = h.chain.readSession.bind(h.chain);
    let reads = 0;
    let reached!: () => void;
    const second = new Promise<void>((resolve) => (reached = resolve));
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    h.chain.readSession = async (address) => {
      if (reads++ === 1) {
        reached();
        await held;
      }
      return read(address);
    };

    const answer = connect(session, await token(session, "connect"));
    await Promise.race([second, answer]); // the connect is at its second read, or, on a gate that does not adopt, already refused
    await h.gate.close();
    release();

    expect((await answer).status).toBe(503);
    expect(h.calls.provision).toEqual([]);
    expect(h.calls.watch).toEqual([]);
  });

  it("adopts nothing for a buyer whose connection dropped while the connect waited: no provision, no subscription, no timer", async () => {
    const session = await onChain();
    const read = h.chain.readSession.bind(h.chain);
    let reads = 0;
    let reached!: () => void;
    const second = new Promise<void>((resolve) => (reached = resolve));
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    h.chain.readSession = async (address) => {
      if (reads++ === 1) {
        reached();
        await held;
      }
      return read(address);
    };

    const client = new WebSocket(`${h.url.replace("http", "ws")}/sessions/${session}/ws`, {
      headers: { authorization: `Bearer ${await token(session, "connect")}` },
    });
    client.on("error", () => {}); // terminated before it opened
    await second;
    client.terminate();
    await settleDown(); // the gate's side of the connection sees it close
    release();
    await settleDown();

    expect(reads).toBe(2);
    expect(h.calls.provision).toEqual([]);
    expect(h.calls.watch).toEqual([]);
    expect(h.timers.pending).toEqual([]);
  });

  it("refuses with 404, and adopts nothing more, a connect that waits while another adopts the session and the gate ends it", async () => {
    const session = await onChain();
    const read = h.chain.readSession.bind(h.chain);
    let reads = 0;
    let reached!: () => void;
    const second = new Promise<void>((resolve) => (reached = resolve));
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    h.chain.readSession = async (address) => {
      // The first connect's second read is held, and shows the account as the node still has it once released.
      if (reads++ === 1) {
        reached();
        await held;
      }
      return read(address);
    };

    const waiting = connect(session, await token(session, "connect"));
    await second;
    const adopted = await connect(session, await token(session, "connect"));
    expect(adopted.socket).toBeDefined();
    expect((await closeWith(session)).status).toBe(200);
    expect(h.calls.provision).toHaveLength(1);
    release();

    expect((await waiting).status).toBe(404);
    expect(h.calls.provision).toHaveLength(1);
    expect(h.calls.watch).toEqual([session]);
  });

  it("refuses with 402, and adopts nothing, a session whose paid_until the session clock reaches while the connect waits", async () => {
    const session = await onChain(); // paid until NOW + 30 s
    const read = h.chain.readSession.bind(h.chain);
    let reads = 0;
    h.chain.readSession = async (address) => {
      if (reads++ === 1) h.clock.now = NOW_MS + 30_000; // by the second read, the paid time is up
      return read(address);
    };

    expect((await connect(session, await token(session, "connect"))).status).toBe(402);

    expect(reads).toBe(2);
    expect(h.calls.provision).toEqual([]);
  });

  it("adopts a new session opened at the address of one it has ended", async () => {
    const { session } = await open();
    expect((await closeWith(session)).status).toBe(200);
    h.sessions.set(session, { ...h.sessions.get(session)!, startedAt: BigInt(NOW_MS / 1000) + 1n });

    const { socket } = await connect(session, await token(session, "connect"));

    expect(socket).toBeDefined();
    expect(h.calls.provision).toHaveLength(2);
    socket!.close();
  });

  it("remembers a session it has ended for ten minutes, then forgets it", async () => {
    const { session } = await open();
    expect((await closeWith(session)).status).toBe(200);

    h.clock.now = NOW_MS + 10 * 60_000;
    expect((await connect(session, await token(session, "connect"))).status).toBe(404);

    h.clock.now = NOW_MS + 10 * 60_000 + 1;
    // Forgotten: the account the node still shows is then a session past its end, which no connect is accepted for.
    expect((await connect(session, await token(session, "connect"))).status).toBe(402);
    expect(h.calls.provision).toHaveLength(1);
  });

  it("provisions once when two connects for a session it does not track arrive together", async () => {
    const session = await onChain();
    let release!: () => void;
    h.hold.provision = new Promise<void>((resolve) => (release = resolve));

    const first = connect(session, await token(session, "connect"));
    const second = connect(session, await token(session, "connect"));
    await expect.poll(() => h.calls.provision).toHaveLength(1);
    await settleDown(); // the second connect reaches the provisioning in flight
    release();
    const [a, b] = await Promise.all([first, second]);

    expect(a.socket).toBeDefined();
    expect(b.socket).toBeDefined();
    expect(h.calls.provision).toHaveLength(1);
    a.socket!.close();
    b.socket!.close();
  });

  it("refuses with 502 a connect for a session it does not track when the chain cannot be read", async () => {
    const session = await onChain();
    h.chain.readSession = async () => {
      throw new Error("rpc down");
    };

    expect((await connect(session, await token(session, "connect"))).status).toBe(502);
    expect(h.calls.provision).toEqual([]);
  });
});
