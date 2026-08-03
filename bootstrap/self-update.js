import { copyFile, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { randomUUID } from "node:crypto";
import { BOOTSTRAP_API } from "./constants.js";
import { acquireBootstrapLock } from "./lock.js";
import { firstOutputLine } from "./process.js";
import { createRuntimeManifest, RUNTIME_MANIFEST_FILE, runtimePath, verifyRuntime } from "./runtime.js";
import { resolveBootstrapPaths } from "./paths.js";
import { isCommit, loadSelfState, saveSelfState } from "./state.js";

const BRANCH = "main";
const TIMEOUT_MS = 1_800_000;
const MAX_OUTPUT_BYTES = 65_536;

function parseCommit(output) {
  return firstOutputLine(output).match(/^([0-9a-f]{40})(?:\s|$)/i)?.[1]?.toLowerCase() || null;
}

function sanitizeRemote(value) {
  try {
    const url = new URL(value.replace(/^git\+/, ""));
    url.username = "";
    url.password = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return value.replace(/\/\/.+@/, "//");
  }
}

async function readPackage(root) {
  try {
    return JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  } catch {
    throw new Error("Updater package.json is unreadable");
  }
}

function repositoryUrl(pkg) {
  const raw = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
  if (typeof raw !== "string" || !raw) throw new Error("Updater package.json has no repository URL");
  return sanitizeRemote(raw);
}

async function runChecked(run, command, options, label) {
  const output = await run(command, { timeoutMs: TIMEOUT_MS, maxOutputBytes: MAX_OUTPUT_BYTES, ...options });
  if (output.code !== 0 || output.reason) throw new Error(`${label}: ${firstOutputLine(output) || output.reason || `exit ${output.code}`}`);
  return output;
}

async function currentCommit(paths, state, run) {
  if (isCommit(state.current)) return state.current;
  const output = await run(["git", "rev-parse", "HEAD"], { cwd: paths.pluginRoot, timeoutMs: 5_000, maxOutputBytes: 8_192 });
  return output.code === 0 ? parseCommit(output) : state.baselineCommit;
}

async function filesIn(root, path = root) {
  const rootStat = await lstat(path);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error(`Unsupported source path: ${relative(root, path) || "."}`);
  const entries = await readdir(path, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const target = join(path, entry.name);
    const stat = await lstat(target);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error(`Unsupported source path: ${relative(root, target)}`);
    if (stat.isDirectory()) files.push(...await filesIn(root, target));
    else files.push(target);
  }
  return files;
}

async function copyPayload(source, destination) {
  const names = ["runtime.js", "package.json", "src"];
  for (const name of names) {
    const root = join(source, name);
    const stat = await lstat(root);
    if (stat.isSymbolicLink()) throw new Error(`Unsupported source path: ${name}`);
    if (stat.isFile()) {
      await mkdir(dirname(join(destination, name)), { recursive: true });
      await copyFile(root, join(destination, name));
      continue;
    }
    const files = await filesIn(root);
    for (const file of files) {
      const target = join(destination, relative(source, file));
      await mkdir(dirname(target), { recursive: true });
      await copyFile(file, target);
    }
  }
}

async function assertCandidatePackage(source) {
  const pkg = await readPackage(source);
  if (pkg?.name !== "opencode-component-updater" || pkg?.type !== "module" || pkg?.opencodeComponentUpdater?.bootstrapApi !== BOOTSTRAP_API) {
    throw new Error("Candidate package is incompatible with this bootstrap");
  }
}

export function createSelfUpdater({ pluginRoot, paths = resolveBootstrapPaths({ pluginRoot }), run, now = Date.now } = {}) {
  if (typeof run !== "function") throw new Error("Self updater requires a command runner");

  async function check({ force = false, intervalHours = 24 } = {}) {
    const state = await loadSelfState(paths);
    const intervalMs = intervalHours * 60 * 60 * 1_000;
    if (!force && state.lastCheck?.checkedAt && now() - state.lastCheck.checkedAt < intervalMs) {
      return { ...state.lastCheck, skipped: true };
    }
    const pkg = await readPackage(paths.pluginRoot);
    const remote = repositoryUrl(pkg);
    const current = await currentCommit(paths, state, run);
    const output = await run(["git", "ls-remote", remote, `refs/heads/${BRANCH}`], { timeoutMs: 30_000, maxOutputBytes: 8_192 });
    const latest = output.code === 0 ? parseCommit(output) : null;
    const result = latest && current
      ? { status: current === latest ? "current" : "update-available", summary: `${current.slice(0, 7)} -> ${latest.slice(0, 7)}`, current, latest }
      : latest
        ? { status: "manual-only", summary: `Running updater commit unknown; latest is ${latest.slice(0, 7)}`, current: null, latest }
      : { status: "check-error", summary: firstOutputLine(output) || output.reason || "git ls-remote failed", current, latest: null };
    await saveSelfState(paths, {
      ...state,
      baselineCommit: state.baselineCommit || (state.current === "baseline" ? current : null),
      lastCheck: { checkedAt: now(), ...result },
    });
    return result;
  }

  async function stage(expected) {
    let state = await loadSelfState(paths);
    const commit = isCommit(expected || state.lastCheck?.latest);
    if (!commit) throw new Error("Run a successful self-update check before staging");
    if (state.lastCheck?.status !== "update-available" || commit !== state.lastCheck.latest) {
      throw new Error("Self-update commit does not match the latest checked commit");
    }
    if (state.current === commit) return { skipped: true, reason: "already current", commit };
    const lock = await acquireBootstrapLock(paths.selfLockPath, { now });
    if (!lock) throw new Error("Updater self-update is already running");
    const stage = join(paths.versionsRoot, `.stage-${randomUUID()}`);
    try {
      state = await loadSelfState(paths);
      if (state.lastCheck?.status !== "update-available" || commit !== state.lastCheck.latest) {
        throw new Error("Self-update commit does not match the latest checked commit");
      }
      if (state.candidate && state.candidate !== commit) throw new Error("Another self-update is already staged");
      if (state.candidate === commit) return { skipped: true, reason: "already staged", commit };
      if (state.current === commit) return { skipped: true, reason: "already current", commit };
      const pkg = await readPackage(paths.pluginRoot);
      const remote = repositoryUrl(pkg);
      const source = join(stage, "source");
      const payload = join(stage, "payload");
      await mkdir(paths.versionsRoot, { recursive: true });
      await mkdir(stage, { mode: 0o700 });
      await runChecked(run, ["git", "clone", "--no-checkout", remote, source], {}, "Clone failed");
      await runChecked(run, ["git", "checkout", "--detach", commit], { cwd: source }, "Checkout failed");
      const head = parseCommit(await runChecked(run, ["git", "rev-parse", "HEAD"], { cwd: source }, "HEAD verification failed"));
      if (head !== commit) throw new Error("Checked out commit does not match requested self-update");
      const current = await currentCommit(paths, state, run);
      if (!current) throw new Error("Running updater commit is unknown; install from a Git checkout first");
      const ancestry = await run(["git", "merge-base", "--is-ancestor", current, commit], { cwd: source, timeoutMs: 30_000, maxOutputBytes: 8_192 });
      if (ancestry.code !== 0) throw new Error("Remote main is not a fast-forward from the running updater");
      await assertCandidatePackage(source);
      await copyPayload(source, payload);
      for (const file of await filesIn(payload)) {
        if (file.endsWith(".js") || file.endsWith(".mjs")) await runChecked(run, ["node", "--check", file], {}, "Syntax check failed");
      }
      const manifest = await createRuntimeManifest(payload, commit);
      await writeFile(join(payload, RUNTIME_MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
      const target = runtimePath(paths, commit);
      await rename(payload, target).catch(async (error) => {
        if (error?.code !== "EEXIST" && error?.code !== "ENOTEMPTY") throw error;
        await verifyRuntime(paths, commit);
      });
      await verifyRuntime(paths, commit);
      await saveSelfState(paths, { ...state, candidate: commit, lastFailure: null });
      return { skipped: false, commit, target, summary: `${commit.slice(0, 7)} staged; restart OpenCode to activate` };
    } finally {
      await rm(stage, { recursive: true, force: true }).catch(() => {});
      await lock.release();
    }
  }

  async function status() {
    const state = await loadSelfState(paths);
    return {
      ...state,
      running: state.current,
      current: state.current === "baseline" ? state.baselineCommit : state.current,
    };
  }

  async function rollback() {
    const state = await loadSelfState(paths);
    if (state.current === "baseline" || !state.previous) return { skipped: true, reason: "no previous updater runtime" };
    if (state.candidate) return { skipped: true, reason: "another self-update is already staged" };
    await saveSelfState(paths, { ...state, candidate: state.previous, lastFailure: null });
    return { skipped: false, commit: state.previous, summary: "Previous updater runtime staged; restart OpenCode to activate" };
  }

  return { check, stage, status, rollback };
}
