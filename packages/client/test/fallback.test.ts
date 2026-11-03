import { generateKeyPairSigner, type KeyPairSigner } from "@solana/kit";
import {
  CloseKind,
  STINT_PROGRAM_ADDRESS,
  StintInstruction,
  identifyStintInstruction,
  parseCloseInstruction,
  type ClosedEventArgs,
} from "@lxfoundry/stint-program-client";
import { inspectTransaction } from "@lxfoundry/stint-x402";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StintError, createStintClient, type ClientOptions, type Policy, type StintSession } from "../src/index.js";
import { NETWORK, startTestGate, type TestGate } from "./gate.js";
import { RENT_EXEMPT_LAMPORTS, fakeRpc, fakeSignature, signatureOf, type FakeNode } from "./rpc.js";

/** The time limit each wait for a confirmation was given, its fourth argument: the scheme package's own function runs all the same. */
const confirmationLimits = vi.hoisted((): (number | undefined)[] => []);
vi.mock("@lxfoundry/stint-x402", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@lxfoundry/stint-x402")>();
  return {
    ...actual,
    waitForConfirmation: (...args: Parameters<typeof actual.waitForConfirmation>) => {
      confirmationLimits.push(args[3]);
      return actual.waitForConfirmation(...args);
    },
  };
});

const policy: Policy = {
  maxRate: 1_000n,
  maxPerSession: 100_000n,
  budget: { amount: 100_000n, periodSeconds: 3_600 },
  closeWaitSeconds: 5,
};
/** What the test gate's facilitator answers a sponsored close with, by default, as the client reports it. */
const SPONSORED = { paid: 8_000n, refunded: 22_000n, transaction: "sponsored-sig", via: "sponsored" };

