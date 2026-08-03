import { fileURLToPath } from "node:url";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createConfig } from "./config.js";

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readJsonFile(path, errors) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") errors.push(`${path}: ${error.message}`);
    return {};
  }
}

function within(parent, child) {
  const path = relative(parent, child);
  return path && !path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path);
}

function localPath(spec, configRoot) {
  if (typeof spec !== "string") return null;
  if (spec.startsWith("file://")) return fileURLToPath(spec);
  if (isAbsolute(spec)) return spec;
  if (spec.startsWith(".")) return resolve(configRoot, spec);
  return null;
}

function component(id, kind, name, target, policy = "manual") {
  return {
    id,
    component: {
      scope: "global",
      kind,
      name,
      target,
      enabled: false,
      autoUpdate: false,
      source: { mode: "auto" },
      policy: { apply: policy, dirty: "refuse", allowedPaths: [], protectedPaths: [] },
      check: { command: [] },
      update: { command: [], healthcheck: [] },
    },
  };
}

function addRecord(records, record) {
  const previous = records.get(record.id);
  if (!previous) {
    records.set(record.id, record);
    return;
  }
  previous.active ||= record.active;
  previous.hints.push(...record.hints);
}

function ownerTarget(target, root) {
  if (!target || !within(root, target)) return target;
  return join(root, relative(root, target).split(sep)[0]);
}

function executableTarget(command, mcpsRoot) {
  if (!Array.isArray(command)) return null;
  for (const argument of command) {
    const path = localPath(argument, mcpsRoot);
    if (path && within(mcpsRoot, path)) return ownerTarget(path, mcpsRoot);
  }
  return null;
}

function pluginName(spec, target) {
  if (target) return basename(target);
  return typeof spec === "string" ? spec.replace(/^@/, "").replace(/[\\/]/g, "-") : "unknown";
}

async function childDirectories(root) {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith(".")).map((entry) => join(root, entry.name));
  } catch {
    return [];
  }
}

export async function discoverInventory(paths) {
  const errors = [];
  const records = new Map();
  const configRoot = paths.opencodeConfigRoot;
  const mcpsRoot = join(configRoot, "mcps");
  const pluginsRoot = join(configRoot, "plugins");
  const [opencode, tui] = await Promise.all([
    readJsonFile(join(configRoot, "opencode.json"), errors),
    readJsonFile(join(configRoot, "tui.json"), errors),
  ]);

  for (const [name, entry] of Object.entries(opencode.mcp || {})) {
    const target = entry?.type === "local" ? executableTarget(entry.command, mcpsRoot) : null;
    const id = `mcp.${name}`;
    addRecord(records, {
      ...component(id, "mcp", name, target, target ? "manual" : "none"),
      active: true,
      hints: [{ type: entry?.type === "remote" ? "remote" : target ? "local" : "system" }],
    });
  }

  for (const rawEntry of [...(opencode.plugin || []), ...(tui.plugin || [])]) {
    const spec = Array.isArray(rawEntry) ? rawEntry[0] : rawEntry;
    const target = localPath(spec, configRoot);
    const owner = ownerTarget(target, pluginsRoot);
    const name = pluginName(spec, owner);
    const id = `plugin.${name}`;
    addRecord(records, {
      ...component(id, "plugin", name, owner, owner ? "manual" : "none"),
      active: true,
      hints: [{ type: owner ? "local" : "npm", spec: typeof spec === "string" ? spec : "" }],
    });
  }

  for (const target of await childDirectories(mcpsRoot)) {
    const name = basename(target);
    addRecord(records, {
      ...component(`mcp.${name}`, "mcp", name, target),
      active: false,
      hints: [{ type: "local" }],
    });
  }
  for (const target of await childDirectories(pluginsRoot)) {
    const name = basename(target);
    addRecord(records, {
      ...component(`plugin.${name}`, "plugin", name, target),
      active: false,
      hints: [{ type: "local" }],
    });
  }

  return {
    errors,
    records: [...records.values()],
    config: createConfig(Object.fromEntries([...records.values()].map((record) => [record.id, record.component]))),
  };
}

export async function bootstrapConfig(paths, { inventory = discoverInventory } = {}) {
  if (await exists(paths.configPath)) return false;
  const discovered = await inventory(paths);
  const { saveConfig } = await import("./config.js");
  await saveConfig(paths, discovered.config);
  return true;
}
