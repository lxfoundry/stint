import { address, signature as toSignature, type Address } from "@solana/kit";
import { fetchMaybeSession } from "@lxfoundry/stint-program-client";
import { createSessionTools, createStintClient, type SessionTools } from "@lxfoundry/stint-client";
import { associatedTokenAddress, lamportBalances, tokenBalanceChanges, type LamportBalance } from "@lxfoundry/stint-x402";
import { expectEqual, expectTrue, sleep } from "../assert.js";
import { readUntil } from "../reads.js";
import type { ScenarioContext } from "../types.js";

/** The stream's `account` message about a token account (spec §8), as the node sends it with `jsonParsed`. */
export interface AccountMessage {
  readonly type: "account";
  readonly address: string;
  /** A decimal string: the stream sends every u64 as one. */
  readonly slot: string;
  readonly encoding: "jsonParsed" | "base64";
  readonly data: { readonly parsed?: { readonly info?: { readonly tokenAmount?: { readonly amount?: string } } } };
}

/** The token amount in a stream message about the token account `account`, or undefined if it carries none. */
export function receivedAmount(message: unknown, account: string): bigint | undefined {
  const candidate = message as Partial<AccountMessage> | null;
  if (!candidate || candidate.type !== "account" || candidate.address !== account || candidate.encoding !== "jsonParsed") return undefined;
  const amount = candidate.data?.parsed?.info?.tokenAmount?.amount;
  return typeof amount === "string" ? BigInt(amount) : undefined;
}

/**
 * The rent assertion on a close: the session account and its vault end at zero, and the rent payer
 * gains exactly what they held. Everything comes from the close's own metadata. Returns the amount.
 */
export function assertRentReturned(
  balances: ReadonlyMap<Address, LamportBalance>,
  accounts: { readonly rentPayer: Address; readonly session: Address; readonly vault: Address },
): bigint {
  const read = (name: string, key: Address): LamportBalance => {
    const balance = balances.get(key);
    if (!balance) throw new Error(`${name} ${key} is not in the transaction`);
    return balance;
  };
  const rentPayer = read("rent payer", accounts.rentPayer);
  const session = read("session", accounts.session);
  const vault = read("vault", accounts.vault);
  const held = session.pre + vault.pre;
  if (held === 0n) throw new Error("The session and its vault held no lamports before the close");
  if (session.post !== 0n || vault.post !== 0n) throw new Error("The session or its vault still holds lamports after the close");
  if (rentPayer.post - rentPayer.pre !== held) {
    throw new Error(`The rent payer gained ${rentPayer.post - rentPayer.pre} lamports, expected ${held}`);
  }
  return held;
}

/** Calls `stint_receive` until a message about `account` carries `amount`; messages about other changes are skipped. */
async function awaitPayment(tools: SessionTools["tools"], sessionId: string, account: Address, amount: bigint): Promise<AccountMessage> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const { messages } = await tools.stint_receive.run({
      sessionId,
      timeoutSeconds: 5,
      match: { type: "account", address: account },
    });
    for (const message of messages) if (receivedAmount(message, account) === amount) return message as AccountMessage;
  }
  throw new Error(`No message about ${account} carried ${amount} within 20 s`);
}

/**
 * Scenario 22 (spec §12.7): the example agent's task, scripted. The agent opens a session, watches a
 * token account, learns of a payment to it, and closes. `paid` and `refunded` equal what the session's
 * close transferred; the session is closed and its rent returned to the rent payer.
 */
export async function exampleAgentTask(context: ScenarioContext): Promise<void> {
  const agent = await context.newBuyer(1_000_000n);
  const payer = await context.newBuyer(500_000n);
  // The watched account exists before the subscription: the node then sends one message per change.
  const watched = await context.newBuyer(0n);
  const client = createStintClient({
    signer: agent.signer,
    policy: { maxRate: 10_000n, maxPerSession: 1_000_000n, budget: { amount: 1_000_000n, periodSeconds: 3_600 } },
  });
  const { tools, closeCode } = createSessionTools(client);

  const opened = await tools.stint_open_session.run({ url: context.gateUrl, seconds: 30, reason: "conformance scenario 22" });
  const session = address(opened.sessionId);
  const readSession = () => fetchMaybeSession(context.rpc, session, { commitment: "confirmed" });
  const account = await readUntil(context.readRetry, readSession, (read) => read.exists);
  expectTrue(account.exists, "the session exists on-chain after the open");
  const stored = account.data;
  const deposit = BigInt(opened.cost);
  const vault = await associatedTokenAddress(session, stored.mint);

  await tools.stint_send.run({ sessionId: opened.sessionId, message: { op: "subscribe", accounts: [watched.usdcAccount] } });
  await sleep(context.subscriptionSettleMs); // the subscription is in place before the payment

  const payment = 250_000n;
  const paymentSignature = await context.sendUsdc(payer, watched.usdcAccount, payment);
  const message = await awaitPayment(tools, opened.sessionId, watched.usdcAccount, payment);

  if (context.target.name === "devnet") {
    // A real network reports the slot of the change; the local network reports the subscription's (T6).
    const transaction = await readUntil(
      context.readRetry,
      () =>
        context.rpc
          .getTransaction(toSignature(paymentSignature), { commitment: "confirmed", encoding: "json", maxSupportedTransactionVersion: 0 })
          .send(),
      (read) => read !== null,
    );
    expectTrue(transaction, "the payment is on-chain");
    expectTrue(BigInt(message.slot) >= transaction.slot, "the message's slot is at or after the payment's slot");
  }

  const receipt = await tools.stint_close_session.run({ sessionId: opened.sessionId });
  expectTrue(receipt.paid !== undefined && receipt.refunded !== undefined, "the gate reported the close's amounts");
  const changes = await tokenBalanceChanges(context.rpc, receipt.transaction, context.readRetry);
  const receiverToken = await associatedTokenAddress(stored.receiver, stored.mint);
  // `paid` is claimed + owed + redirected (spec §5.5). The scenario makes no claim, so `claimed` is zero and the
  // receiver's whole gain is in the close; a claim made earlier would have to be added to the close's gain.
  expectEqual(BigInt(receipt.paid), changes.get(receiverToken) ?? 0n, "paid = what the receiver gained in the close");
  expectEqual(BigInt(receipt.refunded), changes.get(agent.usdcAccount) ?? 0n, "refunded = what the buyer gained in the close");
  expectEqual(BigInt(receipt.paid) + BigInt(receipt.refunded), deposit, "paid + refunded = the deposit");

  assertRentReturned(await lamportBalances(context.rpc, receipt.transaction, context.readRetry), { rentPayer: stored.rentPayer, session, vault });
  expectTrue(!(await readUntil(context.readRetry, readSession, (read) => !read.exists)).exists, "the session account is closed");
  expectEqual(await waitForClose(() => closeCode(opened.sessionId)), 4410, "the connection is dropped with 4410");
}

/** Polls a close code for up to 5 s. */
async function waitForClose(read: () => number | undefined): Promise<number | undefined> {
  const deadline = Date.now() + 5_000;
  while (read() === undefined && Date.now() < deadline) await sleep(100);
  return read();
}