describe("the close fallback chain (spec §9.3)", () => {
  let buyer: KeyPairSigner;
  let gate: TestGate;

  beforeEach(async () => {
    buyer = await generateKeyPairSigner();
    gate = await startTestGate(buyer.address);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await gate.stop();
    expect(gate.escaped).toEqual([]);
  });

  /**
   * A 30 s session on the test gate, for a client that reads a pending close's status every 20 ms, gives a read up after
   * 200 ms, and a request that sends a close after 300 ms.
   */
  async function openSession(overrides: Partial<Policy> = {}): Promise<StintSession> {
    const client = createStintClient({
      signer: buyer,
      policy: { ...policy, ...overrides },
      closePollMs: 20,
      requestTimeoutMs: 200,
      closeRequestTimeoutMs: 300,
    });
    return client.open(gate.url, { seconds: 30 });
  }
  /** The gate's close settles as pending: its signature is known, its confirmation is not. */
  const PENDING = { success: false, errorReason: "settlement_pending", transaction: "pending-sig", network: NETWORK } as const;

  /** Answers the gate's close with `status` and `body`; every other request goes through. */
  function gateCloseAnswers(session: StintSession, status: number, body: unknown): void {
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) =>
      String(input) === `${gate.url}/sessions/${session.id}/close`
        ? Promise.resolve(Response.json(body, { status }))
        : realFetch(input, init),
    );
  }

  it("closes through the gate when the gate answers, and asks the facilitator nothing", async () => {
    const session = await openSession();

    expect(await session.close()).toEqual({ paid: 8_000n, refunded: 22_000n, transaction: "sig", via: "gate" });
    expect(gate.sponsored).toEqual([]);
  });

  it("closes through closeUrl when the gate cannot be reached: a close it built itself, signed only as the authority, the facilitator's fee payer left to sign", async () => {
    const session = await openSession();
    gate.gateDown = true;

    expect(await session.close()).toEqual(SPONSORED);

    expect(gate.sponsored).toHaveLength(1);
    const close = inspectTransaction(gate.sponsored[0]!)!;
    expect(close.feePayer).toBe(gate.feePayer);
    expect([...close.signed]).toEqual([buyer.address]);
    expect(close.accounts).toContain(session.id);
  });

  it("closes through closeUrl when the gate answers 404: it does not track the session, as after a restart", async () => {
    const session = await openSession();
    gateCloseAnswers(session, 404, { error: "unknown_session" });

    expect(await session.close()).toEqual(SPONSORED);
  });

  it("closes through closeUrl when the gate's close fails with a 5xx", async () => {
    const session = await openSession();
    gate.closeSettlement = { success: false, errorReason: "simulation_failed", transaction: "", network: NETWORK };

    expect(await session.close()).toEqual(SPONSORED);
  });

  it("waits for a close the gate reports pending, and returns it once the gate reports the session gone", async () => {
    const session = await openSession({ closeWaitSeconds: 60 });
    gate.closeSettlement = PENDING;
    const closing = gate; // not `gate`, which names the next test's gate by the time a late timer fires
    setTimeout(() => (closing.sessionOpen = false), 100);
    const started = Date.now();

    expect(await session.close()).toEqual({ transaction: "pending-sig", via: "gate" });
    expect(Date.now() - started).toBeLessThan(2_000); // at the gate's 404, not at the end of the wait
    expect(gate.sponsored).toEqual([]);
  });

  it("moves on to closeUrl once the gate's pending close outlasts closeWaitSeconds", async () => {
    const session = await openSession({ closeWaitSeconds: 0.2 });
    gate.closeSettlement = PENDING;

    expect(await session.close()).toEqual(SPONSORED);
  });

  it("returns a close the gate reported pending when closeUrl then finds the session closed: that close may be the one that landed", async () => {
    const session = await openSession({ closeWaitSeconds: 0.2 });
    gate.closeSettlement = PENDING;
    gate.facilitatorSessionOpen = false; // the gate's node still shows the session; the facilitator's no longer does

    expect(await session.close()).toEqual({ transaction: "pending-sig", via: "gate" });
    expect(gate.sponsored).toEqual([]);
  });

  it("names a close that may still land when no step closes the session", async () => {
    const session = await openSession({ closeWaitSeconds: 0.2 });
    gate.closeSettlement = PENDING;
    gate.facilitatorDown = true;

    await expect(session.close()).rejects.toThrow(/may still land: pending-sig \(gate\)[\s\S]*runs to the end of its paid time/);
  });

  it("reports a session that closeUrl finds closed, sends no close, and counts it as closed", async () => {
    const session = await openSession();
    gate.gateDown = true;
    gate.sessionOpen = false;

    await expect(session.close()).rejects.toMatchObject({ status: 404, message: "The session is already closed" });

    expect(gate.sponsored).toEqual([]);
    await session[Symbol.asyncDispose](); // counted as closed: disposing it does not close it again
  });

  it("says the session runs to the end of its paid time when neither the gate nor the facilitator can close it, and closes it once one can", async () => {
    const session = await openSession();
    gate.gateDown = true;
    gate.facilitatorDown = true;

    const error = await session.close().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(StintError);
    expect((error as Error).message).toMatch(/the gate cannot be reached/);
    expect((error as Error).message).toMatch(/sponsored close failed/);
    expect((error as Error).message).toMatch(/no rpc/);
    expect((error as Error).message).toMatch(/runs to the end of its paid time/);
    gate.gateDown = false;
    expect(await session.close()).toMatchObject({ via: "gate" });
  });

  it("takes POST closeUrl's unknown_session for the session closed: the gate's pending close, which landed after the GET, is the receipt", async () => {
    const session = await openSession({ closeWaitSeconds: 0.2 });
    gate.closeSettlement = PENDING;
    gate.sponsoredAnswer = { success: false, errorReason: "unknown_session", errorMessage: "no such session", transaction: "" };

    expect(await session.close()).toEqual({ transaction: "pending-sig", via: "gate" });
    expect(gate.sponsored).toHaveLength(1);
  });

  it("refuses a close at once, with 404, once a close of the session has succeeded", async () => {
    const session = await openSession();
    expect(await session.close()).toMatchObject({ via: "gate" });
    gate.gateDown = true;
    gate.facilitatorDown = true;

    await expect(session.close()).rejects.toMatchObject({ status: 404, message: "The session is already closed" });
  });

  it("moves past a sponsored close that the facilitator refuses, and names the refusal", async () => {
    const session = await openSession();
    gate.gateDown = true;
    gate.sponsoredAnswer = { success: false, errorReason: "simulation_failed", errorMessage: "custom program error: 0x1774", transaction: "" };

    await expect(session.close()).rejects.toThrow(/simulation_failed[\s\S]*runs to the end of its paid time/);
    expect(gate.sponsored).toHaveLength(1);
  });

  it.each<[number, unknown]>([
    [401, { error: "unauthorized" }],
    [409, { error: "refund_account_closed" }],
  ])("moves on to closeUrl when the gate refuses its close with %i: the later steps judge the close for themselves", async (status, body) => {
    const session = await openSession();
    gateCloseAnswers(session, status, body);

    expect(await session.close()).toEqual(SPONSORED);
  });

  it("names the gate's refusal when no later step closes the session either", async () => {
    const session = await openSession();
    gateCloseAnswers(session, 409, { error: "refund_account_closed" });
    gate.sponsoredAnswer = { success: false, errorReason: "simulation_failed", errorMessage: "custom program error: 0x1772", transaction: "" };

    await expect(session.close()).rejects.toThrow(/the gate answered 409[\s\S]*refund_account_closed[\s\S]*simulation_failed/);
  });

  it("passes over a gate that takes the close and never answers, after closeRequestTimeoutMs, and says its close may still land", async () => {
    const session = await openSession();
    gate.gateSilent = true;
    gate.sponsoredAnswer = { success: false, errorReason: "simulation_failed", errorMessage: "custom program error: 0x1772", transaction: "" };

    await expect(session.close()).rejects.toThrow(/the gate did not answer its close within 300 ms, and that close may still land[\s\S]*simulation_failed/);
    expect(gate.sponsored).toHaveLength(1);
  });

  it("passes over a closeUrl that never answers, after requestTimeoutMs, and says why", async () => {
    const session = await openSession();
    gate.gateDown = true;
    gate.facilitatorSilent = true;

    await expect(session.close()).rejects.toThrow(/sponsored close failed \(.*timeout[\s\S]*runs to the end of its paid time/);
  });

  it("passes over a closeUrl that takes the close and never answers, after closeRequestTimeoutMs, and says that close may still land", async () => {
    const session = await openSession();
    gate.gateDown = true;
    gate.sponsoredSilent = true;

    await expect(session.close()).rejects.toThrow(
      /the facilitator did not answer its close within 300 ms, and that close may still land[\s\S]*unless that close lands or a later close succeeds/,
    );
  });

  it("says that close may still land when closeUrl starts its answer to the close and never finishes it", async () => {
    const session = await openSession();
    gate.gateDown = true;
    gate.sponsoredStalls = true;

    await expect(session.close()).rejects.toThrow(/the facilitator did not answer its close within 300 ms, and that close may still land/);
  });

  it("says the gate's close may still land when the connection drops after the close was sent", async () => {
    const session = await openSession();
    gate.gateDrops = true;
    gate.sponsoredAnswer = { success: false, errorReason: "simulation_failed", errorMessage: "custom program error: 0x1772", transaction: "" };

    await expect(session.close()).rejects.toThrow(
      /the connection to the gate dropped after its close was sent, and that close may still land[\s\S]*simulation_failed[\s\S]*unless that close lands or a later close succeeds/,
    );
    expect(gate.sponsored).toHaveLength(1);
  });

  it("says a sponsored close may still land when the connection drops after POST closeUrl was sent", async () => {
    const session = await openSession();
    gate.gateDown = true;
    gate.sponsoredDrops = true;

    await expect(session.close()).rejects.toThrow(
      /the gate cannot be reached[\s\S]*the connection to the facilitator dropped after its close was sent, and that close may still land[\s\S]*unless that close lands or a later close succeeds/,
    );
    expect(gate.sponsored).toHaveLength(1);
  });

  it("reads a refused connection as a host that cannot be reached, and passes nothing on: the close was never sent", async () => {
    const session = await openSession();
    gate.gateDown = true;
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
      // The facilitator goes down between GET closeUrl and POST closeUrl: the close is refused.
      if (String(input) === gate.closeUrl && init?.method === "POST") gate.facilitatorDown = true;
      return realFetch(input, init);
    });

    const error = await session.close().catch((caught: unknown) => caught);

    expect((error as Error).message).toMatch(/the gate cannot be reached \(fetch failed: connect ECONNREFUSED/);
    expect((error as Error).message).toMatch(/the facilitator's sponsored close failed \(fetch failed: connect ECONNREFUSED/);
    expect((error as Error).message).not.toContain("may still land");
    expect((error as Error).message).toMatch(/unless a later close succeeds$/);
    expect(gate.sponsored).toEqual([]);
  });

  it("gives up a read of the gate's status that never answers, and moves on once closeWaitSeconds have gone by", async () => {
    const session = await openSession({ closeWaitSeconds: 0.5 });
    gate.closeSettlement = PENDING;
    gate.statusSilent = true;

    expect(await session.close()).toEqual(SPONSORED);
  });

  it("takes only the gate's own 404 for a closed session: another 404 on its status, a proxy's say, is waited out", async () => {
    const session = await openSession({ closeWaitSeconds: 0.2 });
    gate.closeSettlement = PENDING;
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) =>
      String(input) === `${gate.url}/sessions/${session.id}` ? Promise.resolve(new Response("Not Found", { status: 404 })) : realFetch(input, init),
    );

    expect(await session.close()).toEqual(SPONSORED);
  });

  it("refuses a time limit that is not a whole number of milliseconds that Node's timers keep", () => {
    expect(() => createStintClient({ signer: buyer, policy, requestTimeoutMs: Infinity })).toThrow(RangeError);
    expect(() => createStintClient({ signer: buyer, policy, closeRequestTimeoutMs: 1.5 })).toThrow(RangeError);
    expect(() => createStintClient({ signer: buyer, policy, closeRequestTimeoutMs: 2 ** 31 })).toThrow(RangeError);
    expect(() => createStintClient({ signer: buyer, policy, requestTimeoutMs: 2 ** 31 - 1 })).not.toThrow();
  });

  it("refuses a closePollMs that is not a whole number of milliseconds, and a closeWaitSeconds that is not a positive, finite number of seconds", () => {
    expect(() => createStintClient({ signer: buyer, policy, closePollMs: NaN })).toThrow(RangeError);
    expect(() => createStintClient({ signer: buyer, policy, closePollMs: 0 })).toThrow(RangeError);
    expect(() => createStintClient({ signer: buyer, policy: { ...policy, closeWaitSeconds: NaN } })).toThrow(RangeError);
    expect(() => createStintClient({ signer: buyer, policy: { ...policy, closeWaitSeconds: Infinity } })).toThrow(RangeError);
    expect(() => createStintClient({ signer: buyer, policy: { ...policy, closeWaitSeconds: 0 } })).toThrow(RangeError);
    expect(() => createStintClient({ signer: buyer, policy: { ...policy, closeWaitSeconds: 0.2 }, closePollMs: 20 })).not.toThrow();
  });

  it("shares one chain between overlapping calls: one close is sent, and both get its receipt", async () => {
    const session = await openSession();
    gate.gateDown = true;

    const [first, second] = await Promise.all([session.close(), session.close()]);

    expect(first).toEqual(SPONSORED);
    expect(second).toEqual(SPONSORED);
    expect(gate.sponsored).toHaveLength(1);
  });
});

