import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createConfig } from "../src/config.js";
import { createLease } from "../src/lease.js";
import { resolveUpdaterPaths } from "../src/paths.js";
import { applyPending, loadPending, stageComponent, validateManifest } from "../src/transaction.js";

async function write(path, text) {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, text);
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "component-updater-transaction-"));
  const target = join(root, "components", "example");
  await mkdir(join(target, "runtime"), { recursive: true });
  await write(join(target, "runtime", "version.txt"), "old\n");
  await write(join(target, "calibration.json"), "keep\n");
  const paths = resolveUpdaterPaths({ pluginRoot: join(root, "plugin"), env: {}, home: root });
  const config = createConfig({
    "plugin.example": {
      scope: "global",
      kind: "plugin",
      name: "example",
      target,
      enabled: true,
      autoUpdate: false,
      source: { mode: "custom" },
      policy: {
        apply: "manifest",
        dirty: "refuse",
        allowedPaths: ["runtime"],
        protectedPaths: ["calibration.json"],
      },
      check: { command: [] },
      update: { command: ["fake-update"], healthcheck: [] },
    },
  });
  return { root, target, paths, config };
}

function stagedRunner({ code = 0 } = {}) {
  return async (_command, options) => {
    if (code !== 0) return { code, stdout: "failed\n", stderr: "", reason: null };
    await mkdir(join(options.env.OPENCODE_UPDATER_STAGE, "runtime"), { recursive: true });
    await writeFile(join(options.env.OPENCODE_UPDATER_STAGE, "runtime", "version.txt"), "new\n");
    await writeFile(options.env.OPENCODE_UPDATER_MANIFEST, JSON.stringify({ schemaVersion: 1, paths: ["runtime"] }));
    return { code: 0, stdout: "old -> new\n", stderr: "", reason: null };
  };
}

test("stages without changing target, then applies only manifest-approved paths", async () => {
  const { target, paths, config } = await fixture();
  const update = await stageComponent({ paths, config, id: "plugin.example", run: stagedRunner() });
  assert.equal(await readFile(join(target, "runtime", "version.txt"), "utf8"), "old\n");
  assert.equal((await loadPending(paths)).updates["plugin.example"].stage, update.stage);

  const result = await applyPending({ paths, config });
  assert.equal(result.applied.length, 1);
  assert.equal(await readFile(join(target, "runtime", "version.txt"), "utf8"), "new\n");
  assert.equal(await readFile(join(target, "calibration.json"), "utf8"), "keep\n");
  assert.equal(await readFile(join(result.applied[0].backup, "runtime", "version.txt"), "utf8"), "old\n");
  assert.deepEqual((await loadPending(paths)).updates, {});
});

test("removes failed staging output and preserves target", async () => {
  const { target, paths, config } = await fixture();
  await assert.rejects(
    stageComponent({ paths, config, id: "plugin.example", run: stagedRunner({ code: 1 }) }),
    /Update command failed/,
  );
  assert.equal(await readFile(join(target, "runtime", "version.txt"), "utf8"), "old\n");
  assert.deepEqual((await loadPending(paths)).updates, {});
});

test("rejects manifests that target protected or escaping paths", async () => {
  const { target, config } = await fixture();
  const stage = join(dirname(target), ".component-updater-stage-test");
  await mkdir(join(stage, "calibration.json"), { recursive: true });
  await assert.rejects(
    validateManifest({ component: config.components["plugin.example"], stage, manifest: { schemaVersion: 1, paths: ["../escape"] } }),
    /escapes component root/,
  );
  await assert.rejects(
    validateManifest({ component: config.components["plugin.example"], stage, manifest: { schemaVersion: 1, paths: ["calibration.json"] } }),
    /not allowed/,
  );
});

test("rolls target back when a later path move fails", async () => {
  const { target, paths, config } = await fixture();
  config.components["plugin.example"].policy.allowedPaths = ["runtime", "other"];
  await mkdir(join(target, "other"), { recursive: true });
  await write(join(target, "other", "version.txt"), "old-other\n");
  const run = async (_command, options) => {
    await mkdir(join(options.env.OPENCODE_UPDATER_STAGE, "runtime"), { recursive: true });
    await mkdir(join(options.env.OPENCODE_UPDATER_STAGE, "other"), { recursive: true });
    await writeFile(join(options.env.OPENCODE_UPDATER_STAGE, "runtime", "version.txt"), "new\n");
    await writeFile(join(options.env.OPENCODE_UPDATER_STAGE, "other", "version.txt"), "new-other\n");
    await writeFile(options.env.OPENCODE_UPDATER_MANIFEST, JSON.stringify({ schemaVersion: 1, paths: ["runtime", "other"] }));
    return { code: 0, stdout: "", stderr: "", reason: null };
  };
  await stageComponent({ paths, config, id: "plugin.example", run });
  let failed = false;
  const move = async (from, to) => {
    if (!failed && from.includes("stage") && from.endsWith("/other") && to.endsWith("/other")) {
      failed = true;
      throw new Error("simulated rename failure");
    }
    await rename(from, to);
  };
  const result = await applyPending({ paths, config, move });
  assert.equal(result.failed.length, 1);
  assert.equal(await readFile(join(target, "runtime", "version.txt"), "utf8"), "old\n");
  assert.equal(await readFile(join(target, "other", "version.txt"), "utf8"), "old-other\n");
});

test("does not apply staged changes while another OpenCode instance holds a lease", async () => {
  const { target, paths, config } = await fixture();
  await stageComponent({ paths, config, id: "plugin.example", run: stagedRunner() });
  const lease = await createLease(paths, { heartbeatMs: 60_000 });
  const result = await applyPending({ paths, config });
  assert.equal(result.skipped, true);
  assert.equal(result.reason, "other OpenCode instances are active");
  assert.equal(await readFile(join(target, "runtime", "version.txt"), "utf8"), "old\n");
  await lease.dispose();
});
