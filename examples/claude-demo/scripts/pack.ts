import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const at = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const bundle = at("../dist/claude-demo.cjs");
const stage = at("../dist/mcpb/");
const output = at("../dist/stint-claude-demo.mcpb");
const mcpb = at("../node_modules/.bin/mcpb");

if (!existsSync(bundle)) throw new Error(`${bundle} is missing: run the build first`);
rmSync(stage, { recursive: true, force: true });
mkdirSync(at("../dist/mcpb/server/"), { recursive: true });
copyFileSync(at("../mcpb/manifest.json"), at("../dist/mcpb/manifest.json"));
copyFileSync(bundle, at("../dist/mcpb/server/claude-demo.cjs"));
copyFileSync(at("../../../brand/icon-512.png"), at("../dist/mcpb/icon.png"));
execFileSync(mcpb, ["validate", at("../dist/mcpb/manifest.json")], { stdio: "inherit" });
execFileSync(mcpb, ["pack", stage, output], { stdio: "inherit" });
console.error(`packed ${output}`);
