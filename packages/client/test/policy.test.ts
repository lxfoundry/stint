import { buildOpenOffer, type ElapsedRequirements } from "@lxfoundry/stint-x402";
import { address } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { checkOffer, type Policy } from "../src/index.js";

const signer = address("7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU");
const policy: Policy = { maxRate: 1_000n, maxPerSession: 100_000n, budget: { amount: 200_000n, periodSeconds: 3_600 } };

const offer: ElapsedRequirements = buildOpenOffer({
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
    closeUrl: "http://f/close",
  },
  lifetime: { blockhash: "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N", lastValidBlockHeight: 1n },
  maxTimeoutSeconds: 60,
  idleCloseSeconds: 10,
  closeOnOutage: true,
});

const withExtra = (extra: object): ElapsedRequirements => ({ ...offer, extra: { ...offer.extra, ...extra } });

describe("checkOffer (spec §9.2, §9.3)", () => {
  it("accepts an offer within every limit, with the asset's decimals", () => {
    expect(checkOffer(policy, offer, 30, 0n, signer)).toEqual({ ok: true, decimals: 6, amount: 30_000n });
  });

  it.each<[string, ElapsedRequirements, number, bigint, Policy?]>([
    ["another network", { ...offer, network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" }, 30, 0n],
    ["another program", withExtra({ programId: "11111111111111111111111111111111" }), 30, 0n],
    ["another asset", { ...offer, asset: "So11111111111111111111111111111111111111112" }, 30, 0n],
    ["a seller off the list", offer, 30, 0n, { ...policy, sellers: [address("11111111111111111111111111111111")] }],
    ["a rate above maxRate", withExtra({ rate: "1001" }), 30, 0n],
    ["a minimum above maxMinSeconds", withExtra({ minSeconds: 301, maxSeconds: 400 }), 30, 0n],
    ["another duration than requested", offer, 60, 0n],
    ["an amount that is not rate × seconds", { ...offer, amount: "30001" }, 30, 0n],
    ["more than maxPerSession", offer, 30, 0n, { ...policy, maxPerSession: 29_999n }],
    ["more than the period budget", offer, 30, 170_001n],
  ])("refuses %s", (_, candidate, requested, locked, override) => {
    expect(checkOffer(override ?? policy, candidate, requested, locked, signer).ok).toBe(false);
  });

  it.each([
    ["fee payer", { feePayer: signer }],
    ["rent payer", { rentPayer: signer }],
  ])("refuses an offer that names the client's own signer as the %s", (role, extra) => {
    expect(checkOffer(policy, withExtra(extra), 30, 0n, signer)).toEqual({
      ok: false,
      reason: `the offer names this client's own signer as the ${role}`,
    });
  });
});
