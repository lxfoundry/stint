import { randomUUID } from "node:crypto";
import {
  createSignableMessage,
  getPublicKeyFromAddress,
  verifySignature,
  type Address,
  type MessagePartialSigner,
  type SignatureBytes,
} from "@solana/kit";

export type TokenPurpose = "connect" | "close";

/** The claims of spec §7.2. Times are in seconds. */
export interface SessionTokenClaims {
  readonly sub: string;
  readonly aud: string;
  readonly purpose: TokenPurpose;
  readonly iat: number;
  readonly exp: number;
  readonly jti: string;
}

export interface TokenOptions {
  readonly nowMs?: number;
  /** At most 120 s (spec §7.2). Default 60. */
  readonly lifetimeSeconds?: number;
  /** Clients emit `Ed25519` (RFC 9864); `EdDSA` exists for testing the gate's acceptance of it. */
  readonly alg?: "Ed25519" | "EdDSA";
}

const MAX_LIFETIME_SECONDS = 120;
const SKEW_SECONDS = 30;
const encoder = new TextEncoder();
const base64url = (bytes: Uint8Array | string) => Buffer.from(bytes).toString("base64url");

/** A JWS signed by the session's authority over the raw signing input, with no envelope. */
export async function createSessionToken(
  signer: MessagePartialSigner,
  claims: { readonly session: string; readonly audience: string; readonly purpose: TokenPurpose },
  options: TokenOptions = {},
): Promise<string> {
  const iat = Math.floor((options.nowMs ?? Date.now()) / 1000);
  const payload: SessionTokenClaims = {
    sub: claims.session,
    aud: claims.audience,
    purpose: claims.purpose,
    iat,
    exp: iat + (options.lifetimeSeconds ?? 60),
    jti: randomUUID(),
  };
  const signingInput = `${base64url(JSON.stringify({ alg: options.alg ?? "Ed25519", typ: "JWT" }))}.${base64url(JSON.stringify(payload))}`;
  const [signatures] = await signer.signMessages([createSignableMessage(encoder.encode(signingInput))]);
  const signature = signatures?.[signer.address];
  if (!signature) throw new Error("The signer returned no signature");
  return `${signingInput}.${base64url(signature)}`;
}

export interface ExpectedToken {
  readonly authority: Address;
  readonly session: string;
  readonly audience: string;
  readonly purpose: TokenPurpose;
  /** The gate's token clock (spec §7.3). */
  readonly nowMs: number;
}

export type TokenCheck =
  | { readonly ok: true; readonly claims: SessionTokenClaims }
  | { readonly ok: false; readonly reason: string };

const fail = (reason: string): TokenCheck => ({ ok: false, reason });

function parseJson(segment: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** Checks 1 and 2 of spec §7.2: the signature, `sub`, `aud`, `purpose` and the times. */
export async function verifySessionToken(token: string, expected: ExpectedToken): Promise<TokenCheck> {
  const parts = token.split(".");
  if (parts.length !== 3) return fail("malformed");
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
  const header = parseJson(headerPart);
  const claims = parseJson(payloadPart);
  if (!header || !claims) return fail("malformed");
  if (header.alg !== "Ed25519" && header.alg !== "EdDSA") return fail("unsupported algorithm");

  const signature = Buffer.from(signaturePart, "base64url");
  if (signature.length !== 64) return fail("bad signature");
  const key = await getPublicKeyFromAddress(expected.authority);
  const signed = encoder.encode(`${headerPart}.${payloadPart}`);
  if (!(await verifySignature(key, Uint8Array.from(signature) as SignatureBytes, signed))) return fail("bad signature");

  const { sub, aud, purpose, iat, exp, jti } = claims;
  if (sub !== expected.session) return fail("wrong session");
  if (aud !== expected.audience) return fail("wrong audience");
  if (purpose !== expected.purpose) return fail("wrong purpose");
  if (typeof jti !== "string" || jti.length === 0) return fail("missing jti");
  if (!Number.isInteger(iat) || !Number.isInteger(exp)) return fail("missing times");
  const now = Math.floor(expected.nowMs / 1000);
  if ((exp as number) - (iat as number) > MAX_LIFETIME_SECONDS) return fail("lifetime too long");
  if ((iat as number) > now + SKEW_SECONDS) return fail("issued in the future");
  if ((exp as number) < now - SKEW_SECONDS) return fail("expired");
  return { ok: true, claims: claims as unknown as SessionTokenClaims };
}
