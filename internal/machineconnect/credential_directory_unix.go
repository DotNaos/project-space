//go:build !windows

package machineconnect

import "os"

func defaultCredentialDirectory() (string, error) {
	return os.UserConfigDir()
}
