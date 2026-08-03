# OpenCode Component Updater

Staged updater for globally configured OpenCode MCP servers and plugins.

This repository is source-only. It does not modify `~/.config/opencode`, load
itself into OpenCode, or update a real component during development.

## Runtime Files

When deployed later, the plugin keeps machine-local configuration beside its
code:

```text
~/.config/opencode/plugins/component-updater/
  config/components.json
```

`components.json` is ignored by Git. Volatile state, locks, leases, staged
updates, and backups live under the XDG state directory instead.

## Safety Model

- Checks are read-only by default.
- Update scripts stage files; they never apply changes to a running component.
- Graceful OpenCode shutdown applies staged, manifest-approved paths only when
  no other OpenCode instance is active.
- Each component controls its own allowed and protected paths.
- The test suite uses an isolated lab tree, never the active OpenCode runtime.

## Self-Update

The updater can update its runtime from `origin/main` after deployment. The
stable `index.js` loader and `bootstrap/` directory are never replaced.

- A daily read-only GitHub check compares the running commit to `main`.
- `/component_updates` offers a manual self-update check and exact-SHA stage.
- Staging clones the checked commit, verifies it is a fast-forward, copies only
  `runtime.js`, `src/`, and `package.json`, then records SHA-256 hashes.
- No remote package scripts run during staging.
- The candidate activates only before a clean OpenCode startup, after all
  existing instance leases have ended.
- A failed candidate falls back to the prior runtime or baseline. Rollback is
  staged manually and also activates at the next clean startup.

Self-update state lives at:

```text
~/.local/state/opencode/component-updater/self-update.json
```

Versioned runtimes live beside the deployed plugin under `versions/<commit>`.
The deployment must be a Git checkout with a repository URL in `package.json`;
source-only development does not self-update.

## Development

```bash
npm run check
npm test
```
