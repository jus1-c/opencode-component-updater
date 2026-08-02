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

## Development

```bash
npm run check
npm test
```
