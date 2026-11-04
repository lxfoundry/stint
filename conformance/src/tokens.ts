import type { Address, KeyPairSigner } from "@solana/kit";
import { createSessionToken, type TokenOptions, type TokenPurpose } from "@lxfoundry/stint-x402";
import { WebSocket } from "ws";

/**
 * A session token for `session` signed by `signer` (spec §7.2), as the session client signs one: `aud` is the gate's
 * origin unless `audience` names another, and `nowMs` and `lifetimeSeconds` set its times.
 */
export function tokenFor(
  signer: KeyPairSigner,
  gateUrl: string,
  session: Address,
  purpose: TokenPurpose,
  options: TokenOptions & { readonly audience?: string } = {},
): Promise<string> {
  const { audience = new URL(gateUrl).origin, ...times } = options;
  return createSessionToken(signer, { session, audience, purpose }, times);
}

/** The gate's answer to a WebSocket connect (spec §7.1): the open socket on `101`, or the status of the refusal. */
export type ConnectAnswer = { readonly status: 101; readonly socket: WebSocket } | { readonly status: number; readonly socket?: undefined };

/** Connects to `session` through the gate, with `token` as a bearer in the `Authorization` header (spec §7.2). */
export function connectWith(gateUrl: string, session: Address, token?: string): Promise<ConnectAnswer> {
  const url = `${gateUrl.replace(/^http/, "ws")}/sessions/${session}/ws`;
  const socket = new WebSocket(url, token === undefined ? {} : { headers: { authorization: `Bearer ${token}` } });
  return new Promise((resolve, reject) => {
    socket.once("open", () => resolve({ status: 101, socket }));
    socket.once("unexpected-response", (_, response) => resolve({ status: response.statusCode ?? 0 }));
    socket.once("error", reject);
  });
}

/** The code `socket` is closed with, whichever side closes it. */
export function closeCodeOf(socket: WebSocket): Promise<number> {
  return new Promise((resolve) => socket.once("close", (code) => resolve(code)));
}

/** Asks the gate to close `session` with `token` as a bearer (spec §7.1), and returns its status and its body, as JSON when it is. */
export async function closeWith(gateUrl: string, session: Address, token: string): Promise<{ readonly status: number; readonly body: unknown }> {
  const response = await fetch(`${gateUrl}/sessions/${session}/close`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
  const text = await response.text();
  try {
    return { status: response.status, body: JSON.parse(text) as unknown };
  } catch {
    return { status: response.status, body: text };
  }
}
