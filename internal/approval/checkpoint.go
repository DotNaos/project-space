package approval

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
)

func loadCheckpoint(path string, policy Policy, policyDigest string, trust TrustRoot) (*Checkpoint, bool, error) {
	body, exists, err := readOptionalFile(path)
	if err != nil {
		return nil, false, fmt.Errorf("read external checkpoint: %w", err)
	}
	if !exists {
		return nil, false, nil
	}
	var checkpoint Checkpoint
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&checkpoint); err != nil {
		return nil, true, fmt.Errorf("parse external checkpoint: %w", err)
	}
	if err := requireDecoderEOF(decoder.Decode); err != nil {
		return nil, true, fmt.Errorf("parse external checkpoint: trailing value")
	}
	if checkpoint.Version != CheckpointVersion || checkpoint.Repository != policy.Repository || checkpoint.PolicyID != policy.PolicyID || checkpoint.PolicyDigest != policyDigest || checkpoint.SignerID != trust.SignerID || checkpoint.Scopes == nil {
		return nil, true, fmt.Errorf("external checkpoint does not authorize this repository policy and signer")
	}
	for scopeID, scope := range checkpoint.Scopes {
		if scopeID == "" || scope.Sequence == 0 || !validOperation(scope.Operation) || !validSHA256Digest(scope.EventDigest) || !validContentDigest(scope.ContentDigest) {
			return nil, true, fmt.Errorf("external checkpoint contains an invalid scope tip")
		}
	}
	return &checkpoint, true, nil
}

func newCheckpoint(context verificationContext) Checkpoint {
	return Checkpoint{
		Version: CheckpointVersion, Repository: context.policy.Repository, PolicyID: context.policy.PolicyID,
		PolicyDigest: context.policyDigest, SignerID: context.trust.SignerID, Scopes: map[string]ScopeCheckpoint{},
	}
}

func writeCheckpoint(path string, checkpoint Checkpoint) error {
	body, err := json.MarshalIndent(checkpoint, "", "  ")
	if err != nil {
		return err
	}
	body = append(body, '\n')
	return atomicWriteFile(path, body, 0o700, 0o600)
}

func acquireCheckpointLock(path string) (func(), error) {
	lockPath := path + ".lock"
	lock, err := os.OpenFile(lockPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return nil, fmt.Errorf("approval checkpoint is busy: %w", err)
	}
	if _, err := fmt.Fprintf(lock, "%d\n", os.Getpid()); err != nil {
		lock.Close()
		os.Remove(lockPath)
		return nil, err
	}
	if err := lock.Close(); err != nil {
		os.Remove(lockPath)
		return nil, err
	}
	return func() { _ = os.Remove(lockPath) }, nil
}
