package approval

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"gopkg.in/yaml.v3"
)

func LoadPolicy(root, path string) (Policy, []byte, string, error) {
	resolved, err := confinedPath(root, path)
	if err != nil {
		return Policy{}, nil, "", err
	}
	if err := rejectSymlinkComponents(root, resolved); err != nil {
		return Policy{}, nil, "", fmt.Errorf("approval policy: %w", err)
	}
	body, err := os.ReadFile(resolved)
	if err != nil {
		return Policy{}, nil, "", fmt.Errorf("read approval policy: %w", err)
	}
	var policy Policy
	decoder := yaml.NewDecoder(strings.NewReader(string(body)))
	decoder.KnownFields(true)
	if err := decoder.Decode(&policy); err != nil {
		return Policy{}, nil, "", fmt.Errorf("parse approval policy: %w", err)
	}
	if err := requireDecoderEOF(decoder.Decode); err != nil {
		return Policy{}, nil, "", fmt.Errorf("parse approval policy: trailing document")
	}
	if err := validatePolicy(root, policy); err != nil {
		return Policy{}, nil, "", err
	}
	rootAbsolute, err := filepath.Abs(root)
	if err != nil {
		return Policy{}, nil, "", err
	}
	policyRelative, err := filepath.Rel(rootAbsolute, resolved)
	if err != nil {
		return Policy{}, nil, "", err
	}
	policyRelative = filepath.ToSlash(policyRelative)
	for _, scope := range policy.Scopes {
		if filepath.ToSlash(filepath.Clean(scope.Attestation)) == policyRelative {
			return Policy{}, nil, "", fmt.Errorf("scope %s attestation must not replace the approval policy", scope.ID)
		}
	}
	canonical, err := json.Marshal(policy)
	if err != nil {
		return Policy{}, nil, "", err
	}
	sum := sha256.Sum256(canonical)
	return policy, canonical, hex.EncodeToString(sum[:]), nil
}

func LoadTrustRoot(path string) (TrustRoot, error) {
	body, err := os.ReadFile(path)
	if err != nil {
		return TrustRoot{}, fmt.Errorf("read external trust root: %w", err)
	}
	var root TrustRoot
	decoder := json.NewDecoder(strings.NewReader(string(body)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&root); err != nil {
		return TrustRoot{}, fmt.Errorf("parse external trust root: %w", err)
	}
	if err := requireDecoderEOF(decoder.Decode); err != nil {
		return TrustRoot{}, fmt.Errorf("parse external trust root: trailing value")
	}
	if root.Version != TrustRootVersion || root.Repository == "" || root.PolicyID == "" || root.PolicyDigest == "" || root.SignerID == "" || root.PublicKeyPEM == "" || root.KeyFingerprint == "" {
		return TrustRoot{}, fmt.Errorf("external trust root is incomplete or unsupported")
	}
	return root, nil
}

func requireExternalTrustRoot(repositoryRoot, trustPath string) error {
	repository, err := filepath.EvalSymlinks(repositoryRoot)
	if err != nil {
		return fmt.Errorf("resolve repository root: %w", err)
	}
	trusted, err := evalPathAllowMissing(trustPath)
	if err != nil {
		return fmt.Errorf("resolve external trust root: %w", err)
	}
	inside, err := pathHasPhysicalAncestor(trusted, repository)
	if err != nil {
		return fmt.Errorf("compare trust root with repository: %w", err)
	}
	if inside {
		return fmt.Errorf("trust root must be outside the mutable repository")
	}
	rel, err := filepath.Rel(repository, trusted)
	if err != nil {
		return err
	}
	if rel == "." || (rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))) {
		return fmt.Errorf("trust root must be outside the mutable repository")
	}
	return nil
}

func pathHasPhysicalAncestor(target, ancestor string) (bool, error) {
	ancestorInfo, err := os.Stat(ancestor)
	if err != nil {
		return false, err
	}
	current := target
	for {
		info, err := os.Stat(current)
		if err == nil && os.SameFile(info, ancestorInfo) {
			return true, nil
		}
		if err != nil && !os.IsNotExist(err) {
			return false, err
		}
		parent := filepath.Dir(current)
		if parent == current {
			return false, nil
		}
		current = parent
	}
}

