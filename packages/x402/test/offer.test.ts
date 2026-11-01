import { describe, expect, it } from "vitest";
import {
  amountFor,
  buildCloseRequirements,
  buildOpenOffer,
  buildTopUpOffer,
  checkOpenDuration,
  checkTopUpDuration,
  readElapsedRequirements,
  sameRequirements,
  sellerTermsOf,
} from "../src/index.js";
import { offerInput } from "./fixtures.js";

const input = offerInput();

describe("offers", () => {
  it("quotes the exact deposit, rate × seconds, as a decimal string (spec §5.1)", () => {
    expect(amountFor(1_000n, 30)).toBe(30_000n);
    const offer = buildOpenOffer(input);
    expect(offer).toEqual({
      scheme: "elapsed",
      network: input.network,
      amount: "30000",
      asset: input.asset,
      payTo: input.payTo,
      maxTimeoutSeconds: 60,
      extra: {
        paymentFlow: "escrow",
        action: "open",
        programId: input.facilitator.programId,
        rate: "1000",
        seconds: 30,
        minSeconds: 5,
        maxSeconds: 120,
        receiverAuthorizer: input.receiverAuthorizer,
        feePayer: input.facilitator.feePayer,
        rentPayer: input.facilitator.rentPayer,
        closeUrl: input.facilitator.closeUrl,
        recentBlockhash: input.lifetime.blockhash,
        lastValidBlockHeight: "1234",
        idleCloseSeconds: 10,
        closeOnOutage: true,
      },
    });
  });

  it("builds a close's requirements: amount 0, action close, the session set (spec §5.5)", () => {
    const { seconds: _, ...rest } = input;
    const requirements = buildCloseRequirements({ ...rest, session: input.payTo });
    expect(requirements.amount).toBe("0");
    expect(requirements.extra.action).toBe("close");
    expect(requirements.extra.session).toBe(input.payTo);
  });

  it("builds a top-up entry: the deposit for its seconds, action topUp, the session set (spec §5.1)", () => {
    const entry = buildTopUpOffer({ ...input, seconds: 12, session: input.payTo });
    expect(entry.amount).toBe("12000");
    expect(entry.extra).toMatchObject({ action: "topUp", session: input.payTo, seconds: 12, rate: "1000", minSeconds: 5, maxSeconds: 120 });
    expect(readElapsedRequirements(entry)).toEqual(entry);
  });

  it("accepts top-up durations from 1 to what maxSeconds leaves after the covered seconds, whatever minSeconds (spec §5.2)", () => {
    const terms = input.terms; // 5 to 120 s
    expect(checkTopUpDuration(terms, 30n, 1)).toEqual({ ok: true });
    expect(checkTopUpDuration(terms, 30n, 90)).toEqual({ ok: true });
    for (const seconds of [0, 91, 2.5, Number.NaN]) {
      expect(checkTopUpDuration(terms, 30n, seconds)).toEqual({ ok: false, minSeconds: 1, maxSeconds: 90 });
    }
    // A session paid for maxSeconds has no room left; nor has one paid for more, which an open never allows.
    expect(checkTopUpDuration(terms, 120n, 1)).toEqual({ ok: false, minSeconds: 1, maxSeconds: 0 });
    expect(checkTopUpDuration(terms, 121n, 1)).toEqual({ ok: false, minSeconds: 1, maxSeconds: 0 });
  });

  it("accepts open durations from minSeconds to maxSeconds only (spec §5.2)", () => {
    const terms = input.terms;
    expect(checkOpenDuration(terms, 5)).toEqual({ ok: true });
    expect(checkOpenDuration(terms, 120)).toEqual({ ok: true });
    for (const seconds of [4, 121, 7.5, Number.NaN]) {
      expect(checkOpenDuration(terms, seconds)).toEqual({ ok: false, minSeconds: 5, maxSeconds: 120 });
    }
  });

  it("reads an elapsed entry back, and rejects malformed ones", () => {
    const offer = buildOpenOffer(input);
    expect(readElapsedRequirements(JSON.parse(JSON.stringify(offer)))).toEqual(offer);
    expect(readElapsedRequirements({ ...offer, scheme: "exact" })).toBeUndefined();
    expect(readElapsedRequirements({ ...offer, extra: { ...offer.extra, rate: 1000 } })).toBeUndefined();
    expect(readElapsedRequirements({ ...offer, extra: { ...offer.extra, paymentFlow: "upfront" } })).toBeUndefined();
  });

  it("rejects an entry whose address fields are not addresses, instead of throwing later", () => {
    const offer = buildOpenOffer(input);
    expect(readElapsedRequirements({ ...offer, asset: "not base58 0OIl" })).toBeUndefined();
    expect(readElapsedRequirements({ ...offer, payTo: "short" })).toBeUndefined();
    for (const field of ["programId", "receiverAuthorizer", "feePayer", "rentPayer", "session"] as const) {
      expect(readElapsedRequirements({ ...offer, extra: { ...offer.extra, [field]: "0OIl" } })).toBeUndefined();
    }
  });

  it("compares requirements by value, whatever the key order", () => {
    const offer = buildOpenOffer(input);
    const reordered = JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(offer).reverse())));
    expect(sameRequirements(offer, reordered)).toBe(true);
    expect(sameRequirements(offer, { ...offer, amount: "30001" })).toBe(false);
  });

  it("extracts the seller's terms", () => {
    expect(sellerTermsOf(buildOpenOffer(input))).toEqual({
      programId: input.facilitator.programId,
      asset: input.asset,
      payTo: input.payTo,
      receiverAuthorizer: input.receiverAuthorizer,
      terms: input.terms,
    });
  });
});
