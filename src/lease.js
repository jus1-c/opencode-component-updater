import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { readJson, writeJsonAtomic } from "./json.js";

function leasePath(paths, id) {
  return join(paths.instanceRoot, `${id}.json`);
}

export async function listLiveInstances(paths, { now = Date.now, staleMs } = {}) {
  const prune = arguments[1]?.prune !== false;
  let files = [];
  try {
    files = await readdir(paths.instanceRoot);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const instances = [];
  for (const file of files.filter((file) => file.endsWith(".json"))) {
    const path = join(paths.instanceRoot, file);
    let instance;
    try {
      instance = await readJson(path, null);
    } catch {
      if (prune) await rm(path, { force: true }).catch(() => {});
      continue;
    }
    if (!instance?.id || !Number.isSafeInteger(instance.heartbeatAt)) {
      if (prune) await rm(path, { force: true }).catch(() => {});
      continue;
    }
    if (now() - instance.heartbeatAt > staleMs) {
      if (prune) await rm(path, { force: true }).catch(() => {});
      continue;
    }
    instances.push(instance);
  }
  return instances;
}

export async function createLease(paths, {
  id = randomUUID(),
  now = Date.now,
  pid = process.pid,
  worktree = "",
  heartbeatMs,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
} = {}) {
  const path = leasePath(paths, id);
  const startedAt = now();
  let disposed = false;
  let refreshInFlight;

  async function refresh() {
    if (disposed) return;
    const write = writeJsonAtomic(path, { id, pid, worktree, startedAt, heartbeatAt: now() });
    refreshInFlight = write;
    try {
      await write;
    } finally {
      if (refreshInFlight === write) refreshInFlight = undefined;
    }
  }

  await refresh();
  const timer = setIntervalImpl(() => {
    void refresh();
  }, heartbeatMs);
  timer.unref?.();

  return {
    id,
    path,
    refresh,
    async dispose() {
      if (disposed) return;
      disposed = true;
      clearIntervalImpl(timer);
      await refreshInFlight?.catch(() => {});
      await rm(path, { force: true });
    },
  };
}
