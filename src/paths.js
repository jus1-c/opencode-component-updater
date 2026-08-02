import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function resolveUpdaterPaths({ pluginRoot, env = process.env, home = homedir() }) {
  if (!pluginRoot) throw new Error("pluginRoot is required");

  const configHome = env.XDG_CONFIG_HOME || join(home, ".config");
  const stateHome = env.XDG_STATE_HOME || join(home, ".local", "state");
  const opencodeConfigRoot = env.OPENCODE_CONFIG_DIR || join(configHome, "opencode");
  const stateRoot = env.OPENCODE_COMPONENT_UPDATER_STATE_DIR || join(stateHome, "opencode", "component-updater");

  return {
    pluginRoot: resolve(pluginRoot),
    pluginConfigRoot: resolve(pluginRoot, "config"),
    configPath: resolve(pluginRoot, "config", "components.json"),
    exampleConfigPath: resolve(pluginRoot, "config", "components.example.json"),
    opencodeConfigRoot: resolve(opencodeConfigRoot),
    stateRoot: resolve(stateRoot),
  };
}
