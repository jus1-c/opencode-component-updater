package main

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestCheckPreservesLastGoodAfterFailure(t *testing.T) {
	root := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(root, "config"))
	t.Setenv("XDG_STATE_HOME", filepath.Join(root, "state"))
	t.Setenv("OPENCODE_CONFIG_DIR", filepath.Join(root, "opencode"))
	paths, err := resolvePaths()
	if err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(root, "component")
	if err := os.MkdirAll(target, 0o700); err != nil {
		t.Fatal(err)
	}
	item := discoveredComponent("plugin", "example", &target)
	item.Enabled = true
	item.Check.Command = []string{"sh", "-c", "printf '{\"schemaVersion\":1,\"status\":\"update-available\",\"current\":\"1.0.0\",\"latest\":\"1.1.0\"}' > \"$OPENCODE_UPDATER_CHECK_RESULT\""}
	if err := saveConfig(paths.ConfigPath, config{SchemaVersion: configSchemaVersion, Defaults: defaultDefaults(), Components: map[string]component{"plugin.example": item}}); err != nil {
		t.Fatal(err)
	}
	if _, err := checkAll(context.Background(), paths, nil); err != nil {
		t.Fatal(err)
	}
	item.Check.Command = []string{"sh", "-c", "exit 1"}
	if err := saveConfig(paths.ConfigPath, config{SchemaVersion: configSchemaVersion, Defaults: defaultDefaults(), Components: map[string]component{"plugin.example": item}}); err != nil {
		t.Fatal(err)
	}
	if _, err := checkAll(context.Background(), paths, nil); err != nil {
		t.Fatal(err)
	}
	state, err := loadState(paths.StatePath)
	if err != nil {
		t.Fatal(err)
	}
	entry := state.Components[componentKey("plugin.example", item)]
	if entry.LastGood == nil || entry.LastGood.Latest != "1.1.0" {
		t.Fatalf("last good result lost: %#v", entry.LastGood)
	}
	if entry.LastAttempt == nil || entry.LastAttempt.Status != "check-error" {
		t.Fatalf("last attempt not recorded: %#v", entry.LastAttempt)
	}
}

func TestOpenCodeProcessClassification(t *testing.T) {
	if !isOpenCodeProcess("/home/c/.opencode/bin/opencode", "other", true) {
		t.Fatal("expected exact executable name to match")
	}
	if isOpenCodeProcess("/usr/bin/not-opencode", "opencode", true) {
		t.Fatal("executable must win when available")
	}
	if !isOpenCodeProcess("", "opencode", false) {
		t.Fatal("expected comm fallback to match")
	}
	if isOpenCodeProcess("/usr/bin/opencode-wrapper", "opencode-wrapper", true) {
		t.Fatal("substring match must not classify as OpenCode")
	}
}
