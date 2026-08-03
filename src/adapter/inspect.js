import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { fail, isCommit, isSemver, run } from "./util.js";

/** Exact HEAD of a local git worktree, or null when the path is not a checkout. */
export async function localGitHead(root) {
  const result = await run(["git", "-C", root, "rev-parse", "HEAD"], { timeoutMs: 30_000 });
  if (result.code !== 0) return null;
  const commit = result.stdout.trim().toLowerCase();
  return isCommit(commit) ? commit : null;
}

export async function localGitDirty(root) {
  const result = await run(["git", "-C", root, "status", "--porcelain"], { timeoutMs: 60_000 });
  if (result.code !== 0) return false;
  return result.stdout.trim() !== "";
}

/** Installed version of a dependency recorded in a package.json. */
export async function installedPackageVersion(packageJsonPath, dependency) {
  const manifest = await readJson(packageJsonPath);
  const version = manifest?.dependencies?.[dependency] || manifest?.devDependencies?.[dependency];
  if (typeof version !== "string") return null;
  const exact = version.replace(/^[~^]/, "");
  return isSemver(exact) ? exact : null;
}

/** Version declared by an installed package's own package.json. */
export async function installedSelfVersion(packageJsonPath) {
  const manifest = await readJson(packageJsonPath);
  return isSemver(manifest?.version) ? manifest.version : null;
}

/** Exact `name==version` pin from a requirements file. */
export async function requirementPin(requirementsPath, distribution) {
  const contents = await readFile(requirementsPath, "utf8");
  for (const line of contents.split("\n")) {
    const bare = line.split("#")[0].trim();
    if (!bare.startsWith(distribution)) continue;
    const pinned = bare.split("==")[1]?.trim();
    if (isSemver(pinned)) return pinned;
  }
  return null;
}

/** Exact commit from a `name @ git+https://...@<sha>` requirement line. */
export async function requirementCommit(requirementsPath, distribution) {
  const contents = await readFile(requirementsPath, "utf8");
  for (const line of contents.split("\n")) {
    const bare = line.split("#")[0].trim();
    if (!bare.startsWith(distribution)) continue;
    const commit = bare.split("@").pop()?.trim().toLowerCase();
    if (isCommit(commit)) return commit;
  }
  return null;
}

export async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Content fingerprint of a directory tree: sorted relative paths plus per-file
 * SHA-256. Used to compare the Cheat Engine mirror against its canonical source
 * without trusting timestamps.
 */
export async function treeFingerprint(root) {
  const entries = [];
  await walk(root, root, entries);
  entries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const digest = createHash("sha256");
  for (const entry of entries) digest.update(`${entry.path}\u0000${entry.hash}\u0000`);
  return { digest: `sha256:${digest.digest("hex")}`, count: entries.length };
}

async function walk(root, directory, entries) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    const relativePath = relative(root, absolute).split(sep).join("/");
    if (entry.isSymbolicLink()) fail(`refusing symbolic entry: ${absolute}`);
    if (entry.isDirectory()) {
      entries.push({ path: `${relativePath}/`, hash: "dir" });
      await walk(root, absolute, entries);
      continue;
    }
    if (!entry.isFile()) fail(`unsupported entry: ${absolute}`);
    entries.push({ path: relativePath, hash: await fileHash(absolute) });
  }
}

function fileHash(path) {
  return new Promise((resolve, reject) => {
    const digest = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => digest.update(chunk));
    stream.once("end", () => resolve(digest.digest("hex")));
    stream.once("error", reject);
  });
}

/** Reject any symlink or externally hardlinked file the transaction cannot back up. */
export async function assertLinkFree(root) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const absolute = join(root, entry.name);
    if (entry.isSymbolicLink()) fail(`symbolic entry not allowed: ${absolute}`);
    if (entry.isDirectory()) {
      await assertLinkFree(absolute);
      continue;
    }
    const info = await lstat(absolute);
    if (!info.isFile()) fail(`unsupported entry: ${absolute}`);
    if (info.nlink > 1) fail(`hardlinked file not allowed: ${absolute}`);
  }
}
