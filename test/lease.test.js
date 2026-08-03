import assert from "node:assert/strict";
import test from "node:test";
import { access, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLease, listLiveInstances } from "../src/lease.js";
import { resolveUpdaterPaths } from "../src/paths.js";

test("tracks live instances and prunes stale leases", async () => {
  const root = await mkdtemp(join(tmpdir(), "component-updater-lease-"));
  const paths = resolveUpdaterPaths({ pluginRoot: root, env: {}, home: root });
  let clock = 1_000;
  const timers = [];
  const lease = await createLease(paths, {
    id: "instance-a",
    now: () => clock,
    heartbeatMs: 10,
    setIntervalImpl: (fn) => {
      timers.push(fn);
      return { unref() {} };
    },
    clearIntervalImpl() {},
  });

  assert.equal((await listLiveInstances(paths, { now: () => clock, staleMs: 100 })).length, 1);
  clock += 101;
  assert.equal((await listLiveInstances(paths, { now: () => clock, staleMs: 100 })).length, 0);
  await lease.dispose();
});

test("prunes corrupt lease files", async () => {
  const root = await mkdtemp(join(tmpdir(), "component-updater-lease-"));
  const paths = resolveUpdaterPaths({ pluginRoot: root, env: {}, home: root });
  await writeFile(join(paths.instanceRoot, "broken.json"), "not json").catch(async () => {
    await (await import("node:fs/promises")).mkdir(paths.instanceRoot, { recursive: true });
    await writeFile(join(paths.instanceRoot, "broken.json"), "not json");
  });
  assert.deepEqual(await listLiveInstances(paths, { staleMs: 100 }), []);
});

test("can inspect stale leases without deleting them", async () => {
  const root = await mkdtemp(join(tmpdir(), "component-updater-lease-"));
  const paths = resolveUpdaterPaths({ pluginRoot: root, env: {}, home: root });
  await (await import("node:fs/promises")).mkdir(paths.instanceRoot, { recursive: true });
  const path = join(paths.instanceRoot, "stale.json");
  await writeFile(path, JSON.stringify({ id: "stale", heartbeatAt: 1 }));
  assert.deepEqual(await listLiveInstances(paths, { now: () => 1_000, staleMs: 100, prune: false }), []);
  await access(path);
});
