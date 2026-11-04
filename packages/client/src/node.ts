import { createDefaultRpcTransport, createSolanaRpcFromTransport, type Rpc, type RpcTransport, type SolanaRpcApi } from "@solana/kit";
import { redactUrls } from "@lxfoundry/stint-x402";

/**
 * Whether `value` can be a node's URL (spec §9.1): an http or https URL that `URL` parses, as `fetch` will. A value with
 * a space in its host, no scheme or another scheme cannot. A problem never quotes the value: an RPC URL may carry an API
 * key.
 */
export function isNodeUrl(value: string): boolean {
  try {
    return /^https?:$/.test(new URL(value).protocol);
  } catch {
    return false;
  }
}

/** Shorter parts of a URL carry no key (`v2`, `rpc`), and hiding them would only garble a message. */
const SHORTEST_SECRET = 4;

/**
 * The parts of a node's URL that may carry a key: its user info, path segments, query values and fragment, as written
 * and decoded. For a URL that does not parse, the whole of it and each of its pieces between spaces.
 */
function secretParts(url: string): string[] {
  let raw: string[];
  try {
    const parsed = new URL(url);
    raw = [
      parsed.username,
      parsed.password,
      ...parsed.pathname.split("/"),
      ...parsed.search.slice(1).split("&").map((pair) => pair.slice(pair.indexOf("=") + 1)),
      parsed.hash.slice(1),
    ];
  } catch {
    raw = [url, ...url.split(/\s+/)];
  }
  const decoded = raw.map((part) => {
    try {
      return decodeURIComponent(part);
    } catch {
      return part;
    }
  });
  // Longest first, so that a part that holds another is hidden whole.
  return [...new Set([...raw, ...decoded])].filter((part) => part.length >= SHORTEST_SECRET).sort((a, b) => b.length - a.length);
}

/** `text` with every part of `url` that may carry a key hidden, wherever it appears, and every URL reduced to its scheme and host. */
export function hideNodeUrl(url: string, text: string): string {
  let hidden = text;
  for (const part of secretParts(url)) hidden = hidden.split(part).join("…");
  return redactUrls(hidden);
}

/**
 * A client of the node at `url` (spec §9.1) whose errors never carry what may be the URL's key. What the node answers in
 * a JSON-RPC error and what the transport throws go through `hideNodeUrl` before any caller sees them: a node can repeat
 * the key it was given ("invalid api key …"), and a failed request can quote its URL. `transport` is for tests.
 */
export function createNodeRpc(url: string, transport: RpcTransport = createDefaultRpcTransport({ url })): Rpc<SolanaRpcApi> {
  const hiding = (async (request: Parameters<RpcTransport>[0]) => {
    let response: unknown;
    try {
      response = await transport(request);
    } catch (error) {
      if (!(error instanceof Error)) throw new Error(hideNodeUrl(url, String(error)));
      error.message = hideNodeUrl(url, error.message);
      if (error.stack !== undefined) error.stack = hideNodeUrl(url, error.stack);
      throw error;
    }
    const answered = (response as { error?: { message?: unknown } } | null)?.error;
    if (answered && typeof answered.message === "string") answered.message = hideNodeUrl(url, answered.message);
    return response;
  }) as RpcTransport;
  return createSolanaRpcFromTransport(hiding);
}
