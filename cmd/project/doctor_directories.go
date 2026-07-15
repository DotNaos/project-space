package main

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

type projectDirectoryStatus string

const (
	projectDirectoryReady   projectDirectoryStatus = "ready"
	projectDirectoryMissing projectDirectoryStatus = "missing"
	projectDirectoryCreated projectDirectoryStatus = "created"
	projectDirectoryBlocked projectDirectoryStatus = "blocked"
)

type projectDirectoryCheck struct {
	Path   string                 `json:"path"`
	Status projectDirectoryStatus `json:"status"`
}

type projectDirectoryReport struct {
	Ready  bool                    `json:"ready"`
	Checks []projectDirectoryCheck `json:"checks"`
}

func (report projectDirectoryReport) hasMissing() bool {
	for _, check := range report.Checks {
		if check.Status == projectDirectoryMissing {
			return true
		}
	}
	return false
}

type projectDirectoryDoctor struct {
	homeDir func() (string, error)
}

func newProjectDirectoryDoctor(homeDir func() (string, error)) projectDirectoryDoctor {
	return projectDirectoryDoctor{homeDir: homeDir}
}

func (doctor projectDirectoryDoctor) Check(fix bool) (projectDirectoryReport, error) {
	if doctor.homeDir == nil {
		return projectDirectoryReport{}, errors.New("project directory home resolver is missing")
	}
	home, err := doctor.homeDir()
	if err != nil {
		return projectDirectoryReport{}, fmt.Errorf("resolve home directory: %w", err)
	}
	home = strings.TrimSpace(home)
	if home == "" || !filepath.IsAbs(home) {
		return projectDirectoryReport{}, errors.New("home directory must be an absolute path")
	}

	projects := filepath.Join(filepath.Clean(home), "projects")
	paths := []string{
		projects,
		filepath.Join(projects, ".worktrees"),
		filepath.Join(projects, ".codex-worktrees"),
	}
	report := projectDirectoryReport{
		Ready:  true,
		Checks: make([]projectDirectoryCheck, 0, len(paths)),
	}
	var checkErr error
	for _, path := range paths {
		check, err := checkProjectDirectory(path, fix)
		report.Checks = append(report.Checks, check)
		if check.Status == projectDirectoryMissing || check.Status == projectDirectoryBlocked {
			report.Ready = false
		}
		checkErr = errors.Join(checkErr, err)
	}
	return report, checkErr
}

func checkProjectDirectory(path string, fix bool) (projectDirectoryCheck, error) {
	check := projectDirectoryCheck{Path: path}
	info, err := os.Stat(path)
	switch {
	case err == nil && info.IsDir():
		check.Status = projectDirectoryReady
		return check, nil
	case err == nil:
		check.Status = projectDirectoryBlocked
		return check, fmt.Errorf("required project path %q is not a directory", path)
	case !os.IsNotExist(err):
		check.Status = projectDirectoryBlocked
		return check, fmt.Errorf("check required project directory %q: %w", path, err)
	case !fix:
		check.Status = projectDirectoryMissing
		return check, nil
	}

	if err := os.MkdirAll(path, 0o755); err != nil {
		check.Status = projectDirectoryBlocked
		return check, fmt.Errorf("create required project directory %q: %w", path, err)
	}
	info, err = os.Stat(path)
	if err != nil {
		check.Status = projectDirectoryBlocked
		return check, fmt.Errorf("verify required project directory %q: %w", path, err)
	}
	if !info.IsDir() {
		check.Status = projectDirectoryBlocked
		return check, fmt.Errorf("required project path %q is not a directory", path)
	}
	check.Status = projectDirectoryCreated
	return check, nil
}

func writeProjectDirectoryReport(writer io.Writer, report projectDirectoryReport) {
	for _, check := range report.Checks {
		switch check.Status {
		case projectDirectoryMissing:
			fmt.Fprintf(writer, "Missing project directory: %s\n", check.Path)
		case projectDirectoryCreated:
			fmt.Fprintf(writer, "Created project directory: %s\n", check.Path)
		case projectDirectoryBlocked:
			fmt.Fprintf(writer, "Blocked project directory: %s\n", check.Path)
		}
	}
	if report.Ready {
		fmt.Fprintln(writer, "Project directories are ready.")
	}
}
