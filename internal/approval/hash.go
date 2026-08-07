package approval

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
)

func BuildPayload(root string, policy Policy, policyDigest string, scope Scope, signerID string) (Payload, error) {
	files, err := hashScope(root, policy, scope)
	if err != nil {
		return Payload{}, err
	}
	digest, err := digestFiles(files)
	if err != nil {
		return Payload{}, err
	}
	return Payload{Version: AttestationVersion, Repository: policy.Repository, PolicyID: policy.PolicyID, PolicyDigest: policyDigest, ScopeID: scope.ID, ContentDigest: digest, Files: files, SignerID: signerID}, nil
}

func CanonicalPayload(payload Payload) ([]byte, error) { return json.Marshal(payload) }

func digestFiles(files []FileHash) (string, error) {
	content, err := json.Marshal(files)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(content)
	return hex.EncodeToString(sum[:]), nil
}

func hashScope(root string, policy Policy, scope Scope) ([]FileHash, error) {
	rootHandle, err := os.OpenRoot(root)
	if err != nil {
		return nil, err
	}
	defer rootHandle.Close()
	byPath := map[string]FileHash{}
	attestations := make(map[string]bool, len(policy.Scopes))
	for _, declaredScope := range policy.Scopes {
		attestations[filepath.ToSlash(filepath.Clean(declaredScope.Attestation))] = true
	}
	for _, declared := range scope.Paths {
		path, err := confinedPath(root, declared)
		if err != nil {
			return nil, err
		}
		if err := rejectSymlinkComponents(root, path); err != nil {
			return nil, fmt.Errorf("scope %s path %s: %w", scope.ID, declared, err)
		}
		declared = filepath.Clean(declared)
		info, err := rootHandle.Lstat(declared)
		if err != nil {
			return nil, fmt.Errorf("scope %s path %s: %w", scope.ID, declared, err)
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return nil, fmt.Errorf("scope %s path %s is a symlink", scope.ID, declared)
		}
		if !info.IsDir() {
			if err := addFileHash(rootHandle, filepath.ToSlash(declared), attestations, scope.Ignore, byPath); err != nil {
				return nil, err
			}
			continue
		}
		err = fs.WalkDir(rootHandle.FS(), filepath.ToSlash(declared), func(current string, entry fs.DirEntry, walkErr error) error {
			if walkErr != nil {
				return walkErr
			}
			if entry.Type()&os.ModeSymlink != 0 {
				return fmt.Errorf("scope %s contains symlink %s", scope.ID, current)
			}
			if entry.IsDir() {
				return nil
			}
			return addFileHash(rootHandle, current, attestations, scope.Ignore, byPath)
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

func addFileHash(root *os.Root, rel string, attestations map[string]bool, ignore []string, result map[string]FileHash) error {
	rel = filepath.ToSlash(filepath.Clean(rel))
	if attestations[rel] {
		return nil
	}
	for _, pattern := range ignore {
		if pathMatch(pattern, rel) {
			return nil
		}
	}
	file, err := root.Open(rel)
	if err != nil {
		return err
	}
	defer file.Close()
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return err
	}
	result[rel] = FileHash{Path: rel, SHA256: hex.EncodeToString(hash.Sum(nil))}
	return nil
}

func pathMatch(pattern, name string) bool {
	pattern = filepath.ToSlash(strings.TrimPrefix(pattern, "./"))
	return matchGlobParts(strings.Split(pattern, "/"), strings.Split(name, "/"))
}

func matchGlobParts(pattern, name []string) bool {
	if len(pattern) == 0 {
		return len(name) == 0
	}
	if pattern[0] == "**" {
		return matchGlobParts(pattern[1:], name) || (len(name) > 0 && matchGlobParts(pattern, name[1:]))
	}
	if len(name) == 0 {
		return false
	}
	matched, err := path.Match(pattern[0], name[0])
	return err == nil && matched && matchGlobParts(pattern[1:], name[1:])
}

func validateGlobPattern(pattern string) error {
	for _, part := range strings.Split(filepath.ToSlash(strings.TrimPrefix(pattern, "./")), "/") {
		if part == "**" {
			continue
		}
		if _, err := path.Match(part, "candidate"); err != nil {
			return err
		}
	}
	return nil
}
