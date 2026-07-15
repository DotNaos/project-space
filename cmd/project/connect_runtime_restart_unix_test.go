//go:build !windows

package main

import (
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestRestartConnectorSupervisorExecsOnlyManagedCurrentProject(t *testing.T) {
	toolsRoot := filepath.Join(t.TempDir(), ".project-space-machine-tools")
	releaseRoot := filepath.Join(toolsRoot, "versions", "0.4.7-bbbbbbbbbbbbbbbb")
	if err := os.MkdirAll(releaseRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	connector := filepath.Join(releaseRoot, "project-space-connector")
	project := filepath.Join(releaseRoot, "project")
	for _, path := range []string{connector, project} {
		if err := os.WriteFile(path, []byte("fixture"), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Symlink("versions/0.4.7-bbbbbbbbbbbbbbbb", filepath.Join(toolsRoot, "current")); err != nil {
		t.Fatal(err)
	}
	resolvedProject, err := filepath.EvalSymlinks(project)
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("PROJECT_CONNECTOR_RELAUNCH_TEST", "fixed")
	wantErr := errors.New("exec fixture stopped replacement")
	var actualPath string
	var actualArguments []string
	var actualEnvironment []string
	previousExec := execConnectorSupervisor
	execConnectorSupervisor = func(path string, arguments []string, environment []string) error {
		actualPath = path
		actualArguments = append([]string(nil), arguments...)
		actualEnvironment = append([]string(nil), environment...)
		return wantErr
	}
	t.Cleanup(func() { execConnectorSupervisor = previousExec })

	err = restartConnectorSupervisor(connector)
	if !errors.Is(err, wantErr) || actualPath != resolvedProject ||
		!reflect.DeepEqual(actualArguments, []string{resolvedProject, "connector", "run"}) {
		t.Fatalf("managed exec = path %q args %#v err %v", actualPath, actualArguments, err)
	}
	foundEnvironment := false
	for _, entry := range actualEnvironment {
		if entry == "PROJECT_CONNECTOR_RELAUNCH_TEST=fixed" {
			foundEnvironment = true
			break
		}
	}
	if !foundEnvironment {
		t.Fatal("managed exec did not preserve the service environment")
	}
}

func TestRestartConnectorSupervisorRejectsUnmanagedExecutableBeforeExec(t *testing.T) {
	called := false
	previousExec := execConnectorSupervisor
	execConnectorSupervisor = func(string, []string, []string) error {
		called = true
		return nil
	}
	t.Cleanup(func() { execConnectorSupervisor = previousExec })

	if err := restartConnectorSupervisor(filepath.Join(t.TempDir(), "project-space-connector")); err == nil {
		t.Fatal("unmanaged connector was accepted")
	}
	if called {
		t.Fatal("exec ran for an unmanaged connector")
	}
}
