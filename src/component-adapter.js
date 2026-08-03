#!/usr/bin/env node
// Component check/stage helper invoked by opencode-component-updater through the
// `check.command` and `update.command` hooks. Node standard library only.
import { basename, join } from "node:path";
import {
  checkCheatEngine,
  checkGitHead,
  checkNpmRelease,
  checkPypiRelease,
  checkRequirementCommit,
  checkRequirementRelease,
  replaceMirror,
  stageGitCommit,
  writeCheckResult,
  writeManifest,
} from "./adapter/actions.js";
import { AdapterError, fail } from "./adapter/util.js";

function options(argv) {
  const parsed = {};
  for (const entry of argv) {
    if (!entry.startsWith("--")) fail(`unexpected argument: ${entry}`);
    const [key, ...rest] = entry.slice(2).split("=");
    parsed[key] = rest.length ? rest.join("=") : "true";
  }
  return parsed;
}

function required(parsed, name) {
  const value = parsed[name];
  if (!value) fail(`--${name} is required`);
  return value;
}

function env(name) {
  const value = process.env[name];
  if (!value) fail(`${name} is not set`);
  return value;
}

const MODES = {
  "check-git-head": (parsed) => checkGitHead({
    target: env("OPENCODE_UPDATER_TARGET"),
    remote: required(parsed, "remote"),
    sourceSubdir: parsed.subdir || "",
  }),
  "check-requirement-commit": (parsed) => checkRequirementCommit({
    target: env("OPENCODE_UPDATER_TARGET"),
    remote: required(parsed, "remote"),
    distribution: required(parsed, "distribution"),
  }),
  "check-requirement-release": (parsed) => checkRequirementRelease({
    target: env("OPENCODE_UPDATER_TARGET"),
    remote: required(parsed, "remote"),
    distribution: required(parsed, "distribution"),
  }),
  "check-pypi-release": (parsed) => checkPypiRelease({
    target: env("OPENCODE_UPDATER_TARGET"),
    distribution: required(parsed, "distribution"),
  }),
  "check-npm-release": (parsed) => checkNpmRelease({
    target: env("OPENCODE_UPDATER_TARGET"),
    packageName: required(parsed, "package"),
    manifest: parsed.manifest || "package.json",
    self: parsed.self === "true",
  }),
  "check-cheatengine": (parsed) => checkCheatEngine({
    target: env("OPENCODE_UPDATER_TARGET"),
    remote: required(parsed, "remote"),
    mirror: required(parsed, "mirror"),
  }),
};

async function runCheck(mode, parsed) {
  const result = await MODES[mode](parsed);
  await writeCheckResult(process.env.OPENCODE_UPDATER_CHECK_RESULT, result);
  process.stdout.write(`${result.status}: ${result.summary}\n`);
}

async function stageCheatEngine(parsed) {
  const stage = env("OPENCODE_UPDATER_STAGE");
  const commit = env("OPENCODE_UPDATER_LATEST");
  const remote = required(parsed, "remote");
  const mirror = required(parsed, "mirror");

  const source = await stageGitCommit({ stage, remote, commit, name: "source" });
  const mirrorSource = join(source, "MCP_Server");
  await writeManifest({
    manifestPath: process.env.OPENCODE_UPDATER_MANIFEST,
    planSha256: process.env.OPENCODE_UPDATER_PLAN_SHA256,
    paths: ["source"],
  });
  // Best-effort mirror: replaced here rather than by the transaction, so a later
  // canonical failure can leave the mirror ahead. The next check detects the
  // drift and the following upgrade resyncs it.
  const mirrored = await replaceMirror({
    sourceDir: mirrorSource,
    mirror,
    runId: basename(stage),
  });
  process.stdout.write(`staged ${commit}; mirror files ${mirrored.files}\n`);
}

async function main(argv) {
  const [mode, ...rest] = argv;
  if (!mode) fail("a mode is required");
  const parsed = options(rest);
  if (mode in MODES) return runCheck(mode, parsed);
  if (mode === "stage-cheatengine") return stageCheatEngine(parsed);
  fail(`unknown mode: ${mode}`);
}

main(process.argv.slice(2)).catch((error) => {
  const message = error instanceof AdapterError ? error.message : String(error?.message || error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
