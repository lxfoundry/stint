import {
  generateKeyPairSigner,
  getBase58Decoder,
  getBase58Encoder,
  getBase64Decoder,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getTransactionDecoder,
  partiallySignTransaction,
  type Address,
  type KeyPairSigner,
  type Rpc,
  type SolanaRpcApi,
} from "@solana/kit";
import {
  CloseKind,
  SESSION_DISCRIMINATOR,
  STINT_PROGRAM_ADDRESS,
  getCloseInstructionDataDecoder,
  getSessionEncoder,
} from "@lxfoundry/stint-program-client";
import { inspectTransaction, type InspectedTransaction } from "@lxfoundry/stint-x402";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { KoraClient } from "../src/kora.js";
import { createSweeper } from "../src/sweeper.js";
import type { FacilitatorContext } from "../src/verify.js";

const NETWORK = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const BLOCKHASH = "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N";
const MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU" as Address;

/** Sessions of 30 s at 1,000 per second, started at this second. The sweeper closes when `paid_until <= clock`. */
const STARTED_AT = 1_800_000_000n;
const PAID_UNTIL_MS = Number(STARTED_AT + 30n) * 1_000;
const JUST_BEFORE_MS = PAID_UNTIL_MS - 1;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function until(condition: () => boolean, what: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await sleep(5);
  }
}

type Filter =
  | { readonly dataSize: bigint }
  | { readonly memcmp: { readonly offset: bigint; readonly bytes: string; readonly encoding: string } };
interface Listing {
  readonly program: Address;
  readonly config: { readonly commitment: string; readonly encoding: string; readonly filters: readonly Filter[] };
}

/** What the fake node holds and what it was asked; the unset parts are the happy path. */
interface Node {
  /** The session accounts, by address. A close that lands removes its account, as the program does. */
  accounts: Map<Address, Uint8Array>;
  /** Sessions whose close the node refuses at submission. */
  refuse: Set<Address>;
  /** Makes every listing fail with this message. */
  listingError?: string;
  /** Holds every submission until it settles. */
  hold?: Promise<void>;
  /** Runs after a listing has been answered. */
  onListed?: () => void;
  listings: Listing[];
  /** The accounts read one by one. */
  reads: Address[];
  /** Submissions that reached the node, held or not. */
  submitting: number;
  sent: { readonly session: Address; readonly tx: InspectedTransaction }[];
}

/**
 * Two views of one node: the main RPC, which refuses to list a program's accounts as a free tier does, and the
 * scan RPC, which does nothing else.
 */
function createChain(): { node: Node; rpc: Rpc<SolanaRpcApi>; scanRpc: Rpc<SolanaRpcApi> } {
  const node: Node = { accounts: new Map(), refuse: new Set(), listings: [], reads: [], submitting: 0, sent: [] };
  const call = (answer: () => unknown) => ({ send: async () => answer() });
  const rpcAccount = (data: Uint8Array) => ({
    data: [getBase64Decoder().decode(data), "base64"],
    executable: false,
    lamports: 1_000_000n,
    owner: STINT_PROGRAM_ADDRESS,
    space: BigInt(data.length),
  });
  const matches = (data: Uint8Array, filter: Filter): boolean => {
    if ("dataSize" in filter) return BigInt(data.length) === filter.dataSize;
    const expected = getBase58Encoder().encode(filter.memcmp.bytes);
    return expected.every((byte, index) => data[Number(filter.memcmp.offset) + index] === byte);
  };
  const scanRpc = {
    getProgramAccounts: (program: Address, config: Listing["config"]) =>
      call(() => {
        node.listings.push({ program, config });
        if (node.listingError) throw new Error(node.listingError);
        const listed = [...node.accounts]
          .filter(([, data]) => config.filters.every((filter) => matches(data, filter)))
          .map(([pubkey, data]) => ({ pubkey, account: rpcAccount(data) }));
        node.onListed?.();
        return listed;
      }),
  };
  const rpc = {
    getProgramAccounts: () =>
      call(() => {
        throw new Error("HTTP error (400): Bad Request");
      }),
    getAccountInfo: (target: Address) =>
      call(() => {
        node.reads.push(target);
        const data = node.accounts.get(target);
        return { value: data ? rpcAccount(data) : null };
      }),
    getLatestBlockhash: () => call(() => ({ value: { blockhash: BLOCKHASH, lastValidBlockHeight: 1_234n } })),
    sendTransaction: (wire: string) =>
      call(async () => {
        node.submitting++;
        await node.hold;
        const tx = inspectTransaction(wire)!;
        // `close`'s accounts: closer, session, vault, receiver token, refund account, rent payer.
        const session = tx.instructions[0]!.accounts![1]!.address;
        if (node.refuse.has(session)) throw new Error("Transaction simulation failed: custom program error 0x1774");
        node.sent.push({ session, tx });
        node.accounts.delete(session);
        return "accepted";
      }),
    getSignatureStatuses: () => call(() => ({ value: [{ confirmationStatus: "confirmed", err: null }] })),
    isBlockhashValid: () => call(() => ({ value: true })),
    getTransaction: () => call(() => null),
  };
  return { node, rpc: rpc as unknown as Rpc<SolanaRpcApi>, scanRpc: scanRpc as unknown as Rpc<SolanaRpcApi> };
}