func evalPathAllowMissing(path string) (string, error) {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	current := absolute
	missing := []string{}
	for {
		resolved, err := filepath.EvalSymlinks(current)
		if err == nil {
			parts := append([]string{resolved}, reverseStrings(missing)...)
			return filepath.Join(parts...), nil
		}
		if !os.IsNotExist(err) {
			return "", err
		}
		parent := filepath.Dir(current)
		if parent == current {
			return "", err
		}
		missing = append(missing, filepath.Base(current))
		current = parent
	}
}

func reverseStrings(values []string) []string {
	reversed := make([]string, len(values))
	for index := range values {
		reversed[len(values)-1-index] = values[index]
	}
	return reversed
}

func rejectSymlinkComponents(root, target string) error {
	rootAbs, err := filepath.Abs(root)
	if err != nil {
		return err
	}
	targetAbs, err := filepath.Abs(target)
	if err != nil {
		return err
	}
	relative, err := filepath.Rel(rootAbs, targetAbs)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return fmt.Errorf("path escapes repository")
	}
	current := rootAbs
	for _, component := range strings.Split(relative, string(filepath.Separator)) {
		if component == "." || component == "" {
			continue
		}
		current = filepath.Join(current, component)
		info, err := os.Lstat(current)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("repository path contains symlink: %s", current)
		}
	}
	return nil
}

func requireDecoderEOF(decode func(any) error) error {
	var trailing any
	err := decode(&trailing)
	if err == io.EOF {
		return nil
	}
	if err != nil {
		return err
	}
	return fmt.Errorf("unexpected trailing value")
}

func validatePolicy(root string, policy Policy) error {
	if policy.Version != PolicyVersion {
		return fmt.Errorf("unsupported approval policy version %d", policy.Version)
	}
	if strings.TrimSpace(policy.Repository) == "" || strings.TrimSpace(policy.PolicyID) == "" {
		return fmt.Errorf("approval policy requires repository and policyId")
	}
	if len(policy.Scopes) == 0 {
		return fmt.Errorf("approval policy requires at least one scope")
	}
	seen := map[string]bool{}
	attestations := map[string]bool{}
	for _, scope := range policy.Scopes {
		if strings.TrimSpace(scope.ID) == "" || strings.TrimSpace(scope.Label) == "" || len(scope.Paths) == 0 || strings.TrimSpace(scope.Attestation) == "" {
			return fmt.Errorf("approval scope is incomplete")
		}
		if seen[scope.ID] {
			return fmt.Errorf("duplicate approval scope %q", scope.ID)
		}
		seen[scope.ID] = true
		attestation := filepath.ToSlash(filepath.Clean(scope.Attestation))
		if attestations[attestation] {
			return fmt.Errorf("duplicate approval attestation path %q", scope.Attestation)
		}
		attestations[attestation] = true
		if _, err := confinedPath(root, scope.Attestation); err != nil {
			return fmt.Errorf("scope %s attestation: %w", scope.ID, err)
		}
		for _, path := range append(append([]string{}, scope.Paths...), scope.Ignore...) {
			if filepath.IsAbs(path) || strings.Contains(filepath.ToSlash(path), "../") {
				return fmt.Errorf("scope %s contains unsafe path %q", scope.ID, path)
			}
		}
		for _, pattern := range scope.Ignore {
			if err := validateGlobPattern(pattern); err != nil {
				return fmt.Errorf("scope %s contains invalid ignore pattern %q", scope.ID, pattern)
			}
		}
	}
	return nil
}

func confinedPath(root, relative string) (string, error) {
	if filepath.IsAbs(relative) {
		return "", fmt.Errorf("path must be repository-relative")
	}
	root, err := filepath.Abs(root)
	if err != nil {
		return "", err
	}
	path := filepath.Clean(filepath.Join(root, relative))
	rel, err := filepath.Rel(root, path)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("path escapes repository")
	}
	return path, nil
}
