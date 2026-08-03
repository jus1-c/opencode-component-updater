import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { firstOutputLine, runCommand } from "./process.js";

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readText(path) {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

function sanitizeUrl(value) {
  try {
    const url = new URL(value.replace(/^git\+/, ""));
    url.username = "";
    url.password = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return value.replace(/\/\/.+@/, "//");
  }
}

function parseRequirements(text) {
  const git = [];
  const pypi = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, "").trim();
    if (!line || line.startsWith("#") || line.startsWith("-")) continue;
    const directGit = line.match(/^([\w.-]+)(?:\[[^\]]+\])?\s*@\s*git\+(.+?)@([^\s#]+)(?:#.*)?$/);
    if (directGit) {
      git.push({ name: directGit[1], url: sanitizeUrl(directGit[2]), ref: directGit[3] });
      continue;
    }
    const exact = line.match(/^([\w.-]+)(?:\[[^\]]+\])?==([^\s;#]+)$/);
    if (exact) pypi.push({ name: exact[1], version: exact[2] });
  }
  return { git, pypi };
}

function parseRepository(repository) {
  if (typeof repository === "string") return sanitizeUrl(repository);
  if (repository && typeof repository.url === "string") return sanitizeUrl(repository.url);
  return null;
}

function exactVersion(value) {
  return /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value || "");
}

function parseNpmSpecifier(spec) {
  if (typeof spec !== "string" || !spec || spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("file:")) return null;
  const scoped = spec.match(/^(@[^/]+\/[^@]+)@(.+)$/);
  if (scoped) return { name: scoped[1], version: scoped[2] };
  const unscoped = spec.match(/^([^@/][^@]*)@(.+)$/);
  if (unscoped) return { name: unscoped[1], version: unscoped[2] };
  if (/^@[^/]+\/[^@]+$/.test(spec) || /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(spec)) return { name: spec, version: null };
  return null;
}

function compareVersions(left, right) {
  const parse = (value) => value.replace(/^v/, "").split("-")[0].split(".").map(Number);
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

function sourceResult(primary, layers, evidence, extra = {}) {
  return { primary, layers, evidence, confidence: primary === "local" ? "low" : "high", ...extra };
}

function addLayer(layers, layer) {
  if (!layers.some((existing) => existing.type === layer.type && existing.name === layer.name && existing.version === layer.version && existing.url === layer.url)) {
    layers.push(layer);
  }
}

async function readPackage(path) {
  try {
    return JSON.parse(await readText(path) || "null");
  } catch {
    return null;
  }
}

async function packageAtEntrypoint(entrypoint) {
  const entrypointStat = await stat(entrypoint).catch(() => null);
  if (!entrypointStat) return null;
  return readPackage(join(entrypointStat.isDirectory() ? entrypoint : new URL(".", `file://${entrypoint}`).pathname, "package.json"));
}

function npmLayer(pkg, { nested = false } = {}) {
  if (!pkg?.name || !exactVersion(pkg.version) || pkg.private || (!nested && !pkg.repository)) return null;
  return { type: "npm", name: pkg.name, version: pkg.version, repository: parseRepository(pkg.repository) };
}

async function gitWorktree(target, run) {
  if (!(await exists(join(target, ".git")))) return null;
  const options = { cwd: target, timeoutMs: 5_000, maxOutputBytes: 8_192 };
  const [url, head, dirty] = await Promise.all([
    run(["git", "remote", "get-url", "origin"], options),
    run(["git", "rev-parse", "HEAD"], options),
    run(["git", "status", "--porcelain"], options),
  ]);
  if (url.code !== 0 || head.code !== 0) return null;
  return {
    url: sanitizeUrl(firstOutputLine(url)),
    current: firstOutputLine(head),
    dirty: dirty.code === 0 && Boolean(firstOutputLine(dirty)),
  };
}

export async function detectComponent(component, { record, run = runCommand } = {}) {
  const hints = record?.hints || [];
  if (hints.some((hint) => hint.type === "remote")) {
    return sourceResult("remote", [{ type: "remote" }], ["opencode.json:mcp"]);
  }
  if (!component.target) {
    const npmHint = hints.find((hint) => hint.type === "npm");
    const parsed = parseNpmSpecifier(npmHint?.spec);
    return sourceResult(parsed ? "npm" : "system", [parsed ? { type: "npm", ...parsed } : { type: "system" }], ["OpenCode config"]);
  }

  const layers = [];
  const evidence = [];
  const requirements = parseRequirements(await readText(join(component.target, "requirements.in")));
  if (requirements.git.length) {
    addLayer(layers, { type: "git", ...requirements.git[0], current: requirements.git[0].ref });
    evidence.push("requirements.in");
  }
  if (requirements.pypi.length) {
    addLayer(layers, { type: "pypi", ...requirements.pypi[0] });
    evidence.push("requirements.in");
  }

  const worktree = await gitWorktree(component.target, run);
  if (worktree) {
    layers.unshift({ type: "git", ...worktree });
    evidence.push(".git");
  }

  const pkg = await readPackage(join(component.target, "package.json"));
  if (pkg) {
    const rootNpm = npmLayer(pkg);
    if (rootNpm) addLayer(layers, rootNpm);
    const exactDependencies = Object.entries(pkg.dependencies || {}).filter(([, version]) => exactVersion(version));
    if (!rootNpm && exactDependencies.length === 1) {
      const [name, version] = exactDependencies[0];
      addLayer(layers, { type: "npm", name, version, repository: null });
    }
    evidence.push("package.json");
  } else if (await exists(join(component.target, "package.json"))) {
    evidence.push("invalid package.json");
  }
  for (const entrypoint of record?.entrypoints || []) {
    if (entrypoint === component.target) continue;
    const nested = await packageAtEntrypoint(entrypoint);
    const nestedNpm = npmLayer(nested, { nested: true });
    if (nestedNpm) {
      addLayer(layers, nestedNpm);
      evidence.push("plugin entrypoint package.json");
    }
  }
  if (await exists(join(component.target, ".venv"))) layers.push({ type: "python-venv", path: ".venv" });
  if (await exists(join(component.target, "node_modules"))) layers.push({ type: "node-runtime", path: "node_modules" });

  const primaryLayer = layers.find((layer) => layer.type === "git") || layers.find((layer) => layer.type === "npm") || layers.find((layer) => layer.type === "pypi");
  return sourceResult(primaryLayer?.type || "local", layers, evidence, { dirty: Boolean(worktree?.dirty) });
}

function firstRemoteHash(output) {
  const match = output.match(/^([0-9a-f]{40})\s/m);
  return match?.[1] || null;
}

async function fetchJson(url, fetchImpl) {
  const response = await fetchImpl(url, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

export async function checkDetectedSource(detection, { fetchImpl = globalThis.fetch, run = runCommand, timeoutMs, maxOutputBytes } = {}) {
  const source = detection.layers.find((layer) => layer.type === detection.primary);
  if (detection.primary === "remote" || detection.primary === "system" || detection.primary === "local" || !source) {
    return { status: "manual-only", summary: `${detection.primary} source requires a custom check` };
  }
  try {
    if (source.type === "git") {
      if (!source.url || !source.current || !/^[0-9a-f]{40}$/i.test(source.current)) {
        return { status: "manual-only", summary: "Git ref is not a pinned commit" };
      }
      const remote = await run(["git", "ls-remote", source.url, "HEAD"], { timeoutMs, maxOutputBytes });
      const latest = remote.code === 0 ? firstRemoteHash(remote.stdout) : null;
      if (!latest) throw new Error(firstOutputLine(remote) || "git ls-remote failed");
      return latest === source.current
        ? { status: "current", current: source.current, latest, summary: source.current.slice(0, 7) }
        : { status: "update-available", current: source.current, latest, summary: `${source.current.slice(0, 7)} -> ${latest.slice(0, 7)}` };
    }
    if (source.type === "npm") {
      if (!source.name || !exactVersion(source.version)) return { status: "manual-only", summary: "npm version is not exact semver" };
      const metadata = await fetchJson(`https://registry.npmjs.org/${encodeURIComponent(source.name)}`, fetchImpl);
      const latest = metadata?.["dist-tags"]?.latest;
      if (!exactVersion(latest)) throw new Error("npm metadata has no exact latest version");
      const comparison = compareVersions(source.version, latest);
      return comparison >= 0
        ? { status: "current", current: source.version, latest, summary: source.version }
        : { status: "update-available", current: source.version, latest, summary: `${source.version} -> ${latest}` };
    }
    if (source.type === "pypi") {
      if (!exactVersion(source.version)) return { status: "manual-only", summary: "PyPI version is not exact semver" };
      const metadata = await fetchJson(`https://pypi.org/pypi/${encodeURIComponent(source.name)}/json`, fetchImpl);
      const latest = metadata?.info?.version;
      if (!exactVersion(latest)) throw new Error("PyPI metadata has no exact latest version");
      const comparison = compareVersions(source.version, latest);
      return comparison >= 0
        ? { status: "current", current: source.version, latest, summary: source.version }
        : { status: "update-available", current: source.version, latest, summary: `${source.version} -> ${latest}` };
    }
  } catch (error) {
    return { status: "check-error", summary: error instanceof Error ? error.message : String(error) };
  }
  return { status: "manual-only", summary: "No supported source check" };
}
