import { readJson, writeJsonAtomic } from "./json.js";

export const CONFIG_SCHEMA_VERSION = 1;

export const DEFAULTS = Object.freeze({
  checkIntervalHours: 24,
  checkTimeoutMs: 60_000,
  updateTimeoutMs: 1_800_000,
  toastDurationMs: 10_000,
  maxOutputBytes: 65_536,
  instanceHeartbeatMs: 15_000,
  staleInstanceMs: 90_000,
});

export function createConfig(components = {}) {
  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    defaults: { ...DEFAULTS },
    components,
  };
}

function positiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function normalizeDefaults(input = {}) {
  return Object.fromEntries(
    Object.entries(DEFAULTS).map(([key, fallback]) => [key, positiveInteger(input[key], fallback)]),
  );
}

function normalizeComponent(id, input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`Component ${id} must be an object`);
  }
  if (input.kind !== "mcp" && input.kind !== "plugin") {
    throw new Error(`Component ${id} must have kind mcp or plugin`);
  }
  if (typeof input.name !== "string" || !input.name) {
    throw new Error(`Component ${id} must have a name`);
  }
  if (input.target !== null && (typeof input.target !== "string" || !input.target)) {
    throw new Error(`Component ${id} must have a target path or null`);
  }

  return {
    scope: input.scope === "project" ? "project" : "global",
    kind: input.kind,
    name: input.name,
    target: input.target,
    enabled: input.enabled === true,
    autoUpdate: input.autoUpdate === true,
    source: {
      mode: input.source?.mode === "custom" ? "custom" : "auto",
    },
    policy: {
      apply: ["manifest", "manual", "none"].includes(input.policy?.apply) ? input.policy.apply : "manual",
      dirty: input.policy?.dirty === "allow" ? "allow" : "refuse",
      allowedPaths: Array.isArray(input.policy?.allowedPaths) ? input.policy.allowedPaths : [],
      protectedPaths: Array.isArray(input.policy?.protectedPaths) ? input.policy.protectedPaths : [],
    },
    check: {
      command: Array.isArray(input.check?.command) ? input.check.command : [],
    },
    update: {
      command: Array.isArray(input.update?.command) ? input.update.command : [],
      healthcheck: Array.isArray(input.update?.healthcheck) ? input.update.healthcheck : [],
    },
  };
}

export function normalizeConfig(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Component updater config must be an object");
  }
  if (input.schemaVersion !== CONFIG_SCHEMA_VERSION) {
    throw new Error(`Unsupported config schema version: ${input.schemaVersion}`);
  }
  if (!input.components || typeof input.components !== "object" || Array.isArray(input.components)) {
    throw new Error("Component updater config must include a components object");
  }

  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    defaults: normalizeDefaults(input.defaults),
    components: Object.fromEntries(
      Object.entries(input.components).map(([id, component]) => [id, normalizeComponent(id, component)]),
    ),
  };
}

export async function loadConfig(paths) {
  const config = await readJson(paths.configPath, null);
  return config ? normalizeConfig(config) : null;
}

export async function saveConfig(paths, config) {
  await writeJsonAtomic(paths.configPath, normalizeConfig(config));
}
