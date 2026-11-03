import {
  address,
  generateKeyPairSigner,
  getPublicKeyFromAddress,
  verifySignature,
  type KeyPairSigner,
} from "@solana/kit";
import { STINT_PROGRAM_ADDRESS, parseOpenInstruction } from "@lxfoundry/stint-program-client";
import { buildOpenOffer, decodePaymentSignatureHeader, inspectTransaction, type PaymentRequired } from "@lxfoundry/stint-x402";
import { beforeAll, describe, expect, it } from "vitest";
import { appendInstructions, openPayment } from "../src/payments.js";
import type { Buyer } from "../src/types.js";

const MEMO = address("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

describe("payments a scenario builds itself", () => {
  let signer: KeyPairSigner;
  let buyer: Buyer;
  let rentPayer: string;
  let feePayer: string;
  const offer = () =>
    buildOpenOffer({
      network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
      asset: address("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"),
      payTo: address("9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin"),
      receiverAuthorizer: address("Hq8i9ZoCdUuY6bEcUd5V2nhZqGPAiyxS5fTuQUe3tGLL"),
      terms: { rate: 1_000n, minSeconds: 5, maxSeconds: 120 },
      seconds: 30,
      facilitator: { feePayer, rentPayer, programId: STINT_PROGRAM_ADDRESS, closeUrl: "http://127.0.0.1:4021/close" },
      lifetime: { blockhash: "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N", lastValidBlockHeight: 1_234n },
      maxTimeoutSeconds: 60,
      idleCloseSeconds: 10,
      closeOnOutage: true,
    });
  const required = (entry: ReturnType<typeof offer>): PaymentRequired => ({ x402Version: 2, resource: { url: "http://gate.test/sessions" }, accepts: [entry] });

  beforeAll(async () => {
    signer = await generateKeyPairSigner();
    buyer = { signer, usdcAccount: address("9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin") };
    rentPayer = (await generateKeyPairSigner()).address;
    feePayer = (await generateKeyPairSigner()).address;
  });

  it("builds the payment a client builds, for the entry exactly as received, in its header", async () => {
    const entry = offer();
    const payment = await openPayment(buyer, required(entry), entry);
    expect(payment.payload).toMatchObject({ x402Version: 2, resource: { url: "http://gate.test/sessions" }, payload: { type: "open", session: payment.session } });
    expect(payment.payload.accepted).toBe(entry);
    expect(decodePaymentSignatureHeader(payment.header)).toEqual(payment.payload);
  });

  it("applies a scenario's changes: another version, another accepted entry, a transaction built from other terms", async () => {
    const entry = offer();
    const changed = { ...entry, extra: { ...entry.extra, closeUrl: "http://127.0.0.1:4021/closx" } };
    expect((await openPayment(buyer, required(entry), entry, { x402Version: 1 })).payload.x402Version).toBe(1);
    expect((await openPayment(buyer, required(entry), entry, { accepted: changed })).payload.accepted).toBe(changed);

    const otherRate = { ...entry, extra: { ...entry.extra, rate: "1001" } };
    const payment = await openPayment(buyer, required(entry), entry, { buildFrom: otherRate });
    expect(payment.payload.accepted).toBe(entry);
    const tx = inspectTransaction(payment.payload.payload.transaction as string)!;
    expect(parseOpenInstruction(tx.instructions[2] as never).data.rate).toBe(1_001n);
  });

  it("appends instructions after stint.open and signs again as the buyer, leaving the other signers' slots empty", async () => {
    const entry = offer();
    const payment = await openPayment(buyer, required(entry), entry);
    const wire = await appendInstructions(payment.payload.payload.transaction as string, signer, [
      { programAddress: MEMO, data: new TextEncoder().encode("stint") },
    ]);
    const tx = inspectTransaction(wire)!;
    expect(tx.instructions.map((ix) => ix.programAddress).at(-1)).toBe(MEMO);
    expect(tx.instructions).toHaveLength(4);
    const signature = tx.transaction.signatures[signer.address]!;
    expect(await verifySignature(await getPublicKeyFromAddress(signer.address), signature, tx.transaction.messageBytes)).toBe(true);
    expect(tx.transaction.signatures[address(rentPayer)]).toBeNull();
    expect(tx.transaction.signatures[address(feePayer)]).toBeNull();
  });
});
