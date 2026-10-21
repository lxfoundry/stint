// Generates the program client from the Anchor IDL. Run after every `anchor build` that changes
// the program's interface; the output in src/generated is committed and never edited by hand.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createFromRoot } from "codama";
import { rootNodeFromAnchor } from "@codama/nodes-from-anchor";
import { renderVisitor } from "@codama/renderers-js";

const idlPath = fileURLToPath(new URL("../../../target/idl/stint.json", import.meta.url));
const packageFolder = fileURLToPath(new URL("..", import.meta.url));

const idl = JSON.parse(readFileSync(idlPath, "utf8"));
await createFromRoot(rootNodeFromAnchor(idl)).accept(
  renderVisitor(packageFolder, { importExtension: "js" }),
);
