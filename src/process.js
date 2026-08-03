import { spawn } from "node:child_process";

function validateCommand(command) {
  if (!Array.isArray(command) || command.length === 0 || command.some((part) => typeof part !== "string" || !part)) {
    throw new Error("Command must be a non-empty array of non-empty strings");
  }
}

export async function runCommand(command, {
  cwd,
  env,
  timeoutMs = 60_000,
  maxOutputBytes = 65_536,
  signal,
} = {}) {
  validateCommand(command);
  if (signal?.aborted) return { code: null, stdout: "", stderr: "", reason: "aborted" };

  return new Promise((resolve) => {
    let child;
    let reason = null;
    let timeout;
    let killTimeout;
    let outputBytes = 0;
    const stdout = [];
    const stderr = [];

    function stop(nextReason) {
      if (reason) return;
      reason = nextReason;
      child?.kill("SIGTERM");
      killTimeout = setTimeout(() => child?.kill("SIGKILL"), 2_000);
      killTimeout.unref?.();
    }

    function capture(target, chunk) {
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        stop("output-limit");
        return;
      }
      target.push(chunk);
    }

    const abort = () => stop("aborted");
    try {
      child = spawn(command[0], command.slice(1), {
        cwd,
        env: { ...process.env, ...env },
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      resolve({ code: null, stdout: "", stderr: "", reason: "spawn-error", error: String(error) });
      return;
    }

    timeout = setTimeout(() => stop("timeout"), timeoutMs);
    timeout.unref?.();
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk) => capture(stdout, chunk));
    child.stderr.on("data", (chunk) => capture(stderr, chunk));
    child.on("error", (error) => {
      if (!reason) reason = "spawn-error";
      stderr.push(Buffer.from(String(error)));
    });
    child.on("close", (code, exitSignal) => {
      clearTimeout(timeout);
      clearTimeout(killTimeout);
      signal?.removeEventListener("abort", abort);
      resolve({
        code,
        signal: exitSignal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        reason,
      });
    });
  });
}

export function firstOutputLine({ stdout, stderr }) {
  const line = `${stdout}\n${stderr}`.split(/\r?\n/).map((value) => value.trim()).find(Boolean) || "";
  return line
    .replace(/\bBearer\s+[^\s]+/gi, "Bearer [redacted]")
    .replace(/\b(api[_-]?key|token|password|secret)\s*[:=]\s*[^\s]+/gi, "$1=[redacted]")
    .replace(/\/\/[^\s/@:]+(?::[^\s/@]+)?@/g, "//[redacted]@");
}
