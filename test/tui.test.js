import assert from "node:assert/strict";
import test from "node:test";
import { createTuiPlugin } from "../src/tui.js";

function createContext({ snapshot, answers = [], commands = [] } = {}) {
  const toasts = [];
  const dialogs = [];
  const reloads = [];
  return {
    toasts,
    dialogs,
    reloads,
    context: {
      keymap: { layer: (factory) => commands.push(...factory().commands) },
      ui: {
        toast: { show: (payload) => toasts.push(payload) },
        dialog: {
          alert: async (payload) => { dialogs.push({ kind: "alert", ...payload }); },
          confirm: async (payload) => {
            dialogs.push({ kind: "confirm", ...payload });
            return answers.shift() ?? false;
          },
          select: async (payload) => {
            dialogs.push({ kind: "select", ...payload });
            return answers.shift();
          },
        },
      },
      client: {
        location: { reload: async () => { reloads.push(true); } },
      },
    },
  };
}

const emptySnapshot = { checkIntervalHours: 24, components: [] };

test("registers three slash commands and delegates automatic checks to the binary", async () => {
  const commands = [];
  let checks = 0;
  let checkOptions;
  let scheduled;
  let disposed = 0;
  const { context } = createContext({ commands });

  const setup = createTuiPlugin({
    pluginRoot: "/lab/plugin",
    readSnapshot: async () => emptySnapshot,
    runCheck: async (options) => { checks += 1; checkOptions = options; },
    setIntervalImpl: (callback, interval) => {
      scheduled = { callback, interval };
      return { unref() {} };
    },
    clearIntervalImpl: () => { disposed += 1; },
  });

  const cleanup = await setup(context);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(
    commands.map((command) => command.slash.name),
    ["component-status", "component-update", "component-rollback"],
  );
  assert.equal(checks, 1);
  assert.deepEqual(checkOptions, { pluginRoot: "/lab/plugin" });
  assert.equal(scheduled.interval, 24 * 60 * 60 * 1_000);

  scheduled.callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(checks, 2);

  cleanup();
  assert.equal(disposed, 1);
});

test("component-update applies live, then reloads locations", async () => {
  const commands = [];
  const { context, dialogs, reloads, toasts } = createContext({
    commands,
    answers: [true],
  });
  let invocation;
  const snapshot = {
    checkIntervalHours: 24,
    components: [
      { id: "plugin.quota", status: "update-available", summary: "4.4.0 -> 4.5.0" },
    ],
  };

  const setup = createTuiPlugin({
    pluginRoot: "/lab/plugin",
    readSnapshot: async () => snapshot,
    runCheck: async () => {},
    runCommand: async (options) => { invocation = options; options.onLine("[apply] plugin.quota: complete"); return 0; },
    setIntervalImpl: () => ({ unref() {} }),
    clearIntervalImpl: () => {},
  });

  await setup(context);
  const update = commands.find((command) => command.slash.name === "component-update");
  await update.run();

  assert.equal(invocation.args[0], "upgrade");
  assert.ok(invocation.args.includes("--allow-running"));
  assert.equal(dialogs[0].kind, "confirm");
  assert.equal(reloads.length, 1);
  assert.ok(toasts.some((toast) => toast.variant === "success"));
});

test("component-update reports partial failure without reloading", async () => {
  const commands = [];
  const { context, dialogs, reloads } = createContext({ commands, answers: [true] });
  const snapshot = {
    checkIntervalHours: 24,
    components: [{ id: "plugin.quota", status: "update-available", summary: "a -> b" }],
  };

  const setup = createTuiPlugin({
    pluginRoot: "/lab/plugin",
    readSnapshot: async () => snapshot,
    runCheck: async () => {},
    runCommand: async (options) => { options.onLine("plugin.quota: manifest path is protected"); return 4; },
    setIntervalImpl: () => ({ unref() {} }),
    clearIntervalImpl: () => {},
  });

  await setup(context);
  await commands.find((command) => command.slash.name === "component-update").run();

  assert.equal(reloads.length, 0);
  const alert = dialogs.find((dialog) => dialog.kind === "alert");
  assert.match(alert.title, /partially/i);
  assert.match(alert.message, /manifest path is protected/);
});

test("component-update does nothing when cancelled", async () => {
  const commands = [];
  const { context, reloads } = createContext({ commands, answers: [false] });
  let ran = false;

  const setup = createTuiPlugin({
    pluginRoot: "/lab/plugin",
    readSnapshot: async () => ({ checkIntervalHours: 24, components: [] }),
    runCheck: async () => {},
    runCommand: async () => { ran = true; return 0; },
    setIntervalImpl: () => ({ unref() {} }),
    clearIntervalImpl: () => {},
  });

  await setup(context);
  await commands.find((command) => command.slash.name === "component-update").run();

  assert.equal(ran, false);
  assert.equal(reloads.length, 0);
});
