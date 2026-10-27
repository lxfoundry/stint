import { createSignableMessage, generateKeyPairSigner, type KeyPairSigner } from "@solana/kit";
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

  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const segments = (token: string) => token.split(".") as [string, string, string];

  it("refuses a payload changed after signing, with the header and signature of a valid token", async () => {
    const token = await createSessionToken(authority, { session, audience, purpose: "connect" }, { nowMs: now });
    const [header, payload, signature] = segments(token);
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
    const tampered = `${header}.${encode({ ...claims, purpose: "close" })}.${signature}`;
    expect(await verifySessionToken(tampered, expected({ purpose: "close" }))).toEqual({ ok: false, reason: "bad signature" });
  });

  it.each(["none", "HS256", "ES256", "ed25519", ""])("refuses the algorithm %j", async (alg) => {
    const token = await createSessionToken(authority, { session, audience, purpose: "connect" }, { nowMs: now });
    const [, payload, signature] = segments(token);
    expect(await verifySessionToken(`${encode({ alg, typ: "JWT" })}.${payload}.${signature}`, expected())).toEqual({
      ok: false,
      reason: "unsupported algorithm",
    });
  });

  it("refuses an unsigned token with alg none", async () => {
    const token = await createSessionToken(authority, { session, audience, purpose: "connect" }, { nowMs: now });
    const [, payload] = segments(token);
    expect((await verifySessionToken(`${encode({ alg: "none" })}.${payload}.`, expected())).ok).toBe(false);
  });

  it("refuses a token with a missing or empty identifier", async () => {
    const token = await createSessionToken(authority, { session, audience, purpose: "connect" }, { nowMs: now });
    const [header, payload] = segments(token);
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
    const { jti: _jti, ...withoutJti } = claims;
    // Re-signed by the authority, so only the missing claim can be the reason.
    const resign = async (body: unknown) => {
      const input = `${header}.${encode(body)}`;
      const [signatures] = await authority.signMessages([createSignableMessage(new TextEncoder().encode(input))]);
      return `${input}.${Buffer.from(signatures![authority.address]!).toString("base64url")}`;
    };
    expect(await verifySessionToken(await resign(withoutJti), expected())).toEqual({ ok: false, reason: "missing jti" });
    expect(await verifySessionToken(await resign({ ...claims, jti: "" }), expected())).toEqual({ ok: false, reason: "missing jti" });
  });

  it("refuses a malformed token", async () => {
    expect((await verifySessionToken("a.b", expected())).ok).toBe(false);
    expect((await verifySessionToken("a.b.c", expected())).ok).toBe(false);
  });
});
