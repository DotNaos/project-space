package approval

import (
	"crypto/ecdsa"
	"fmt"
	"path/filepath"
)

type verificationContext struct {
	root           string
	policy         Policy
	policyDigest   string
	trust          TrustRoot
	key            *ecdsa.PublicKey
	checkpointPath string
	checkpoint     *Checkpoint
}

func loadVerificationContext(root, policyPath, trustPath, checkpointPath string) (verificationContext, error) {
	root, err := filepath.Abs(root)
	if err != nil {
		return verificationContext{}, err
	}
	if err := requireExternalTrustRoot(root, trustPath); err != nil {
		return verificationContext{}, err
	}
	checkpointPath = ResolveCheckpointPath(trustPath, checkpointPath)
	if err := requireExternalTrustRoot(root, checkpointPath); err != nil {
		return verificationContext{}, fmt.Errorf("external checkpoint: %w", err)
	}
	policy, _, policyDigest, err := LoadPolicy(root, policyPath)
	if err != nil {
		return verificationContext{}, err
	}
	trust, err := LoadTrustRoot(trustPath)
	if err != nil {
		return verificationContext{}, err
	}
	if trust.Repository != policy.Repository || trust.PolicyID != policy.PolicyID || trust.PolicyDigest != policyDigest {
		return verificationContext{}, fmt.Errorf("external trust root does not authorize this repository policy")
	}
	key, err := parsePublicKey(trust)
	if err != nil {
		return verificationContext{}, err
	}
	checkpoint, _, err := loadCheckpoint(checkpointPath, policy, policyDigest, trust)
	if err != nil {
		return verificationContext{}, err
	}
	return verificationContext{
		root: root, policy: policy, policyDigest: policyDigest, trust: trust, key: key,
		checkpointPath: checkpointPath, checkpoint: checkpoint,
	}, nil
}

func (context verificationContext) scope(scopeID string) (Scope, error) {
	for _, scope := range context.policy.Scopes {
		if scope.ID == scopeID {
			return scope, nil
		}
	}
	return Scope{}, fmt.Errorf("unknown approval scope %q", scopeID)
}

func ResolveCheckpointPath(trustPath, configured string) string {
	if configured != "" {
		return configured
	}
	return trustPath + ".checkpoint.json"
}
