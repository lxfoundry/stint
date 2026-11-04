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
    for (const id of ["address", "balance", "launch", "refresh", "top-up", "close", "ledger", "rows", "links", "error"]) {
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

describe("the panel's stylesheet", () => {
  const css = (/<style>([\s\S]*?)<\/style>/.exec(sourceOf("../app/panel.html"))?.[1] ?? "").replace(/\/\*[\s\S]*?\*\//g, "");
  /** Each innermost rule: its selector and its declarations. */
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({ selector: match[1]!.trim(), body: match[2]! }));
  const rule = (selector: string) => rules.find((candidate) => candidate.selector === selector);

  it("draws in the brand's six colours and no mix of them", () => {
    expect(css).not.toMatch(/color-mix|rgba?\(|hsla?\(|oklch\(/i);
    const palette = ["#111318", "#f4f5f2", "#2ed18b", "#0b6b45", "#5e636c", "#a9aeb6"];
    const hexes = css.match(/#[0-9a-f]{6}\b/gi) ?? [];
    expect(hexes.length).toBeGreaterThanOrEqual(6);
    for (const hex of hexes) expect(palette).toContain(hex.toLowerCase());
  });

  it("takes the border colour from the palette: Mist on a light surface, Slate on a dark one", () => {
    expect(rule(":root")?.body).toMatch(/--line:\s*var\(--color-border-primary,\s*var\(--mist\)\)/);
    expect(rule(':root[data-surface="dark"]')?.body).toMatch(/--line:\s*var\(--color-border-primary,\s*var\(--slate\)\)/);
  });

  it("uses Signal only on a dark surface, apart from the closed capsule's outline", () => {
    const users = rules.filter((candidate) => /var\(--signal\)/.test(candidate.body));
    expect(users.length).toBeGreaterThan(0);
    for (const user of users) {
      expect([':root[data-surface="dark"]', '#track[data-state="closed"] #paid']).toContain(user.selector);
    }
    // Signal is never text on the default (light) surface.
    expect(rule(":root")?.body).toMatch(/--accent-text:\s*var\(--deep\)/);
    expect(rule(":root")?.body).toMatch(/--used:\s*var\(--ink\)/);
  });

  it("tells a closed capsule from a running one in both themes: Signal outline, used part in the text colour", () => {
    expect(rule('#track[data-state="closed"] #paid')?.body).toMatch(/border-color:\s*var\(--signal\)/);
    expect(rule('#track[data-state="closed"] #used')?.body).toMatch(/background:\s*var\(--fg\)/);
    // Not a fill of the outlined part.
    expect(rule('#track[data-state="closed"] #paid')?.body).not.toMatch(/background/);
  });
});
