# OpenCode Component Updater

Standalone Linux/WSL updater for locally managed OpenCode MCP servers and plugins.

`opencode-component-updater` owns checks, staging, apply, backup, recovery,
rollback, and its own paired binary/plugin update. The OpenCode plugin is
read-only: it shows status and periodically runs `check --quiet`.

This source repository does not deploy itself or change an active OpenCode
configuration.

## Build And Install

Build a binary carrying its source commit. Without build metadata,
self-update needs the deployed plugin directory to be the matching Git checkout.

```bash
install -d "$HOME/.local/bin"
go build -trimpath -ldflags "-X main.commit=$(git rev-parse HEAD)" \
  -o "$HOME/.local/bin/opencode-component-updater" \
  ./cmd/opencode-component-updater
export PATH="$HOME/.local/bin:$PATH"
opencode-component-updater doctor
```

Register `index.js` as an OpenCode plugin only after the binary is available
on `PATH`, or set `OPENCODE_COMPONENT_UPDATER_BIN` to its absolute path.

Canonical runtime paths:

```text
$XDG_CONFIG_HOME/opencode/component-updater/components.json
$XDG_STATE_HOME/opencode/component-updater/
```

Defaults resolve to `~/.config/opencode/component-updater/components.json` and
`~/.local/state/opencode/component-updater/`. Override only when needed:

```text
OPENCODE_CONFIG_DIR
OPENCODE_COMPONENT_UPDATER_CONFIG
OPENCODE_COMPONENT_UPDATER_STATE_DIR
OPENCODE_COMPONENT_UPDATER_PLUGIN_DIR
OPENCODE_COMPONENT_UPDATER_REPOSITORY
```

## Commands

```text
opencode-component-updater check [--quiet]
opencode-component-updater upgrade [--best-effort]
opencode-component-updater rollback [component-id]
opencode-component-updater self-update [check|apply [commit]|rollback]
opencode-component-updater status
opencode-component-updater doctor
```

- `check` is read-only for component targets. It refreshes metadata and retains
  a valid prior result when a later check fails.
- `upgrade` force-checks, stages every strict update, then applies by
  journaled same-filesystem renames. `--best-effort` skips failed components
  and exits `4` for a partial result.
- `rollback` restores a verified backup. A component ID is required outside an
  interactive terminal.
- `self-update` is explicit. Ordinary `upgrade` never upgrades this updater.
- Every mutating command blocks until every OpenCode process is closed. It
  never sends a signal, kills a process, or starts/stops OpenCode.

## Component Configuration

Use `config/components.example.json` as the schema-2 baseline. A component is
eligible for automatic upgrade only when all conditions hold:

```text
enabled == true
target is set
policy.apply == "manifest"
update.command is non-empty
```

Checks may write this exact JSON to `OPENCODE_UPDATER_CHECK_RESULT`:

```json
{
  "schemaVersion": 1,
  "status": "update-available",
  "current": "1.2.3",
  "latest": "1.2.4",
  "summary": "optional status text"
}
```

`current` and `latest` must be exact semver values or 40-character commits.
Update commands receive immutable plan, stage, manifest, current, latest, and
source environment variables. They write a schema-2 manifest naming only
allowed paths. Symlinks, external hardlinks, protected paths, traversal, and
overlapping paths are rejected.

Backups are verified `.tar.gz` archives with SHA-256 metadata. Three archives
per component are retained.

## Updater Self-Update

`self-update check` resolves the exact `main` SHA from the configured
repository. `self-update apply` checks again, rejects a non-fast-forward,
builds the checked Go source, syntax-checks the read-only plugin payload, then
atomically stages both targets through the normal transaction journal.

The installed binary must be a regular unlinked file. The plugin target is
`$OPENCODE_COMPONENT_UPDATER_PLUGIN_DIR`, defaulting to:

```text
~/.config/opencode/plugins/opencode-component-updater
```

`self-update rollback` restores both targets from their matching verified
archives. Neither self-update path runs `npm install`, package lifecycle
scripts, or deployment commands.

## Development

```bash
npm run check
npm test
go test ./...
go vet ./...
go build -o /tmp/opencode/component-updater ./cmd/opencode-component-updater
```
