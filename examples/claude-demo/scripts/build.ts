import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { buildPanelHtml } from "./panel.js";

const at = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const outfile = at("../dist/claude-demo.cjs");

/**
 * One file that runs on any Node.js from 22, with no `node_modules` and no repository: the server and every dependency,
 * the panel's HTML defined in. CommonJS, because `ws` is.
 */
await build({
  entryPoints: [at("../src/cli.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  outfile,
  define: { PANEL_HTML: JSON.stringify(await buildPanelHtml()) },
  // `ws` uses these native helpers when they are installed, and works without them.
  external: ["bufferutil", "utf-8-validate"],
  logLevel: "warning",
});
console.error(`built ${outfile}`);
