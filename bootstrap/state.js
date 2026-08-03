import { readFile } from "node:fs/promises";

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
  };
}

function commit(value) {
  return typeof value === "string" && /^[0-9a-f]{40}$/i.test(value) ? value.toLowerCase() : null;
}

function runtime(value, fallback) {
  return value === BASELINE_RUNTIME || commit(value) ? value : fallback;
}

export function normalizeSelfState(input) {
  const fallback = createSelfState();
  if (!input || input.schemaVersion !== SELF_STATE_SCHEMA_VERSION || typeof input !== "object") return fallback;
  const current = runtime(input.current, BASELINE_RUNTIME);
  return {
    schemaVersion: SELF_STATE_SCHEMA_VERSION,
    baselineCommit: commit(input.baselineCommit),
    current,
    previous: runtime(input.previous, null),
    candidate: commit(input.candidate),
    lastFailure: typeof input.lastFailure === "string" ? input.lastFailure : null,
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
