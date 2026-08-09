package selfupdate

import (
	"errors"
	"path/filepath"
)

func managedInstallerArguments(
	installation Installation,
	homeDirectory string,
) ([]string, error) {
	arguments := []string{"--install-dir", installation.InstallDir}
	switch installation.Source {
	case InstallSourceManaged:
		return arguments, nil
	case InstallSourceHomebrew:
		expectedDirectory := managedUnixInstallDirectory(homeDirectory)
		if expectedDirectory == "" ||
			filepath.Clean(installation.InstallDir) != expectedDirectory ||
			!filepath.IsAbs(installation.ExecutablePath) ||
			!isHomebrewExecutable(installation.ExecutablePath) {
			return nil, errors.New("managed artifact installer rejected an unsafe Homebrew migration")
		}
		return append(
			arguments,
			"--migrate-from-homebrew",
			filepath.Clean(installation.ExecutablePath),
		), nil
	default:
		return nil, errors.New("managed artifact installer does not support this installation source")
	}
}
