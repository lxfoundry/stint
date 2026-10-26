import { generateKeyPairSigner, type KeyPairSigner } from "@solana/kit";
import { beforeAll, describe, expect, it } from "vitest";
import { createSessionToken, verifySessionToken } from "../src/index.js";

const session = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const audience = "http://127.0.0.1:4000";
const now = 1_800_000_000_000;

describe("session tokens (spec §7.2)", () => {
  let authority: KeyPairSigner;
  const expected = (overrides: object = {}) => ({
    authority: authority.address,
    session,
    audience,
    purpose: "connect" as const,
    nowMs: now,
    ...overrides,
  });

  beforeAll(async () => {
    authority = await generateKeyPairSigner();
  });

  it("verifies a token signed by the session's authority", async () => {
    const token = await createSessionToken(authority, { session, audience, purpose: "connect" }, { nowMs: now });
    const check = await verifySessionToken(token, expected());
    expect(check.ok).toBe(true);
    if (check.ok) expect(check.claims).toMatchObject({ sub: session, aud: audience, purpose: "connect" });
  });

  it("accepts the older EdDSA algorithm name", async () => {
    const token = await createSessionToken(authority, { session, audience, purpose: "connect" }, { nowMs: now, alg: "EdDSA" });
    expect((await verifySessionToken(token, expected())).ok).toBe(true);
  });

  it.each([
    ["another signer", async () => createSessionToken(await generateKeyPairSigner(), { session, audience, purpose: "connect" }, { nowMs: now })],
    ["another purpose", () => createSessionToken(authority, { session, audience, purpose: "close" }, { nowMs: now })],
    ["another audience", () => createSessionToken(authority, { session, audience: "http://other", purpose: "connect" }, { nowMs: now })],
    ["another session", () => createSessionToken(authority, { session: authority.address, audience, purpose: "connect" }, { nowMs: now })],
    ["an expired token", () => createSessionToken(authority, { session, audience, purpose: "connect" }, { nowMs: now - 200_000 })],
    ["a lifetime above 120 s", () => createSessionToken(authority, { session, audience, purpose: "connect" }, { nowMs: now, lifetimeSeconds: 121 })],
  ])("refuses %s", async (_, make) => {
    expect((await verifySessionToken(await make(), expected())).ok).toBe(false);
  });

  it("allows 30 s of clock skew on iat and exp", async () => {
    const ahead = await createSessionToken(authority, { session, audience, purpose: "connect" }, { nowMs: now + 25_000 });
    expect((await verifySessionToken(ahead, expected())).ok).toBe(true);
    const tooFar = await createSessionToken(authority, { session, audience, purpose: "connect" }, { nowMs: now + 40_000 });
    expect((await verifySessionToken(tooFar, expected())).ok).toBe(false);
  });

  it("refuses a malformed token", async () => {
    expect((await verifySessionToken("a.b", expected())).ok).toBe(false);
    expect((await verifySessionToken("a.b.c", expected())).ok).toBe(false);
  });
});
