import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PLACEHOLDER, buildPanelHtml } from "../scripts/panel.js";
import { ALLOWANCE_TOOL } from "../src/names.js";

const sourceOf = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

describe("the allowance demo's panel", () => {
  it("writes data as text only, and styles through the CSSOM only", () => {
    const source = sourceOf("../app/panel.ts");
    expect(source).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
    expect(source).not.toMatch(/\.style\.cssText|setAttribute\(\s*["']style["']|\.style\s*=[^=]/);
  });

  it("is one file, its script inlined, with the owner, the agent, the strip and the grant command", async () => {
    const html = await buildPanelHtml();
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).not.toContain(PLACEHOLDER);
    const start = html.indexOf("<script>");
    const end = html.lastIndexOf("</script>");
    expect(html.slice(start + "<script>".length, end)).not.toMatch(/<\/script/i);
    for (const id of ["address", "balance", "agent", "budget", "budget-pulled", "grant", "grant-command", "copy-grant", "launch-hint", "launch", "top-up", "close", "ledger", "rows", "links", "error"]) {
      expect(html).toContain(`id="${id}"`);
    }
  });

  it("calls this extension's tools, not the first demo's", async () => {
    const html = await buildPanelHtml();
    for (const name of Object.values(ALLOWANCE_TOOL).filter((name) => name !== ALLOWANCE_TOOL.demo)) expect(html).toContain(name);
  });
});
