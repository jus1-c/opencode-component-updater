import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
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
  const app = createUpdaterApp({
    paths,
    run: async () => {
      spawned += 1;
      return { code: 0, stdout: "", stderr: "", reason: null };
    },
    inventory: async () => ({ records: [] }),
    setIntervalImpl: () => ({ unref() {} }),
    clearIntervalImpl() {},
  });
  const snapshot = await app.status();
  assert.equal(snapshot.components.length, 1);
  assert.equal(spawned, 0);
  await app.dispose();
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
