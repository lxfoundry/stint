import { describe, expect, it } from "vitest";
import { redactUrls } from "../src/redact.js";

const KEYED = "https://devnet.provider.example/v2/SECRETKEY?api-key=SECRETKEY";

describe("redactUrls", () => {
  it("reduces every URL to its scheme and host, in a text of any shape", () => {
    expect(redactUrls(`error sending request for url (${KEYED}): timed out`)).toBe(
      "error sending request for url (https://devnet.provider.example): timed out",
    );
    expect(redactUrls("wss://user:pw@ws.example:8900/path?k=SECRETKEY and http://127.0.0.1:8899")).toBe("wss://ws.example:8900 and http://127.0.0.1:8899");
    expect(redactUrls("no url here")).toBe("no url here");
  });

  it("keeps a port, and takes the credentials, a path, a query or a fragment off a host", () => {
    expect(redactUrls("https://u:p@a.example:8899")).toBe("https://a.example:8899");
    expect(redactUrls("https://a.example?api-key=SECRETKEY")).toBe("https://a.example");
    expect(redactUrls("https://a.example#SECRETKEY")).toBe("https://a.example");
  });

  it("redacts a URL that follows a word character, as a log line or an identifier can put it", () => {
    expect(redactUrls("rpc_https://a.example/SECRETKEY")).toBe("rpc_https://a.example");
    expect(redactUrls("9https://a.example/SECRETKEY")).toBe("9https://a.example");
  });

  it("redacts a URL whatever the case of its scheme", () => {
    expect(redactUrls("HTTPS://A.EXAMPLE/SECRETKEY")).toBe("HTTPS://A.EXAMPLE");
  });

  it("reads a backslash as a URL parser does, as the end of the host like a slash", () => {
    expect(redactUrls("https://a.example\\SECRETKEY")).toBe("https://a.example");
  });

  it("redacts every URL when a text has several, one inside quotes or brackets", () => {
    expect(redactUrls(`{"url":"${KEYED}","fallback":"http://b.example/SECRETKEY"} [see <https://c.example/SECRETKEY>]`)).toBe(
      '{"url":"https://devnet.provider.example","fallback":"http://b.example"} [see <https://c.example>]',
    );
  });
});
