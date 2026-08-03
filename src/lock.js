import { mkdir, open, readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

async function readLock(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

export async function acquireLock(path, { staleMs, now = Date.now, pid = process.pid } = {}) {
  const token = randomUUID();
  const startedAt = now();

  await mkdir(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(path, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify({ token, pid, startedAt })}\n`);
      await handle.close();
      return {
        token,
        async release() {
          const current = await readLock(path);
          if (current?.token === token) await rm(path, { force: true });
        },
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const holder = await readLock(path);
      if (!holder || !Number.isSafeInteger(holder.startedAt)) {
        await rm(path, { force: true });
        continue;
      }
      if (!Number.isSafeInteger(staleMs) || staleMs <= 0 || startedAt - holder.startedAt <= staleMs) {
        return null;
      }
      await rm(path, { force: true });
    }
  }
  return null;
}
