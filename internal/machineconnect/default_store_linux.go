//go:build !darwin && !windows

package machineconnect

func NewDefaultCredentialStore() (CredentialStore, error) {
	return NewFileStore("")
}
