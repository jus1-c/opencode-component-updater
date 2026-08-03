import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { BOOTSTRAP_API } from "./constants.js";
import { isCommit } from "./state.js";

export const RUNTIME_MANIFEST_FILE = ".opencode-component-updater-runtime.json";

function relativePath(root, path) {
  return relative(root, path).split(sep).join("/");
}

function allowedPath(path) {
  return path === "runtime.js" || path === "package.json" || path.startsWith("src/");
}

async function filesIn(root, path = root) {
  const entries = await readdir(path, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const target = join(path, entry.name);
    const stat = await lstat(target);
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
      throw new Error(`Runtime has unsupported file: ${relativePath(root, target)}`);
    }
    if (stat.isDirectory()) files.push(...await filesIn(root, target));
    else files.push(relativePath(root, target));
  }
  return files.sort();
}

export async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

export function runtimePath(paths, commit) {
  return join(paths.versionsRoot, commit);
}

export function runtimeManifestPath(paths, commit) {
  return join(runtimePath(paths, commit), RUNTIME_MANIFEST_FILE);
}

export async function createRuntimeManifest(root, commit) {
  if (!isCommit(commit)) throw new Error("Runtime commit must be a full SHA-1");
  const files = await filesIn(root);
  if (!files.includes("runtime.js") || !files.includes("package.json") || files.some((path) => !allowedPath(path))) {
    throw new Error("Runtime payload contains unsupported paths");
  }
  return {
    schemaVersion: 1,
    commit,
    bootstrapApi: BOOTSTRAP_API,
    files: await Promise.all(files.map(async (path) => ({ path, sha256: await sha256(join(root, path)) }))),
  };
}

export async function verifyRuntime(paths, commit) {
  if (!isCommit(commit)) throw new Error("Runtime commit must be a full SHA-1");
  const root = runtimePath(paths, commit);
  let manifest;
  try {
    manifest = JSON.parse(await readFile(runtimeManifestPath(paths, commit), "utf8"));
  } catch {
    throw new Error(`Runtime manifest is unreadable: ${commit}`);
  }
  if (manifest?.schemaVersion !== 1 || manifest.commit !== commit || manifest.bootstrapApi !== BOOTSTRAP_API || !Array.isArray(manifest.files)) {
    throw new Error(`Runtime manifest is invalid: ${commit}`);
  }
  const listed = manifest.files.map((entry) => entry?.path);
  if (!listed.length || new Set(listed).size !== listed.length || listed.some((path) => typeof path !== "string" || !allowedPath(path))) {
    throw new Error(`Runtime manifest has invalid files: ${commit}`);
  }
  const actual = (await filesIn(root)).filter((path) => path !== RUNTIME_MANIFEST_FILE);
  if (actual.length !== listed.length || actual.some((path, index) => path !== [...listed].sort()[index])) {
    throw new Error(`Runtime files do not match manifest: ${commit}`);
  }
  for (const entry of manifest.files) {
    if (typeof entry.sha256 !== "string" || !/^[0-9a-f]{64}$/i.test(entry.sha256) || await sha256(join(root, entry.path)) !== entry.sha256) {
      throw new Error(`Runtime hash mismatch: ${entry.path}`);
    }
  }
  return { root, manifest };
}

export async function validateRuntimeModule(paths, commit) {
  const verified = await verifyRuntime(paths, commit);
  const module = await import(pathToFileURL(join(verified.root, "runtime.js")).href);
  if (module.BOOTSTRAP_API !== BOOTSTRAP_API || typeof module.createRuntimePlugin !== "function") {
    throw new Error(`Incompatible updater runtime: ${commit}`);
  }
  return { ...verified, module };
}
