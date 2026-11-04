import { describe, expect, it } from "vitest";
import { LATEST_RELEASE_URL, LIVE_DEMO_GUIDE_URL, REPOSITORY_URL, landingPage, usdc } from "../src/landing.js";
import { sellerLandingPage } from "../src/seller.js";

const PROGRAM = "5iCYPqLjCWw5KzQTU6NBUhR2hxg5SWGmS1ctUn3qESvr";

describe("usdc", () => {
  it("writes base units as USDC with at least three decimals", () => {
    expect(usdc(1_000n)).toBe("0.001");
    expect(usdc(100_000n)).toBe("0.100");
    expect(usdc(1_234_567n)).toBe("1.234567");
    expect(usdc(2_000_000n)).toBe("2.000");
    expect(usdc(0n)).toBe("0.000");
  });
});

describe("the seller's landing page", () => {
  const page = sellerLandingPage("https://stint-demo.lxfoundry.ai");

  it("states the offer the seller makes, from its own settings", () => {
    expect(page).toContain("0.001 USDC a second (1000 base units of devnet USDC)");
    expect(page).toContain("from 5 s to 1000 s; 100 s (0.100 USDC) when a request names no duration");
    expect(page).toContain("after 30 s, the gate closes the session");
    expect(page).toContain("curl -i -X POST https://stint-demo.lxfoundry.ai/sessions");
  });

  it("links to the release, the live demo guide, the repository and the program on devnet's Explorer", () => {
    expect(page).toContain(`href="${LATEST_RELEASE_URL}"`);
    expect(page).toContain(`href="${LIVE_DEMO_GUIDE_URL}"`);
    expect(page).toContain(`href="${REPOSITORY_URL}"`);
    expect(page).toContain(`https://explorer.solana.com/address/${PROGRAM}?cluster=devnet`);
  });

  it("says what Stint provides, allowance funding included", () => {
    for (const part of ["A Solana program", "an x402 scheme for time", "A facilitator", "A gate", "A client library", "an MCP server", "Allowance funding"]) {
      expect(page).toContain(part);
    }
    expect(page).toContain("Subscriptions &amp; Allowances program");
  });

  it("runs no script and loads nothing from elsewhere", () => {
    expect(page).not.toMatch(/<script|<link|<img|<iframe|@import|url\(/i);
  });

  it("escapes the origin it is given", () => {
    const odd = landingPage({ origin: "https://a.example/<b>", terms: { rate: 1n, minSeconds: 1, maxSeconds: 2 }, durations: [1], idleCloseSeconds: 1, programId: PROGRAM });
    expect(odd).toContain("https://a.example/&lt;b&gt;/sessions");
    expect(odd).not.toContain("<b>");
  });
});
