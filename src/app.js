import { loadConfig } from "./config.js";
import { runChecks } from "./engine.js";
import { bootstrapConfig, discoverInventory } from "./inventory.js";
import { createLease } from "./lease.js";
import { runCommand } from "./process.js";
import { readStatus } from "./status.js";
import { applyPending, stageComponent } from "./transaction.js";

function message(error) {
  return error instanceof Error ? error.message : String(error);
}

export function createUpdaterApp({
  paths,
  worktree = "",
  now = Date.now,
  run = runCommand,
  fetchImpl,
  inventory = discoverInventory,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
  onEvent = () => {},
} = {}) {
  const controller = new AbortController();
  const jobs = new Set();
  let config;
  let records = [];
  let lease;
  let timer;
  let started;
  let checkJob;
  let disposed = false;

  function emit(type, detail = {}) {
    onEvent({ type, ...detail });
  }

  function track(job) {
    jobs.add(job);
    void job.then(
      () => jobs.delete(job),
      () => jobs.delete(job),
    );
    return job;
  }

  async function ensureReady() {
    if (started) return started;
    const startup = (async () => {
      await bootstrapConfig(paths, { inventory });
      config = await loadConfig(paths);
      if (!config) throw new Error("Component updater config could not be created");
      const discovered = await inventory(paths);
      records = discovered.records;
      lease = await createLease(paths, {
        now,
        worktree,
        heartbeatMs: config.defaults.instanceHeartbeatMs,
        setIntervalImpl,
        clearIntervalImpl,
      });
      const interval = Math.min(config.defaults.checkIntervalHours * 60 * 60 * 1_000, 60 * 60 * 1_000);
      timer = setIntervalImpl(() => {
        void check({ force: false });
      }, interval);
      timer.unref?.();
      emit("started", { config, records });
    })();
    started = startup;
    try {
      await startup;
    } catch (error) {
      started = undefined;
      throw error;
    }
    return startup;
  }

  async function stage(id) {
    await ensureReady();
    const job = (async () => {
      emit("stage-started", { id });
      try {
        const update = await stageComponent({ paths, config, id, run, signal: controller.signal, now });
        emit("stage-ready", { id, update });
        return update;
      } catch (error) {
        emit("stage-error", { id, error: message(error) });
        throw error;
      }
    })();
    return track(job);
  }

  async function stageAvailable() {
    const snapshot = await status();
    const updates = snapshot.components.filter((item) => item.status === "update-available" && config.components[item.id].update.command.length);
    const results = [];
    for (const item of updates) {
      try {
        results.push({ id: item.id, update: await stage(item.id) });
      } catch (error) {
        results.push({ id: item.id, error: message(error) });
      }
    }
    return results;
  }

  async function check({ force = false } = {}) {
    await ensureReady();
    if (checkJob) {
      if (!force) return checkJob;
      return checkJob.then(() => check({ force: true }));
    }
    const job = (async () => {
      const discovered = await inventory(paths);
      records = discovered.records;
      const outcome = await runChecks({ paths, config, records, force, now, run, fetchImpl, signal: controller.signal });
      const available = outcome.results.filter((item) => !item.skipped && item.status === "update-available");
      const errors = outcome.results.filter((item) => item.status === "check-error");
      emit("check-complete", { force, outcome, available, errors });
      for (const item of available) {
        if (config.components[item.id]?.autoUpdate) {
          void stage(item.id).catch(() => {});
        }
      }
      return outcome;
    })();
    checkJob = track(job);
    void checkJob.then(
      () => { checkJob = undefined; },
      () => { checkJob = undefined; },
    );
    return checkJob;
  }

  async function status() {
    await ensureReady();
    return readStatus({ paths, config, now });
  }

  async function start() {
    await ensureReady();
    void check({ force: false }).catch((error) => emit("check-error", { error: message(error) }));
  }

  async function dispose() {
    if (disposed) return { skipped: true, reason: "already disposed" };
    disposed = true;
    if (timer) clearIntervalImpl(timer);
    controller.abort();
    await Promise.allSettled([...jobs]);
    await lease?.dispose();
    const applied = await applyPending({ paths, config, now });
    emit("disposed", { applied });
    return applied;
  }

  return { start, check, stage, stageAvailable, status, dispose, get config() { return config; } };
}
