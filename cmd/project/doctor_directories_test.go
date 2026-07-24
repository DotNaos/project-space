package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestProjectDirectoryDoctorReportsEveryMissingDirectoryWithoutFix(t *testing.T) {
	home := t.TempDir()
	doctor := newProjectDirectoryDoctor(func() (string, error) { return home, nil })

	report, err := doctor.Check(false)
	if err != nil {
		t.Fatalf("check: %v", err)
	}
	if report.Ready {
		t.Fatal("missing directories reported ready")
	}

	want := []string{
		filepath.Join(home, "projects"),
		filepath.Join(home, "projects", ".worktrees"),
		filepath.Join(home, "projects", ".codex-worktrees"),
	}
	if len(report.Checks) != len(want) {
		t.Fatalf("checks = %#v, want %d entries", report.Checks, len(want))
	}
	for index, path := range want {
		if report.Checks[index].Path != path || report.Checks[index].Status != projectDirectoryMissing {
			t.Errorf("check %d = %#v, want missing %q", index, report.Checks[index], path)
		}
		if _, statErr := os.Stat(path); !os.IsNotExist(statErr) {
			t.Errorf("check created %q without --fix: %v", path, statErr)
		}
	}
}

func TestProjectDirectoryDoctorFixCreatesAndVerifiesDirectories(t *testing.T) {
	home := t.TempDir()
	doctor := newProjectDirectoryDoctor(func() (string, error) { return home, nil })

	report, err := doctor.Check(true)
	if err != nil {
		t.Fatalf("fix: %v", err)
	}
	if !report.Ready {
		t.Fatalf("fixed report is not ready: %#v", report)
	}
	for _, check := range report.Checks {
		if check.Status != projectDirectoryCreated {
			t.Errorf("check = %#v, want created", check)
		}
		info, statErr := os.Stat(check.Path)
		if statErr != nil || !info.IsDir() {
			t.Errorf("fixed path %q is not a directory: info=%v err=%v", check.Path, info, statErr)
		}
	}

	second, err := doctor.Check(true)
	if err != nil {
		t.Fatalf("second fix: %v", err)
	}
	for _, check := range second.Checks {
		if check.Status != projectDirectoryReady {
			t.Errorf("idempotent check = %#v, want ready", check)
		}
	}
}

func TestProjectDirectoryDoctorRejectsFileAtRequiredPath(t *testing.T) {
	home := t.TempDir()
	projects := filepath.Join(home, "projects")
	if err := os.WriteFile(projects, []byte("not a directory"), 0o600); err != nil {
		t.Fatalf("write blocker: %v", err)
	}
	doctor := newProjectDirectoryDoctor(func() (string, error) { return home, nil })

	report, err := doctor.Check(true)
	if err == nil || !strings.Contains(err.Error(), "is not a directory") {
		t.Fatalf("error = %v, want non-directory error", err)
	}
	if report.Ready || report.Checks[0].Status != projectDirectoryBlocked {
		t.Fatalf("blocked path reported incorrectly: %#v", report)
	}
}

func TestDoctorCommandReportsMissingDirectoriesAndStillChecksBackend(t *testing.T) {
	home := t.TempDir()
	dependencies, backend, _, _ := testCommandDependencies()
	command := newMachineDoctorCommandWithDependencyFactoryAndDirectoryDoctor(
		fixedMachineConnectionDependencies(dependencies),
		newProjectDirectoryDoctor(func() (string, error) { return home, nil }),
	)
	output := &bytes.Buffer{}
	command.SetOut(output)
	command.SetIn(strings.NewReader("n\n"))

	err := command.Execute()
	if err == nil || !strings.Contains(err.Error(), `run "project doctor --fix"`) {
		t.Fatalf("error = %v, want --fix guidance", err)
	}
	if backend.healthCalls != 1 {
		t.Fatalf("backend health calls = %d, want 1", backend.healthCalls)
	}
	if !strings.Contains(output.String(), "Project Space backend is reachable.") {
		t.Fatalf("backend result missing from output: %q", output.String())
	}
	for _, suffix := range []string{"projects", ".worktrees", ".codex-worktrees"} {
		if !strings.Contains(output.String(), suffix) {
			t.Errorf("missing %q from output: %q", suffix, output.String())
		}
	}
}

