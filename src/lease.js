import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { readJson, writeJsonAtomic } from "./json.js";

function leasePath(paths, id) {
  return join(paths.instanceRoot, `${id}.json`);
}

export async function listLiveInstances(paths, { now = Date.now, staleMs } = {}) {
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
      await rm(path, { force: true }).catch(() => {});
      continue;
    }
    if (!instance?.id || !Number.isSafeInteger(instance.heartbeatAt)) {
      await rm(path, { force: true }).catch(() => {});
      continue;
    }
    if (now() - instance.heartbeatAt > staleMs) {
      await rm(path, { force: true }).catch(() => {});
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

  async function refresh() {
    if (disposed) return;
    await writeJsonAtomic(path, { id, pid, worktree, startedAt, heartbeatAt: now() });
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
      await rm(path, { force: true });
    },
  };
}
