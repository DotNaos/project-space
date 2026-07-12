package approval

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

func readOptionalRootFile(repositoryRoot, relative string) ([]byte, bool, error) {
	root, err := os.OpenRoot(repositoryRoot)
	if err != nil {
		return nil, false, err
	}
	defer root.Close()
	body, err := root.ReadFile(filepath.Clean(relative))
	if errors.Is(err, os.ErrNotExist) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	return body, true, nil
}

func atomicWriteRootFile(repositoryRoot, relative string, body []byte, fileMode os.FileMode) error {
	root, err := os.OpenRoot(repositoryRoot)
	if err != nil {
		return err
	}
	defer root.Close()
	relative = filepath.Clean(relative)
	directory := filepath.Dir(relative)
	if err := root.MkdirAll(directory, 0o755); err != nil {
		return err
	}
	var temporaryName string
	var temporary *os.File
	for attempt := 0; attempt < 10; attempt++ {
		random := make([]byte, 12)
		if _, err := rand.Read(random); err != nil {
			return err
		}
		temporaryName = filepath.Join(directory, ".approval-"+hex.EncodeToString(random)+".tmp")
		temporary, err = root.OpenFile(temporaryName, os.O_WRONLY|os.O_CREATE|os.O_EXCL, fileMode)
		if err == nil {
			break
		}
		if !errors.Is(err, os.ErrExist) {
			return err
		}
	}
	if temporary == nil {
		return fmt.Errorf("create repository-confined approval temporary file")
	}
	defer root.Remove(temporaryName)
	if _, err := temporary.Write(body); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	if err := root.Rename(temporaryName, relative); err != nil {
		return err
	}
	return syncRootDirectory(root, directory)
}

func restoreRootFile(repositoryRoot, relative string, body []byte, existed bool, fileMode os.FileMode) error {
	if existed {
		return atomicWriteRootFile(repositoryRoot, relative, body, fileMode)
	}
	root, err := os.OpenRoot(repositoryRoot)
	if err != nil {
		return err
	}
	defer root.Close()
	if err := root.Remove(filepath.Clean(relative)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}
