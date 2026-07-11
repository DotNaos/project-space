package approval

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

func EnrollTrustRoot(root, policyPath, trustPath string, signer SignatureProvider) (TrustRoot, error) {
	rootAbs, err := filepath.Abs(root)
	if err != nil {
		return TrustRoot{}, err
	}
	trustAbs, err := filepath.Abs(trustPath)
	if err != nil {
		return TrustRoot{}, err
	}
	rel, _ := filepath.Rel(rootAbs, trustAbs)
	if rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return TrustRoot{}, fmt.Errorf("trust root must be outside the mutable repository")
	}
	policy, _, digest, err := LoadPolicy(rootAbs, policyPath)
	if err != nil {
		return TrustRoot{}, err
	}
	if enrollable, ok := signer.(interface{ Enroll(string) error }); ok {
		if err := enrollable.Enroll("Enroll human approval key for " + policy.Repository); err != nil {
			return TrustRoot{}, err
		}
	}
	signerID, err := signer.SignerID()
	if err != nil {
		return TrustRoot{}, err
	}
	publicKey, err := signer.PublicKeyPEM()
	if err != nil {
		return TrustRoot{}, err
	}
	trusted := TrustRoot{Version: TrustRootVersion, Repository: policy.Repository, PolicyID: policy.PolicyID, PolicyDigest: digest, SignerID: signerID, PublicKeyPEM: publicKey, KeyFingerprint: signerID}
	body, err := json.MarshalIndent(trusted, "", "  ")
	if err != nil {
		return TrustRoot{}, err
	}
	body = append(body, '\n')
	if err := os.MkdirAll(filepath.Dir(trustAbs), 0o700); err != nil {
		return TrustRoot{}, err
	}
	temporary := trustAbs + ".tmp"
	if err := os.WriteFile(temporary, body, 0o600); err != nil {
		return TrustRoot{}, err
	}
	if err := os.Rename(temporary, trustAbs); err != nil {
		return TrustRoot{}, err
	}
	return trusted, nil
}