func TestDoctorCommandConfirmationFixesDirectories(t *testing.T) {
	home := t.TempDir()
	dependencies, backend, _, _ := testCommandDependencies()
	command := newMachineDoctorCommandWithDependencyFactoryAndDirectoryDoctor(
		fixedMachineConnectionDependencies(dependencies),
		newProjectDirectoryDoctor(func() (string, error) { return home, nil }),
	)
	output := &bytes.Buffer{}
	command.SetOut(output)
	command.SetErr(output)
	command.SetIn(strings.NewReader("y\n"))
	command.SetArgs([]string{"--fix"})

	if err := command.Execute(); err != nil {
		t.Fatalf("execute: %v", err)
	}
	if backend.healthCalls != 1 {
		t.Fatalf("backend health calls = %d, want 1", backend.healthCalls)
	}
	if !strings.Contains(output.String(), "Create missing project directories now? y/N: ") ||
		!strings.Contains(output.String(), "Project directories are ready.") {
		t.Fatalf("unexpected confirmation output: %q", output.String())
	}
	for _, path := range []string{
		filepath.Join(home, "projects"),
		filepath.Join(home, "projects", ".worktrees"),
		filepath.Join(home, "projects", ".codex-worktrees"),
	} {
		info, statErr := os.Stat(path)
		if statErr != nil || !info.IsDir() {
			t.Errorf("confirmed path %q is not a directory: info=%v err=%v", path, info, statErr)
		}
	}
}

func TestDoctorCommandConfirmationDefaultsToNo(t *testing.T) {
	for _, test := range []struct {
		name  string
		input string
	}{
		{name: "enter", input: "\n"},
		{name: "n", input: "n\n"},
		{name: "no", input: "no\n"},
		{name: "invalid", input: "fix it\n"},
		{name: "eof", input: ""},
	} {
		t.Run(test.name, func(t *testing.T) {
			home := t.TempDir()
			dependencies, backend, _, _ := testCommandDependencies()
			command := newMachineDoctorCommandWithDependencyFactoryAndDirectoryDoctor(
				fixedMachineConnectionDependencies(dependencies),
				newProjectDirectoryDoctor(func() (string, error) { return home, nil }),
			)
			output := &bytes.Buffer{}
			command.SetOut(output)
			command.SetErr(output)
			command.SetIn(strings.NewReader(test.input))
			command.SetArgs([]string{"--fix"})

			err := command.Execute()
			if err == nil || !strings.Contains(err.Error(), "repair was not confirmed") {
				t.Fatalf("error = %v, want confirmation failure", err)
			}
			if backend.healthCalls != 0 {
				t.Fatalf("backend health calls = %d, want 0 after declined plan", backend.healthCalls)
			}
			if !strings.Contains(output.String(), "Create missing project directories now? y/N: ") {
				t.Fatalf("confirmation prompt missing: %q", output.String())
			}
			if _, statErr := os.Stat(filepath.Join(home, "projects")); !os.IsNotExist(statErr) {
				t.Fatalf("default-no confirmation changed the filesystem: %v", statErr)
			}
		})
	}
}

func TestDoctorCommandDoesNotPromptForNonInteractiveStdin(t *testing.T) {
	home := t.TempDir()
	inputPath := filepath.Join(t.TempDir(), "stdin")
	if err := os.WriteFile(inputPath, []byte("y\n"), 0o600); err != nil {
		t.Fatalf("write stdin fixture: %v", err)
	}
	input, err := os.Open(inputPath)
	if err != nil {
		t.Fatalf("open stdin fixture: %v", err)
	}
	defer input.Close()

	dependencies, backend, _, _ := testCommandDependencies()
	command := newMachineDoctorCommandWithDependencyFactoryAndDirectoryDoctor(
		fixedMachineConnectionDependencies(dependencies),
		newProjectDirectoryDoctor(func() (string, error) { return home, nil }),
	)
	output := &bytes.Buffer{}
	command.SetOut(output)
	command.SetIn(input)

	err = command.Execute()
	if err == nil || !strings.Contains(err.Error(), `run "project doctor --fix"`) {
		t.Fatalf("error = %v, want --fix guidance", err)
	}
	if backend.healthCalls != 1 {
		t.Fatalf("backend health calls = %d, want 1", backend.healthCalls)
	}
	if strings.Contains(output.String(), "Create missing project directories") {
		t.Fatalf("non-interactive output contains a prompt: %q", output.String())
	}
	if _, statErr := os.Stat(filepath.Join(home, "projects")); !os.IsNotExist(statErr) {
		t.Fatalf("non-interactive stdin changed the filesystem: %v", statErr)
	}
}

