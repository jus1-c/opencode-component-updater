import { spawn } from "node:child_process";

function validateCommand(command) {
  if (!Array.isArray(command) || !command.length || command.some((part) => typeof part !== "string" || !part)) {
    throw new Error("Command must be a non-empty array of non-empty strings");
  }
}

function sanitize(value) {
  return String(value || "")
    .replace(/\bBearer\s+[^\s]+/gi, "Bearer [redacted]")
    .replace(/\b(api[_-]?key|token|password|secret)\s*[:=]\s*[^\s]+/gi, "$1=[redacted]")
    .replace(/\/\/[^\s/@:]+(?::[^\s/@]+)?@/g, "//[redacted]@");
}

export function firstOutputLine({ stdout, stderr }) {
  const line = `${stdout || ""}\n${stderr || ""}`.split(/\r?\n/).map((value) => value.trim()).find(Boolean) || "";
  return sanitize(line);
}

export async function runBootstrapCommand(command, { cwd, timeoutMs = 60_000, maxOutputBytes = 65_536 } = {}) {
  validateCommand(command);
  return new Promise((resolve) => {
    let child;
    let finished = false;
    let reason = null;
    let timeout;
    let killTimeout;
    let outputBytes = 0;
    const stdout = [];
    const stderr = [];
    const finish = (code, signal = null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      clearTimeout(killTimeout);
      resolve({ code, signal, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"), reason });
    };
    const stop = (nextReason) => {
      if (reason) return;
      reason = nextReason;
      child?.kill("SIGTERM");
      killTimeout = setTimeout(() => child?.kill("SIGKILL"), 2_000);
      killTimeout.unref?.();
    };
    const capture = (target, chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) return stop("output-limit");
      target.push(chunk);
    };
    try {
      child = spawn(command[0], command.slice(1), { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (error) {
      reason = "spawn-error";
      stderr.push(Buffer.from(String(error)));
      return finish(null);
    }
    timeout = setTimeout(() => stop("timeout"), timeoutMs);
    timeout.unref?.();
    child.stdout.on("data", (chunk) => capture(stdout, chunk));
    child.stderr.on("data", (chunk) => capture(stderr, chunk));
    child.on("error", (error) => {
      if (!reason) reason = "spawn-error";
      stderr.push(Buffer.from(String(error)));
      finish(null);
    });
    child.on("close", finish);
  });
}
