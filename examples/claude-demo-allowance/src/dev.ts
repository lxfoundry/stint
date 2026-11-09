import { buildPanelHtml } from "../scripts/panel.js";
import { run } from "./main.js";

/** The server from source (`tsx src/dev.ts`), building the panel in memory at start. */
run(buildPanelHtml);
