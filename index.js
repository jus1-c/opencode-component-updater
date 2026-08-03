import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { loadRuntimePlugin } from "./bootstrap/loader.js";

const pluginRoot = dirname(fileURLToPath(import.meta.url));

export default {
  id: "opencode-component-updater",
  async tui(...args) {
    const plugin = await loadRuntimePlugin({ pluginRoot });
    return plugin.tui(...args);
  },
};
