import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { getTransferSolInstruction, parseTransferSolInstruction } from "@solana-program/system";
import { TOKEN_PROGRAM_ADDRESS, parseCreateAssociatedTokenIdempotentInstruction } from "@solana-program/token";
import {
  createSolanaRpc,
  decompileTransactionMessage,
  generateKeyPairSigner,
  getAddressEncoder,
  getBase58Decoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  type AccountMeta,
  type Address,
  type Instruction,
  type InstructionWithAccounts,
  type InstructionWithData,
  type ReadonlyUint8Array,
  type Rpc,
  type SolanaRpcApi,
} from "@solana/kit";
import { SYSVAR_CLOCK_ADDRESS, getSysvarClockEncoder } from "@solana/sysvars";
import {
  CloseKind,
  SESSION_DISCRIMINATOR,
  STINT_PROGRAM_ADDRESS,
  eventAccounts,
  getSessionEncoder,
  parseCloseInstruction,
  type Session,
  type SessionArgs,
} from "@lxfoundry/stint-program-client";
import { associatedTokenAddress } from "@lxfoundry/stint-x402";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEVNET_GENESIS_HASH,
  FUNDING_MARGIN_LAMPORTS,
  assertDevnet,
  closableAtStart,
  closeLeftSessions,
  ensureTokenAccount,
  fundingNeeded,
  lamportsToSend,
  listSessionsOf,
  sendInstructions,
  topUpSol,
  type ListedSession,
} from "../src/chain.js";

const RENT_PAYER = "SysvarRent111111111111111111111111111111111" as Address;
const AUTHORIZER = "SysvarC1ock11111111111111111111111111111111" as Address;
const OTHER = "Stake11111111111111111111111111111111111111" as Address;
const [A, B, C, D] = [
  "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDyLb",
  "So11111111111111111111111111111111111111112",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
] as [Address, Address, Address, Address];

/** A session of 100 s from 1,000 at 1000 base units a second, the deployment's own unless `fields` say otherwise. */
const listed = (address: Address, fields: Partial<Session> = {}): ListedSession => ({
  address,
  stored: { rentPayer: RENT_PAYER, receiverAuthorizer: AUTHORIZER, startedAt: 1_000n, deposited: 100_000n, rate: 1_000n, ...fields } as unknown as Session,
});

/** An RPC that reports `genesis` as its genesis hash and answers nothing else. */
const rpcWithGenesis = (genesis: string) => ({ getGenesisHash: () => ({ send: async () => genesis }) }) as unknown as Rpc<SolanaRpcApi>;

describe("the network the seller runs on", () => {
  it("goes on with an RPC that reports devnet's genesis hash", async () => {
    expect(DEVNET_GENESIS_HASH).toBe("EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG");
    await expect(assertDevnet(rpcWithGenesis(DEVNET_GENESIS_HASH))).resolves.toBeUndefined();
  });

  it("refuses an RPC that reports any other genesis hash", async () => {
    const mainnet = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
    await expect(assertDevnet(rpcWithGenesis(mainnet))).rejects.toThrow(`The RPC reports genesis hash ${mainnet}, which is not devnet's: refusing to start`);
  });
});

describe("the SOL the stack's keys are given", () => {
  it("tops a key up to its target, and sends nothing to one that holds as much or more", () => {
    expect(lamportsToSend(0n, 50_000_000n)).toBe(50_000_000n);
    expect(lamportsToSend(49_000_000n, 50_000_000n)).toBe(1_000_000n);
    expect(lamportsToSend(50_000_000n, 50_000_000n)).toBe(0n);
    expect(lamportsToSend(70_000_000n, 50_000_000n)).toBe(0n);
  });

  it("asks the funding key for a margin whenever it has to pay, the seller's missing token account included", () => {
    expect(fundingNeeded(0n, false)).toBe(0n);
    expect(fundingNeeded(0n, true)).toBe(FUNDING_MARGIN_LAMPORTS);
    expect(fundingNeeded(5_000_000n, false)).toBe(5_000_000n + FUNDING_MARGIN_LAMPORTS);
    expect(fundingNeeded(5_000_000n, true)).toBe(5_000_000n + FUNDING_MARGIN_LAMPORTS);
  });
});

