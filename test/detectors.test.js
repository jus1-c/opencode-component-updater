import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkDetectedSource, detectComponent } from "../src/detectors.js";

test("detects a pinned PyPI requirement and reports a newer registry version", async () => {
  const root = await mkdtemp(join(tmpdir(), "component-updater-detector-"));
  await writeFile(join(root, "requirements.in"), "example-package==1.2.3\n");
  const detection = await detectComponent({ target: root }, { run: async () => ({ code: 1, stdout: "", stderr: "" }) });
  assert.equal(detection.primary, "pypi");
  const checked = await checkDetectedSource(detection, {
    fetchImpl: async () => ({ ok: true, json: async () => ({ info: { version: "1.3.0" } }) }),
  });
  assert.deepEqual(checked, {
    status: "update-available",
    current: "1.2.3",
    latest: "1.3.0",
    summary: "1.2.3 -> 1.3.0",
  });
});

test("refuses automatic checks for dirty Git worktrees", async () => {
  const root = await mkdtemp(join(tmpdir(), "component-updater-detector-"));
  await mkdir(join(root, ".git"));
  const outputs = [
    { code: 0, stdout: "https://github.com/example/repo.git\n", stderr: "" },
    { code: 0, stdout: "0123456789012345678901234567890123456789\n", stderr: "" },
    { code: 0, stdout: " M file.js\n", stderr: "" },
  ];
  const detection = await detectComponent({ target: root }, { run: async () => outputs.shift() });
  assert.equal(detection.primary, "git");
  assert.equal(detection.dirty, true);
});

test("detects an exact nested npm plugin package from its configured entrypoint", async () => {
  const root = await mkdtemp(join(tmpdir(), "component-updater-detector-"));
  const entrypoint = join(root, "node_modules", "@vendor", "plugin");
  await mkdir(entrypoint, { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { "@vendor/plugin": "1.2.3" } }));
  await writeFile(join(entrypoint, "package.json"), JSON.stringify({ name: "@vendor/plugin", version: "1.2.3" }));
  const detection = await detectComponent({ target: root }, { record: { hints: [], entrypoints: [entrypoint] } });
  assert.equal(detection.primary, "npm");
  assert.deepEqual(detection.layers.find((layer) => layer.type === "npm"), {
    type: "npm",
    name: "@vendor/plugin",
    version: "1.2.3",
    repository: null,
  });
});

test("follows nested requirements files from a component owner", async () => {
  const root = await mkdtemp(join(tmpdir(), "component-updater-detector-"));
  const requirements = join(root, "source", "MCP_Server", "requirements.txt");
  await mkdir(join(root, "source", "MCP_Server"), { recursive: true });
  await writeFile(join(root, "requirements.in"), "-r source/MCP_Server/requirements.txt\n");
  await writeFile(requirements, "example-package==1.2.3\n");

  const detection = await detectComponent({ target: root }, { run: async () => ({ code: 1, stdout: "", stderr: "" }) });
  assert.equal(detection.primary, "pypi");
  assert.deepEqual(detection.layers.find((layer) => layer.type === "pypi"), {
    type: "pypi",
    name: "example-package",
    version: "1.2.3",
  });
  assert.ok(detection.evidence.includes("source/MCP_Server/requirements.txt"));
});

test("detects a Git worktree nested under source", async () => {
  const root = await mkdtemp(join(tmpdir(), "component-updater-detector-"));
  const source = join(root, "source");
  await mkdir(join(source, ".git"), { recursive: true });
  const outputs = [
    { code: 0, stdout: "https://github.com/example/repo.git\n", stderr: "" },
    { code: 0, stdout: "0123456789012345678901234567890123456789\n", stderr: "" },
    { code: 0, stdout: "", stderr: "" },
  ];

  const detection = await detectComponent({ target: root }, { run: async () => outputs.shift() });
  assert.equal(detection.primary, "git");
  assert.ok(detection.evidence.includes("source/.git"));
});

test("labels root metadata without a leading slash", async () => {
  const root = await mkdtemp(join(tmpdir(), "component-updater-detector-"));
  await mkdir(join(root, ".git"));
  const outputs = [
    { code: 0, stdout: "https://github.com/example/repo.git\n", stderr: "" },
    { code: 0, stdout: "0123456789012345678901234567890123456789\n", stderr: "" },
    { code: 0, stdout: "", stderr: "" },
  ];

  const detection = await detectComponent({ target: root }, { run: async () => outputs.shift() });
  assert.ok(detection.evidence.includes(".git"));
  assert.ok(!detection.evidence.includes("./.git"));
});

test("detects an exact runtime package from a nested npm lockfile", async () => {
  const root = await mkdtemp(join(tmpdir(), "component-updater-detector-"));
  const runtime = join(root, "runtime");
  const entrypoint = join(root, "bin", "agentmemory-wrapper.js");
  await mkdir(join(root, "bin"), { recursive: true });
  await mkdir(runtime, { recursive: true });
  await writeFile(entrypoint, "#!/usr/bin/env node\n");
  await writeFile(join(runtime, "package.json"), JSON.stringify({
    name: "mcp-runtime",
    version: "1.0.0",
    dependencies: { "@agentmemory/mcp": "^0.9.27" },
  }));
  await writeFile(join(runtime, "package-lock.json"), JSON.stringify({
    lockfileVersion: 3,
    packages: {
      "": { dependencies: { "@agentmemory/mcp": "^0.9.27" } },
      "node_modules/@agentmemory/mcp": { version: "0.9.27" },
    },
  }));

  const detection = await detectComponent({ target: root }, { record: { hints: [], entrypoints: [entrypoint] } });
  assert.equal(detection.primary, "npm");
  assert.deepEqual(detection.layers.find((layer) => layer.type === "npm"), {
    type: "npm",
    name: "@agentmemory/mcp",
    version: "0.9.27",
    repository: null,
  });
});
