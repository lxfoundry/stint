// Generates the Subscriptions program's client from its vendored Codama IDL (see idl/README.md). The output in
// src/generated is committed and never edited by hand.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createFromRoot } from "codama";
import { renderVisitor } from "@codama/renderers-js";

const idlPath = fileURLToPath(new URL("../idl/subscriptions.json", import.meta.url));
const packageFolder = fileURLToPath(new URL("..", import.meta.url));

await createFromRoot(JSON.parse(readFileSync(idlPath, "utf8"))).accept(
  renderVisitor(packageFolder, { importExtension: "js" }),
);
