import { TOOL } from "../../claude-demo/src/state.js";

/** The tools this server offers. The panel calls them by these names; the call handler knows the first demo's. */
export const ALLOWANCE_TOOL = {
  demo: "stint_allowance_demo",
  state: "stint_allowance_demo_state",
  launch: "stint_allowance_demo_launch",
  topUp: "stint_allowance_demo_top_up",
  close: "stint_allowance_demo_close",
} as const;

export type AllowanceToolName = (typeof ALLOWANCE_TOOL)[keyof typeof ALLOWANCE_TOOL];

/** Each of this server's tools, and the call handler's tool it runs: so both extensions can be installed at once. */
export const TO_HANDLER: Readonly<Record<AllowanceToolName, string>> = {
  [ALLOWANCE_TOOL.demo]: TOOL.demo,
  [ALLOWANCE_TOOL.state]: TOOL.state,
  [ALLOWANCE_TOOL.launch]: TOOL.launch,
  [ALLOWANCE_TOOL.topUp]: TOOL.topUp,
  [ALLOWANCE_TOOL.close]: TOOL.close,
};

/** The panel, as an MCP App resource: not the first demo's URI. */
export const PANEL_URI = "ui://stint-allowance-demo/panel.html";
