import assert from "node:assert/strict";
import test from "node:test";
import { createTuiPlugin } from "../src/tui.js";

test("registers both component slash commands and disposes the updater app", async () => {
  const commands = [];
  const lifecycle = [];
  let started = 0;
  let disposed = 0;
  const app = {
    start: async () => { started += 1; },
    dispose: async () => { disposed += 1; },
    status: async () => ({ components: [], instances: [] }),
    check: async () => {},
    stage: async () => {},
    stageAvailable: async () => [],
  };
  const api = {
    state: { path: { worktree: "/lab" } },
    keymap: { registerLayer: (layer) => commands.push(...layer.commands) },
    lifecycle: { onDispose: (fn) => lifecycle.push(fn) },
    ui: {
      toast() {},
      dialog: { replace() {}, clear() {} },
      DialogAlert: (props) => props,
      DialogConfirm: (props) => props,
      DialogSelect: (props) => props,
    },
  };
  const tui = createTuiPlugin({ pluginRoot: "/lab/plugin", createApp: () => app });
  await tui(api);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(commands.map((command) => command.slashName), ["component_updates", "component_status"]);
  assert.equal(started, 1);
  await lifecycle[0]();
  assert.equal(disposed, 1);
});

test("checks self-update daily without staging it automatically", async () => {
  const commands = [];
  const toasts = [];
  const lifecycle = [];
  const app = {
    start: async () => {},
    dispose: async () => {},
    status: async () => ({ components: [], instances: [] }),
    check: async () => {},
    stage: async () => {},
    stageAvailable: async () => [],
  };
  let checked = 0;
  let staged = 0;
  let scheduled;
  let interval;
  let cleared = 0;
  const selfUpdater = {
    check: async () => {
      checked += 1;
      return { status: "update-available", summary: "aaaaaaa -> bbbbbbb", latest: "b".repeat(40) };
    },
    stage: async () => { staged += 1; },
    rollback: async () => {},
    status: async () => ({ current: "a".repeat(40), candidate: null, previous: null, lastCheck: null }),
  };
  const api = {
    state: { path: { worktree: "/lab" } },
    keymap: { registerLayer: (layer) => commands.push(...layer.commands) },
    lifecycle: { onDispose: (fn) => lifecycle.push(fn) },
    ui: {
      toast: (toast) => toasts.push(toast),
      dialog: { replace() {}, clear() {} },
      DialogAlert: (props) => props,
      DialogConfirm: (props) => props,
      DialogSelect: (props) => props,
    },
  };
  await createTuiPlugin({
    pluginRoot: "/lab/plugin",
    createApp: () => app,
    selfUpdater,
    setIntervalImpl: (callback, duration) => {
      scheduled = callback;
      interval = duration;
      return { unref() {} };
    },
    clearIntervalImpl: () => { cleared += 1; },
  })(api);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(checked, 1);
  assert.equal(staged, 0);
  assert.equal(interval, 60 * 60 * 1_000);
  assert.ok(toasts.some((toast) => toast.title === "Updater self-update" && toast.variant === "warning"));
  assert.equal(commands.length, 2);
  scheduled();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(checked, 2);
  await Promise.all(lifecycle.map((dispose) => dispose()));
  assert.equal(cleared, 1);
});
