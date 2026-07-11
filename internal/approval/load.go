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
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		return Policy{}, nil, "", fmt.Errorf("approval policy must contain exactly one document")
	}
	if err := requireDecoderEOF(decoder.Decode); err != nil {
		return Policy{}, nil, "", fmt.Errorf("parse approval policy: trailing document")
	}
	if err := validatePolicy(root, policy); err != nil {
		return Policy{}, nil, "", err
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
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		return TrustRoot{}, fmt.Errorf("external trust root must contain exactly one JSON object")
	}
	if err := requireDecoderEOF(decoder.Decode); err != nil {
		return TrustRoot{}, fmt.Errorf("parse external trust root: trailing value")
	}
	if root.Version != TrustRootVersion || root.Repository == "" || root.PolicyID == "" || root.PolicyDigest == "" || root.SignerID == "" || root.PublicKeyPEM == "" || root.KeyFingerprint == "" {
		return TrustRoot{}, fmt.Errorf("external trust root is incomplete or unsupported")
	}
	return root, nil
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
	for _, scope := range policy.Scopes {
		if scope.ID == "" || scope.Label == "" || len(scope.Paths) == 0 || scope.Attestation == "" {
			return fmt.Errorf("approval scope is incomplete")
		}
		if seen[scope.ID] {
			return fmt.Errorf("duplicate approval scope %q", scope.ID)
		}
		seen[scope.ID] = true
		if _, err := confinedPath(root, scope.Attestation); err != nil {
			return fmt.Errorf("scope %s attestation: %w", scope.ID, err)
		}
		for _, path := range append(append([]string{}, scope.Paths...), scope.Ignore...) {
			if filepath.IsAbs(path) || strings.Contains(filepath.ToSlash(path), "../") {
				return fmt.Errorf("scope %s contains unsafe path %q", scope.ID, path)
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
