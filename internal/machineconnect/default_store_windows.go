//go:build windows

package machineconnect

func NewDefaultCredentialStore() (CredentialStore, error) {
	return newWindowsDPAPICredentialStore("")
}
