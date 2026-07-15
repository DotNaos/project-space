package machineconnect

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestLinuxServiceConnectorUsesManagedCurrentProjectAcrossPointerSwitch(t *testing.T) {
	installRoot := t.TempDir()
	toolsRoot := filepath.Join(installRoot, ".project-space-machine-tools")
	versionsRoot := filepath.Join(toolsRoot, connectorSupervisorVersionsDirectoryName)
	oldRelease := filepath.Join(versionsRoot, "0.4.5-aaaaaaaaaaaaaaaa")
	newRelease := filepath.Join(versionsRoot, "0.4.6-bbbbbbbbbbbbbbbb")
	for _, release := range []string{oldRelease, newRelease} {
		if err := os.MkdirAll(release, 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(release, "project"), []byte("project\n"), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	current := filepath.Join(toolsRoot, connectorSupervisorCurrentPointerName)
	if err := os.Symlink(filepath.Join(
		connectorSupervisorVersionsDirectoryName,
		filepath.Base(oldRelease),
	), current); err != nil {
		t.Fatal(err)
	}

	runner := &scriptedServiceRunner{responses: []serviceCommandResponse{
		{output: "not-found\n"},
		{},
	}}
	connector := testServiceConnector(t, ServiceConnectorOptions{
		Executable: filepath.Join(oldRelease, "project"),
		GOOS:       "linux",
	}, runner, &recordingServiceFiles{})
	resolvedInstallRoot, err := filepath.EvalSymlinks(installRoot)
	if err != nil {
		t.Fatal(err)
	}
	stable := filepath.Join(
		resolvedInstallRoot,
		".project-space-machine-tools",
		connectorSupervisorCurrentPointerName,
		"project",
	)
	if connector.executable != stable {
		t.Fatalf("Linux service executable = %q, want stable path %q", connector.executable, stable)
	}

	if err := connector.Start(context.Background()); err != nil {
		t.Fatalf("start managed Linux service: %v", err)
	}
	if got := serviceCommandNames(runner.calls); !reflect.DeepEqual(got, []string{"systemctl", "systemd-run"}) {
		t.Fatalf("Linux service calls = %#v", got)
	}
	if !containsArgument(runner.calls[1].arguments, stable) ||
		containsArgument(runner.calls[1].arguments, filepath.Join(oldRelease, "project")) {
		t.Fatalf("systemd command did not use only the stable managed path: %#v", runner.calls[1])
	}

	if err := os.Remove(current); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(
		connectorSupervisorVersionsDirectoryName,
		filepath.Base(newRelease),
	), current); err != nil {
		t.Fatal(err)
	}
	resolved, err := filepath.EvalSymlinks(connector.executable)
	if err != nil {
		t.Fatal(err)
	}
	if want := filepath.Join(
		resolvedInstallRoot,
		".project-space-machine-tools",
		connectorSupervisorVersionsDirectoryName,
		filepath.Base(newRelease),
		"project",
	); resolved != want {
		t.Fatalf("stable Linux service path resolved to %q after update, want %q", resolved, want)
	}
}

func TestManagedLinuxServiceConnectorCanStopBeforeCurrentPointerExists(t *testing.T) {
	toolsRoot := filepath.Join(t.TempDir(), ".project-space-machine-tools")
	project := filepath.Join(
		toolsRoot,
		connectorSupervisorVersionsDirectoryName,
		"0.4.7-candidate",
		"project",
	)
	if err := os.MkdirAll(filepath.Dir(project), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(project, []byte("project\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	runner := &scriptedServiceRunner{responses: []serviceCommandResponse{{output: "not-found\n"}}}
	connector := testServiceConnector(t, ServiceConnectorOptions{
		Executable: project,
		GOOS:       "linux",
	}, runner, &recordingServiceFiles{})

	if err := connector.Stop(context.Background()); err != nil {
		t.Fatalf("stop from staged managed executable: %v", err)
	}
	if got := serviceCommandNames(runner.calls); !reflect.DeepEqual(got, []string{"systemctl"}) {
		t.Fatalf("staged stop commands = %#v", got)
	}
	if err := connector.Start(context.Background()); err == nil ||
		!strings.Contains(err.Error(), "managed Linux connector service executable is unsafe") {
		t.Fatalf("start without stable current pointer was accepted: %v", err)
	}
}

func TestManagedLinuxServiceConnectorStartRevalidatesCurrentPointer(t *testing.T) {
	for name, replaceCurrent := range map[string]func(*testing.T, string){
		"missing": func(t *testing.T, current string) {
			t.Helper()
			if err := os.Remove(current); err != nil {
				t.Fatal(err)
			}
		},
		"outside managed versions": func(t *testing.T, current string) {
			t.Helper()
			if err := os.Remove(current); err != nil {
				t.Fatal(err)
			}
			external := t.TempDir()
			if err := os.WriteFile(filepath.Join(external, "project"), []byte("project\n"), 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(external, current); err != nil {
				t.Fatal(err)
			}
		},
	} {
		t.Run(name, func(t *testing.T) {
			toolsRoot := filepath.Join(t.TempDir(), ".project-space-machine-tools")
			release := filepath.Join(
				toolsRoot,
				connectorSupervisorVersionsDirectoryName,
				"0.4.7-current",
			)
			if err := os.MkdirAll(release, 0o700); err != nil {
				t.Fatal(err)
			}
			project := filepath.Join(release, "project")
			if err := os.WriteFile(project, []byte("project\n"), 0o700); err != nil {
				t.Fatal(err)
			}
			current := filepath.Join(toolsRoot, connectorSupervisorCurrentPointerName)
			if err := os.Symlink(filepath.Join(
				connectorSupervisorVersionsDirectoryName,
				filepath.Base(release),
			), current); err != nil {
				t.Fatal(err)
			}
			runner := &scriptedServiceRunner{}
			connector := testServiceConnector(t, ServiceConnectorOptions{
				Executable: project,
				GOOS:       "linux",
			}, runner, &recordingServiceFiles{})
			replaceCurrent(t, current)

			err := connector.Start(context.Background())
			if err == nil || !strings.Contains(err.Error(), "managed Linux connector service executable is unsafe") {
				t.Fatalf("start accepted changed managed current pointer: %v", err)
			}
			if len(runner.calls) != 0 {
				t.Fatalf("start touched the service before pointer validation: %#v", runner.calls)
			}
		})
	}
}
