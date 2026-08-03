import { checkDetectedSource, detectComponent } from "./detectors.js";
import { acquireLock } from "./lock.js";
import { firstOutputLine, runCommand, sanitizeSummary } from "./process.js";
import { componentIdentity, loadState, saveState } from "./state.js";

function elapsedEnough(entry, intervalMs, now) {
  return !entry?.lastCheckedAt || now - entry.lastCheckedAt >= intervalMs;
}

function result(status, summary, lastCheckedAt, extra = {}) {
  return { status, summary, lastCheckedAt, ...extra };
}

async function customCheck(id, component, defaults, { run, signal, now }) {
  const command = component.check.command;
  const output = await run(command, {
    cwd: component.target || undefined,
    timeoutMs: defaults.checkTimeoutMs,
    maxOutputBytes: defaults.maxOutputBytes,
    signal,
    env: {
      OPENCODE_UPDATER_COMPONENT_ID: id,
      OPENCODE_UPDATER_TARGET: component.target || "",
    },
  });
  const summary = firstOutputLine(output) || output.reason || `exit ${output.code}`;
  if (output.code === 0 && !output.reason) return result("current", summary, now);
  if (output.code === 10 && !output.reason) return result("update-available", summary, now);
  return result("check-error", summary, now);
}

export async function checkComponent({ id, component, record, previous, defaults, force = false, now = Date.now(), run = runCommand, fetchImpl, signal }) {
  try {
    if (!component.enabled) return { ...previous, status: "disabled", summary: "Disabled" };
    const intervalMs = defaults.checkIntervalHours * 60 * 60 * 1_000;
    if (!force && !elapsedEnough(previous, intervalMs, now)) return { ...previous, skipped: true };

    const detection = await detectComponent(component, { record, run });
    if (detection.dirty && component.policy.dirty !== "allow") {
      return result("manual-only", "Dirty Git worktree", now, { source: detection });
    }
    if (component.check.command.length) {
      return { ...(await customCheck(id, component, defaults, { run, signal, now })), source: detection };
    }
    return { ...(await checkDetectedSource(detection, { fetchImpl, run, timeoutMs: defaults.checkTimeoutMs, maxOutputBytes: defaults.maxOutputBytes })), lastCheckedAt: now, source: detection };
  } catch (error) {
    return result("check-error", sanitizeSummary(error instanceof Error ? error.message : error), now);
  }
}

export async function runChecks({ paths, config, records = [], force = false, now = Date.now, run = runCommand, fetchImpl, signal }) {
  const lock = await acquireLock(paths.checkLockPath, { staleMs: config.defaults.checkTimeoutMs * 2, now });
  if (!lock) return { skipped: true, reason: "another check is running", results: [] };
  try {
    const state = await loadState(paths);
    const recordById = new Map(records.map((record) => [record.id, record]));
    const results = [];
    for (const [id, component] of Object.entries(config.components)) {
      if (signal?.aborted) break;
      const key = componentIdentity(id, component);
      const next = await checkComponent({
        id,
        component,
        record: recordById.get(id),
        previous: state.components[key],
        defaults: config.defaults,
        force,
        now: now(),
        run,
        fetchImpl,
        signal,
      });
      state.components[key] = next;
      results.push({ id, key, ...next });
    }
    await saveState(paths, state);
    return { skipped: false, results, state };
  } finally {
    await lock.release();
  }
}