describe("the sessions the start-up closes", () => {
  it("closes the deployment's own sessions that are still paid for, and leaves the rest to the sweeper or their owner", () => {
    const sessions = [listed(A), listed(B, { startedAt: 900n }), listed(C, { rentPayer: OTHER }), listed(D, { receiverAuthorizer: OTHER })];
    expect(closableAtStart(sessions, { rentPayer: RENT_PAYER, receiverAuthorizer: AUTHORIZER }, 1_050n)).toEqual([A]);
  });

  it("leaves a session alone from its paid_until on", () => {
    expect(closableAtStart([listed(A)], { rentPayer: RENT_PAYER, receiverAuthorizer: AUTHORIZER }, 1_100n)).toEqual([]);
  });
});

// What follows runs the code that reads the chain and sends transactions against a node on 127.0.0.1, reached through
// kit's own RPC client, so that requests and answers are encoded as they are with a real node.

const MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU" as Address;
// Addresses of no program: a transaction may not mark a program it invokes as writable.
const anAddress = async () => (await generateKeyPairSigner()).address;
const [RECEIVER, REFUND_OWNER, FIRST, SECOND, BLOCKHASH] = await Promise.all([anAddress(), anAddress(), anAddress(), anAddress(), anAddress()]);
const SYSVAR_OWNER = "Sysvar1111111111111111111111111111111111111" as Address;
const KEY = "SECRETKEY0123";
const context = { slot: 1 };

/** A JSON-RPC error the node answers with instead of a result. */
class NodeError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

/** A transaction the node was sent, decoded. */
interface Sent {
  readonly feePayer: Address;
  /** The keys whose signatures it carries. */
  readonly signedBy: Address[];
  readonly instructions: readonly Instruction[];
}

interface FakeNode {
  readonly rpc: Rpc<SolanaRpcApi>;
  /** The methods it was asked, in order, with their parameters as sent. */
  readonly asked: { readonly method: string; readonly params: readonly unknown[] }[];
  readonly sent: Sent[];
}

/** How the node answers a method: `standard` is its own answer, for an answer that only sometimes differs. */
type Answers = Record<string, (params: readonly unknown[], standard: () => unknown) => unknown>;

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

/**
 * A node that gives a blockhash, confirms every transaction it is sent and keeps it decoded in `sent`, and answers the
 * other methods from `answers`; any other method is an error.
 */
async function fakeNode(answers: Answers = {}): Promise<FakeNode> {
  const asked: FakeNode["asked"] = [];
  const sent: Sent[] = [];
  const standards: Record<string, (params: readonly unknown[]) => unknown> = {
    getLatestBlockhash: () => ({ context, value: { blockhash: BLOCKHASH, lastValidBlockHeight: 1_000 } }),
    getSignatureStatuses: () => ({ context, value: [{ slot: 1, confirmations: null, err: null, confirmationStatus: "confirmed", status: { Ok: null } }] }),
    sendTransaction: ([wire]) => {
      const transaction = getTransactionDecoder().decode(Buffer.from(wire as string, "base64"));
      const message = decompileTransactionMessage(
        getCompiledTransactionMessageDecoder().decode(transaction.messageBytes) as Parameters<typeof decompileTransactionMessage>[0],
      );
      sent.push({
        feePayer: message.feePayer.address,
        signedBy: Object.entries(transaction.signatures)
          .filter(([, signature]) => signature !== null)
          .map(([address]) => address as Address),
        instructions: message.instructions,
      });
      return "1".repeat(64);
    },
  };
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += String(chunk)));
    request.on("end", () => {
      const { id, method, params } = JSON.parse(body) as { id: unknown; method: string; params: readonly unknown[] };
      asked.push({ method, params });
      const standard = () => {
        const answer = standards[method];
        if (!answer) throw new NodeError(-32601, `no ${method} here`);
        return answer(params);
      };
      let reply: object;
      try {
        reply = { result: (answers[method] ?? standard)(params, standard) };
      } catch (error) {
        if (!(error instanceof NodeError)) throw error;
        reply = { error: { code: error.code, message: error.message } };
      }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ jsonrpc: "2.0", id, ...reply }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return { rpc: createSolanaRpc(`http://127.0.0.1:${(server.address() as AddressInfo).port}`), asked, sent };
}

