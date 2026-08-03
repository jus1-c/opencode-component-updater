import { createUpdaterApp } from "./app.js";
import { formatStatusDetail } from "./status.js";
import { resolveUpdaterPaths } from "./paths.js";

function showAlert(api, title, message) {
  api.ui.dialog.replace(() => api.ui.DialogAlert({ title, message }));
}

function showStatus(api, app) {
  void app.status().then((snapshot) => {
    const options = snapshot.components.map((item) => ({
      title: `${item.id}  ${item.status}`,
      value: item.id,
      description: item.summary,
      onSelect: () => showAlert(api, item.id, formatStatusDetail(item, {
        instanceCount: snapshot.instances.length,
        checkIntervalHours: snapshot.checkIntervalHours,
      })),
    }));
    api.ui.dialog.replace(() => api.ui.DialogSelect({
      title: "Component Status",
      placeholder: "Select a component",
      options,
    }));
  }).catch((error) => showAlert(api, "Component Status", String(error)));
}

function showUpdates(api, app) {
  void app.status().then((snapshot) => {
    const options = [
      {
        title: "Check now",
        value: "check",
        description: "Run enabled update checks now",
        onSelect: () => {
          api.ui.dialog.clear();
          api.ui.toast({ title: "Component updates", message: "Check started in background", variant: "info" });
          void app.check({ force: true }).catch(() => {});
        },
      },
      {
        title: "Stage all available",
        value: "stage-all",
        description: "Stage configured updates without changing live components",
        onSelect: () => {
          api.ui.dialog.replace(() => api.ui.DialogConfirm({
            title: "Stage all available updates?",
            message: "Updates apply only after every OpenCode instance closes.",
            onConfirm: () => {
              api.ui.dialog.clear();
              api.ui.toast({ title: "Component updates", message: "Staging available updates", variant: "info" });
              void app.stageAvailable().catch(() => {});
            },
          }));
        },
      },
      ...snapshot.components
        .filter((item) => item.status === "update-available")
        .map((item) => ({
          title: `${item.id}  ${item.summary}`,
          value: item.id,
          description: item.component.update.command.length ? "Stage this update" : "No update script configured",
          disabled: !item.component.update.command.length,
          onSelect: () => {
            api.ui.dialog.replace(() => api.ui.DialogConfirm({
              title: `Stage ${item.id}?`,
              message: `Target: ${item.component.target || "external"}\n\nLive runtime stays unchanged until all OpenCode instances close.`,
              onConfirm: () => {
                api.ui.dialog.clear();
                api.ui.toast({ title: "Component updates", message: `Staging ${item.id}`, variant: "info" });
                void app.stage(item.id).catch(() => {});
              },
            }));
          },
        })),
    ];
    api.ui.dialog.replace(() => api.ui.DialogSelect({
      title: "Component Updates",
      placeholder: "Select an action",
      options,
    }));
  }).catch((error) => showAlert(api, "Component Updates", String(error)));
}

export function createTuiPlugin({ pluginRoot, createApp = createUpdaterApp } = {}) {
  return async (api) => {
    const app = createApp({
      paths: resolveUpdaterPaths({ pluginRoot }),
      worktree: api.state?.path?.worktree || "",
      onEvent(event) {
        if (event.type === "check-complete" && event.available.length) {
          api.ui.toast({
            title: "Component updates",
            message: `${event.available.length} component update${event.available.length === 1 ? "" : "s"} available`,
            variant: "warning",
          });
        }
        if (event.type === "stage-ready") {
          api.ui.toast({ title: "Component updates", message: `${event.id} staged. Restart OpenCode to apply.`, variant: "success" });
        }
        if (event.type === "stage-error") {
          api.ui.toast({ title: "Component updates", message: `${event.id}: ${event.error}`, variant: "error" });
        }
      },
    });
    api.keymap.registerLayer({
      commands: [
        {
          name: "component-updater.updates",
          title: "Component Updates",
          category: "Plugin",
          namespace: "palette",
          slashName: "component_updates",
          run: () => showUpdates(api, app),
        },
        {
          name: "component-updater.status",
          title: "Component Status",
          category: "Plugin",
          namespace: "palette",
          slashName: "component_status",
          run: () => showStatus(api, app),
        },
      ],
    });
    api.lifecycle.onDispose(() => app.dispose());
    void app.start().catch((error) => {
      api.ui.toast({ title: "Component updates", message: String(error), variant: "error" });
    });
  };
}
