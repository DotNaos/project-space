package approval

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

func BuildPayload(root string, policy Policy, policyDigest string, scope Scope, signerID string) (Payload, error) {
	files, err := hashScope(root, scope)
	if err != nil {
		return Payload{}, err
	}
	content, err := json.Marshal(files)
	if err != nil {
		return Payload{}, err
	}
	sum := sha256.Sum256(content)
	return Payload{Version: AttestationVersion, Repository: policy.Repository, PolicyID: policy.PolicyID, PolicyDigest: policyDigest, ScopeID: scope.ID, ContentDigest: hex.EncodeToString(sum[:]), Files: files, SignerID: signerID}, nil
}

func CanonicalPayload(payload Payload) ([]byte, error) { return json.Marshal(payload) }

func hashScope(root string, scope Scope) ([]FileHash, error) {
	byPath := map[string]FileHash{}
	for _, declared := range scope.Paths {
		path, err := confinedPath(root, declared)
		if err != nil {
			return nil, err
		}
		info, err := os.Lstat(path)
		if err != nil {
			return nil, fmt.Errorf("scope %s path %s: %w", scope.ID, declared, err)
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return nil, fmt.Errorf("scope %s path %s is a symlink", scope.ID, declared)
		}
		if !info.IsDir() {
			if err := addFileHash(root, path, scope.Attestation, scope.Ignore, byPath); err != nil {
				return nil, err
			}
			continue
		}
		err = filepath.WalkDir(path, func(current string, entry fs.DirEntry, walkErr error) error {
			if walkErr != nil {
				return walkErr
			}
			if entry.Type()&os.ModeSymlink != 0 {
				return fmt.Errorf("scope %s contains symlink %s", scope.ID, current)
			}
			if entry.IsDir() {
				return nil
			}
			return addFileHash(root, current, scope.Attestation, scope.Ignore, byPath)
		})
		if err != nil {
			return nil, err
		}
	}
	files := make([]FileHash, 0, len(byPath))
	for _, file := range byPath {
		files = append(files, file)
	}
	sort.Slice(files, func(i, j int) bool { return files[i].Path < files[j].Path })
	if len(files) == 0 {
		return nil, fmt.Errorf("scope %s contains no files", scope.ID)
	}
	return files, nil
}

func addFileHash(root, path, attestation string, ignore []string, result map[string]FileHash) error {
	rel, err := filepath.Rel(root, path)
	if err != nil {
		return err
	}
	rel = filepath.ToSlash(rel)
	if rel == filepath.ToSlash(attestation) {
		return nil
	}
	for _, pattern := range ignore {
		if pathMatch(pattern, rel) {
			return nil
		}
	}
	body, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	sum := sha256.Sum256(body)
	result[rel] = FileHash{Path: rel, SHA256: hex.EncodeToString(sum[:])}
	return nil
}

func pathMatch(pattern, name string) bool {
	pattern = filepath.ToSlash(strings.TrimPrefix(pattern, "./"))
	if strings.HasSuffix(pattern, "/**") {
		return name == strings.TrimSuffix(pattern, "/**") || strings.HasPrefix(name, strings.TrimSuffix(pattern, "**"))
	}
	matched, _ := filepath.Match(pattern, name)
	return matched
}
