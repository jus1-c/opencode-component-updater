import { createUpdaterApp } from "./app.js";
import { formatSelfUpdateStatus, formatStatusDetail } from "./status.js";
import { resolveUpdaterPaths } from "./paths.js";

function showAlert(api, title, message) {
  api.ui.dialog.replace(() => api.ui.DialogAlert({ title, message }));
}

function showStatus(api, app, selfUpdater) {
  void Promise.all([app.status(), selfUpdater?.status().catch(() => null)]).then(([snapshot, self]) => {
    const options = [
      ...(self ? [{
        title: `plugin.component-updater  ${self.candidate ? "staged-pending-restart" : self.lastCheck?.status || "not checked"}`,
        value: "plugin.component-updater",
        description: self.lastCheck?.summary || self.lastFailure || "Self-update status",
        onSelect: () => showAlert(api, "plugin.component-updater", formatSelfUpdateStatus(self)),
      }] : []),
      ...snapshot.components
        .filter((item) => item.id !== "plugin.component-updater")
        .map((item) => ({
      title: `${item.id}  ${item.status}`,
      value: item.id,
      description: item.summary,
      onSelect: () => showAlert(api, item.id, formatStatusDetail(item, {
        instanceCount: snapshot.instances.length,
        checkIntervalHours: snapshot.checkIntervalHours,
      })),
        })),
    ];
    api.ui.dialog.replace(() => api.ui.DialogSelect({
      title: "Component Status",
      placeholder: "Select a component",
      options,
    }));
  }).catch((error) => showAlert(api, "Component Status", String(error)));
}

function checkSelfUpdate(api, selfUpdater) {
  if (!selfUpdater) return;
  api.ui.dialog.clear();
  api.ui.toast({ title: "Updater self-update", message: "Checking GitHub main", variant: "info" });
  void selfUpdater.check({ force: true }).then((result) => {
    if (result.status === "current") {
      api.ui.toast({ title: "Updater self-update", message: "Already current", variant: "success" });
      return;
    }
    if (result.status !== "update-available") {
      showAlert(api, "Updater self-update", result.summary);
      return;
    }
    api.ui.dialog.replace(() => api.ui.DialogConfirm({
      title: "Stage updater self-update?",
      message: `Commit: ${result.latest}\n\nCurrent runtime stays active. The checked commit activates only after every OpenCode instance closes and OpenCode starts again.`,
      onConfirm: () => {
        api.ui.dialog.clear();
        api.ui.toast({ title: "Updater self-update", message: "Staging checked commit", variant: "info" });
        void selfUpdater.stage(result.latest).then((staged) => {
          api.ui.toast({ title: "Updater self-update", message: staged.summary || staged.reason, variant: "success" });
        }).catch((error) => api.ui.toast({ title: "Updater self-update", message: String(error), variant: "error" }));
      },
    }));
  }).catch((error) => api.ui.toast({ title: "Updater self-update", message: String(error), variant: "error" }));
}

function rollbackSelfUpdate(api, selfUpdater) {
  if (!selfUpdater) return;
  api.ui.dialog.replace(() => api.ui.DialogConfirm({
    title: "Stage updater rollback?",
    message: "The previous updater runtime will activate after every OpenCode instance closes and OpenCode starts again.",
    onConfirm: () => {
      api.ui.dialog.clear();
      void selfUpdater.rollback().then((result) => {
        api.ui.toast({ title: "Updater self-update", message: result.summary || result.reason, variant: result.skipped ? "info" : "success" });
      }).catch((error) => api.ui.toast({ title: "Updater self-update", message: String(error), variant: "error" }));
    },
  }));
}

function showUpdates(api, app, selfUpdater) {
  void app.status().then((snapshot) => {
    const options = [
      ...(selfUpdater ? [
        {
          title: "Check updater self-update",
          value: "self-check",
          description: "Check GitHub main, then offer manual exact-SHA staging",
          onSelect: () => checkSelfUpdate(api, selfUpdater),
        },
        {
          title: "Rollback updater",
          value: "self-rollback",
          description: "Stage the previous updater runtime for next startup",
          onSelect: () => rollbackSelfUpdate(api, selfUpdater),
        },
      ] : []),
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
        .filter((item) => item.id !== "plugin.component-updater" && item.status === "update-available")
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

export function createTuiPlugin({
  pluginRoot,
  createApp = createUpdaterApp,
  selfUpdater,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
} = {}) {
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
          run: () => showUpdates(api, app, selfUpdater),
        },
        {
          name: "component-updater.status",
          title: "Component Status",
          category: "Plugin",
          namespace: "palette",
          slashName: "component_status",
          run: () => showStatus(api, app, selfUpdater),
        },
      ],
    });
    api.lifecycle.onDispose(() => app.dispose());
    void app.start().catch((error) => {
      api.ui.toast({ title: "Component updates", message: String(error), variant: "error" });
    });
    if (selfUpdater) {
      const checkSelf = () => void selfUpdater.check().then((result) => {
        if (!result.skipped && result.status === "update-available") {
          api.ui.toast({ title: "Updater self-update", message: `Update available: ${result.summary}`, variant: "warning" });
        }
      }).catch(() => {});
      checkSelf();
      const timer = setIntervalImpl(checkSelf, 60 * 60 * 1_000);
      timer.unref?.();
      api.lifecycle.onDispose(() => clearIntervalImpl(timer));
    }
  };
}
