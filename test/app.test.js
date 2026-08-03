import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig, saveConfig } from "../src/config.js";
import { createUpdaterApp } from "../src/app.js";
import { resolveUpdaterPaths } from "../src/paths.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "component-updater-app-"));
  const target = join(root, "component");
  await mkdir(target, { recursive: true });
  const paths = resolveUpdaterPaths({ pluginRoot: join(root, "plugin"), env: {}, home: root });
  await saveConfig(paths, createConfig({
    "plugin.example": {
      scope: "global",
      kind: "plugin",
      name: "example",
      target,
      enabled: true,
      autoUpdate: false,
      source: { mode: "custom" },
      policy: { apply: "none", dirty: "refuse", allowedPaths: [], protectedPaths: [] },
      check: { command: ["check"] },
      update: { command: [], healthcheck: [] },
    },
  }));
  return { root, paths, target };
}

test("status is cached and does not spawn a check command", async () => {
  const { paths } = await fixture();
  let spawned = 0;
  let inventoried = 0;
  let timers = 0;
  const app = createUpdaterApp({
    paths,
    run: async () => {
      spawned += 1;
      return { code: 0, stdout: "", stderr: "", reason: null };
    },
    inventory: async () => {
      inventoried += 1;
      return { records: [] };
    },
    setIntervalImpl: () => {
      timers += 1;
      return { unref() {} };
    },
    clearIntervalImpl() {},
  });
  const snapshot = await app.status();
  assert.equal(snapshot.components.length, 1);
  assert.equal(spawned, 0);
  assert.equal(inventoried, 0);
  assert.equal(timers, 0);
  assert.equal(app.config, undefined);
  assert.deepEqual(await app.dispose(), { skipped: true, reason: "not started" });
});

test("first status is read-only when config has not been bootstrapped", async () => {
  const root = await mkdtemp(join(tmpdir(), "component-updater-app-"));
  const paths = resolveUpdaterPaths({ pluginRoot: join(root, "plugin"), env: {}, home: root });
  let timers = 0;
  const app = createUpdaterApp({
    paths,
    inventory: async () => ({ config: createConfig({ "plugin.example": {
      kind: "plugin",
      name: "example",
      target: join(root, "component"),
    } }) }),
    setIntervalImpl: () => {
      timers += 1;
      return { unref() {} };
    },
    clearIntervalImpl() {},
  });

  const snapshot = await app.status();
  assert.equal(snapshot.components[0].id, "plugin.example");
  assert.equal(timers, 0);
  await assert.rejects(stat(paths.configPath), { code: "ENOENT" });
  await assert.rejects(stat(paths.instanceRoot), { code: "ENOENT" });
  assert.deepEqual(await app.dispose(), { skipped: true, reason: "not started" });
});

test("manual check joins the startup check and updates cached status", async () => {
  const { paths } = await fixture();
  let clock = 1_000;
  const events = [];
  const app = createUpdaterApp({
    paths,
    now: () => clock,
    run: async () => ({ code: 10, stdout: "1 -> 2\n", stderr: "", reason: null }),
    inventory: async () => ({ records: [] }),
    setIntervalImpl: () => ({ unref() {} }),
    clearIntervalImpl() {},
    onEvent: (event) => events.push(event),
  });
  await app.start();
  await app.check({ force: true });
  const snapshot = await app.status();
  assert.equal(snapshot.components[0].status, "update-available");
  assert.ok(events.some((event) => event.type === "check-complete"));
  const dispose = await app.dispose();
  assert.equal(dispose.skipped, false);
});

test("startup backfills newly discovered components without replacing config", async () => {
  const { paths } = await fixture();
  const app = createUpdaterApp({
    paths,
    inventory: async () => ({ config: createConfig({ "plugin.discovered": {
      kind: "plugin",
      name: "discovered",
      target: "/lab/discovered",
    } }), records: [] }),
    run: async () => ({ code: 0, stdout: "", stderr: "", reason: null }),
    setIntervalImpl: () => ({ unref() {} }),
    clearIntervalImpl() {},
  });

  await app.start();
  assert.equal(app.config.components["plugin.example"].enabled, true);
  assert.equal(app.config.components["plugin.discovered"].enabled, false);
  await app.dispose();
});

test("stage available excludes the updater self component", async () => {
  const { paths, target } = await fixture();
  const config = await (await import("../src/config.js")).loadConfig(paths);
  config.components["plugin.component-updater"] = {
    ...config.components["plugin.example"],
    name: "component-updater",
    target,
  };
  await (await import("../src/config.js")).saveConfig(paths, config);
  let stages = 0;
  const app = createUpdaterApp({
    paths,
    inventory: async () => ({ records: [] }),
    run: async (_command, options) => {
      if (options?.env?.OPENCODE_UPDATER_STAGE) stages += 1;
      return { code: 0, stdout: "", stderr: "", reason: null };
    },
    setIntervalImpl: () => ({ unref() {} }),
    clearIntervalImpl() {},
  });
  await app.start();
  const result = await app.stageAvailable();
  assert.deepEqual(result, []);
  assert.equal(stages, 0);
  await app.dispose();
});

test("scheduled checks report failures instead of rejecting unhandled", async () => {
  const { paths } = await fixture();
  const events = [];
  let inventoryCalls = 0;
  let interval;
  const app = createUpdaterApp({
    paths,
    inventory: async () => {
      inventoryCalls += 1;
      if (inventoryCalls > 2) throw new Error("scheduled inventory failure");
      return { records: [] };
    },
    setIntervalImpl: (callback) => {
      interval = callback;
      return { unref() {} };
    },
    clearIntervalImpl() {},
    onEvent: (event) => events.push(event),
  });

  await app.start();
  await new Promise((resolve) => setImmediate(resolve));
  interval();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(events.some((event) => event.type === "check-error" && /scheduled inventory failure/.test(event.error)));
  await app.dispose();
});

test("failed startup does not attempt a pending apply on dispose", async () => {
  const root = await mkdtemp(join(tmpdir(), "component-updater-app-"));
  const paths = resolveUpdaterPaths({ pluginRoot: join(root, "plugin"), env: {}, home: root });
  const app = createUpdaterApp({
    paths,
    inventory: async () => { throw new Error("inventory unavailable"); },
    setIntervalImpl: () => ({ unref() {} }),
    clearIntervalImpl() {},
  });
  await assert.rejects(app.start(), /inventory unavailable/);
  assert.deepEqual(await app.dispose(), { skipped: true, reason: "not started" });
});
