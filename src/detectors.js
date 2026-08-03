import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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

function within(parent, child) {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function addEvidence(evidence, value) {
  if (!evidence.includes(value)) evidence.push(value);
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
  const includes = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, "").trim();
    if (!line || line.startsWith("#")) continue;
    const include = line.match(/^(?:-r|--requirement)(?:\s+|=)(.+)$/);
    if (include) {
      includes.push(include[1].trim().split(/\s+/)[0]);
      continue;
    }
    if (line.startsWith("-")) continue;
    const directGit = line.match(/^([\w.-]+)(?:\[[^\]]+\])?\s*@\s*git\+(.+?)@([^\s#]+)(?:#.*)?$/);
    if (directGit) {
      git.push({ name: directGit[1], url: sanitizeUrl(directGit[2]), ref: directGit[3] });
      continue;
    }
    const exact = line.match(/^([\w.-]+)(?:\[[^\]]+\])?==([^\s;#]+)$/);
    if (exact) pypi.push({ name: exact[1], version: exact[2] });
  }
  return { git, pypi, includes };
}

async function readRequirements(path, target, seen) {
  const requirementsPath = resolve(path);
  if (!within(target, requirementsPath) || seen.has(requirementsPath)) {
    return { git: [], pypi: [], files: [] };
  }
  const entry = await stat(requirementsPath).catch(() => null);
  if (!entry?.isFile()) return { git: [], pypi: [], files: [] };

  seen.add(requirementsPath);
  const requirements = parseRequirements(await readText(requirementsPath));
  const result = { git: [...requirements.git], pypi: [...requirements.pypi], files: [requirementsPath] };
  for (const include of requirements.includes) {
    const nested = await readRequirements(resolve(dirname(requirementsPath), include), target, seen);
    result.git.push(...nested.git);
    result.pypi.push(...nested.pypi);
    result.files.push(...nested.files);
  }
  return result;
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
  return readPackage(join(entrypointStat.isDirectory() ? entrypoint : dirname(entrypoint), "package.json"));
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

async function metadataRoots(target, entrypoints = []) {
  const candidates = [target, join(target, "source"), join(target, "runtime")];
  for (const entrypoint of entrypoints) {
    const entry = await stat(entrypoint).catch(() => null);
    let current = entry?.isDirectory() ? entrypoint : dirname(entrypoint);
    while (within(target, current)) {
      candidates.push(current);
      if (current === target) break;
      current = dirname(current);
    }
  }
  const roots = [];
  for (const root of candidates) {
    if (!roots.includes(root) && (await stat(root).catch(() => null))?.isDirectory()) roots.push(root);
  }
  return roots;
}

function evidencePath(target, path) {
  return relative(target, path) || ".";
}

function metadataEvidence(target, root, filename) {
  const path = evidencePath(target, root);
  return path === "." ? filename : `${path}/${filename}`;
}

async function packageLockLayers(root) {
  const lock = await readPackage(join(root, "package-lock.json"));
  const dependencies = lock?.packages?.[""]?.dependencies;
  if (!dependencies || typeof dependencies !== "object") return [];
  return Object.keys(dependencies).flatMap((name) => {
    const version = lock.packages[`node_modules/${name}`]?.version;
    return exactVersion(version) ? [{ type: "npm", name, version, repository: null }] : [];
  });
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
  const roots = await metadataRoots(component.target, record?.entrypoints);
  const seenRequirements = new Set();
  let worktree;
  for (const root of roots) {
    for (const filename of ["requirements.in", "requirements.txt"]) {
      const requirements = await readRequirements(join(root, filename), component.target, seenRequirements);
      for (const entry of requirements.git) addLayer(layers, { type: "git", ...entry, current: entry.ref });
      for (const entry of requirements.pypi) addLayer(layers, { type: "pypi", ...entry });
      for (const path of requirements.files) addEvidence(evidence, evidencePath(component.target, path));
    }

    const nestedWorktree = await gitWorktree(root, run);
    if (nestedWorktree) {
      addLayer(layers, { type: "git", ...nestedWorktree });
      addEvidence(evidence, metadataEvidence(component.target, root, ".git"));
      worktree ||= nestedWorktree;
    }

    const packagePath = join(root, "package.json");
    const pkg = await readPackage(packagePath);
    if (pkg) {
      const rootNpm = npmLayer(pkg);
      if (rootNpm) addLayer(layers, rootNpm);
      const exactDependencies = Object.entries(pkg.dependencies || {}).filter(([, version]) => exactVersion(version));
      if (!rootNpm && exactDependencies.length === 1) {
        const [name, version] = exactDependencies[0];
        addLayer(layers, { type: "npm", name, version, repository: null });
      }
      addEvidence(evidence, metadataEvidence(component.target, root, "package.json"));
    } else if (await exists(packagePath)) {
      addEvidence(evidence, metadataEvidence(component.target, root, "invalid package.json"));
    }
    for (const layer of await packageLockLayers(root)) addLayer(layers, layer);
    if (await exists(join(root, "package-lock.json"))) addEvidence(evidence, metadataEvidence(component.target, root, "package-lock.json"));
  }
  for (const entrypoint of record?.entrypoints || []) {
    if (entrypoint === component.target) continue;
    const nested = await packageAtEntrypoint(entrypoint);
    const nestedNpm = npmLayer(nested, { nested: true });
    if (nestedNpm) {
      addLayer(layers, nestedNpm);
      addEvidence(evidence, "plugin entrypoint package.json");
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