interface FakeKora extends KoraClient {
  /** While set, Kora refuses to sign. */
  failing: boolean;
}

/** Signs as the fee payer, as Kora does: it adds its signature to a transaction that already carries the others. */
function createKora(feePayer: KeyPairSigner): FakeKora {
  const kora: FakeKora = {
    failing: false,
    getPayerSigner: async () => ({ signer_address: feePayer.address, payment_address: feePayer.address }),
    signTransaction: async (wire) => {
      if (kora.failing) throw new Error("Kora signTransaction: the policy refuses this transaction (-32000)");
      const transaction = getTransactionDecoder().decode(getBase64Encoder().encode(wire));
      return getBase64EncodedWireTransaction(await partiallySignTransaction([feePayer.keyPair], transaction));
    },
  };
  return kora;
}

describe("the sweeper (spec §6.4)", () => {
  let buyer: Address;
  let seller: Address;
  let authorizer: Address;
  let feePayer: KeyPairSigner;
  let rentPayer: KeyPairSigner;
  let stranger: KeyPairSigner;
  let fake: ReturnType<typeof createChain>;
  let kora: FakeKora;
  let logs: Record<string, unknown>[];
  let ctx: FacilitatorContext;

  beforeAll(async () => {
    buyer = (await generateKeyPairSigner()).address;
    seller = (await generateKeyPairSigner()).address;
    authorizer = (await generateKeyPairSigner()).address;
    feePayer = await generateKeyPairSigner();
    rentPayer = await generateKeyPairSigner();
    stranger = await generateKeyPairSigner();
  });

  beforeEach(() => {
    fake = createChain();
    kora = createKora(feePayer);
    logs = [];
    ctx = {
      rpc: fake.rpc,
      network: NETWORK,
      keys: { feePayer: feePayer.address, rentPayer: rentPayer.address },
      rentPayer,
      kora,
      confirmTimeoutMs: 1_000,
      readRetry: { attempts: 1, delayMs: 0 },
    };
  });

  const sweeper = (clock: () => number = () => PAID_UNTIL_MS) =>
    createSweeper({ ctx, scanRpc: fake.scanRpc, clock, log: (entry) => logs.push(entry) });

  const sessionData = (options: { rentPayer?: Address; deposited?: bigint }): Uint8Array =>
    Uint8Array.from(
      getSessionEncoder().encode({
        version: 1,
        bump: 255,
        authority: buyer,
        seed: 1n,
        mint: MINT,
        receiver: seller,
        receiverAuthorizer: authorizer,
        refundOwner: buyer,
        rentPayer: options.rentPayer ?? rentPayer.address,
        rate: 1_000n,
        minSeconds: 5,
        maxSeconds: 120,
        startedAt: STARTED_AT,
        deposited: options.deposited ?? 30_000n,
        claimed: 0n,
      }),
    );

  /** A session on the node, naming the facilitator's rent payer unless told otherwise. */
  const addSession = async (options: { rentPayer?: Address } = {}): Promise<Address> => {
    const address = (await generateKeyPairSigner()).address;
    fake.node.accounts.set(address, sessionData(options));
    return address;
  };

  it("lists the sessions that name its rent payer, on the scan RPC and never on the main one", async () => {
    const ours = await addSession();
    await addSession({ rentPayer: stranger.address });

    await sweeper().sweepOnce();

    // The main RPC refuses to list (see `createChain`): reaching it would have failed the sweep.
    expect(fake.node.listings).toEqual([
      {
        program: STINT_PROGRAM_ADDRESS,
        config: {
          commitment: "confirmed",
          encoding: "base64",
          filters: [
            { dataSize: 250n },
            { memcmp: { offset: 0n, bytes: getBase58Decoder().decode(SESSION_DISCRIMINATOR), encoding: "base58" } },
            { memcmp: { offset: 178n, bytes: rentPayer.address, encoding: "base58" } },
          ],
        },
      },
    ]);
    // The fake applied those filters to the real layout: the other rent payer's session was never listed, so never read.
    expect(fake.node.reads).toEqual([ours]);
  });

  it("closes an expired session with AtExpiry, signed by the rent payer and by Kora's fee payer", async () => {
    const session = await addSession();

    expect(await sweeper().sweepOnce()).toEqual({ closed: [session], failed: [] });

    expect(fake.node.sent).toHaveLength(1);
    const { tx } = fake.node.sent[0]!;
    const close = tx.instructions[0]!;
    expect(tx.instructions).toHaveLength(1);
    expect(getCloseInstructionDataDecoder().decode(close.data!).kind).toBe(CloseKind.AtExpiry);
    expect(close.accounts![0]!.address).toBe(rentPayer.address); // the closer
    expect(tx.feePayer).toBe(feePayer.address);
    expect(tx.blockhash).toBe(BLOCKHASH);
    expect(new Set(tx.signers)).toEqual(new Set([feePayer.address, rentPayer.address]));
    expect(tx.signed).toEqual(new Set([feePayer.address, rentPayer.address]));
  });

  it("leaves a session that has not expired alone", async () => {
    await addSession();

    expect(await sweeper(() => JUST_BEFORE_MS).sweepOnce()).toEqual({ closed: [], failed: [] });

    expect(fake.node.reads).toEqual([]);
    expect(fake.node.sent).toEqual([]);
  });

  it("skips a session that is gone when it reads it, without reporting it as failed", async () => {
    const session = await addSession();
    fake.node.onListed = () => fake.node.accounts.delete(session);

    expect(await sweeper().sweepOnce()).toEqual({ closed: [], failed: [] });

    expect(fake.node.reads).toEqual([session]);
    expect(fake.node.sent).toEqual([]);
    expect(logs).toEqual([]);
  });

  it("decides on what it reads, not on the listing: a session whose paid time moved later is left alone", async () => {
    const session = await addSession();
    fake.node.onListed = () => fake.node.accounts.set(session, sessionData({ deposited: 60_000n }));

    expect(await sweeper().sweepOnce()).toEqual({ closed: [], failed: [] });

    expect(fake.node.reads).toEqual([session]);
    expect(fake.node.sent).toEqual([]);
  });

  it("does not stop at a failing close: it closes the others, reports the failure, and tries it again at the next sweep", async () => {
    const first = await addSession();
    const second = await addSession();
    const third = await addSession();
    fake.node.refuse.add(second);
    const sweep = sweeper();

    expect(await sweep.sweepOnce()).toEqual({
      closed: [first, third],
      failed: [{ session: second, error: expect.stringContaining("simulation_failed") }],
    });
    expect(fake.node.sent.map(({ session }) => session)).toEqual([first, third]);

    fake.node.refuse.delete(second);
    expect(await sweep.sweepOnce()).toEqual({ closed: [second], failed: [] });
  });

  it("reports a close that Kora refuses to sign, and sends nothing", async () => {
    const session = await addSession();
    kora.failing = true;

    expect(await sweeper().sweepOnce()).toEqual({
      closed: [],
      failed: [{ session, error: expect.stringContaining("Kora") }],
    });
    expect(fake.node.sent).toEqual([]);
  });

  it("shares one sweep between callers that overlap, so a close is never sent twice", async () => {
    const session = await addSession();
    let release!: () => void;
    fake.node.hold = new Promise<void>((resolve) => (release = resolve));
    const sweep = sweeper();

    const first = sweep.sweepOnce();
    const second = sweep.sweepOnce();
    await until(() => fake.node.submitting === 1, "the close to reach the node");
    release();

    const [one, other] = await Promise.all([first, second]);
    expect(other).toBe(one);
    expect(one).toEqual({ closed: [session], failed: [] });
    expect(fake.node.sent).toHaveLength(1);
    expect(fake.node.listings).toHaveLength(1);

    // Once it has finished, the next call is a sweep of its own.
    expect(await sweep.sweepOnce()).toEqual({ closed: [], failed: [] });
    expect(fake.node.listings).toHaveLength(2);
  });

  it("sweeps on every interval with the clock it is given, until it is stopped", async () => {
    const session = await addSession();
    let now = JUST_BEFORE_MS;
    const sweep = sweeper(() => now);

    sweep.start(10);
    await until(() => fake.node.listings.length >= 3, "three sweeps");
    expect(fake.node.sent).toEqual([]);

    now = PAID_UNTIL_MS;
    await until(() => fake.node.sent.length === 1, "the close");
    await sweep.stop();
    expect(fake.node.sent[0]!.session).toBe(session);

    const sweeps = fake.node.listings.length;
    await sleep(50);
    expect(fake.node.listings).toHaveLength(sweeps);
  });

  it("never throws out of the interval: a failed sweep is logged, without the URL's secret, and the next one runs", async () => {
    fake.node.listingError = "HTTP error (429) from https://rpc.example/v2/secret-key: rate limited";
    const sweep = sweeper();
    // A caller that logs what `sweepOnce` rejects with must not leak the secret either.
    const rejection = (await sweep.sweepOnce().catch((error: unknown) => error)) as Error;
    expect(rejection.message).toBe("HTTP error (429) from https://rpc.example rate limited");

    sweep.start(10);
    await until(() => logs.length >= 2, "two failed sweeps");
    await sweep.stop();

    expect(logs[0]).toMatchObject({ event: "sweep_error" });
    expect(JSON.stringify(logs)).toContain("https://rpc.example");
    expect(JSON.stringify(logs)).not.toContain("secret-key");
  });

  it("does not let a logger that throws escape: the report is still returned, and the timer raises no unhandled rejection", async () => {
    const session = await addSession();
    let logged = 0;
    const sweep = createSweeper({
      ctx,
      scanRpc: fake.scanRpc,
      clock: () => PAID_UNTIL_MS,
      log: () => {
        logged++;
        throw new Error("the log is down");
      },
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      expect(await sweep.sweepOnce()).toEqual({ closed: [session], failed: [] });

      fake.node.listingError = "listing failed";
      sweep.start(10);
      await until(() => logged >= 3, "the logger to be called for two failed sweeps");
      await sweep.stop();
      await sleep(20);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }

    expect(unhandled).toEqual([]);
  });

  it("waits, when it stops, for a sweep in flight", async () => {
    await addSession();
    let release!: () => void;
    fake.node.hold = new Promise<void>((resolve) => (release = resolve));
    const sweep = sweeper();
    try {
      sweep.start(10);
      await until(() => fake.node.submitting === 1, "a close in flight");

      let stopped = false;
      const stopping = sweep.stop().then(() => (stopped = true));
      await sleep(50);
      expect(stopped).toBe(false);

      release();
      await stopping;
      expect(fake.node.sent).toHaveLength(1);
    } finally {
      release();
    }
    const sweeps = fake.node.listings.length;
    await sleep(50);
    expect(fake.node.listings).toHaveLength(sweeps);
  });
});
