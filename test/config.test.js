import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig, loadConfig, normalizeConfig, saveConfig } from "../src/config.js";
import { resolveUpdaterPaths } from "../src/paths.js";

test("resolves plugin-local config and XDG state paths", () => {
  const paths = resolveUpdaterPaths({
    pluginRoot: "/lab/plugin",
    env: {
      XDG_CONFIG_HOME: "/lab/config",
      XDG_STATE_HOME: "/lab/state",
    },
    home: "/ignored",
  });

  assert.equal(paths.configPath, "/lab/plugin/config/components.json");
  assert.equal(paths.opencodeConfigRoot, "/lab/config/opencode");
  assert.equal(paths.stateRoot, "/lab/state/opencode/component-updater");
});

test("writes and reads a normalized plugin-local config", async () => {
  const root = await mkdtemp(join(tmpdir(), "component-updater-config-"));
  const paths = resolveUpdaterPaths({ pluginRoot: root, env: {}, home: root });
  const config = createConfig({
    "plugin.example": {
      kind: "plugin",
      name: "example",
      target: "/lab/plugins/example",
    },
  });

  await saveConfig(paths, config);
  assert.deepEqual(await loadConfig(paths), normalizeConfig(config));
  assert.match(await readFile(paths.configPath, "utf8"), /"schemaVersion": 1/);
});

test("rejects malformed component targets", () => {
  assert.throws(
    () => normalizeConfig(createConfig({ "plugin.bad": { kind: "plugin", name: "bad", target: "" } })),
    /target path or null/,
  );
});
