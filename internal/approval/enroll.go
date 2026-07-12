package approval

import (
	"encoding/json"
	"os"
	"path/filepath"
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
	if err := requireExternalTrustRoot(rootAbs, trustAbs); err != nil {
		return TrustRoot{}, err
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
	temporary, err := os.CreateTemp(filepath.Dir(trustAbs), ".approval-trust-*.tmp")
	if err != nil {
		return TrustRoot{}, err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(0o600); err != nil {
		temporary.Close()
		return TrustRoot{}, err
	}
	if _, err := temporary.Write(body); err != nil {
		temporary.Close()
		return TrustRoot{}, err
	}
	if err := temporary.Sync(); err != nil {
		temporary.Close()
		return TrustRoot{}, err
	}
	if err := temporary.Close(); err != nil {
		return TrustRoot{}, err
	}
	if err := os.Rename(temporaryPath, trustAbs); err != nil {
		return TrustRoot{}, err
	}
	return trusted, nil
}
