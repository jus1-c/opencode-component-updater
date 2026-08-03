import assert from "node:assert/strict";
import test from "node:test";
import { createTuiPlugin } from "../src/tui.js";

test("registers status only and delegates automatic checks to the binary", async () => {
  const commands = [];
  const lifecycle = [];
  let checks = 0;
  let scheduled;
  let cleared = 0;
  const api = {
    keymap: { registerLayer: (layer) => commands.push(...layer.commands) },
    lifecycle: { onDispose: (fn) => lifecycle.push(fn) },
    ui: {
      toast() {},
      dialog: { replace() {}, clear() {} },
      DialogAlert: (props) => props,
      DialogSelect: (props) => props,
    },
  };
  const tui = createTuiPlugin({
    pluginRoot: "/lab/plugin",
    readSnapshot: async () => ({ checkIntervalHours: 24, components: [] }),
    runCheck: async () => { checks += 1; },
    setIntervalImpl: (callback, interval) => {
      scheduled = { callback, interval };
      return { unref() {} };
    },
    clearIntervalImpl: () => { cleared += 1; },
  });

  await tui(api);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(commands.map((command) => command.slashName), ["component_status"]);
  assert.equal(checks, 1);
  assert.equal(scheduled.interval, 24 * 60 * 60 * 1_000);

  scheduled.callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(checks, 2);
  await lifecycle[0]();
  assert.equal(cleared, 1);
});
