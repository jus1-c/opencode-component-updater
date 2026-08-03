import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { get } from "node:https";

const COMMIT = /^[0-9a-f]{40}$/i;
const SEMVER = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const INTEGRITY = /^sha(?:256|384|512)-[A-Za-z0-9+/]+={0,2}$/;

export function isCommit(value) {
  return typeof value === "string" && COMMIT.test(value);
}

export function isSemver(value) {
  return typeof value === "string" && SEMVER.test(value);
}

export function isIntegrity(value) {
  return typeof value === "string" && INTEGRITY.test(value);
}

export class AdapterError extends Error {}

export function fail(message) {
  throw new AdapterError(message);
}

/**
 * Run a command as an argv array. Never uses a shell, so component names and
 * URLs cannot be interpreted as shell syntax.
 */
export function run(argv, { cwd, env, timeoutMs = 600_000, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      env: env || process.env,
      shell: false,
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      child.kill("SIGKILL");
      reject(new AdapterError(`${argv[0]} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => {
      clearTimeout(timer);
      if (!settled) reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (settled) return;
      resolve({ code: code ?? -1, stdout, stderr });
    });
    if (input !== undefined) child.stdin.end(input);
  });
}

export async function runOrFail(argv, options) {
  const result = await run(argv, options);
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim().split("\n")[0] || `exit ${result.code}`;
    fail(`${argv[0]} failed: ${detail}`);
  }
  return result.stdout.trim();
}

export function fetchJson(url, { timeoutMs = 60_000, accept = "application/json" } = {}) {
  return fetchBuffer(url, { timeoutMs, accept }).then((buffer) => {
    try {
      return JSON.parse(buffer.toString("utf8"));
    } catch {
      return fail(`response from ${url} is not valid JSON`);
    }
  });
}

export function fetchBuffer(url, { timeoutMs = 120_000, accept = "*/*", redirects = 5 } = {}) {
  if (!url.startsWith("https://")) return Promise.reject(new AdapterError(`refusing non-https url: ${url}`));
  return new Promise((resolve, reject) => {
    const request = get(url, { headers: { accept, "user-agent": "opencode-component-updater" }, timeout: timeoutMs }, (response) => {
      const status = response.statusCode || 0;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        if (redirects <= 0) return reject(new AdapterError(`too many redirects for ${url}`));
        const next = new URL(response.headers.location, url).toString();
        return resolve(fetchBuffer(next, { timeoutMs, accept, redirects: redirects - 1 }));
      }
      if (status !== 200) {
        response.resume();
        return reject(new AdapterError(`${url} returned HTTP ${status}`));
      }
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.once("end", () => resolve(Buffer.concat(chunks)));
      response.once("error", reject);
    });
    request.once("timeout", () => {
      request.destroy(new AdapterError(`${url} timed out`));
    });
    request.once("error", reject);
  });
}

export function hashBuffer(buffer, algorithm = "sha256") {
  return createHash(algorithm).update(buffer).digest();
}

/** Verify a subresource-integrity string such as `sha512-<base64>`. */
export function verifyIntegrity(buffer, integrity) {
  if (!isIntegrity(integrity)) fail(`unsupported integrity value: ${integrity}`);
  const [algorithm, expected] = integrity.split("-", 2);
  const actual = hashBuffer(buffer, algorithm).toString("base64");
  if (actual !== expected) fail(`artifact integrity mismatch (expected ${integrity})`);
}