/** An account as `getAccountInfo` and `getProgramAccounts` give it, in base64. */
const account = (data: ReadonlyUint8Array, owner: Address) => ({
  data: [Buffer.from(data).toString("base64"), "base64"],
  executable: false,
  lamports: 4_088_560,
  owner,
  rentEpoch: 0,
  space: data.length,
});

/** A session of 100 s from 1,000 at 1000 base units a second (paid until 1,100), opened with `rentPayer` for `receiverAuthorizer`. */
const sessionBytes = (rentPayer: Address, receiverAuthorizer: Address, fields: Partial<SessionArgs> = {}) =>
  getSessionEncoder().encode({
    version: 1,
    bump: 255,
    authority: REFUND_OWNER,
    seed: 1n,
    mint: MINT,
    receiver: RECEIVER,
    receiverAuthorizer,
    refundOwner: REFUND_OWNER,
    rentPayer,
    rate: 1_000n,
    minSeconds: 5,
    maxSeconds: 300,
    startedAt: 1_000n,
    deposited: 100_000n,
    claimed: 0n,
    ...fields,
  });

/** A node's answer to `getProgramAccounts`: `sessions` by address. */
const listing = (sessions: [Address, ReadonlyUint8Array][]) => sessions.map(([pubkey, data]) => ({ pubkey, account: account(data, STINT_PROGRAM_ADDRESS) }));

/**
 * A node holding `sessions` by address, and the Clock sysvar, whose `unix_timestamp` is each value of `clock` in turn,
 * then the last one.
 */
function chainAnswers(sessions: Map<Address, ReadonlyUint8Array>, clock: bigint[]): Answers {
  let reads = 0;
  return {
    getAccountInfo: ([address]) => {
      if (address === SYSVAR_CLOCK_ADDRESS) {
        const unixTimestamp = clock[Math.min(reads++, clock.length - 1)]!;
        const data = getSysvarClockEncoder().encode({ slot: 1n, epochStartTimestamp: 0n, epoch: 0n, leaderScheduleEpoch: 0n, unixTimestamp } as never);
        return { context, value: account(data, SYSVAR_OWNER) };
      }
      const data = sessions.get(address as Address);
      return { context, value: data ? account(data, STINT_PROGRAM_ADDRESS) : null };
    },
  };
}

/** A decoded instruction: those these transactions carry all have accounts and data. */
const complete = (instruction: Instruction | undefined) =>
  instruction as Instruction & InstructionWithAccounts<readonly AccountMeta[]> & InstructionWithData<ReadonlyUint8Array>;

/** The address of each account an instruction names, by the name its parser gives it. */
const addresses = (accounts: Record<string, AccountMeta>) => Object.fromEntries(Object.entries(accounts).map(([name, meta]) => [name, meta.address]));

describe("the sessions the start-up finds", () => {
  it("asks for the program's sessions by size, discriminator and rent payer, the last where the session's layout keeps rent_payer", async () => {
    const stored = sessionBytes(RENT_PAYER, AUTHORIZER);
    const node = await fakeNode({ getProgramAccounts: () => listing([[SECOND, stored]]) });

    const found = await listSessionsOf(node.rpc, RENT_PAYER);

    expect(found).toEqual([{ address: SECOND, stored: expect.objectContaining({ rentPayer: RENT_PAYER, receiverAuthorizer: AUTHORIZER, startedAt: 1_000n, deposited: 100_000n }) }]);
    const [program, { filters }] = node.asked[0]!.params as [string, { filters: [{ dataSize: number }, { memcmp: { offset: number; bytes: string } }, { memcmp: { offset: number; bytes: string } }] }];
    expect(program).toBe(STINT_PROGRAM_ADDRESS);
    expect(filters[0].dataSize).toBe(stored.length);
    expect(filters[1].memcmp).toMatchObject({ offset: 0, bytes: getBase58Decoder().decode(SESSION_DISCRIMINATOR) });
    const { offset, bytes } = filters[2].memcmp;
    expect(bytes).toBe(RENT_PAYER);
    expect(stored.slice(offset, offset + 32)).toEqual(getAddressEncoder().encode(RENT_PAYER));
  });
});

