import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSelfUpdater } from "../bootstrap/self-update.js";
import { runtimePath, verifyRuntime } from "../bootstrap/runtime.js";
import { resolveBootstrapPaths } from "../bootstrap/paths.js";
import { loadSelfState } from "../bootstrap/state.js";
import { runCommand } from "../src/process.js";

async function git(command, options = {}) {
  const output = await runCommand(["git", ...command], options);
  assert.equal(output.code, 0, `${command.join(" ")}: ${output.stderr || output.stdout}`);
  return output.stdout.trim();
}

async function writeSource(root, marker) {
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "test"), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({
    name: "opencode-component-updater",
    type: "module",
    repository: { type: "git", url: "REPOSITORY_URL" },
    opencodeComponentUpdater: { bootstrapApi: 1 },
    scripts: {
      check: "node --check runtime.js",
      test: "node --test test/smoke.test.js",
    },
  }, null, 2));
  await writeFile(join(root, "runtime.js"), [
    "import { marker } from \"./src/tui.js\";",
    "export const BOOTSTRAP_API = 1;",
    "export function createRuntimePlugin() {",
    "  return { id: \"opencode-component-updater\", tui: () => marker };",
    "}",
  ].join("\n"));
  await writeFile(join(root, "src", "tui.js"), `export const marker = ${JSON.stringify(marker)};\n`);
  await writeFile(join(root, "test", "smoke.test.js"), "import assert from 'node:assert/strict'; assert.ok(true);\n");
}

async function commit(root, message) {
  await git(["add", "-A"], { cwd: root });
  await git(["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", message], { cwd: root });
  return git(["rev-parse", "HEAD"], { cwd: root });
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "component-updater-self-"));
  const source = join(root, "source");
  const remote = join(root, "remote.git");
  const pluginRoot = join(root, "plugin");
  await mkdir(source, { recursive: true });
  await git(["init", "-b", "main"], { cwd: source });
  await writeSource(source, "one");
  const first = await commit(source, "first");
  await git(["init", "--bare", remote]);
  await git(["remote", "add", "origin", `file://${remote}`], { cwd: source });
  await git(["push", "-u", "origin", "main"], { cwd: source });
  await git(["clone", "--branch", "main", `file://${remote}`, pluginRoot]);
  const packagePath = join(source, "package.json");
  const pkg = JSON.parse(await readFile(packagePath, "utf8"));
  pkg.repository.url = `file://${remote}`;
  await writeFile(packagePath, JSON.stringify(pkg, null, 2));
  const packageCommit = await commit(source, "set repository");
  await git(["push"], { cwd: source });
  await git(["pull", "--ff-only"], { cwd: pluginRoot });
  const paths = resolveBootstrapPaths({ pluginRoot, env: {}, home: root });
  return { first, packageCommit, paths, pluginRoot, remote, root, source };
}

async function pushVersion(fixture, marker) {
  await writeSource(fixture.source, marker);
  const packagePath = join(fixture.source, "package.json");
  const pkg = JSON.parse(await readFile(packagePath, "utf8"));
  pkg.repository.url = `file://${fixture.remote}`;
  await writeFile(packagePath, JSON.stringify(pkg, null, 2));
  const sha = await commit(fixture.source, marker);
  await git(["push"], { cwd: fixture.source });
  return sha;
}

test("stages the checked Git commit without changing the running updater", async () => {
  const lab = await fixture();
  const latest = await pushVersion(lab, "two");
  const updater = createSelfUpdater({ pluginRoot: lab.pluginRoot, paths: lab.paths, run: runCommand });
  const checked = await updater.check();
  assert.deepEqual(checked, {
    status: "update-available",
    summary: `${lab.packageCommit.slice(0, 7)} -> ${latest.slice(0, 7)}`,
    current: lab.packageCommit,
    latest,
  });

  const staged = await updater.stage();
  assert.equal(staged.commit, latest);
  assert.equal((await loadSelfState(lab.paths)).candidate, latest);
  assert.match(await readFile(join(lab.pluginRoot, "src", "tui.js"), "utf8"), /one/);
  await verifyRuntime(lab.paths, latest);
  const files = JSON.parse(await readFile(join(runtimePath(lab.paths, latest), ".opencode-component-updater-runtime.json"), "utf8")).files.map((file) => file.path);
  assert.deepEqual(files, ["package.json", "runtime.js", "src/tui.js"]);
});

test("stages the checked SHA even when main advances after the check", async () => {
  const lab = await fixture();
  const checkedCommit = await pushVersion(lab, "two");
  const updater = createSelfUpdater({ pluginRoot: lab.pluginRoot, paths: lab.paths, run: runCommand });
  await updater.check();
  const newerCommit = await pushVersion(lab, "three");

  const staged = await updater.stage();
  assert.equal(staged.commit, checkedCommit);
  assert.notEqual(staged.commit, newerCommit);
});

test("rejects a rewritten main branch", async () => {
  const lab = await fixture();
  await git(["checkout", "--orphan", "rewrite"], { cwd: lab.source });
  await rm(join(lab.source, "package.json"));
  await rm(join(lab.source, "runtime.js"));
  await rm(join(lab.source, "src"), { recursive: true });
  await rm(join(lab.source, "test"), { recursive: true });
  await writeSource(lab.source, "rewritten");
  const packagePath = join(lab.source, "package.json");
  const pkg = JSON.parse(await readFile(packagePath, "utf8"));
  pkg.repository.url = `file://${lab.remote}`;
  await writeFile(packagePath, JSON.stringify(pkg, null, 2));
  const rewritten = await commit(lab.source, "rewritten");
  await git(["push", "--force", "origin", "HEAD:main"], { cwd: lab.source });
  const updater = createSelfUpdater({ pluginRoot: lab.pluginRoot, paths: lab.paths, run: runCommand });
  const checked = await updater.check();
  assert.equal(checked.latest, rewritten);
  await assert.rejects(updater.stage(), /not a fast-forward/);
  assert.equal((await loadSelfState(lab.paths)).candidate, null);
});

test("does not stage a commit that was not returned by the latest check", async () => {
  const lab = await fixture();
  const latest = await pushVersion(lab, "two");
  const updater = createSelfUpdater({ pluginRoot: lab.pluginRoot, paths: lab.paths, run: runCommand });
  await updater.check();
  await assert.rejects(updater.stage("f".repeat(40)), /does not match/);
  assert.equal((await loadSelfState(lab.paths)).candidate, null);
  await updater.stage(latest);
});
