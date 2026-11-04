import { run } from "./main.js";

/** Set by `scripts/build.ts`: the panel's HTML, its script inlined. */
declare const PANEL_HTML: string;

run(async () => PANEL_HTML);
