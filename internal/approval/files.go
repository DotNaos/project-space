package approval

import (
	"errors"
	"os"
	"path/filepath"
)

func readOptionalFile(path string) ([]byte, bool, error) {
	body, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	return body, true, nil
}

func atomicWriteFile(path string, body []byte, directoryMode, fileMode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(path), directoryMode); err != nil {
		return err
	}
	temporary, err := os.CreateTemp(filepath.Dir(path), ".approval-*.tmp")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(fileMode); err != nil {
		temporary.Close()
		return err
	}
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
	if err := os.Rename(temporaryPath, path); err != nil {
		return err
	}
	return syncDirectory(filepath.Dir(path))
}

func restoreFile(path string, body []byte, existed bool, directoryMode, fileMode os.FileMode) error {
	if existed {
		return atomicWriteFile(path, body, directoryMode, fileMode)
	}
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return syncDirectory(filepath.Dir(path))
}
