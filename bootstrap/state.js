import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export const SELF_STATE_SCHEMA_VERSION = 1;
export const BASELINE_RUNTIME = "baseline";

export function createSelfState() {
  return {
    schemaVersion: SELF_STATE_SCHEMA_VERSION,
    baselineCommit: null,
    current: BASELINE_RUNTIME,
    previous: null,
    candidate: null,
    lastFailure: null,
    lastCheck: null,
  };
}

export function isCommit(value) {
  return typeof value === "string" && /^[0-9a-f]{40}$/i.test(value) ? value.toLowerCase() : null;
}

function runtime(value, fallback) {
  return value === BASELINE_RUNTIME ? BASELINE_RUNTIME : isCommit(value) || fallback;
}

function check(input) {
  if (!input || typeof input !== "object" || !Number.isSafeInteger(input.checkedAt)) return null;
  return {
    checkedAt: input.checkedAt,
    status: typeof input.status === "string" ? input.status : "check-error",
    summary: typeof input.summary === "string" ? input.summary : "",
    current: isCommit(input.current),
    latest: isCommit(input.latest),
  };
}

export function normalizeSelfState(input) {
  const fallback = createSelfState();
  if (!input || input.schemaVersion !== SELF_STATE_SCHEMA_VERSION || typeof input !== "object") return fallback;
  const current = runtime(input.current, BASELINE_RUNTIME);
  return {
    schemaVersion: SELF_STATE_SCHEMA_VERSION,
    baselineCommit: isCommit(input.baselineCommit),
    current,
    previous: runtime(input.previous, null),
    candidate: isCommit(input.candidate),
    lastFailure: typeof input.lastFailure === "string" ? input.lastFailure : null,
    lastCheck: check(input.lastCheck),
  };
}

export async function loadSelfState(paths) {
  try {
    return normalizeSelfState(JSON.parse(await readFile(paths.selfStatePath, "utf8")));
  } catch (error) {
    if (error?.code === "ENOENT") return createSelfState();
    return createSelfState();
  }
}

export async function saveSelfState(paths, state) {
  const temporary = join(dirname(paths.selfStatePath), `.${randomUUID()}.tmp`);
  const text = `${JSON.stringify(normalizeSelfState(state), null, 2)}\n`;
  await mkdir(dirname(paths.selfStatePath), { recursive: true });
  try {
    await writeFile(temporary, text, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, paths.selfStatePath);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}
