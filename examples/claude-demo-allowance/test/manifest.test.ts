import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ALLOWANCE_TOOL } from "../src/names.js";
import { SERVER_INFO } from "../src/server.js";

const manifest = JSON.parse(readFileSync(fileURLToPath(new URL("../mcpb/manifest.json", import.meta.url)), "utf8"));

describe("the extension's manifest", () => {
  it("is this extension, at the server's version, running the bundle the build writes", () => {
    expect(manifest).toMatchObject({ name: "stint-claude-demo-allowance", display_name: "Stint allowance demo", version: SERVER_INFO.version });
    expect(manifest.server.entry_point).toBe("server/claude-demo-allowance.cjs");
    expect(manifest.server.mcp_config.args).toEqual(["${__dirname}/server/claude-demo-allowance.cjs"]);
  });

  it("passes each setting to the variable the server reads", () => {
    expect(manifest.server.mcp_config.env).toEqual({
      STINT_DEMO_HOME: "${user_config.wallet_dir}",
      STINT_DEMO_GATE_URL: "${user_config.gate_url}",
      STINT_DEMO_ALLOWANCE_OWNER: "${user_config.owner}",
      STINT_DEMO_ALLOWANCE_NONCE: "${user_config.nonce}",
    });
    expect(manifest.user_config.owner).toMatchObject({ type: "string", required: true });
  });

  it("lists the server's tools by their names", () => {
    expect(manifest.tools.map((tool: { name: string }) => tool.name)).toEqual(Object.values(ALLOWANCE_TOOL));
  });
});
