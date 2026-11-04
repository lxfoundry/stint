import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_GATE_URL } from "../src/config.js";
import { TOOL } from "../src/state.js";

const raw = readFileSync(fileURLToPath(new URL("../mcpb/manifest.json", import.meta.url)));
const pkg = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")) as { version: string };

describe("the extension's manifest", () => {
  it("is UTF-8 without a byte-order mark, which mcpb refuses", () => {
    expect(raw[0]).toBe(0x7b);
  });

  it("runs the bundled server with Claude Desktop's Node.js, given the wallet folder and the gate", () => {
    const manifest = JSON.parse(raw.toString("utf8"));
    expect(manifest).toMatchObject({ manifest_version: "0.3", name: "stint-claude-demo", version: pkg.version });
    expect(manifest.server).toEqual({
      type: "node",
      entry_point: "server/claude-demo.cjs",
      mcp_config: {
        command: "node",
        args: ["${__dirname}/server/claude-demo.cjs"],
        env: { STINT_DEMO_HOME: "${user_config.wallet_dir}", STINT_DEMO_GATE_URL: "${user_config.gate_url}" },
      },
    });
    expect(manifest.user_config.wallet_dir).toMatchObject({ type: "directory", required: true, default: "${HOME}" });
    expect(manifest.user_config.gate_url).toMatchObject({ type: "string", default: DEFAULT_GATE_URL });
    expect(manifest.tools.map((tool: { name: string }) => tool.name).sort()).toEqual(Object.values(TOOL).sort());
    expect(manifest.compatibility).toEqual({ platforms: ["win32", "darwin", "linux"], runtimes: { node: ">=22" } });
  });
});
