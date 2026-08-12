package workspacerun

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"

	"golang.org/x/sys/unix"
)

func (store *stateStore) openDirectory(name string) (*os.File, error) {
	path := store.root
	if name != "" {
		path = filepath.Join(store.root, name)
	}
	proof := store.directoryProofs[name]
	fd, err := unix.Open(path, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
	if err != nil {
		return nil, fmt.Errorf("open workspace runtime %s directory: %w", name, err)
	}
	file := os.NewFile(uintptr(fd), path)
	info, statErr := file.Stat()
	if statErr != nil || proof == nil || !os.SameFile(proof, info) || !info.IsDir() || info.Mode().Perm()&0o077 != 0 {
		_ = file.Close()
		return nil, fmt.Errorf("workspace runtime %s directory identity changed", name)
	}
	return file, nil
}

func (store *stateStore) regularFileProof(directory *os.File, name string) (os.FileInfo, error) {
	fd, err := unix.Openat(int(directory.Fd()), name, unix.O_RDONLY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
	if err != nil {
		return nil, fmt.Errorf("open private runtime file %q: %w", name, err)
	}
	file := os.NewFile(uintptr(fd), name)
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0o077 != 0 {
		return nil, fmt.Errorf("runtime file %q is not a private regular file", name)
	}
	return info, nil
}

func fileIdentity(info os.FileInfo) string {
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return ""
	}
	return fmt.Sprintf("%x:%x", uint64(stat.Dev), stat.Ino)
}

func (store *stateStore) openGeneration(record runtimeRecord) (*os.File, error) {
	root, err := store.openDirectory("generations")
	if err != nil {
		return nil, err
	}
	defer root.Close()
	parentFD, err := unix.Openat(int(root.Fd()), record.WorkspaceID, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
	if err != nil {
		return nil, fmt.Errorf("open runtime generation parent: %w", err)
	}
	defer unix.Close(parentFD)
	fd, err := unix.Openat(parentFD, record.Generation, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
	if err != nil {
		return nil, fmt.Errorf("open runtime generation: %w", err)
	}
	file := os.NewFile(uintptr(fd), store.generationHome(record.WorkspaceID, record.Generation))
	info, statErr := file.Stat()
	if statErr != nil || !info.IsDir() || info.Mode().Perm()&0o077 != 0 || fileIdentity(info) != record.GenerationProof {
		_ = file.Close()
		return nil, fmt.Errorf("runtime generation directory identity changed")
	}
	return file, nil
}

func (store *stateStore) openLog(record runtimeRecord) (*os.File, error) {
	directory, err := store.openGeneration(record)
	if err != nil {
		return nil, err
	}
	defer directory.Close()
	fd, err := unix.Openat(int(directory.Fd()), "runtime.log", unix.O_CREAT|unix.O_EXCL|unix.O_RDWR|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0o600)
	if err != nil {
		return nil, fmt.Errorf("create Workspace runtime log: %w", err)
	}
	file := os.NewFile(uintptr(fd), store.logPath(record.WorkspaceID, record.Generation))
	info, statErr := file.Stat()
	if statErr != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0o077 != 0 {
		_ = file.Close()
		return nil, fmt.Errorf("Workspace runtime log must be a private regular file")
	}
	return file, nil
}

func (store *stateStore) publishState(directory *os.File, name, temporaryName, key string) error {
	proof := store.stateProofs[key]
	currentFD, err := unix.Openat(int(directory.Fd()), name, unix.O_RDONLY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
	var current *os.File
	if err == nil {
		current = os.NewFile(uintptr(currentFD), name)
		defer current.Close()
		info, statErr := current.Stat()
		if statErr != nil || proof == nil || !os.SameFile(proof, info) || !info.Mode().IsRegular() || info.Mode().Perm()&0o077 != 0 {
			return fmt.Errorf("refusing to replace changed runtime state %q", name)
		}
		if err := exchangeAt(int(directory.Fd()), temporaryName, int(directory.Fd()), name); err != nil {
			return fmt.Errorf("atomically publish workspace runtime state: %w", err)
		}
		moved, movedErr := store.regularFileProof(directory, temporaryName)
		if movedErr != nil || !os.SameFile(info, moved) {
			_ = exchangeAt(int(directory.Fd()), temporaryName, int(directory.Fd()), name)
			return errors.Join(movedErr, fmt.Errorf("runtime state changed during atomic replacement"))
		}
		// Keep the exact previous inode under the random internal name. POSIX has
		// no unlink-by-handle primitive; retaining it prevents an equal-UID race
		// from replacing the checked name with a foreign inode before deletion.
		return nil
	} else if !errors.Is(err, syscall.ENOENT) {
		return fmt.Errorf("inspect existing runtime state: %w", err)
	} else if proof != nil {
		return fmt.Errorf("runtime state disappeared during replacement")
	}

	if err := unix.Linkat(int(directory.Fd()), temporaryName, int(directory.Fd()), name, 0); err != nil {
		return fmt.Errorf("publish workspace runtime state: %w", err)
	}
	// The initial hard link is retained for the same no-unlink-by-handle
	// boundary. A separate privileged retention service may reclaim it later.
	return nil
}

func mkdirPrivateAt(parentFD int, name string) error {
	if err := unix.Mkdirat(parentFD, name, 0o700); err != nil && !errors.Is(err, syscall.EEXIST) {
		return fmt.Errorf("create private runtime directory %q: %w", name, err)
	}
	fd, err := unix.Openat(parentFD, name, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
	if err != nil {
		return fmt.Errorf("open private runtime directory %q: %w", name, err)
	}
	file := os.NewFile(uintptr(fd), name)
	defer file.Close()
	info, statErr := file.Stat()
	if statErr != nil || !info.IsDir() || info.Mode().Perm()&0o077 != 0 {
		return fmt.Errorf("runtime directory %q is not private", name)
	}
	return nil
}

func directoryContainsProof(directory *os.File, expectedProof, prefix string) (string, error) {
	names, err := directory.Readdirnames(-1)
	if err != nil {
		return "", err
	}
	for _, name := range names {
		if prefix != "" && !strings.HasPrefix(name, prefix) {
			continue
		}
		fd, openErr := unix.Openat(int(directory.Fd()), name, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
		if openErr != nil {
			continue
		}
		candidate := os.NewFile(uintptr(fd), name)
		info, statErr := candidate.Stat()
		_ = candidate.Close()
		if statErr != nil {
			return "", statErr
		}
		if fileIdentity(info) == expectedProof {
			return name, nil
		}
	}
	return "", nil
}
