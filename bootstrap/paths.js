import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function resolveBootstrapPaths({ pluginRoot, env = process.env, home = homedir() }) {
  const stateHome = env.XDG_STATE_HOME || join(home, ".local", "state");
  const stateRoot = env.OPENCODE_COMPONENT_UPDATER_STATE_DIR || join(stateHome, "opencode", "component-updater");
  return {
    pluginRoot: resolve(pluginRoot),
    stateRoot: resolve(stateRoot),
    selfStatePath: resolve(stateRoot, "self-update.json"),
    selfLockPath: resolve(stateRoot, "locks", "self-update.lock"),
    versionsRoot: resolve(pluginRoot, "versions"),
  };
}
