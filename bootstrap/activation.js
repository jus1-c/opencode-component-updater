import { BOOTSTRAP_API } from "./constants.js";
import { listLiveBootstrapLeases } from "./leases.js";
import { acquireBootstrapLock } from "./lock.js";
import { resolveBootstrapPaths } from "./paths.js";
import { validateRuntimeModule } from "./runtime.js";
import { BASELINE_RUNTIME, loadSelfState, saveSelfState } from "./state.js";

function failure(error) {
  return error instanceof Error ? error.message : String(error);
}

export async function activateCandidate({ pluginRoot, paths = resolveBootstrapPaths({ pluginRoot }), now = Date.now, staleInstanceMs = 90_000 } = {}) {
  let state = await loadSelfState(paths);
  if (!state.candidate) return { skipped: true, reason: "no candidate" };
  const lock = await acquireBootstrapLock(paths.selfLockPath, { now });
  if (!lock) return { skipped: true, reason: "self-update is already running" };
  try {
    state = await loadSelfState(paths);
    if (!state.candidate) return { skipped: true, reason: "no candidate" };
    const instances = await listLiveBootstrapLeases(paths, { now, staleMs: staleInstanceMs });
    if (instances.length) return { skipped: true, reason: "other OpenCode instances are active", instances };
    if (state.candidate === state.current) {
      await saveSelfState(paths, { ...state, candidate: null, lastFailure: null });
      return { skipped: true, reason: "candidate already active", commit: state.current };
    }
    if (state.candidate !== BASELINE_RUNTIME) {
      try {
        await validateRuntimeModule(paths, state.candidate);
      } catch (error) {
        await saveSelfState(paths, { ...state, candidate: null, lastFailure: failure(error) });
        return { skipped: true, reason: "candidate rejected", error: failure(error) };
      }
    }
    const previous = state.current || BASELINE_RUNTIME;
    await saveSelfState(paths, { ...state, current: state.candidate, previous, candidate: null, lastFailure: null });
    return { skipped: false, commit: state.candidate, previous };
  } finally {
    await lock.release();
  }
}

export async function rejectRuntime({ pluginRoot, runtime, error, paths = resolveBootstrapPaths({ pluginRoot }), now = Date.now } = {}) {
  if (!runtime || runtime === BASELINE_RUNTIME) return;
  const lock = await acquireBootstrapLock(paths.selfLockPath, { now });
  if (!lock) return;
  try {
    const state = await loadSelfState(paths);
    if (state.current !== runtime) return;
    const fallback = state.previous || BASELINE_RUNTIME;
    await saveSelfState(paths, {
      ...state,
      current: fallback,
      previous: fallback === BASELINE_RUNTIME ? null : BASELINE_RUNTIME,
      lastFailure: failure(error),
    });
  } finally {
    await lock.release();
  }
}

export { BOOTSTRAP_API };
