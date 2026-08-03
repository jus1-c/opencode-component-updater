import assert from "node:assert/strict";
import test from "node:test";
import { runBootstrapCommand } from "../bootstrap/process.js";

test("bootstrap command runner returns spawn failures", async () => {
  const result = await runBootstrapCommand(["definitely-not-a-command-opencode-component-updater"]);
  assert.equal(result.code, null);
  assert.equal(result.reason, "spawn-error");
});
