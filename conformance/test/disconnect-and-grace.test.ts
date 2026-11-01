import { STINT_PROGRAM_ADDRESS } from "@lxfoundry/stint-program-client";
import { SOLANA_DEVNET, USDC_DEVNET, buildCloseRequirements, buildOpenOffer, type PaymentRequired } from "@lxfoundry/stint-x402";
import { generateKeyPairSigner } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { idleCloseSecondsOf } from "../src/scenarios/09-disconnect-and-grace.js";

async function offers(idleCloseSeconds: number) {
  const [feePayer, rentPayer, payTo, receiverAuthorizer] = await Promise.all(
    Array.from({ length: 4 }, async () => (await generateKeyPairSigner()).address),
  );
  const base = {
    network: SOLANA_DEVNET,
    asset: USDC_DEVNET.mint,
    payTo: payTo!,
    receiverAuthorizer: receiverAuthorizer!,
    terms: { rate: 1_000n, minSeconds: 5, maxSeconds: 120 },
    facilitator: { feePayer: feePayer!, rentPayer: rentPayer!, programId: STINT_PROGRAM_ADDRESS, closeUrl: "http://127.0.0.1:1/close" },
    lifetime: { blockhash: "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N", lastValidBlockHeight: 100n },
    maxTimeoutSeconds: 30,
    idleCloseSeconds,
    closeOnOutage: true,
  };
  return {
    open: buildOpenOffer({ ...base, seconds: 30 }),
    close: buildCloseRequirements({ ...base, idleCloseSeconds: 99, session: payTo! }),
  };
}

const answer = (accepts: unknown[]) => ({ x402Version: 2, resource: { url: "http://127.0.0.1:1/sessions" }, accepts }) as PaymentRequired;

describe("idleCloseSecondsOf", () => {
  it("is the idle close of the first open offer", async () => {
    expect(idleCloseSecondsOf(answer([(await offers(7)).open]))).toBe(7);
  });

  it("skips entries that are not open offers", async () => {
    const { open, close } = await offers(7);
    expect(idleCloseSecondsOf(answer([{ scheme: "exact" }, close, open]))).toBe(7);
  });

  it("is nothing when there is no open offer", async () => {
    expect(idleCloseSecondsOf(answer([]))).toBeUndefined();
  });
});
