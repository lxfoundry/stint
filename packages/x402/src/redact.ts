/**
 * Reduces every URL in a text to its scheme and host. An RPC URL can carry an API key in its path or query, and a
 * service that fails quotes the URL it called (Kora's HTTP client does); the host is enough to tell which
 * endpoint failed. Credentials in the authority go too.
 *
 * A scheme is found wherever it starts, even right after a word character, and a backslash ends the host as a
 * slash does, as a URL parser reads it. The URL's text runs to the next space, quote, bracket or parenthesis, so
 * whatever follows a key without one of those goes with it: a redactor errs on the side of cutting.
 */
export function redactUrls(text: string): string {
  return text.replace(/([a-z][a-z0-9+.-]*):\/\/([^\s"'<>)\]]+)/gi, (_match, scheme: string, rest: string) => {
    const authority = rest.split(/[/\\?#]/, 1)[0]!;
    return `${scheme}://${authority.slice(authority.lastIndexOf("@") + 1)}`;
  });
}
