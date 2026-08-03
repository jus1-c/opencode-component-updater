import { lstat, mkdir, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { readJson, writeJsonAtomic } from "./json.js";
import { acquireLock } from "./lock.js";
import { listLiveInstances } from "./lease.js";
import { firstOutputLine, runCommand } from "./process.js";
import { componentIdentity, loadState, saveState } from "./state.js";

const MANIFEST_FILE = ".opencode-component-updater-manifest.json";
const PENDING_SCHEMA_VERSION = 1;

function safeName(value) {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-");
}

async function getStat(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function resolveChild(root, value) {
  if (typeof value !== "string" || !value || isAbsolute(value) || value.includes("\\")) {
    throw new Error(`Invalid relative path: ${String(value)}`);
  }
  const path = resolve(root, value);
  const normalized = relative(root, path);
  if (!normalized || normalized === ".." || normalized.startsWith(`..${sep}`) || isAbsolute(normalized)) {
    throw new Error(`Path escapes component root: ${value}`);
  }
  return { path, relativePath: normalized };
}

function overlaps(left, right) {
  return left === right || left.startsWith(`${right}${sep}`) || right.startsWith(`${left}${sep}`);
}

function isWithin(value, parent) {
  return value === parent || value.startsWith(`${parent}${sep}`);
}

async function assertDirectory(path, label) {
  const entry = await getStat(path);
  if (!entry?.isDirectory() || entry.isSymbolicLink()) {
    throw new Error(`${label} must be a non-symlink directory: ${path}`);
  }
}

function normalizePaths(paths, root, label) {
  if (!Array.isArray(paths)) throw new Error(`${label} paths must be an array`);
  const normalized = paths.map((path) => resolveChild(root, path).relativePath).sort();
  if (normalized.some((path, index) => index > 0 && path === normalized[index - 1])) {
    throw new Error(`${label} has duplicate paths`);
  }
  for (let index = 1; index < normalized.length; index += 1) {
    if (overlaps(normalized[index - 1], normalized[index])) {
      throw new Error(`${label} has overlapping paths`);
    }
  }
  return normalized;
}

function newPending() {
  return { schemaVersion: PENDING_SCHEMA_VERSION, updates: {} };
}

function normalizePending(input) {
  if (!input || input.schemaVersion !== PENDING_SCHEMA_VERSION || !input.updates || typeof input.updates !== "object") {
    return newPending();
  }
  return { schemaVersion: PENDING_SCHEMA_VERSION, updates: input.updates };
}

export async function loadPending(paths) {
  return normalizePending(await readJson(paths.pendingPath, newPending()));
}

export async function savePending(paths, pending) {
  await writeJsonAtomic(paths.pendingPath, normalizePending(pending));
}

export function manifestPath(stage) {
  return join(stage, MANIFEST_FILE);
}

export async function validateManifest({ component, stage, manifest }) {
  if (!manifest || manifest.schemaVersion !== 1 || !Array.isArray(manifest.paths) || manifest.paths.length === 0) {
    throw new Error("Invalid stage manifest");
  }
  if (!component.target) throw new Error("Component has no local target");
  await assertDirectory(component.target, "Component target");
  await assertDirectory(stage, "Stage");

  const manifestPaths = normalizePaths(manifest.paths, component.target, "Manifest");
  const allowed = normalizePaths(component.policy.allowedPaths, component.target, "Allowed");
  const protectedPaths = normalizePaths(component.policy.protectedPaths, component.target, "Protected");
  if (!allowed.length) throw new Error("Component has no allowed update paths");

  for (const path of manifestPaths) {
    if (!allowed.some((allowedPath) => isWithin(path, allowedPath))) {
      throw new Error(`Manifest path is not allowed: ${path}`);
    }
    if (protectedPaths.some((protectedPath) => overlaps(path, protectedPath))) {
      throw new Error(`Manifest path is protected: ${path}`);
    }
    const staged = resolveChild(stage, path).path;
    const stagedStat = await getStat(staged);
    if (!stagedStat || stagedStat.isSymbolicLink()) {
      throw new Error(`Staged path is missing or symbolic: ${path}`);
    }
    const current = resolveChild(component.target, path).path;
    const currentStat = await getStat(current);
    if (currentStat?.isSymbolicLink()) {
      throw new Error(`Target path is symbolic: ${path}`);
    }
  }
  return { schemaVersion: 1, paths: manifestPaths };
}

function stagePath(component, id) {
  if (!component.target) throw new Error("Component has no local target");
  return join(dirname(component.target), `.component-updater-stage-${safeName(id)}-${randomUUID()}`);
}

function backupPath(component, id, jobId) {
  return join(dirname(component.target), `.component-updater-backup-${safeName(id)}-${safeName(jobId)}`);
}

function updateLockPath(paths, id) {
  return join(paths.stateRoot, "locks", `update-${safeName(id)}.lock`);
}

async function runHealthcheck(component, id, stage, manifest, defaults, { run, signal }) {
  if (!component.update.healthcheck.length) return null;
  const output = await run(component.update.healthcheck, {
    cwd: stage,
    timeoutMs: defaults.updateTimeoutMs,
    maxOutputBytes: defaults.maxOutputBytes,
    signal,
    env: {
      OPENCODE_UPDATER_COMPONENT_ID: id,
      OPENCODE_UPDATER_TARGET: component.target,
      OPENCODE_UPDATER_STAGE: stage,
      OPENCODE_UPDATER_MANIFEST: manifestPath(stage),
    },
  });
  if (output.code !== 0 || output.reason) {
    throw new Error(`Stage healthcheck failed: ${firstOutputLine(output) || output.reason || `exit ${output.code}`}`);
  }
  return firstOutputLine(output);
}

export async function stageComponent({ paths, config, id, run = runCommand, signal, now = Date.now }) {
  const component = config.components[id];
  if (!component) throw new Error(`Unknown component: ${id}`);
  if (component.policy.apply !== "manifest") throw new Error(`Component ${id} does not allow manifest apply`);
  if (!component.target) throw new Error(`Component ${id} has no local target`);
  if (!component.update.command.length) throw new Error(`Component ${id} has no update command`);
  await assertDirectory(component.target, "Component target");

  const lock = await acquireLock(updateLockPath(paths, id), { staleMs: config.defaults.updateTimeoutMs * 2, now });
  if (!lock) throw new Error(`Update already running for ${id}`);
  let stage;
  try {
    const pending = await loadPending(paths);
    if (pending.updates[id]) throw new Error(`Component ${id} already has a pending update`);

    stage = stagePath(component, id);
    await mkdir(stage, { mode: 0o700 });
    const output = await run(component.update.command, {
      cwd: stage,
      timeoutMs: config.defaults.updateTimeoutMs,
      maxOutputBytes: config.defaults.maxOutputBytes,
      signal,
      env: {
        OPENCODE_UPDATER_COMPONENT_ID: id,
        OPENCODE_UPDATER_TARGET: component.target,
        OPENCODE_UPDATER_STAGE: stage,
        OPENCODE_UPDATER_MANIFEST: manifestPath(stage),
      },
    });
    if (output.code !== 0 || output.reason) {
      throw new Error(`Update command failed: ${firstOutputLine(output) || output.reason || `exit ${output.code}`}`);
    }
    const manifest = await validateManifest({
      component,
      stage,
      manifest: await readJson(manifestPath(stage), null),
    });
    const healthcheck = await runHealthcheck(component, id, stage, manifest, config.defaults, { run, signal });
    const jobId = safeName(basename(stage));
    const update = {
      id,
      target: component.target,
      stage,
      manifest,
      jobId,
      createdAt: now(),
      summary: firstOutputLine(output),
      healthcheck,
    };
    pending.updates[id] = update;
    await savePending(paths, pending);

    const state = await loadState(paths);
    const key = componentIdentity(id, component);
    state.components[key] = { ...state.components[key], status: "staged-pending-restart", stagedAt: now(), pendingJob: jobId };
    await saveState(paths, state);
    return update;
  } catch (error) {
    if (stage) await rm(stage, { recursive: true, force: true }).catch(() => {});
    throw error;
  } finally {
    await lock.release();
  }
}

async function restoreMoves(moves, { move }) {
  for (const item of [...moves].reverse()) {
    if (item.newMoved && await getStat(item.current)) {
      await mkdir(dirname(item.staged), { recursive: true });
      await move(item.current, item.staged);
    }
    if (item.oldMoved && await getStat(item.backup)) {
      await mkdir(dirname(item.current), { recursive: true });
      await move(item.backup, item.current);
    }
  }
}

export async function applyStagedUpdate({ component, update, move = rename }) {
  if (component.target !== update.target) throw new Error(`Target changed for ${update.id}`);
  if (dirname(component.target) !== dirname(update.stage)) throw new Error(`Stage is not beside target for ${update.id}`);
  const manifest = await validateManifest({
    component,
    stage: update.stage,
    manifest: await readJson(manifestPath(update.stage), null),
  });
  const backup = backupPath(component, update.id, update.jobId);
  await mkdir(backup, { mode: 0o700 });
  const moves = [];
  try {
    for (const path of manifest.paths) {
      const current = resolveChild(component.target, path).path;
      const staged = resolveChild(update.stage, path).path;
      const backupTarget = resolveChild(backup, path).path;
      const currentStat = await getStat(current);
      const item = { current, staged, backup: backupTarget, oldMoved: false, newMoved: false };
      if (currentStat) {
        await mkdir(dirname(backupTarget), { recursive: true });
        await move(current, backupTarget);
        item.oldMoved = true;
      }
      try {
        await mkdir(dirname(current), { recursive: true });
        await move(staged, current);
        item.newMoved = true;
      } catch (error) {
        await restoreMoves([item], { move });
        throw error;
      }
      moves.push(item);
    }
  } catch (error) {
    await restoreMoves(moves, { move }).catch(() => {});
    throw error;
  }
  await rm(update.stage, { recursive: true, force: true });
  return { backup, manifest };
}

export async function applyPending({ paths, config, now = Date.now, move = rename, requireNoLiveInstances = true }) {
  const lock = await acquireLock(paths.applyLockPath, { staleMs: config.defaults.updateTimeoutMs * 2, now });
  if (!lock) return { skipped: true, reason: "another apply is running", applied: [], failed: [] };
  try {
    if (requireNoLiveInstances) {
      const instances = await listLiveInstances(paths, { now, staleMs: config.defaults.staleInstanceMs });
      if (instances.length) {
        return { skipped: true, reason: "other OpenCode instances are active", instances, applied: [], failed: [] };
      }
    }
    const pending = await loadPending(paths);
    const state = await loadState(paths);
    const applied = [];
    const failed = [];
    for (const [id, update] of Object.entries(pending.updates)) {
      const component = config.components[id];
      try {
        if (!component || component.policy.apply !== "manifest") throw new Error(`Component config unavailable: ${id}`);
        const outcome = await applyStagedUpdate({ component, update, move });
        delete pending.updates[id];
        const key = componentIdentity(id, component);
        state.components[key] = { ...state.components[key], status: "applied", appliedAt: now(), backup: outcome.backup, pendingJob: undefined };
        applied.push({ id, ...outcome });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        pending.updates[id] = { ...update, lastApplyError: message };
        failed.push({ id, error: message });
      }
    }
    await savePending(paths, pending);
    await saveState(paths, state);
    return { skipped: false, applied, failed };
  } finally {
    await lock.release();
  }
}
