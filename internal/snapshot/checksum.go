package snapshot

import (
	"crypto/sha256"
	"encoding/hex"
	"io"
	"os"
	"path/filepath"
)

func Checksum(templateRoot string) (string, error) {
	paths, err := Files(templateRoot)
	if err != nil {
		return "", err
	}

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
