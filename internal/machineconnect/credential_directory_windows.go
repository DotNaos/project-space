//go:build windows

package machineconnect

import (
	"errors"
	"strings"

	"golang.org/x/sys/windows"
)

func defaultCredentialDirectory() (string, error) {
	directory, err := windows.KnownFolderPath(
		windows.FOLDERID_LocalAppData,
		windows.KF_FLAG_DEFAULT,
	)
	if err != nil || strings.TrimSpace(directory) == "" {
		return "", errors.New("Windows LocalAppData is unavailable")
	}
	return directory, nil
}
