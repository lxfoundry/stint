import { address } from "@solana/kit";
import type { OfferInput } from "../src/index.js";

export function offerInput(overrides: Partial<OfferInput> = {}): OfferInput {
  return {
    network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
    asset: address("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"),
    payTo: address("9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin"),
    receiverAuthorizer: address("Hq8i9ZoCdUuY6bEcUd5V2nhZqGPAiyxS5fTuQUe3tGLL"),
    terms: { rate: 1_000n, minSeconds: 5, maxSeconds: 120 },
    seconds: 30,
    facilitator: {
      feePayer: "SysvarC1ock11111111111111111111111111111111",
      rentPayer: "SysvarRent111111111111111111111111111111111",
      programId: "5iCYPqLjCWw5KzQTU6NBUhR2hxg5SWGmS1ctUn3qESvr",
      closeUrl: "http://127.0.0.1:4021/close",
    },
    lifetime: { blockhash: "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N", lastValidBlockHeight: 1_234n },
    maxTimeoutSeconds: 60,
    idleCloseSeconds: 10,
    closeOnOutage: true,
    ...overrides,
  };
}
