package projectvalidator

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
)

func checksumTemplateRoot(templateRoot string) (string, error) {
	paths := []string{}
	if err := filepath.WalkDir(templateRoot, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			if entry.Name() == ".git" {
				return filepath.SkipDir
			}
			return nil
		}
		relative, err := filepath.Rel(templateRoot, path)
		if err != nil {
			return err
		}
		paths = append(paths, normalizePath(relative))
		return nil
	}); err != nil {
		return "", err
	}
	sort.Strings(paths)

	hash := sha256.New()
	for _, relative := range paths {
		if _, err := io.WriteString(hash, relative+"\n"); err != nil {
			return "", err
		}
		body, err := os.ReadFile(filepath.Join(templateRoot, filepath.FromSlash(relative)))
		if err != nil {
			return "", err
		}
		if _, err := hash.Write(body); err != nil {
			return "", err
		}
		if _, err := io.WriteString(hash, "\n"); err != nil {
			return "", err
		}
	}
	return "sha256:" + hex.EncodeToString(hash.Sum(nil)), nil
}

func verifyTemplateChecksum(templateRoot string, lock TemplateLock) error {
	if lock.Checksum == "" {
		return nil
	}
	actual, err := checksumTemplateRoot(templateRoot)
	if err != nil {
		return err
	}
	if actual != lock.Checksum {
		return fmt.Errorf("template checksum mismatch: lock has %s, local template has %s", lock.Checksum, actual)
	}
	return nil
}
