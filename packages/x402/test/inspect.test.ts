import { generateKeyPairSigner, getBase64Decoder, getBase64Encoder } from "@solana/kit";
import { beforeAll, describe, expect, it } from "vitest";
import { buildOpenOffer, buildOpenTransaction, inspectTransaction } from "../src/index.js";
import { offerInput } from "./fixtures.js";

describe("inspectTransaction (spec §5.5: a message has one hash)", () => {
  let wire: string;

  beforeAll(async () => {
    const authority = await generateKeyPairSigner();
    wire = (await buildOpenTransaction({ requirements: buildOpenOffer(offerInput()), authority, decimals: 6 })).transaction;
  });

  it("decodes a transaction built by the scheme, and hashes its message", () => {
    const tx = inspectTransaction(wire);
    expect(tx?.messageHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses a wire with bytes after the message, which would decode to the same instructions under another hash", () => {
    const bytes = getBase64Encoder().encode(wire);
    const padded = getBase64Decoder().decode(Uint8Array.from([...bytes, 0]));
    expect(inspectTransaction(padded)).toBeUndefined();
  });
});
