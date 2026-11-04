import {
  address,
  appendTransactionMessageInstructions,
  blockhash,
  createNoopSigner,
  createTransactionMessage,
  fetchEncodedAccount,
  getBase64EncodedWireTransaction,
  partiallySignTransactionMessageWithSigners,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Instruction,
  type KeyPairSigner,
} from "@solana/kit";
import {
  HEADERS,
  USDC_DEVNET,
  X402_VERSION,
  associatedTokenAddress,
  buildOpenTransaction,
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  encodePaymentSignatureHeader,
  inspectTransaction,
  readElapsedRequirements,
  type ElapsedRequirements,
  type PaymentPayload,
  type PaymentRequired,
  type PaymentRequirements,
  type SettleResponse,
} from "@lxfoundry/stint-x402";
import { expectEqual, expectTrue } from "./assert.js";
import type { Buyer, ScenarioContext } from "./types.js";

/** The gate's offers for an open, read from its 402 as a client reads them (spec §5.1), and the first open entry. */
export async function openOffers(
  gateUrl: string,
  seconds?: number,
): Promise<{ readonly required: PaymentRequired; readonly offer: ElapsedRequirements }> {
  const response = await fetch(`${gateUrl}/sessions${seconds === undefined ? "" : `?seconds=${seconds}`}`, { method: "POST" });
  await response.body?.cancel();
  expectEqual(response.status, 402, "the gate answers an open without a payment with 402");
  const header = response.headers.get(HEADERS.paymentRequired);
  expectTrue(header, "the 402 carries its offers in PAYMENT-REQUIRED");
  const required = decodePaymentRequiredHeader(header) as PaymentRequired;
  const offer = required.accepts.map(readElapsedRequirements).find((entry) => entry?.extra.action === "open");
  expectTrue(offer, "the 402 offers an elapsed open");
  return { required, offer };
}

/** The open route for the entry's duration, which the gate then offers alone (spec §5.2). */
export const openUrl = (gateUrl: string, offer: ElapsedRequirements) => `${gateUrl}/sessions?seconds=${offer.extra.seconds}`;

/** What a scenario changes in a payment that the client would build otherwise. */
export interface OpenPaymentOptions {
  /** What the transaction is built from, when it is not the offer: a payment that does not match the entry it accepts. */
  readonly buildFrom?: ElapsedRequirements;
  /** Instructions added after `stint.open`, outside the layout of spec §5.3. */
  readonly append?: readonly Instruction[];
  /** The `accepted` echo, when it is not the offer exactly as received. */
  readonly accepted?: PaymentRequirements;
  /** The payload's `x402Version`, when it is not 2. */
  readonly x402Version?: number;
}

export interface OpenPayment {
  readonly payload: PaymentPayload;
  /** The `PAYMENT-SIGNATURE` header that carries it. */
  readonly header: string;
  /** The session the transaction's `stint.open` creates, and its vault. */
  readonly session: Address;
  readonly vault: Address;
}

/**
 * `wire` with `extra` added after its instructions, signed again by `signer`: what a buyer that adds an instruction of its
 * own sends. The other signers' slots stay empty, as the facilitator's are in any payment.
 */
export async function appendInstructions(wire: string, signer: KeyPairSigner, extra: readonly Instruction[]): Promise<string> {
  const tx = inspectTransaction(wire);
  if (!tx) throw new Error("Not a version 0 transaction");
  // One signer object per address, as the scheme's builder has: the rent payer appears in two instructions.
  const noop = new Map<Address, ReturnType<typeof createNoopSigner>>();
  const signerFor = (account: Address) => {
    if (account === signer.address) return signer;
    let found = noop.get(account);
    if (!found) noop.set(account, (found = createNoopSigner(account)));
    return found;
  };
  const instructions = tx.instructions.map((instruction) => ({
    ...instruction,
    accounts: instruction.accounts?.map((meta) => (tx.signers.includes(meta.address) ? { ...meta, signer: signerFor(meta.address) } : meta)),
  }));
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(tx.feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: blockhash(tx.blockhash), lastValidBlockHeight: 0n }, m),
    (m) => appendTransactionMessageInstructions([...(instructions as Instruction[]), ...extra], m),
  );
  return getBase64EncodedWireTransaction(await partiallySignTransactionMessageWithSigners(message));
}

/**
 * A payment for an open, built and signed by `buyer` as the session client builds one (spec §5.3, §9.3), with the
 * scenario's changes. Without options it is exactly what the client sends for `offer`.
 */
export async function openPayment(
  buyer: Buyer,
  required: PaymentRequired,
  offer: ElapsedRequirements,
  options: OpenPaymentOptions = {},
): Promise<OpenPayment> {
  const from = options.buildFrom ?? offer;
  const built = await buildOpenTransaction({ requirements: from, authority: buyer.signer, decimals: USDC_DEVNET.decimals });
  const transaction = options.append ? await appendInstructions(built.transaction, buyer.signer, options.append) : built.transaction;
  const payload: PaymentPayload = {
    x402Version: options.x402Version ?? X402_VERSION,
    resource: required.resource,
    accepted: options.accepted ?? offer,
    payload: { type: "open", transaction, session: built.session },
  };
  return {
    payload,
    header: encodePaymentSignatureHeader(payload),
    session: built.session,
    vault: await associatedTokenAddress(built.session, address(from.asset)),
  };
}

/** The gate's answer to a payment. */
export interface GateAnswer {
  readonly status: number;
  readonly body: Record<string, unknown>;
  /** The decoded `PAYMENT-RESPONSE` header, when the answer carries one. */
  readonly paymentResponse?: SettleResponse;
}

/** Sends a payment, in its `PAYMENT-SIGNATURE` header, to one of the gate's payment routes. */
export async function sendPayment(url: string, header: string): Promise<GateAnswer> {
  const response = await fetch(url, { method: "POST", headers: { [HEADERS.paymentSignature]: header } });
  const settled = response.headers.get(HEADERS.paymentResponse);
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
    ...(settled === null ? {} : { paymentResponse: decodePaymentResponseHeader(settled) }),
  };
}

/** Checks that the gate refused a payment with 402 and `reason` (spec §7.1, §11). */
export function expectRefused(answer: GateAnswer, reason: string, what: string): void {
  expectEqual(answer.status, 402, `${what}: refused with 402`);
  expectEqual(answer.body.error, reason, `${what}: refused as ${reason}`);
}

/** Checks that neither the session nor its vault exists: nothing of a refused, or merely verified, payment reached the chain. */
export async function expectNoSession(
  context: ScenarioContext,
  payment: Pick<OpenPayment, "session" | "vault">,
  what: string,
): Promise<void> {
  const [session, vault] = await Promise.all([
    fetchEncodedAccount(context.rpc, payment.session, { commitment: "confirmed" }),
    fetchEncodedAccount(context.rpc, payment.vault, { commitment: "confirmed" }),
  ]);
  expectTrue(!session.exists, `${what}: no session account on-chain`);
  expectTrue(!vault.exists, `${what}: no vault on-chain`);
}
