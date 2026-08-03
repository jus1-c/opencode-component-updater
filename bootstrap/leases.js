import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export async function listLiveBootstrapLeases(paths, { now = Date.now, staleMs = 90_000 } = {}) {
  let files = [];
  try {
    files = await readdir(paths.instanceRoot);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const instances = [];
  for (const file of files.filter((name) => name.endsWith(".json"))) {
    try {
      const instance = JSON.parse(await readFile(join(paths.instanceRoot, file), "utf8"));
      if (instance?.id && Number.isSafeInteger(instance.heartbeatAt) && now() - instance.heartbeatAt <= staleMs) {
        instances.push(instance);
      }
    } catch {
      // Invalid leases are not evidence of a live OpenCode process.
    }
  }
  return instances;
}
