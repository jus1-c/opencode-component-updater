import { AdapterError, fail, fetchJson, isCommit, isIntegrity, isSemver, runOrFail } from "./util.js";

/** Exact HEAD commit of a remote default branch. */
export async function resolveGitHead(remote) {
  const output = await runOrFail(["git", "ls-remote", remote, "HEAD"], { timeoutMs: 120_000 });
  const commit = output.split(/\s+/)[0]?.toLowerCase();
  if (!isCommit(commit)) fail(`could not resolve an exact HEAD commit for ${remote}`);
  return commit;
}

/**
 * Exact commit for the newest non-prerelease tag, dereferencing annotated tags
 * so the returned value is the commit a checkout would land on.
 */
export async function resolveGitRelease(remote) {
  const output = await runOrFail(["git", "ls-remote", "--tags", remote], { timeoutMs: 120_000 });
  const commits = new Map();
  for (const line of output.split("\n")) {
    const [sha, ref] = line.trim().split(/\s+/);
    if (!isCommit(sha) || !ref?.startsWith("refs/tags/")) continue;
    const dereferenced = ref.endsWith("^{}");
    const tag = ref.slice("refs/tags/".length, dereferenced ? -3 : undefined);
    if (!isSemver(tag) || tag.includes("-")) continue;
    if (dereferenced || !commits.has(tag)) commits.set(tag, sha.toLowerCase());
  }
  if (commits.size === 0) fail(`no release tags found for ${remote}`);
  const [tag, commit] = [...commits.entries()].sort((left, right) => compareSemver(left[0], right[0])).pop();
  return { tag, commit };
}

export function compareSemver(left, right) {
  const parse = (value) => value.replace(/^v/, "").split(".").map((part) => Number.parseInt(part, 10) || 0);
  const [leftParts, rightParts] = [parse(left), parse(right)];
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index];
  }
  return 0;
}

/**
 * Newest published npm release. Identity is the version plus its tarball
 * integrity; `gitHead` is recorded for provenance only because a registry
 * tarball is not guaranteed to match any repository tag.
 */
export async function resolveNpmRelease(name, { fetchImpl = fetchJson } = {}) {
  const metadata = await fetchImpl(`https://registry.npmjs.org/${encodeName(name)}`);
  const version = metadata?.["dist-tags"]?.latest;
  if (!isSemver(version)) fail(`npm metadata for ${name} has no exact latest version`);
  const release = metadata?.versions?.[version];
  if (!release) fail(`npm metadata for ${name} is missing version ${version}`);
  const url = release?.dist?.tarball;
  const integrity = release?.dist?.integrity;
  if (typeof url !== "string" || !url.startsWith("https://")) fail(`npm release ${name}@${version} has no https tarball`);
  if (!isIntegrity(integrity)) fail(`npm release ${name}@${version} has no supported integrity digest`);
  return {
    version,
    artifact: { url, integrity },
    sourceCommit: isCommit(release.gitHead) ? release.gitHead.toLowerCase() : "",
  };
}

/** Newest published PyPI release plus the sdist/wheel digest for that version. */
export async function resolvePypiRelease(name, { fetchImpl = fetchJson } = {}) {
  const metadata = await fetchImpl(`https://pypi.org/pypi/${encodeName(name)}/json`);
  const version = metadata?.info?.version;
  if (!isSemver(version)) fail(`PyPI metadata for ${name} has no exact latest version`);
  const files = metadata?.releases?.[version] || [];
  const chosen = files.find((file) => file?.packagetype === "bdist_wheel") || files.find((file) => file?.packagetype === "sdist");
  if (!chosen?.url?.startsWith("https://") || typeof chosen?.digests?.sha256 !== "string") {
    fail(`PyPI release ${name}==${version} has no verifiable artifact`);
  }
  return {
    version,
    artifact: { url: chosen.url, integrity: `sha256-${Buffer.from(chosen.digests.sha256, "hex").toString("base64")}` },
  };
}

function encodeName(name) {
  if (typeof name !== "string" || name === "" || name.includes("..") || name.includes(" ")) {
    throw new AdapterError(`invalid package name: ${name}`);
  }
  return name.split("/").map(encodeURIComponent).join("/");
}
