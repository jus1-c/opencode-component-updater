import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig } from "../src/config.js";
import { runChecks } from "../src/engine.js";
import { resolveUpdaterPaths } from "../src/paths.js";

function component(overrides = {}) {
  return {
    scope: "global",
    kind: "plugin",
    name: "example",
    target: null,
    enabled: true,
    autoUpdate: false,
    source: { mode: "auto" },
    policy: { apply: "none", dirty: "refuse", allowedPaths: [], protectedPaths: [] },
    check: { command: ["fake-check"] },
    update: { command: [], healthcheck: [] },
    ...overrides,
  };
}

test("runs custom checks once per interval and force bypasses the gate", async () => {
  const root = await mkdtemp(join(tmpdir(), "component-updater-engine-"));
  const paths = resolveUpdaterPaths({ pluginRoot: root, env: {}, home: root });
  const config = createConfig({ "plugin.example": component() });
  let runs = 0;
  const run = async () => {
    runs += 1;
    return { code: 10, stdout: "1.0.0 -> 1.1.0\n", stderr: "", reason: null };
  };
  let clock = 1_000;
  const now = () => clock;

  const first = await runChecks({ paths, config, force: false, now, run });
  assert.equal(first.results[0].status, "update-available");
  assert.equal(runs, 1);
  clock += 1_000;
  const second = await runChecks({ paths, config, force: false, now, run });
  assert.equal(second.results[0].skipped, true);
  assert.equal(runs, 1);
  await runChecks({ paths, config, force: true, now, run });
  assert.equal(runs, 2);
});

test("does not run disabled components", async () => {
  const root = await mkdtemp(join(tmpdir(), "component-updater-engine-"));
  const paths = resolveUpdaterPaths({ pluginRoot: root, env: {}, home: root });
  const config = createConfig({ "plugin.example": component({ enabled: false }) });
  let runs = 0;
  const result = await runChecks({
    paths,
    config,
    force: true,
    run: async () => {
      runs += 1;
      return { code: 0, stdout: "", stderr: "", reason: null };
    },
  });
  assert.equal(result.results[0].status, "disabled");
  assert.equal(runs, 0);
});