describe("the start-up close", () => {
  const signers = async () => ({ funding: await generateKeyPairSigner(), authorizer: await generateKeyPairSigner() });

  it("closes a session still paid for in one transaction: both token accounts made, then a Standard close the receiver authorizer signs, its fee paid by the funding key", async () => {
    const { funding, authorizer } = await signers();
    const stored = sessionBytes(RENT_PAYER, authorizer.address);
    const scan = await fakeNode({ getProgramAccounts: () => listing([[SECOND, stored]]) });
    const node = await fakeNode(chainAnswers(new Map([[SECOND, stored]]), [1_050n]));

    await expect(closeLeftSessions(node.rpc, scan.rpc, funding, { rentPayer: RENT_PAYER, receiverAuthorizer: authorizer })).resolves.toEqual({ closed: [SECOND], failed: [] });

    // The sessions are listed on the scan node; each is read again, and closed, on the other.
    expect(scan.asked.map(({ method }) => method)).toEqual(["getProgramAccounts"]);
    expect(node.asked.map(({ method }) => method)).not.toContain("getProgramAccounts");
    expect(node.sent).toHaveLength(1);
    const [sent] = node.sent;
    expect(sent!.feePayer).toBe(funding.address);
    expect(new Set(sent!.signedBy)).toEqual(new Set([funding.address, authorizer.address]));
    expect(sent!.instructions).toHaveLength(3);
    const [receiverAccount, refundAccount, close] = sent!.instructions.map(complete);
    for (const [instruction, owner] of [
      [receiverAccount, RECEIVER],
      [refundAccount, REFUND_OWNER],
    ] as const) {
      expect(addresses(parseCreateAssociatedTokenIdempotentInstruction(instruction!).accounts)).toMatchObject({
        payer: funding.address,
        ata: await associatedTokenAddress(owner, MINT),
        owner,
        mint: MINT,
      });
    }
    const parsed = parseCloseInstruction(close!);
    expect(parsed.programAddress).toBe(STINT_PROGRAM_ADDRESS);
    expect(parsed.data.kind).toBe(CloseKind.Standard);
    expect(addresses(parsed.accounts)).toEqual({
      closer: authorizer.address,
      session: SECOND,
      vault: await associatedTokenAddress(SECOND, MINT),
      receiverToken: await associatedTokenAddress(RECEIVER, MINT),
      refundTo: await associatedTokenAddress(REFUND_OWNER, MINT),
      rentPayer: RENT_PAYER,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
      ...(await eventAccounts()),
    });
  });

  it("leaves a session that is gone, or whose paid time has run out, when it is read again", async () => {
    const { funding, authorizer } = await signers();
    const [gone, expired] = [sessionBytes(RENT_PAYER, authorizer.address), sessionBytes(RENT_PAYER, authorizer.address, { seed: 2n })];
    const scan = await fakeNode({ getProgramAccounts: () => listing([[FIRST, gone], [SECOND, expired]]) });
    // Paid for at the listing, on the chain's clock; at 1,100, when it is read again, it is the sweeper's.
    const node = await fakeNode(chainAnswers(new Map([[SECOND, expired]]), [1_050n, 1_100n]));

    await expect(closeLeftSessions(node.rpc, scan.rpc, funding, { rentPayer: RENT_PAYER, receiverAuthorizer: authorizer })).resolves.toEqual({ closed: [], failed: [] });
    expect(node.asked.map(({ method }) => method)).not.toContain("sendTransaction");
  });

  it("reports a close that fails, with the node's URLs cut to their hosts, and goes on to the next", async () => {
    const { funding, authorizer } = await signers();
    const [first, second] = [sessionBytes(RENT_PAYER, authorizer.address), sessionBytes(RENT_PAYER, authorizer.address, { seed: 2n })];
    const scan = await fakeNode({ getProgramAccounts: () => listing([[FIRST, first], [SECOND, second]]) });
    let sends = 0;
    const node = await fakeNode({
      ...chainAnswers(
        new Map([
          [FIRST, first],
          [SECOND, second],
        ]),
        [1_050n],
      ),
      sendTransaction: (_, standard) => {
        if (sends++ === 0) throw new NodeError(-32603, `upstream https://rpc.example.invalid/v2/${KEY} timed out`);
        return standard();
      },
    });

    const report = await closeLeftSessions(node.rpc, scan.rpc, funding, { rentPayer: RENT_PAYER, receiverAuthorizer: authorizer });

    expect(report.closed).toEqual([SECOND]);
    expect(report.failed).toEqual([{ session: FIRST, error: expect.stringContaining("https://rpc.example.invalid") }]);
    expect(report.failed[0]!.error).not.toContain(KEY);
    expect(report.failed[0]!.error).not.toContain("/v2/");
  });
});

