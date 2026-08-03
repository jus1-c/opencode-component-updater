import { loadPending } from "./transaction.js";
import { loadState, componentIdentity } from "./state.js";
import { listLiveInstances } from "./lease.js";

export function statusForComponent({ id, component, state, pending, now, checkIntervalMs }) {
  const key = componentIdentity(id, component);
  const cached = state.components[key] || {};
  const update = pending.updates[id];
  if (!component.enabled) return { id, key, component, status: "disabled", summary: "Disabled", cached, update };
  if (update) return { id, key, component, status: "staged-pending-restart", summary: update.summary || "Restart required", cached, update };
  if (!cached.status) return { id, key, component, status: "stale", summary: "Not checked", cached, update };
  if (Number.isSafeInteger(cached.lastCheckedAt) && now - cached.lastCheckedAt >= checkIntervalMs) {
    return { id, key, component, status: "stale", summary: cached.summary || "Check is stale", cached, update };
  }
  return { id, key, component, status: cached.status, summary: cached.summary || cached.status, cached, update };
}

export async function readStatus({ paths, config, now = Date.now }) {
  const [state, pending, instances] = await Promise.all([
    loadState(paths),
    loadPending(paths),
    listLiveInstances(paths, { now, staleMs: config.defaults.staleInstanceMs, prune: false }),
  ]);
  const timestamp = now();
  const checkIntervalMs = config.defaults.checkIntervalHours * 60 * 60 * 1_000;
  return {
    state,
    pending,
    instances,
    checkIntervalHours: config.defaults.checkIntervalHours,
    components: Object.entries(config.components)
      .map(([id, component]) => statusForComponent({ id, component, state, pending, now: timestamp, checkIntervalMs }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  };
}

export function formatStatusDetail(item, { instanceCount, checkIntervalHours = 24 }) {
  const source = item.cached.source;
  const layers = source?.layers?.map((layer) => layer.type).join(" + ") || "not checked";
  const evidence = source?.evidence?.join(", ") || "none";
  const current = item.cached.current || "unknown";
  const latest = item.cached.latest || "unknown";
  const lastChecked = Number.isSafeInteger(item.cached.lastCheckedAt) ? new Date(item.cached.lastCheckedAt).toISOString() : "never";
  const nextCheck = Number.isSafeInteger(item.cached.lastCheckedAt)
    ? new Date(item.cached.lastCheckedAt + checkIntervalHours * 60 * 60 * 1_000).toISOString()
    : "now";
  return [
    `Component: ${item.id}`,
    `Scope: ${item.component.scope}`,
    `Kind: ${item.component.kind}`,
    `Target: ${item.component.target || "external/system-managed"}`,
    `Allowed paths: ${item.component.policy.allowedPaths.join(", ") || "none"}`,
    `Protected paths: ${item.component.policy.protectedPaths.join(", ") || "none"}`,
    `Update script: ${item.component.update.command.length ? "configured" : "not configured"}`,
    "",
    `Status: ${item.status}`,
    `Summary: ${item.summary}`,
    `Source: ${layers}`,
    `Evidence: ${evidence}`,
    `Current: ${current}`,
    `Latest known: ${latest}`,
    `Last check: ${lastChecked}`,
    `Next automatic check: ${nextCheck}`,
    `Pending restart: ${item.update ? "yes" : "no"}`,
    `Active OpenCode instances: ${instanceCount}`,
  ].join("\n");
}

export function formatSelfUpdateStatus(self) {
  const checked = self.lastCheck?.checkedAt ? new Date(self.lastCheck.checkedAt).toISOString() : "never";
  const running = self.current || self.running || "unknown";
  return [
    "Component: plugin.component-updater",
    "Kind: plugin",
    "Apply path: startup-only",
    "",
    `Running commit: ${running}`,
    `Previous runtime: ${self.previous || "none"}`,
    `Staged commit: ${self.candidate || "none"}`,
    `Latest checked: ${self.lastCheck?.latest || "unknown"}`,
    `Check status: ${self.lastCheck?.status || "not checked"}`,
    `Last check: ${checked}`,
    `Last failure: ${self.lastFailure || "none"}`,
  ].join("\n");
}
