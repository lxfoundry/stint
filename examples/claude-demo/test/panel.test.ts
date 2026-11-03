import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TOOL } from "../src/state.js";
import { PLACEHOLDER, buildPanelHtml } from "../scripts/panel.js";

const sourceOf = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

describe("the panel's HTML", () => {
  it("writes data as text only", () => {
    const source = sourceOf("../app/panel.ts");
    expect(source).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  });

  it("sets styles through the CSSOM only", () => {
    const source = sourceOf("../app/panel.ts");
    expect(source).not.toMatch(/\.style\.cssText|setAttribute\(\s*["']style["']|\.style\s*=[^=]/);
  });

  it("is one file, its script inlined where the placeholder was, with no early end of the script", async () => {
    const html = await buildPanelHtml();
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).not.toContain(PLACEHOLDER);
    const start = html.indexOf("<script>");
    const end = html.lastIndexOf("</script>");
    expect(start).toBeGreaterThan(html.indexOf('id="links"'));
    expect(html.slice(start + "<script>".length, end)).not.toMatch(/<\/script/i);
    for (const id of ["address", "balance", "launch", "refresh", "top-up", "close", "rows", "links", "error"]) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(html.length).toBeLessThan(2_000_000);
  }, 60_000);

  it("holds exactly one script, loads nothing else and names every tool it calls", async () => {
    const html = await buildPanelHtml();
    expect(html.match(/<script/gi)).toHaveLength(1);
    expect(html.match(/<\/script>/gi)).toHaveLength(1);
    // The page around the script: no resource to fetch, and no address at all.
    const page = html.slice(0, html.indexOf("<script>")) + html.slice(html.lastIndexOf("</script>"));
    expect(page).not.toMatch(/\bsrc\s*=|\bhref\s*=|@import|url\(|https?:\/\//i);
    for (const name of [TOOL.state, TOOL.launch, TOOL.topUp, TOOL.close]) expect(html).toContain(name);
    expect(html).not.toContain(PLACEHOLDER);
  }, 60_000);
});
