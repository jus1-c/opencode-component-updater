import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRuntimePlugin } from "../bootstrap/loader.js";
import { resolveBootstrapPaths } from "../bootstrap/paths.js";
import { createRuntimeManifest, RUNTIME_MANIFEST_FILE } from "../bootstrap/runtime.js";
import { BASELINE_RUNTIME, normalizeSelfState } from "../bootstrap/state.js";

async function writeRuntime(root, name) {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "runtime.js"), [
    "export const BOOTSTRAP_API = 1;",
    `export function createRuntimePlugin() { return { id: "opencode-component-updater", tui: () => "${name}" }; }`,
  ].join("\n"));
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "component-updater-bootstrap-"));
  const pluginRoot = join(root, "plugin");
  const paths = resolveBootstrapPaths({ pluginRoot, env: {}, home: root });
  await writeRuntime(pluginRoot, "baseline");
  return { paths, pluginRoot };
}

test("loads the immutable baseline runtime by default", async () => {
  const { paths, pluginRoot } = await fixture();
  const plugin = await loadRuntimePlugin({ pluginRoot, paths });
  assert.equal(await plugin.tui(), "baseline");
});

test("loads the selected versioned runtime", async () => {
  const { paths, pluginRoot } = await fixture();
  const commit = "a".repeat(40);
  const runtime = join(paths.versionsRoot, commit);
  await writeRuntime(runtime, "candidate");
  await writeFile(join(runtime, "package.json"), JSON.stringify({ type: "module" }));
  await mkdir(join(runtime, "src"));
  await writeFile(join(runtime, "src", "placeholder.js"), "export {};\n");
  await writeFile(join(runtime, RUNTIME_MANIFEST_FILE), JSON.stringify(await createRuntimeManifest(runtime, commit)));
  await mkdir(join(paths.stateRoot), { recursive: true });
  await writeFile(paths.selfStatePath, JSON.stringify({
    schemaVersion: 1,
    current: commit,
    previous: BASELINE_RUNTIME,
    candidate: null,
  }));

  const plugin = await loadRuntimePlugin({ pluginRoot, paths });
  assert.equal(await plugin.tui(), "candidate");
});

test("falls back to the previous runtime when selected runtime is invalid", async () => {
  const { paths, pluginRoot } = await fixture();
  const commit = "b".repeat(40);
  await mkdir(join(paths.versionsRoot, commit), { recursive: true });
  await writeFile(join(paths.versionsRoot, commit, "runtime.js"), "export const BOOTSTRAP_API = 2;\n");
  await mkdir(join(paths.stateRoot), { recursive: true });
  await writeFile(paths.selfStatePath, JSON.stringify({
    schemaVersion: 1,
    current: commit,
    previous: BASELINE_RUNTIME,
    candidate: null,
  }));

  const plugin = await loadRuntimePlugin({ pluginRoot, paths });
  assert.equal(await plugin.tui(), "baseline");
});

test("normalizes untrusted self-update state", () => {
  assert.deepEqual(normalizeSelfState({
    schemaVersion: 1,
    current: "not-a-commit",
    previous: "f".repeat(40),
    candidate: "not-a-commit",
  }), {
    schemaVersion: 1,
    baselineCommit: null,
    current: BASELINE_RUNTIME,
    previous: "f".repeat(40),
    candidate: null,
    lastFailure: null,
    lastCheck: null,
  });
});

test("rejects manifest paths that could escape a versioned runtime", async () => {
  const { paths } = await fixture();
  const commit = "c".repeat(40);
  const runtime = join(paths.versionsRoot, commit);
  await writeRuntime(runtime, "candidate");
  await writeFile(join(runtime, "package.json"), JSON.stringify({ type: "module" }));
  await mkdir(join(runtime, "src"));
  await writeFile(join(runtime, "src", "placeholder.js"), "export {};\n");
  const manifest = await createRuntimeManifest(runtime, commit);
  manifest.files[0].path = "src/../runtime.js";
  await writeFile(join(runtime, RUNTIME_MANIFEST_FILE), JSON.stringify(manifest));
  await mkdir(join(paths.stateRoot), { recursive: true });
  await writeFile(paths.selfStatePath, JSON.stringify({ schemaVersion: 1, current: commit, previous: BASELINE_RUNTIME }));

  const plugin = await loadRuntimePlugin({ pluginRoot: paths.pluginRoot, paths });
  assert.equal(await plugin.tui(), "baseline");
});
