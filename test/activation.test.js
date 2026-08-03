import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activateCandidate } from "../bootstrap/activation.js";
import { loadRuntimePlugin } from "../bootstrap/loader.js";
import { resolveBootstrapPaths } from "../bootstrap/paths.js";
import { createRuntimeManifest, RUNTIME_MANIFEST_FILE, runtimePath } from "../bootstrap/runtime.js";
import { loadSelfState, saveSelfState } from "../bootstrap/state.js";
import { createSelfUpdater } from "../bootstrap/self-update.js";

async function writeRuntime(root, name, { manifest = false, commit, throws = false } = {}) {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ type: "module" }));
  await writeFile(join(root, "runtime.js"), [
    "export const BOOTSTRAP_API = 1;",
    `export function createRuntimePlugin() { return { id: "opencode-component-updater", tui: () => ${throws ? `(() => { throw new Error("${name} failed"); })()` : JSON.stringify(name)} }; }`,
  ].join("\n"));
  if (manifest) {
    await writeFile(join(root, RUNTIME_MANIFEST_FILE), JSON.stringify(await createRuntimeManifest(root, commit)));
  }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "component-updater-activation-"));
  const pluginRoot = join(root, "plugin");
  const paths = resolveBootstrapPaths({ pluginRoot, env: {}, home: root });
  await writeRuntime(pluginRoot, "baseline");
  return { root, pluginRoot, paths };
}

async function candidate(paths, commit, name = "candidate") {
  const root = runtimePath(paths, commit);
  await writeRuntime(root, name, { manifest: true, commit });
  return root;
}

test("promotes a verified candidate before loading the runtime", async () => {
  const { paths, pluginRoot } = await fixture();
  const commit = "a".repeat(40);
  await candidate(paths, commit);
  await saveSelfState(paths, { schemaVersion: 1, current: "baseline", previous: null, candidate: commit });

  const plugin = await loadRuntimePlugin({ pluginRoot, paths });
  assert.equal(await plugin.tui(), "candidate");
  assert.deepEqual(await loadSelfState(paths), {
    schemaVersion: 1,
    baselineCommit: null,
    current: commit,
    previous: "baseline",
    candidate: null,
    lastFailure: null,
    lastCheck: null,
  });
});

test("does not promote while another OpenCode lease is live", async () => {
  const { paths, pluginRoot } = await fixture();
  const commit = "b".repeat(40);
  await candidate(paths, commit);
  await saveSelfState(paths, { schemaVersion: 1, current: "baseline", previous: null, candidate: commit });
  await mkdir(paths.instanceRoot, { recursive: true });
  await writeFile(join(paths.instanceRoot, "other.json"), JSON.stringify({ id: "other", heartbeatAt: 1_000 }));

  const result = await activateCandidate({ pluginRoot, paths, now: () => 1_001 });
  assert.equal(result.reason, "other OpenCode instances are active");
  assert.equal((await loadSelfState(paths)).candidate, commit);
});

test("rejects a tampered candidate and retains the active runtime", async () => {
  const { paths, pluginRoot } = await fixture();
  const commit = "c".repeat(40);
  const root = await candidate(paths, commit);
  await writeFile(join(root, "runtime.js"), "export const BOOTSTRAP_API = 1;\n");
  await saveSelfState(paths, { schemaVersion: 1, current: "baseline", previous: null, candidate: commit });

  const result = await activateCandidate({ pluginRoot, paths });
  assert.equal(result.reason, "candidate rejected");
  const state = await loadSelfState(paths);
  assert.equal(state.current, "baseline");
  assert.equal(state.candidate, null);
  assert.match(state.lastFailure, /hash mismatch/);
});

test("loader rolls a corrupt active runtime back to baseline", async () => {
  const { paths, pluginRoot } = await fixture();
  const commit = "d".repeat(40);
  const root = await candidate(paths, commit);
  await writeFile(join(root, "runtime.js"), "export const BOOTSTRAP_API = 2;\n");
  await saveSelfState(paths, { schemaVersion: 1, current: commit, previous: "baseline", candidate: null });

  const plugin = await loadRuntimePlugin({ pluginRoot, paths });
  assert.equal(await plugin.tui(), "baseline");
  const state = await loadSelfState(paths);
  assert.equal(state.current, "baseline");
  assert.match(state.lastFailure, /hash mismatch/);
  assert.equal(await readFile(join(pluginRoot, "runtime.js"), "utf8").then((text) => text.includes("baseline")), true);
});

test("loader rolls back when the active runtime fails during TUI initialization", async () => {
  const { paths, pluginRoot } = await fixture();
  const commit = "f".repeat(40);
  const root = runtimePath(paths, commit);
  await writeRuntime(root, "candidate", { manifest: true, commit, throws: true });
  await saveSelfState(paths, { schemaVersion: 1, current: commit, previous: "baseline", candidate: null });

  const plugin = await loadRuntimePlugin({ pluginRoot, paths });
  assert.equal(await plugin.tui(), "baseline");
  const state = await loadSelfState(paths);
  assert.equal(state.current, "baseline");
  assert.match(state.lastFailure, /candidate failed/);
});

test("stages rollback to the previous runtime for the next startup", async () => {
  const { paths, pluginRoot } = await fixture();
  const commit = "e".repeat(40);
  await candidate(paths, commit);
  await saveSelfState(paths, { schemaVersion: 1, current: commit, previous: "baseline", candidate: null });
  const selfUpdater = createSelfUpdater({ pluginRoot, paths, run: async () => ({ code: 1, stdout: "", stderr: "" }) });

  const rollback = await selfUpdater.rollback();
  assert.equal(rollback.commit, "baseline");
  assert.equal((await loadSelfState(paths)).candidate, "baseline");
  const activated = await activateCandidate({ pluginRoot, paths });
  assert.equal(activated.commit, "baseline");
  const state = await loadSelfState(paths);
  assert.equal(state.current, "baseline");
  assert.equal(state.previous, commit);
});
