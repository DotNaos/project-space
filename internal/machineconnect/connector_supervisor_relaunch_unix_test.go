//go:build !windows

package machineconnect

import (
	"os"
	"path/filepath"
	"testing"
)

func TestConnectorSupervisorRelaunchUsesOnlyManagedCurrentProject(t *testing.T) {
	toolsRoot := filepath.Join(t.TempDir(), ".project-space-machine-tools")
	versionsRoot := filepath.Join(toolsRoot, connectorSupervisorVersionsDirectoryName)
	oldName := "0.4.6-aaaaaaaaaaaaaaaa"
	newName := "0.4.7-bbbbbbbbbbbbbbbb"
	for _, name := range []string{oldName, newName} {
		directory := filepath.Join(versionsRoot, name)
		if err := os.MkdirAll(directory, 0o700); err != nil {
			t.Fatal(err)
		}
		for _, executable := range []string{"project", "project-space-connector"} {
			if err := os.WriteFile(filepath.Join(directory, executable), []byte("fixture"), 0o700); err != nil {
				t.Fatal(err)
			}
		}
	}
	current := filepath.Join(toolsRoot, connectorSupervisorCurrentPointerName)
	if err := os.Symlink(filepath.Join(connectorSupervisorVersionsDirectoryName, oldName), current); err != nil {
		t.Fatal(err)
	}
	oldConnector := filepath.Join(versionsRoot, oldName, "project-space-connector")
	oldProject, err := filepath.EvalSymlinks(filepath.Join(versionsRoot, oldName, "project"))
	if err != nil {
		t.Fatal(err)
	}
	newProject, err := filepath.EvalSymlinks(filepath.Join(versionsRoot, newName, "project"))
	if err != nil {
		t.Fatal(err)
	}

	resolved, err := ResolveConnectorSupervisorRelaunchExecutable(oldConnector)
	if err != nil || resolved != oldProject {
		t.Fatalf("initial relaunch executable = %q, err=%v", resolved, err)
	}
	if err := switchManagedPointer(
		current,
		toolsRoot,
		versionsRoot,
		filepath.Join(connectorSupervisorVersionsDirectoryName, newName),
	); err != nil {
		t.Fatal(err)
	}
	resolved, err = ResolveConnectorSupervisorRelaunchExecutable(oldConnector)
	if err != nil || resolved != newProject {
		t.Fatalf("updated relaunch executable = %q, err=%v", resolved, err)
	}
	if err := switchManagedPointer(
		current,
		toolsRoot,
		versionsRoot,
		filepath.Join(connectorSupervisorVersionsDirectoryName, oldName),
	); err != nil {
		t.Fatal(err)
	}
	resolved, err = ResolveConnectorSupervisorRelaunchExecutable(oldConnector)
	if err != nil || resolved != oldProject {
		t.Fatalf("rolled-back relaunch executable = %q, err=%v", resolved, err)
	}
}

func TestConnectorSupervisorRelaunchRejectsUntrustedProject(t *testing.T) {
	toolsRoot := filepath.Join(t.TempDir(), ".project-space-machine-tools")
	versionsRoot := filepath.Join(toolsRoot, connectorSupervisorVersionsDirectoryName)
	releaseName := "0.4.7-bbbbbbbbbbbbbbbb"
	releaseRoot := filepath.Join(versionsRoot, releaseName)
	if err := os.MkdirAll(releaseRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	connector := filepath.Join(releaseRoot, "project-space-connector")
	if err := os.WriteFile(connector, []byte("connector"), 0o700); err != nil {
		t.Fatal(err)
	}
	project := filepath.Join(releaseRoot, "project")
	if err := os.WriteFile(project, []byte("project"), 0o722); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(project, 0o722); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(connectorSupervisorVersionsDirectoryName, releaseName), filepath.Join(toolsRoot, connectorSupervisorCurrentPointerName)); err != nil {
		t.Fatal(err)
	}
	if _, err := ResolveConnectorSupervisorRelaunchExecutable(connector); err == nil {
		t.Fatal("group-writable managed Project CLI was accepted")
	}
}
