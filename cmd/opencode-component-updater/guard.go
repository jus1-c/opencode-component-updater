package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
)

type openCodeRunningError struct {
	Processes []openCodeProcess
}

var findOpenCodeProcesses = listOpenCodeProcesses

// allowRunning lets a caller apply changes while OpenCode stays up. OpenCode V2
// reloads locations from disk, so a restart is no longer required.
var allowRunning bool

var (
	liveServiceOnce    sync.Once
	liveServiceVersion string
	probeLiveService   = func() string {
		output := runCommand(context.Background(), []string{"opencode", "api", "get", "/api/info"}, "", nil, 5_000, 8_192)
		if output.Code != 0 || output.Reason != "" {
			return ""
		}
		var info struct {
			Version string `json:"version"`
		}
		if json.Unmarshal([]byte(output.Stdout), &info) != nil {
			return ""
		}
		return info.Version
	}
)

// detectLiveService reports the running OpenCode server version when it supports
// live reload, or "" when no compatible server answers.
func detectLiveService() string {
	liveServiceOnce.Do(func() {
		liveServiceVersion = probeLiveService()
	})
	return liveServiceVersion
}

// liveApplyAllowed reports whether component changes may be applied without
// waiting for OpenCode to exit.
func liveApplyAllowed() bool {
	if allowRunning || os.Getenv("OPENCODE_COMPONENT_UPDATER_ALLOW_RUNNING") == "1" {
		return true
	}
	return detectLiveService() != ""
}

func (err *openCodeRunningError) Error() string {
	lines := []string{"OpenCode is still running; close every OpenCode process before changing components."}
	for _, process := range err.Processes {
		lines = append(lines, fmt.Sprintf("pid %d: %s", process.PID, fallback(process.Executable, process.Command)))
	}
	return strings.Join(lines, "\n")
}

func ensureNoOpenCodeProcesses() error {
	if liveApplyAllowed() {
		return nil
	}
	processes, err := findOpenCodeProcesses()
	if err != nil {
		return err
	}
	if len(processes) != 0 {
		return &openCodeRunningError{Processes: processes}
	}
	return nil
}

func waitForOpenCodeExit(ctx context.Context) error {
	if err := ensureNoOpenCodeProcesses(); err == nil {
		return nil
	} else if !interactiveTerminal() {
		return err
	}
	model := processGuardModel{ctx: ctx, width: 80}
	final, err := tea.NewProgram(model, tea.WithOutput(os.Stderr)).Run()
	if err != nil {
		return err
	}
	return final.(processGuardModel).err
}

type processScanMessage struct {
	processes []openCodeProcess
	err       error
}

type processGuardModel struct {
	ctx       context.Context
	processes []openCodeProcess
	err       error
	width     int
}

func (model processGuardModel) Init() tea.Cmd {
	return scanOpenCodeProcesses()
}

func (model processGuardModel) Update(message tea.Msg) (tea.Model, tea.Cmd) {
	switch typed := message.(type) {
	case tea.WindowSizeMsg:
		model.width = typed.Width
		return model, nil
	case processScanMessage:
		if typed.err != nil {
			model.err = typed.err
			return model, tea.Quit
		}
		model.processes = typed.processes
		if len(typed.processes) == 0 {
			return model, tea.Quit
		}
	case tea.KeyPressMsg:
		switch typed.String() {
		case "r":
			return model, scanOpenCodeProcesses()
		case "q", "esc", "ctrl+c":
			model.err = &openCodeRunningError{Processes: model.processes}
			return model, tea.Quit
		}
	}
	return model, nil
}

func (model processGuardModel) View() tea.View {
	warning := lipgloss.NewStyle().Bold(true).Foreground(yellow).Render("⚠ BLOCKED")
	lines := []string{warning + "  " + bodyStyle.Render("OpenCode is still running."), "", labelStyle.Render("PID     EXECUTABLE")}
	for _, process := range model.processes {
		lines = append(lines, fmt.Sprintf("%s  %s", componentStyle.Render(fmt.Sprintf("%-7d", process.PID)), dimStyle.Render(fallback(process.Executable, process.Command))))
	}
	lines = append(lines, "", bodyStyle.Render("Close every OpenCode process, or run with --allow-running to apply live."), "", keyHint("r", "retry")+"    "+keyHint("q", "cancel"))
	return tea.NewView(panel("OpenCode Component Updater", strings.Join(lines, "\n"), clamp(model.width-2, 20, 100), yellow) + "\n")
}

func scanOpenCodeProcesses() tea.Cmd {
	return func() tea.Msg {
		processes, err := findOpenCodeProcesses()
		return processScanMessage{processes: processes, err: err}
	}
}

func isOpenCodeBlocked(err error) bool {
	var blocked *openCodeRunningError
	return errors.As(err, &blocked)
}