func TestDoctorCommandFixIncludesDirectoryEvidenceInJSON(t *testing.T) {
	home := t.TempDir()
	dependencies, _, _, _ := testCommandDependencies()
	command := newMachineDoctorCommandWithDependencyFactoryAndDirectoryDoctor(
		fixedMachineConnectionDependencies(dependencies),
		newProjectDirectoryDoctor(func() (string, error) { return home, nil }),
	)
	output := &bytes.Buffer{}
	command.SetOut(output)
	command.SetArgs([]string{"--fix", "--yes", "--json"})

	if err := command.Execute(); err != nil {
		t.Fatalf("execute: %v", err)
	}
	var result struct {
		BackendReachable   bool                   `json:"backendReachable"`
		ProjectDirectories projectDirectoryReport `json:"projectDirectories"`
	}
	if err := json.Unmarshal(output.Bytes(), &result); err != nil {
		t.Fatalf("decode output %q: %v", output.String(), err)
	}
	if !result.BackendReachable || !result.ProjectDirectories.Ready {
		t.Fatalf("unexpected doctor result: %#v", result)
	}
	for _, check := range result.ProjectDirectories.Checks {
		if check.Status != projectDirectoryCreated {
			t.Errorf("JSON check = %#v, want created", check)
		}
	}
}

func TestDoctorCommandJSONReportsMissingDirectoriesBeforeFailing(t *testing.T) {
	home := t.TempDir()
	dependencies, _, _, _ := testCommandDependencies()
	command := newMachineDoctorCommandWithDependencyFactoryAndDirectoryDoctor(
		fixedMachineConnectionDependencies(dependencies),
		newProjectDirectoryDoctor(func() (string, error) { return home, nil }),
	)
	output := &bytes.Buffer{}
	command.SetOut(output)
	command.SetIn(failingReader{})
	command.SetArgs([]string{"--json"})
	command.SilenceUsage = true

	err := command.Execute()
	if err == nil || !strings.Contains(err.Error(), `run "project doctor --fix"`) {
		t.Fatalf("error = %v, want --fix guidance", err)
	}
	var result machineDoctorCommandResult
	if err := json.Unmarshal(output.Bytes(), &result); err != nil {
		t.Fatalf("decode output %q: %v", output.String(), err)
	}
	if result.ProjectDirectories.Ready || !result.ProjectDirectories.hasMissing() {
		t.Fatalf("missing directories reported incorrectly: %#v", result.ProjectDirectories)
	}
	if strings.Contains(output.String(), "Create missing project directories") {
		t.Fatalf("JSON output contains an interactive prompt: %q", output.String())
	}
}

func TestDoctorCommandFixesDirectoriesBeforeBackendDependencyFailure(t *testing.T) {
	home := t.TempDir()
	command := newMachineDoctorCommandWithDependencyFactoryAndDirectoryDoctor(
		func() (machineConnectionCommandDependencies, error) {
			return machineConnectionCommandDependencies{}, errors.New("backend configuration failed")
		},
		newProjectDirectoryDoctor(func() (string, error) { return home, nil }),
	)
	command.SetOut(&bytes.Buffer{})
	command.SetArgs([]string{"--fix", "--yes"})

	err := command.Execute()
	if err == nil || !strings.Contains(err.Error(), "backend configuration failed") {
		t.Fatalf("error = %v, want backend failure", err)
	}
	for _, path := range []string{
		filepath.Join(home, "projects"),
		filepath.Join(home, "projects", ".worktrees"),
		filepath.Join(home, "projects", ".codex-worktrees"),
	} {
		info, statErr := os.Stat(path)
		if statErr != nil || !info.IsDir() {
			t.Errorf("fixed path %q is not a directory: info=%v err=%v", path, info, statErr)
		}
	}
}

type failingReader struct{}

func (failingReader) Read([]byte) (int, error) {
	return 0, errors.New("stdin must not be read")
}