describe("the client's own close on the chain (spec §9.3, step 3)", () => {
  let buyer: KeyPairSigner;
  let gate: TestGate;

  beforeEach(async () => {
    buyer = await generateKeyPairSigner();
    gate = await startTestGate(buyer.address);
  });

  afterEach(async () => {
    await gate.stop();
    expect(gate.escaped).toEqual([]);
  });

  /** The `Closed` event of the client's own close: 8,000 paid, 22,000 refunded. */
  const closedBy = (session: StintSession): ClosedEventArgs => ({
    session: session.id,
    kind: CloseKind.Standard,
    claimed: 0n,
    owed: 8_000n,
    refunded: 22_000n,
    redirected: 0n,
    closedBy: buyer.address,
    paidUntil: BigInt(gate.stored.startedAt) + 30n,
    at: BigInt(gate.stored.startedAt) + 8n,
  });

  /** Time limits small enough for a test to wait them out: a read is given up after 200 ms, a close after 300 ms. */
  const QUICK = { requestTimeoutMs: 200, closeRequestTimeoutMs: 300 } as const;

  /** A 30 s session on the test gate, for a client whose node is `node`; the gate and the facilitator then go down. */
  async function strandedSession(node: FakeNode, limits: Partial<ClientOptions> = {}): Promise<StintSession> {
    const client = createStintClient({ signer: buyer, policy, rpc: fakeRpc(node), ...limits });
    const session = await client.open(gate.url, { seconds: 30 });
    gate.gateDown = true;
    gate.facilitatorDown = true;
    return session;
  }

  it("closes the session itself when neither the gate nor the facilitator can: a Standard close by the authority, which also pays the fee", async () => {
    const node: FakeNode = { session: gate.stored, lamports: 1_000_000n, sent: [] };
    const session = await strandedSession(node);
    node.closed = closedBy(session); // the fake node reads `closed` when the close is fetched

    expect(await session.close()).toEqual({ paid: 8_000n, refunded: 22_000n, transaction: signatureOf(node.sent[0]!), via: "unilateral" });

    expect(node.sent).toHaveLength(1);
    const close = inspectTransaction(node.sent[0]!)!;
    expect(close.feePayer).toBe(buyer.address);
    expect([...close.signed]).toEqual([buyer.address]);
    expect(close.instructions).toHaveLength(1);
    const instruction = close.instructions[0]!;
    expect(instruction.programAddress).toBe(STINT_PROGRAM_ADDRESS);
    expect(identifyStintInstruction(instruction.data!)).toBe(StintInstruction.Close);
    const parsed = parseCloseInstruction(instruction as Parameters<typeof parseCloseInstruction>[0]);
    expect(parsed.data.kind).toBe(CloseKind.Standard);
    expect(parsed.accounts.session.address).toBe(session.id);
    expect(parsed.accounts.closer.address).toBe(buyer.address);
  });

  it("waits for its own close to confirm until closeRequestTimeoutMs from its send, past the scheme package's default of 30 s", async () => {
    const node: FakeNode = { session: gate.stored, lamports: 1_000_000n, sent: [] };
    const session = await strandedSession(node, { closeRequestTimeoutMs: 45_000 });
    confirmationLimits.length = 0;

    expect(await session.close()).toMatchObject({ via: "unilateral" });

    // Waiting out 30 s is too long for a test: the time limit the wait was given is checked instead.
    expect(confirmationLimits).toHaveLength(1);
    expect(confirmationLimits[0]).toBeGreaterThan(44_000);
    expect(confirmationLimits[0]).toBeLessThanOrEqual(45_000);
  });

  it("sends nothing, and says the session runs to the end of its paid time, when the signer holds no SOL", async () => {
    const node: FakeNode = { session: gate.stored, lamports: 0n, sent: [] };
    const session = await strandedSession(node);

    await expect(session.close()).rejects.toThrow(/holds 0 lamports[\s\S]*runs to the end of its paid time/);
    expect(node.sent).toEqual([]);
  });

  it("ends the chain when the chain holds no session at the address: the session is closed", async () => {
    const node: FakeNode = { lamports: 1_000_000n, sent: [] };
    const session = await strandedSession(node);

    await expect(session.close()).rejects.toMatchObject({ status: 404, message: "The session is already closed" });
    expect(node.sent).toEqual([]);
  });

  it("reports a close that the node refuses with an error answer, passes nothing on, and the session runs on", async () => {
    const refuse = { code: -32002, message: "Transaction simulation failed", data: { accounts: null, logs: [], unitsConsumed: 0, returnData: null } };
    const node: FakeNode = { session: gate.stored, lamports: 1_000_000n, refuse, sent: [] };
    const session = await strandedSession(node);

    const error = await session.close().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(StintError);
    expect(node.sent).toEqual([]);
    expect((error as Error).message).toMatch(/own close failed \(Transaction simulation failed\)/);
    expect((error as Error).message).not.toContain("may still land");
    expect((error as Error).message).toMatch(/runs to the end of its paid time/);
  });

  it("names a close it sent as one that may still land when its confirmation cannot be read", async () => {
    const node: FakeNode = { session: gate.stored, lamports: 1_000_000n, statusFails: true, sent: [] };
    const session = await strandedSession(node);

    const error = await session.close().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(StintError);
    expect(node.sent).toHaveLength(1);
    expect((error as Error).message).toContain(`A close sent may still land: ${signatureOf(node.sent[0]!)} (unilateral)`);
    expect((error as Error).message).toContain("confirmation could not be read");
    expect((error as Error).message).toMatch(/runs to the end of its paid time/);
  });

  it("does not pass on a close of its own that the chain reports failed: it cannot land", async () => {
    const node: FakeNode = { session: gate.stored, lamports: 1_000_000n, failed: { InstructionError: [0, { Custom: 6004 }] }, sent: [] };
    const session = await strandedSession(node);

    const error = await session.close().catch((caught: unknown) => caught);

    expect(node.sent).toHaveLength(1);
    expect((error as Error).message).toMatch(/own close failed \(Transaction \w+ failed: /);
    expect((error as Error).message).not.toContain("may still land");
    expect((error as Error).message).toMatch(/runs to the end of its paid time/);
  });

  it("returns a close that confirmed, without amounts, when its Closed event cannot be read", async () => {
    const node: FakeNode = { session: gate.stored, lamports: 1_000_000n, transactionFails: true, sent: [] };
    const session = await strandedSession(node);

    const receipt = await session.close();

    expect(receipt).toEqual({ transaction: signatureOf(node.sent[0]!), via: "unilateral" });
    expect(node.sent).toHaveLength(1);
  });

  it("sends nothing to the chain while the gate can close the session", async () => {
    const sent: string[] = [];
    const client = createStintClient({ signer: buyer, policy, rpc: fakeRpc({ session: gate.stored, lamports: 1_000_000n, sent }) });
    const session = await client.open(gate.url, { seconds: 30 });

    expect(await session.close()).toMatchObject({ via: "gate" });
    expect(sent).toEqual([]);
  });

  it("sends nothing when the signer holds less than the fee on top of a rent-exempt balance: a fee payer may not drop below it", async () => {
    const lamports = RENT_EXEMPT_LAMPORTS + 4_999n;
    const node: FakeNode = { session: gate.stored, lamports, sent: [] };
    const session = await strandedSession(node);

    const error = await session.close().catch((caught: unknown) => caught);

    expect((error as Error).message).toContain(`the signer holds ${lamports} lamports, less than`);
    expect(node.sent).toEqual([]);
  });

  it("checks on the chain a session that closeUrl reports closed, and closes it itself when the chain still holds it", async () => {
    const node: FakeNode = { session: gate.stored, lamports: 1_000_000n, sent: [] };
    const session = await strandedSession(node);
    gate.facilitatorDown = false;
    gate.facilitatorSessionOpen = false; // the facilitator's node, lagging or not, finds no session
    node.closed = closedBy(session);

    expect(await session.close()).toMatchObject({ transaction: signatureOf(node.sent[0]!), via: "unilateral" });
    expect(node.sent).toHaveLength(1);
    expect(gate.sponsored).toEqual([]);
  });

  /**
   * A session whose gate's close and then sponsored close both stay pending, for a client whose node is `node` and shows
   * no session at the address: the chain ends at step 3's read, with both closes passed on.
   */
  async function bothClosesPending(node: FakeNode, limits: Partial<ClientOptions> = {}) {
    const client = createStintClient({ signer: buyer, policy: { ...policy, closeWaitSeconds: 0.2 }, closePollMs: 20, rpc: fakeRpc(node), ...limits });
    const session = await client.open(gate.url, { seconds: 30 });
    const [gateClose, sponsoredClose] = [fakeSignature(1), fakeSignature(2)];
    gate.closeSettlement = { success: false, errorReason: "settlement_pending", transaction: gateClose, network: NETWORK };
    gate.sponsoredAnswer = { success: false, errorReason: "settlement_pending", errorMessage: "not confirmed", transaction: sponsoredClose };
    node.closed = closedBy(session);
    return { session, gateClose, sponsoredClose };
  }

  it("returns the pending close that the chain shows landed, with its amounts, when it finds the session closed", async () => {
    const node: FakeNode = { lamports: 1_000_000n, sent: [] };
    const { session, gateClose } = await bothClosesPending(node);
    node.landed = gateClose; // the gate's close landed, not the facilitator's, which was sent later

    expect(await session.close()).toEqual({ paid: 8_000n, refunded: 22_000n, transaction: gateClose, via: "gate" });
    expect(node.sent).toEqual([]);
  });

  it("reports the session closed by another party when the close the chain shows is none of its own", async () => {
    const node: FakeNode = { lamports: 1_000_000n, sent: [] };
    const { session } = await bothClosesPending(node);
    node.landed = fakeSignature(3); // the gate's end close, say: neither pending close landed

    await expect(session.close()).rejects.toMatchObject({ status: 404, message: "The session is already closed" });
  });

  it("returns the latest pending close, without amounts, when the list of the address's transactions cannot be read", async () => {
    const node: FakeNode = { lamports: 1_000_000n, listFails: true, sent: [] };
    const { session, sponsoredClose } = await bothClosesPending(node);

    expect(await session.close()).toEqual({ transaction: sponsoredClose, via: "sponsored" });
  });

  it("checks the gate's word that the session is closed with its own read, and tries no sponsored close", async () => {
    const node: FakeNode = { lamports: 1_000_000n, sent: [] };
    const client = createStintClient({ signer: buyer, policy: { ...policy, closeWaitSeconds: 60 }, closePollMs: 20, rpc: fakeRpc(node) });
    const session = await client.open(gate.url, { seconds: 30 });
    const gateClose = fakeSignature(1);
    gate.closeSettlement = { success: false, errorReason: "settlement_pending", transaction: gateClose, network: NETWORK };
    gate.facilitatorSessionOpen = true; // the facilitator's node still shows the session
    node.closed = closedBy(session);
    node.landed = gateClose;
    const closing = gate; // not `gate`, which names the next test's gate by the time a late timer fires
    setTimeout(() => (closing.sessionOpen = false), 100); // the gate's close lands, and its status finds no session

    expect(await session.close()).toEqual({ paid: 8_000n, refunded: 22_000n, transaction: gateClose, via: "gate" });
    expect(gate.sponsored).toEqual([]);
  });

  it("takes the seller's word that the session is closed when its own read fails", async () => {
    const node: FakeNode = { session: gate.stored, lamports: 1_000_000n, readFails: true, sent: [] };
    const session = await strandedSession(node);
    gate.facilitatorDown = false;
    gate.facilitatorSessionOpen = false;

    await expect(session.close()).rejects.toMatchObject({ status: 404, message: "The session is already closed" });
    expect(node.sent).toEqual([]);
  });

  it("names a close it sent as one that may still land when the node takes it and the connection drops before its answer", async () => {
    const node: FakeNode = { session: gate.stored, lamports: 1_000_000n, sendDrops: true, sent: [] };
    const session = await strandedSession(node);

    const error = await session.close().catch((caught: unknown) => caught);

    expect(node.sent).toHaveLength(1);
    expect((error as Error).message).toContain(`A close sent may still land: ${signatureOf(node.sent[0]!)} (unilateral)`);
  });

  describe("with a node that takes a request and never answers it", () => {
    it("gives up the read of the session account after requestTimeoutMs, sends nothing, and says why", async () => {
      const node: FakeNode = { session: gate.stored, lamports: 1_000_000n, silent: ["getAccountInfo"], sent: [] };
      const session = await strandedSession(node, QUICK);
      const started = Date.now();

      await expect(session.close()).rejects.toThrow(/its node did not answer within 200 ms[\s\S]*runs to the end of its paid time/);
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(node.sent).toEqual([]);
    });

    it("gives up the read of the signer's balance after requestTimeoutMs, and sends nothing", async () => {
      const node: FakeNode = { session: gate.stored, lamports: 1_000_000n, silent: ["getBalance"], sent: [] };
      const session = await strandedSession(node, QUICK);

      await expect(session.close()).rejects.toThrow(/its node did not answer within 200 ms/);
      expect(node.sent).toEqual([]);
    });

    it("gives up the read of the rent-exempt minimum after requestTimeoutMs, and sends nothing", async () => {
      const node: FakeNode = { session: gate.stored, lamports: 1_000_000n, silent: ["getMinimumBalanceForRentExemption"], sent: [] };
      const session = await strandedSession(node, QUICK);
      const started = Date.now();

      await expect(session.close()).rejects.toThrow(/its node did not answer within 200 ms[\s\S]*runs to the end of its paid time/);
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(node.sent).toEqual([]);
    });

    it("gives up the read of the latest blockhash after requestTimeoutMs, and sends nothing", async () => {
      const node: FakeNode = { session: gate.stored, lamports: 1_000_000n, silent: ["getLatestBlockhash"], sent: [] };
      const session = await strandedSession(node, QUICK);
      const started = Date.now();

      await expect(session.close()).rejects.toThrow(/its node did not answer within 200 ms[\s\S]*runs to the end of its paid time/);
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(node.sent).toEqual([]);
    });

    it("names its own close as one that may still land when the send has no answer within closeRequestTimeoutMs", async () => {
      const node: FakeNode = { session: gate.stored, lamports: 1_000_000n, silent: ["sendTransaction"], sent: [] };
      const session = await strandedSession(node, QUICK);

      const error = await session.close().catch((caught: unknown) => caught);

      expect(node.sent).toHaveLength(1);
      expect((error as Error).message).toContain(`A close sent may still land: ${signatureOf(node.sent[0]!)} (unilateral)`);
      expect((error as Error).message).toMatch(/runs to the end of its paid time/);
    });

    it("names its own close as one that may still land when its status has no answer within closeRequestTimeoutMs of its send", async () => {
      const node: FakeNode = { session: gate.stored, lamports: 1_000_000n, silent: ["getSignatureStatuses"], sent: [] };
      const session = await strandedSession(node, QUICK);
      const started = Date.now();

      const error = await session.close().catch((caught: unknown) => caught);

      expect(Date.now() - started).toBeLessThan(2_000);
      expect(node.sent).toHaveLength(1);
      expect((error as Error).message).toContain(`not confirmed within 300 ms`);
      expect((error as Error).message).toContain(`A close sent may still land: ${signatureOf(node.sent[0]!)} (unilateral)`);
    });

    it("returns its own close that confirmed, without amounts, when the read of its Closed event has no answer within requestTimeoutMs", async () => {
      const node: FakeNode = { session: gate.stored, lamports: 1_000_000n, silent: ["getTransaction"], sent: [] };
      const session = await strandedSession(node, QUICK);
      node.closed = closedBy(session);

      expect(await session.close()).toEqual({ transaction: signatureOf(node.sent[0]!), via: "unilateral" });
    });

    it("returns the latest pending close, without amounts, when the list of the address's transactions has no answer within requestTimeoutMs", async () => {
      const node: FakeNode = { lamports: 1_000_000n, silent: ["getSignaturesForAddress"], sent: [] };
      const { session, gateClose, sponsoredClose } = await bothClosesPending(node, QUICK);
      node.landed = gateClose; // what the list would show, if it answered

      expect(await session.close()).toEqual({ transaction: sponsoredClose, via: "sponsored" });
    });

    it("takes the seller's word that the session is closed when its own read has no answer within requestTimeoutMs", async () => {
      const node: FakeNode = { session: gate.stored, lamports: 1_000_000n, silent: ["getAccountInfo"], sent: [] };
      const session = await strandedSession(node, QUICK);
      gate.facilitatorDown = false;
      gate.facilitatorSessionOpen = false;

      await expect(session.close()).rejects.toMatchObject({ status: 404, message: "The session is already closed" });
      expect(node.sent).toEqual([]);
    });
  });
});
