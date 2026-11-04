package main

import (
	"sync"
	"testing"
)

func resetLiveProbe(t *testing.T, version string) {
	t.Helper()
	previousProbe := probeLiveService
	liveServiceOnce = sync.Once{}
	liveServiceVersion = ""
	probeLiveService = func() string { return version }
	t.Cleanup(func() {
		probeLiveService = previousProbe
		liveServiceOnce = sync.Once{}
		liveServiceVersion = ""
	})
}

func TestLiveApplyAllowedHonoursOverride(t *testing.T) {
	previous := allowRunning
	t.Cleanup(func() { allowRunning = previous })
	resetLiveProbe(t, "")
	t.Setenv("OPENCODE_COMPONENT_UPDATER_ALLOW_RUNNING", "")

	allowRunning = true
	if !liveApplyAllowed() {
		t.Fatal("--allow-running must permit live apply")
	}

	allowRunning = false
	t.Setenv("OPENCODE_COMPONENT_UPDATER_ALLOW_RUNNING", "1")
	if !liveApplyAllowed() {
		t.Fatal("env override must permit live apply")
	}
}

func TestLiveApplyAllowedUsesDetectedService(t *testing.T) {
	previous := allowRunning
	t.Cleanup(func() { allowRunning = previous })
	allowRunning = false
	t.Setenv("OPENCODE_COMPONENT_UPDATER_ALLOW_RUNNING", "")

	resetLiveProbe(t, "2.1.4")
	if !liveApplyAllowed() {
		t.Fatal("a V2 service must permit live apply")
	}

	resetLiveProbe(t, "")
	if liveApplyAllowed() {
		t.Fatal("without a V2 service live apply must stay off")
	}
}

func TestEnsureNoProcessesSkipsGuardWhenLive(t *testing.T) {
	previousAllow := allowRunning
	previousFinder := findOpenCodeProcesses
	t.Cleanup(func() {
		allowRunning = previousAllow
		findOpenCodeProcesses = previousFinder
	})
	t.Setenv("OPENCODE_COMPONENT_UPDATER_ALLOW_RUNNING", "")

	allowRunning = true
	findOpenCodeProcesses = func() ([]openCodeProcess, error) {
		return []openCodeProcess{{PID: 42, Executable: "/usr/bin/opencode"}}, nil
	}
	if err := ensureNoOpenCodeProcesses(); err != nil {
		t.Fatalf("live mode must not block: %v", err)
	}

	allowRunning = false
	resetLiveProbe(t, "")
	if err := ensureNoOpenCodeProcesses(); err == nil {
		t.Fatal("without live support a running process must block")
	}
}

func TestHasFlagAndRemoveFlag(t *testing.T) {
	args := []string{"--best-effort", "--allow-running"}
	if !hasFlag(args, "--allow-running") {
		t.Fatal("flag not detected")
	}
	got := removeFlag(args, "--allow-running")
	if len(got) != 1 || got[0] != "--best-effort" {
		t.Fatalf("removeFlag = %v", got)
	}
}
