import { getBase58Decoder, type Address } from "@solana/kit";
import { SOLANA_DEVNET, USDC_DEVNET, buildOpenOffer, buildTopUpOffer, type ElapsedRequirements } from "@lxfoundry/stint-x402";

export const PROGRAM = "5iCYPqLjCWw5KzQTU6NBUhR2hxg5SWGmS1ctUn3qESvr";
export const GATE = "https://gate.example";
// Valid addresses that stand in for the seller, the facilitator's keys, a session and the agent's USDC account.
export const SELLER = "SysvarRent111111111111111111111111111111111" as Address;
export const FEE_PAYER = "SysvarC1ock11111111111111111111111111111111" as Address;
export const RENT_PAYER = "SysvarEpochSchedu1e111111111111111111111111" as Address;
export const RECEIVER_AUTHORIZER = "Stake11111111111111111111111111111111111111" as Address;
export const SESSION = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDyLb" as Address;
export const AGENT_USDC = "So11111111111111111111111111111111111111112";

/** A transaction signature: 64 bytes of `fill`, in base58. */
export const signatureOf = (fill: number): string => getBase58Decoder().decode(new Uint8Array(64).fill(fill));

/** The example seller's 100 s entry, as its gate builds it: an open, or a top-up of `SESSION`. */
export function offer(action: "open" | "topUp"): ElapsedRequirements {
  const input = {
    network: SOLANA_DEVNET,
    asset: USDC_DEVNET.mint,
    payTo: SELLER,
    receiverAuthorizer: RECEIVER_AUTHORIZER,
    terms: { rate: 1_000n, minSeconds: 5, maxSeconds: 1_000 },
    seconds: 100,
    facilitator: { feePayer: FEE_PAYER, rentPayer: RENT_PAYER, programId: PROGRAM, closeUrl: "http://127.0.0.1:9/close" },
    lifetime: { blockhash: "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N", lastValidBlockHeight: 100n },
    maxTimeoutSeconds: 30,
    idleCloseSeconds: 30,
    closeOnOutage: true,
  };
  return action === "open" ? buildOpenOffer(input) : buildTopUpOffer({ ...input, session: SESSION });
}
