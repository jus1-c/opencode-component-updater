package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
)

type openCodeRunningError struct {
	Processes []openCodeProcess
}

var findOpenCodeProcesses = listOpenCodeProcesses

func (err *openCodeRunningError) Error() string {
	lines := []string{"OpenCode is still running; close every OpenCode process before changing components."}
	for _, process := range err.Processes {
		lines = append(lines, fmt.Sprintf("pid %d: %s", process.PID, fallback(process.Executable, process.Command)))
	}
	return strings.Join(lines, "\n")
}

func ensureNoOpenCodeProcesses() error {
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
	lines = append(lines, "", bodyStyle.Render("Close every OpenCode process before changing components."), "", keyHint("r", "retry")+"    "+keyHint("q", "cancel"))
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
