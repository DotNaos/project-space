//go:build !windows

package workspacerun

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"golang.org/x/sys/unix"
)

func removeExclusiveTreeAt(parent *os.File, name, expectedProof string) error {
	fd, err := unix.Openat(int(parent.Fd()), name, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
	if err != nil {
		return err
	}
	directory := os.NewFile(uintptr(fd), name)
	info, err := directory.Stat()
	if err != nil || fileIdentity(info) != expectedProof {
		_ = directory.Close()
		return errors.Join(err, fmt.Errorf("exclusive generation proof changed"))
	}
	if err := removeExclusiveContents(directory); err != nil {
		_ = directory.Close()
		return err
	}
	if err := directory.Sync(); err != nil {
		_ = directory.Close()
		return err
	}
	if err := directory.Close(); err != nil {
		return err
	}
	if err := unix.Unlinkat(int(parent.Fd()), name, unix.AT_REMOVEDIR); err != nil {
		return err
	}
	return parent.Sync()
}

func removeExclusiveContents(directory *os.File) error {
	names, err := directory.Readdirnames(-1)
	if err != nil {
		return err
	}
	for _, name := range names {
		var stat unix.Stat_t
		if err := unix.Fstatat(int(directory.Fd()), name, &stat, unix.AT_SYMLINK_NOFOLLOW); err != nil {
			return err
		}
		switch stat.Mode & unix.S_IFMT {
		case unix.S_IFREG:
			if err := unix.Unlinkat(int(directory.Fd()), name, 0); err != nil {
				return err
			}
		case unix.S_IFDIR:
			fd, err := unix.Openat(int(directory.Fd()), name, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
			if err != nil {
				return err
			}
			child := os.NewFile(uintptr(fd), name)
			if err := removeExclusiveContents(child); err != nil {
				_ = child.Close()
				return err
			}
			if err := child.Close(); err != nil {
				return err
			}
			if err := unix.Unlinkat(int(directory.Fd()), name, unix.AT_REMOVEDIR); err != nil {
				return err
			}
		default:
			return fmt.Errorf("exclusive archive contains a non-regular entry")
		}
	}
	return nil
}

func readCollectorJSON(path string, output any) error {
	directory, _, err := openPrivateDirectory(filepath.Dir(path))
	if err != nil {
		return err
	}
	defer directory.Close()
	_, err = readBoundedJSONAt(directory, filepath.Base(path), output)
	return err
}
