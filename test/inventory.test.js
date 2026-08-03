import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { bootstrapConfig, discoverInventory } from "../src/inventory.js";
import { createConfig, loadConfig, saveConfig } from "../src/config.js";
import { resolveUpdaterPaths } from "../src/paths.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "component-updater-inventory-"));
  const config = join(root, "opencode");
  await mkdir(join(config, "mcps", "example", ".venv", "bin"), { recursive: true });
  await mkdir(join(config, "plugins", "goal", "node_modules", "@vendor", "goal"), { recursive: true });
  await mkdir(join(config, "plugins", "orphan"), { recursive: true });
  await writeFile(join(config, "opencode.json"), JSON.stringify({
    mcp: {
      example: { type: "local", command: [join(config, "mcps", "example", ".venv", "bin", "example")] },
      remote: { type: "remote", url: "https://example.invalid/mcp" },
      system: { type: "local", command: ["codegraph", "serve", "--mcp"] },
    },
    plugin: [`file://${join(config, "plugins", "goal", "node_modules", "@vendor", "goal")}`],
  }));
  await writeFile(join(config, "tui.json"), JSON.stringify({ plugin: [] }));
  return { root, config };
}

test("discovers configured and orphaned component owners without persisting config secrets", async () => {
  const { root, config } = await fixture();
  const paths = resolveUpdaterPaths({ pluginRoot: join(root, "plugin"), env: { OPENCODE_CONFIG_DIR: config }, home: root });
  const inventory = await discoverInventory(paths);
  const ids = inventory.records.map((record) => record.id).sort();

  assert.deepEqual(ids, ["mcp.example", "mcp.remote", "mcp.system", "plugin.goal", "plugin.orphan"]);
  assert.equal(inventory.config.components["mcp.example"].target, join(config, "mcps", "example"));
  assert.equal(inventory.config.components["plugin.goal"].target, join(config, "plugins", "goal"));
  assert.equal(inventory.config.components["mcp.remote"].target, null);
  assert.equal(inventory.config.components["mcp.remote"].policy.apply, "none");
});

test("backfills missing inventory entries without replacing existing custom commands", async () => {
  const { root, config } = await fixture();
  const paths = resolveUpdaterPaths({ pluginRoot: join(root, "plugin"), env: { OPENCODE_CONFIG_DIR: config }, home: root });
  await saveConfig(paths, createConfig({
    "mcp.example": {
      kind: "mcp",
      name: "example",
      target: join(config, "mcps", "example"),
      enabled: true,
      check: { command: ["custom-check"] },
    },
  }));
  const result = await bootstrapConfig(paths, { backfill: true });
  const updated = await loadConfig(paths);
  assert.equal(result.created, false);
  assert.ok(result.added.includes("plugin.orphan"));
  assert.deepEqual(updated.components["mcp.example"].check.command, ["custom-check"]);
  assert.equal(updated.components["plugin.orphan"].enabled, false);
});
