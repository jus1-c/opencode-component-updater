import { access } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { activateCandidate, rejectRuntime } from "./activation.js";
import { BOOTSTRAP_API } from "./constants.js";
import { resolveBootstrapPaths } from "./paths.js";
import { verifyRuntime } from "./runtime.js";
import { BASELINE_RUNTIME, loadSelfState } from "./state.js";
import { createSelfUpdater } from "./self-update.js";
import { runBootstrapCommand } from "./process.js";

function runtimePath(paths, runtime) {
  return runtime === BASELINE_RUNTIME
    ? join(paths.pluginRoot, "runtime.js")
    : join(paths.versionsRoot, runtime, "runtime.js");
}

async function loadRuntime(paths, runtime) {
  if (runtime !== BASELINE_RUNTIME) await verifyRuntime(paths, runtime);
  const path = runtimePath(paths, runtime);
  await access(path);
  const module = await import(pathToFileURL(path).href);
  if (module.BOOTSTRAP_API !== BOOTSTRAP_API || typeof module.createRuntimePlugin !== "function") {
    throw new Error(`Incompatible updater runtime: ${runtime}`);
  }
  const plugin = module.createRuntimePlugin({ pluginRoot: paths.pluginRoot, createSelfUpdater, run: runBootstrapCommand });
  if (!plugin || plugin.id !== "opencode-component-updater" || typeof plugin.tui !== "function") {
    throw new Error(`Invalid updater runtime: ${runtime}`);
  }
  return plugin;
}

async function fallbackTui(paths, runtime, args, initialError) {
  let failure = initialError;
  const state = await loadSelfState(paths);
  const runtimes = [...new Set([state.current, state.previous, BASELINE_RUNTIME].filter((candidate) => candidate && candidate !== runtime))];
  for (const fallback of runtimes) {
    try {
      return await (await loadRuntime(paths, fallback)).tui(...args);
    } catch (error) {
      failure = error;
      await rejectRuntime({ pluginRoot: paths.pluginRoot, paths, runtime: fallback, error });
    }
  }
  throw failure;
}

function guardedPlugin(paths, runtime, plugin) {
  return {
    id: plugin.id,
    async tui(...args) {
      try {
        return await plugin.tui(...args);
      } catch (error) {
        await rejectRuntime({ pluginRoot: paths.pluginRoot, paths, runtime, error });
        return fallbackTui(paths, runtime, args, error);
      }
    },
  };
}

export async function loadRuntimePlugin({ pluginRoot, paths = resolveBootstrapPaths({ pluginRoot }) }) {
  await activateCandidate({ pluginRoot, paths });
  const state = await loadSelfState(paths);
  const runtimes = [...new Set([state.current, state.previous, BASELINE_RUNTIME].filter(Boolean))];
  let failure;
  for (const runtime of runtimes) {
    try {
      return guardedPlugin(paths, runtime, await loadRuntime(paths, runtime));
    } catch (error) {
      failure = error;
      await rejectRuntime({ pluginRoot, paths, runtime, error });
    }
  }
  throw failure || new Error("No compatible updater runtime is available");
}
