import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const at = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/** Where `app/panel.html` takes the panel's script. */
export const PLACEHOLDER = "<!-- PANEL_SCRIPT -->";

/** The panel as one HTML file: `app/panel.ts` bundled for the browser and inlined, so that the host makes no other request. */
export async function buildPanelHtml(): Promise<string> {
  const result = await build({
    entryPoints: [at("../app/panel.ts")],
    bundle: true,
    platform: "browser",
    format: "iife",
    target: "es2022",
    minify: true,
    write: false,
    logLevel: "warning",
  });
  // `<\/script` is the same text to the script, and does not end the element early.
  const script = result.outputFiles[0]!.text.replace(/<\/script/gi, "<\\/script");
  const template = readFileSync(at("../app/panel.html"), "utf8");
  if (!template.includes(PLACEHOLDER)) throw new Error(`app/panel.html has no ${PLACEHOLDER}`);
  // A function as the replacement, so that `$&` or `$1` in the bundle is not expanded.
  return template.replace(PLACEHOLDER, () => `<script>${script}</script>`);
}
