import { readJson, writeJsonAtomic } from "./json.js";

const STATE_SCHEMA_VERSION = 1;

export function createState() {
  return { schemaVersion: STATE_SCHEMA_VERSION, components: {} };
}

export function normalizeState(input) {
  if (!input || input.schemaVersion !== STATE_SCHEMA_VERSION || !input.components || typeof input.components !== "object") {
    return createState();
  }
  return { schemaVersion: STATE_SCHEMA_VERSION, components: input.components };
}

export async function loadState(paths) {
  return normalizeState(await readJson(paths.statePath, createState()));
}

export async function saveState(paths, state) {
  await writeJsonAtomic(paths.statePath, normalizeState(state));
}

export function componentIdentity(id, component) {
  return `${component.scope}:${id}:${component.target || "external"}`;
}
