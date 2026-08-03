package main

import (
	"context"
	"encoding/json"
	"fmt"
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

func TestStrictUpgradeStagesThenAppliesAndArchives(t *testing.T) {
	withoutLiveOpenCode(t)
	root := t.TempDir()
	target := filepath.Join(root, "component")
	if err := os.MkdirAll(filepath.Join(target, "runtime"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(target, "runtime", "version.txt"), []byte("old\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	value := testPaths(root)
	item := discoveredComponent("plugin", "example", &target)
	item.Enabled = true
	item.Policy.Apply = "manifest"
	item.Policy.AllowedPaths = []string{"runtime"}
	item.Check.Command = []string{"sh", "-c", "printf '{\"schemaVersion\":1,\"status\":\"update-available\",\"current\":\"1.0.0\",\"latest\":\"1.1.0\"}' > \"$OPENCODE_UPDATER_CHECK_RESULT\""}
	item.Update.Command = []string{"sh", "-c", "mkdir -p \"$OPENCODE_UPDATER_STAGE/runtime\"; printf new > \"$OPENCODE_UPDATER_STAGE/runtime/version.txt\"; printf '{\"schemaVersion\":2,\"planSha256\":\"%s\",\"paths\":[\"runtime\"]}' \"$OPENCODE_UPDATER_PLAN_SHA256\" > \"$OPENCODE_UPDATER_MANIFEST\""}
	if err := saveConfig(value.ConfigPath, config{SchemaVersion: configSchemaVersion, Defaults: defaultDefaults(), Components: map[string]component{"plugin.example": item}}); err != nil {
		t.Fatal(err)
	}
	if err := upgradeAll(context.Background(), value, false, nil); err != nil {
		t.Fatal(err)
	}
	contents, err := os.ReadFile(filepath.Join(target, "runtime", "version.txt"))
	if err != nil {
		t.Fatal(err)
	}
	if string(contents) != "new" {
		t.Fatalf("unexpected target content: %q", contents)
	}
	archives, err := filepath.Glob(filepath.Join(value.BackupRoot, "plugin.example", "*.tar.gz"))
	if err != nil || len(archives) != 1 {
		t.Fatalf("expected one backup archive, got %v, %v", archives, err)
	}
	if _, err := verifyArchive(archives[0]); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(value.JournalPath); !os.IsNotExist(err) {
		t.Fatalf("journal should be removed: %v", err)
	}
}

func TestStrictUpgradeLeavesTargetUntouchedWhenStageFails(t *testing.T) {
	withoutLiveOpenCode(t)
	root := t.TempDir()
	target := filepath.Join(root, "component")
	if err := os.MkdirAll(filepath.Join(target, "runtime"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(target, "runtime", "version.txt"), []byte("old"), 0o600); err != nil {
		t.Fatal(err)
	}
	value := testPaths(root)
	item := discoveredComponent("plugin", "example", &target)
	item.Enabled = true
	item.Policy.Apply = "manifest"
	item.Policy.AllowedPaths = []string{"runtime"}
	item.Check.Command = []string{"sh", "-c", "printf '{\"schemaVersion\":1,\"status\":\"update-available\",\"current\":\"1.0.0\",\"latest\":\"1.1.0\"}' > \"$OPENCODE_UPDATER_CHECK_RESULT\""}
	item.Update.Command = []string{"sh", "-c", "exit 1"}
	if err := saveConfig(value.ConfigPath, config{SchemaVersion: configSchemaVersion, Defaults: defaultDefaults(), Components: map[string]component{"plugin.example": item}}); err != nil {
		t.Fatal(err)
	}
	err := upgradeAll(context.Background(), value, false, nil)
	if err == nil {
		t.Fatal("expected strict upgrade to fail")
	}
	contents, readErr := os.ReadFile(filepath.Join(target, "runtime", "version.txt"))
	if readErr != nil || string(contents) != "old" {
		t.Fatalf("target changed after failed preflight: %q, %v", contents, readErr)
	}
}

func testPaths(root string) paths {
	return paths{
		OpenCodeConfigRoot: filepath.Join(root, "opencode"),
		ConfigPath:         filepath.Join(root, "config", "components.json"),
		StateRoot:          filepath.Join(root, "state"),
		StatePath:          filepath.Join(root, "state", "state.json"),
		BackupRoot:         filepath.Join(root, "state", "backups"),
		JournalPath:        filepath.Join(root, "state", "journal.json"),
		LockPath:           filepath.Join(root, "state", "operation.lock"),
		RunsRoot:           filepath.Join(root, "state", "runs"),
		TmpRoot:            filepath.Join(root, "state", "tmp"),
	}
}

func withoutLiveOpenCode(t *testing.T) {
	t.Helper()
	previous := findOpenCodeProcesses
	findOpenCodeProcesses = func() ([]openCodeProcess, error) { return nil, nil }
	t.Cleanup(func() { findOpenCodeProcesses = previous })
}

func TestPlanDigestIsStableWithoutStageFields(t *testing.T) {
	component := plannedComponent{ID: "plugin.example", Target: "/tmp/example", Current: "1.0.0", Latest: "1.1.0"}
	first := planDigest(component)
	component.Stage = "/tmp/stage"
	component.Manifest = stageManifest{SchemaVersion: 2, Paths: []string{"runtime"}}
	if second := planDigest(component); first != second {
		encoded, _ := json.Marshal(component)
		t.Fatalf("plan digest changed with stage data: %s: %s", first, encoded)
	}
}

func TestRecoveryRestoresInterruptedSwap(t *testing.T) {
	withoutLiveOpenCode(t)
	root := t.TempDir()
	value := testPaths(root)
	target := filepath.Join(root, "component")
	stage := filepath.Join(root, "stage")
	backup := filepath.Join(root, "backup")
	for _, path := range []string{filepath.Join(target, "runtime"), filepath.Join(backup, "runtime"), stage} {
		if err := os.MkdirAll(path, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(target, "runtime", "version.txt"), []byte("new"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(backup, "runtime", "version.txt"), []byte("old"), 0o600); err != nil {
		t.Fatal(err)
	}
	journal := journal{
		SchemaVersion: 1,
		RunID:         "test-run",
		Mode:          "strict",
		Phase:         "applying",
		Components: []journalComponent{{
			ID:        "plugin.example",
			Target:    target,
			Stage:     stage,
			RawBackup: backup,
			Moves:     []journalMove{{Path: "runtime", OldExisted: true, OldMoved: true, NewMoved: true}},
		}},
	}
	if err := saveJournal(value, journal); err != nil {
		t.Fatal(err)
	}
	if err := recoverTransaction(value, nil); err != nil {
		t.Fatal(err)
	}
	contents, err := os.ReadFile(filepath.Join(target, "runtime", "version.txt"))
	if err != nil || string(contents) != "old" {
		t.Fatalf("recovery did not restore old target: %q, %v", contents, err)
	}
	if _, err := os.Stat(value.JournalPath); !os.IsNotExist(err) {
		t.Fatalf("journal should be removed: %v", err)
	}
}

func TestBackupRetentionKeepsThreeArchives(t *testing.T) {
	root := t.TempDir()
	value := testPaths(root)
	for index := 0; index < 4; index++ {
		raw := filepath.Join(root, "raw", fmt.Sprintf("%d", index))
		if err := os.MkdirAll(filepath.Join(raw, "runtime"), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(raw, "runtime", "version.txt"), []byte("old"), 0o600); err != nil {
			t.Fatal(err)
		}
		component := journalComponent{
			ID:        "plugin.example",
			Target:    filepath.Join(root, "target"),
			RawBackup: raw,
			Plan: plannedComponent{
				Current:  "1.0.0",
				Latest:   "1.1.0",
				Manifest: stageManifest{Paths: []string{"runtime"}},
			},
		}
		runID := fmt.Sprintf("20260101T00000%dZ-run", index)
		if err := archiveComponentBackup(value, runID, &component); err != nil {
			t.Fatal(err)
		}
	}
	archives, err := filepath.Glob(filepath.Join(value.BackupRoot, "plugin.example", "*.tar.gz"))
	if err != nil || len(archives) != 3 {
		t.Fatalf("expected 3 retained archives, got %v, %v", archives, err)
	}
}