describe("the SOL and token accounts the start-up provides", () => {
  it("sends what brings a key up to its target, from the key that pays the fee", async () => {
    const from = await generateKeyPairSigner();
    const node = await fakeNode({ getBalance: () => ({ context, value: 30_000_000 }) });

    await expect(topUpSol(node.rpc, from, RECEIVER, 50_000_000n)).resolves.toBe(20_000_000n);

    expect(node.sent).toHaveLength(1);
    expect(node.sent[0]!.feePayer).toBe(from.address);
    const transfer = parseTransferSolInstruction(complete(node.sent[0]!.instructions[0]));
    expect(addresses(transfer.accounts)).toEqual({ source: from.address, destination: RECEIVER });
    expect(transfer.data.amount).toBe(20_000_000n);
  });

  it("sends nothing to a key that holds its target", async () => {
    const node = await fakeNode({ getBalance: () => ({ context, value: 50_000_000 }) });
    await expect(topUpSol(node.rpc, await generateKeyPairSigner(), RECEIVER, 50_000_000n)).resolves.toBe(0n);
    expect(node.asked.map(({ method }) => method)).toEqual(["getBalance"]);
  });

  it("makes the owner's token account when it is missing, and gives its address", async () => {
    const payer = await generateKeyPairSigner();
    const node = await fakeNode({ getAccountInfo: () => ({ context, value: null }) });

    await expect(ensureTokenAccount(node.rpc, payer, RECEIVER, MINT)).resolves.toBe(await associatedTokenAddress(RECEIVER, MINT));

    expect(node.sent).toHaveLength(1);
    expect(addresses(parseCreateAssociatedTokenIdempotentInstruction(complete(node.sent[0]!.instructions[0])).accounts)).toMatchObject({
      payer: payer.address,
      ata: await associatedTokenAddress(RECEIVER, MINT),
      owner: RECEIVER,
      mint: MINT,
    });
  });

  it("leaves a token account that exists alone", async () => {
    const node = await fakeNode({ getAccountInfo: () => ({ context, value: account(new Uint8Array(165), TOKEN_PROGRAM_ADDRESS) }) });
    await expect(ensureTokenAccount(node.rpc, await generateKeyPairSigner(), RECEIVER, MINT)).resolves.toBe(await associatedTokenAddress(RECEIVER, MINT));
    expect(node.asked.map(({ method }) => method)).toEqual(["getAccountInfo"]);
  });
});

describe("sending a transaction", () => {
  const transfer = async () => {
    const payer = await generateKeyPairSigner();
    return { payer, instruction: getTransferSolInstruction({ source: payer, destination: RECEIVER, amount: 1n }) };
  };

  it("throws, naming the transaction, when the node reports that it failed", async () => {
    const { payer, instruction } = await transfer();
    const node = await fakeNode({
      getSignatureStatuses: () => ({ context, value: [{ slot: 1, confirmations: 0, err: { InstructionError: [2, { Custom: 6005 }] }, confirmationStatus: "processed", status: { Err: null } }] }),
    });
    await expect(sendInstructions(node.rpc, payer, [instruction])).rejects.toThrow(/^Transaction \w+ failed: .*InstructionError.*6005/);
  });

  it("throws when the transaction is not confirmed in time", async () => {
    const { payer, instruction } = await transfer();
    const node = await fakeNode({ getSignatureStatuses: () => ({ context, value: [null] }) });
    await expect(sendInstructions(node.rpc, payer, [instruction], 5, 50)).rejects.toThrow(/^Transaction \w+ was not confirmed within 50 ms$/);
  });
});
