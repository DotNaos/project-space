//go:build !windows

package workspacerun

import (
	"encoding/json"
	"fmt"
	"os"

	"golang.org/x/sys/unix"
)

func writeCollectorJSON(directory, name string, value any) error {
	body, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	body = append(body, '\n')
	if len(body) > maximumStateBytes {
		return fmt.Errorf("collector evidence exceeds safe size")
	}
	root, _, err := openPrivateDirectory(directory)
	if err != nil {
		return err
	}
	defer root.Close()
	temporaryName := ".evidence-" + recordSafeNonce() + ".json"
	fd, err := unix.Openat(int(root.Fd()), temporaryName, unix.O_CREAT|unix.O_EXCL|unix.O_WRONLY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0o600)
	if err != nil {
		return err
	}
	temporary := os.NewFile(uintptr(fd), temporaryName)
	if _, err := temporary.Write(body); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	if err := unix.Renameat(int(root.Fd()), temporaryName, int(root.Fd()), name); err != nil {
		return err
	}
	return root.Sync()
}

func writeCollectorJSONExclusive(directory, name string, value any) error {
	body, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	body = append(body, '\n')
	if len(body) > maximumStateBytes {
		return fmt.Errorf("collector evidence exceeds safe size")
	}
	root, _, err := openPrivateDirectory(directory)
	if err != nil {
		return err
	}
	defer root.Close()
	fd, err := unix.Openat(int(root.Fd()), name, unix.O_CREAT|unix.O_EXCL|unix.O_WRONLY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0o600)
	if err != nil {
		return err
	}
	file := os.NewFile(uintptr(fd), name)
	if _, err := file.Write(body); err != nil {
		_ = file.Close()
		return err
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	return root.Sync()
}
