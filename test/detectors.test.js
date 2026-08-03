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
