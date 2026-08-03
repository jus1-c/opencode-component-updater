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
  if (cached.lastCheckedAt && now - cached.lastCheckedAt >= checkIntervalMs) {
    return { id, key, component, status: "stale", summary: cached.summary || "Check is stale", cached, update };
  }
  return { id, key, component, status: cached.status, summary: cached.summary || cached.status, cached, update };
}

export async function readStatus({ paths, config, now = Date.now }) {
  const [state, pending, instances] = await Promise.all([
    loadState(paths),
    loadPending(paths),
    listLiveInstances(paths, { now, staleMs: config.defaults.staleInstanceMs }),
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
  const lastChecked = item.cached.lastCheckedAt ? new Date(item.cached.lastCheckedAt).toISOString() : "never";
  const nextCheck = item.cached.lastCheckedAt
    ? new Date(item.cached.lastCheckedAt + checkIntervalHours * 60 * 60 * 1_000).toISOString()
    : "now";
  return [
    `Component: ${item.id}`,
    `Scope: ${item.component.scope}`,
    `Kind: ${item.component.kind}`,
    `Target: ${item.component.target || "external/system-managed"}`,
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
