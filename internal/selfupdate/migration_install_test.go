package selfupdate

import (
	"path/filepath"
	"reflect"
	"testing"
)

func TestManagedInstallerArgumentsPassVerifiedHomebrewMigration(t *testing.T) {
	home := filepath.Join(string(filepath.Separator), "Users", "test")
	executable := filepath.Join(
		string(filepath.Separator),
		"opt",
		"homebrew",
		"Cellar",
		"project",
		"0.4.8",
		"bin",
		"project",
	)
	installDir := filepath.Join(home, ".local", "bin")
	arguments, err := managedInstallerArguments(Installation{
		ExecutablePath: executable,
		InstallDir:     installDir,
		Source:         InstallSourceHomebrew,
		Target:         "darwin-arm64",
	}, home)
	want := []string{
		"--install-dir",
		installDir,
		"--migrate-from-homebrew",
		executable,
	}
	if err != nil || !reflect.DeepEqual(arguments, want) {
		t.Fatalf("managedInstallerArguments() = %#v, %v", arguments, err)
	}
}

func TestManagedInstallerArgumentsRejectUnsafeHomebrewMigration(t *testing.T) {
	home := filepath.Join(string(filepath.Separator), "Users", "test")
	base := Installation{
		ExecutablePath: filepath.Join(
			string(filepath.Separator),
			"opt",
			"homebrew",
			"Cellar",
			"project",
			"0.4.8",
			"bin",
			"project",
		),
		InstallDir: filepath.Join(home, ".local", "bin"),
		Source:     InstallSourceHomebrew,
		Target:     "darwin-arm64",
	}
	tests := []Installation{
		func() Installation {
			value := base
			value.InstallDir = filepath.Join(home, "homebrew", "bin")
			return value
		}(),
		func() Installation {
			value := base
			value.ExecutablePath = filepath.Join(home, "bin", "project")
			return value
		}(),
		func() Installation {
			value := base
			value.Source = InstallSourceUnknown
			return value
		}(),
	}
	for _, installation := range tests {
		if _, err := managedInstallerArguments(installation, home); err == nil {
			t.Fatalf("unsafe migration was accepted: %#v", installation)
		}
	}
}
