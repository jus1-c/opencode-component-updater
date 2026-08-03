import { createTuiPlugin } from "./src/tui.js";

export const BOOTSTRAP_API = 1;

export function createRuntimePlugin({ pluginRoot }) {
  return {
    id: "opencode-component-updater",
    tui: createTuiPlugin({ pluginRoot }),
  };
}
