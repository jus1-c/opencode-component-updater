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

export async function acquireBootstrapLock(path, { now = Date.now, staleMs = 3_600_000 } = {}) {
  const token = randomUUID();
  const startedAt = now();
  await mkdir(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(path, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify({ token, startedAt })}\n`);
      await handle.close();
      return {
        async release() {
          const current = await readLock(path);
          if (current?.token === token) await rm(path, { force: true });
        },
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const current = await readLock(path);
      if (!current || !Number.isSafeInteger(current.startedAt) || startedAt - current.startedAt > staleMs) {
        await rm(path, { force: true });
        continue;
      }
      return null;
    }
  }
  return null;
}
