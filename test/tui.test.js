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
