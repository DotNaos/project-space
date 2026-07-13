package approval

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/pem"
	"fmt"
	"os"
)

func Verify(root, policyPath, trustPath string) (Report, error) {
	return VerifyWithCheckpoint(root, policyPath, trustPath, os.Getenv("PROJECT_APPROVAL_CHECKPOINT"))
}

func VerifyWithCheckpoint(root, policyPath, trustPath, checkpointPath string) (Report, error) {
	context, err := loadVerificationContext(root, policyPath, trustPath, checkpointPath)
	return verifyContext(context, err)
}

func VerifyWithCheckpointAndMonotonic(root, policyPath, trustPath, checkpointPath string, monotonic MonotonicCheckpointProvider) (Report, error) {
	context, err := loadVerificationContextWithMonotonic(root, policyPath, trustPath, checkpointPath, monotonic)
	return verifyContext(context, err)
}

func verifyContext(context verificationContext, err error) (Report, error) {
	if err != nil {
		return Report{}, err
	}
	report := Report{Version: CheckpointVersion, Repository: context.policy.Repository, PolicyID: context.policy.PolicyID, OK: true}
	for _, scope := range context.policy.Scopes {
		status := verifyScope(context, scope)
		report.Scopes = append(report.Scopes, status)
		if status.State != StateApproved {
			report.OK = false
		}
	}
	return report, nil
}

func Prepare(root, policyPath, trustPath, checkpointPath, scopeID string) (Preparation, error) {
	context, err := loadVerificationContext(root, policyPath, trustPath, checkpointPath)
	return prepareContext(context, scopeID, err)
}

func PrepareWithMonotonic(root, policyPath, trustPath, checkpointPath, scopeID string, monotonic MonotonicCheckpointProvider) (Preparation, error) {
	context, err := loadVerificationContextWithMonotonic(root, policyPath, trustPath, checkpointPath, monotonic)
	return prepareContext(context, scopeID, err)
}

func prepareContext(context verificationContext, scopeID string, err error) (Preparation, error) {
	if err != nil {
		return Preparation{}, err
	}
	scope, err := context.scope(scopeID)
	if err != nil {
		return Preparation{}, err
	}
	current, err := BuildPayload(context.root, context.policy, context.policyDigest, scope, context.trust.SignerID)
	if err != nil {
		return Preparation{}, err
	}
	status := verifyScope(context, scope)
	nextSequence, previous := nextEventPosition(context, scope, status)
	return Preparation{
		Version: CheckpointVersion, Repository: context.policy.Repository, PolicyID: context.policy.PolicyID,
		PolicyDigest: context.policyDigest, Scope: PreparedScope{ID: scope.ID, Label: scope.Label}, State: status.State,
		ContentDigest: current.ContentDigest, Files: current.Files, SignerID: context.trust.SignerID,
		KeyFingerprint: context.trust.KeyFingerprint, NextSequence: nextSequence, PreviousEventDigest: previous,
		Attestation: scope.Attestation,
	}, nil
}

func verifyScope(context verificationContext, scope Scope) ScopeStatus {
	status := ScopeStatus{
		ID: scope.ID, Label: scope.Label, State: StateInvalidTampered, Attestation: scope.Attestation,
		SignerID: context.trust.SignerID, Files: make([]FileHash, 0),
	}
	current, currentErr := BuildPayload(context.root, context.policy, context.policyDigest, scope, context.trust.SignerID)
	if currentErr == nil {
		status.ContentDigest = current.ContentDigest
	}
	anchor, anchorBody, anchorExists, anchorErr := readMonotonicAnchor(context, scope)
	if anchorErr != nil {
		status.Reason = anchorErr.Error()
		return status
	}
	record, err := loadScopeRecord(context.root, scope)
	if err != nil {
		status.Reason = err.Error()
		return status
	}
	checkpoint, checkpointExpected := ScopeCheckpoint{}, false
	if context.checkpoint != nil {
		checkpoint, checkpointExpected = context.checkpoint.Scopes[scope.ID]
	}
	if !record.Exists {
		status.State = StateMissingHistory
		if anchorExists {
			status.Reason = "signed history is missing but the protected monotonic checkpoint records an accepted event"
		} else if checkpointExpected {
			status.Reason = "signed history is missing but the external checkpoint records an accepted event"
		} else {
			status.Reason = "signed approval history is missing"
		}
		return status
	}
	if record.Legacy != nil {
		status.Files = append([]FileHash(nil), record.Legacy.Payload.Files...)
		if checkpointExpected || anchorExists {
			status.State = StateReplayCheckpointMismatch
			status.Reason = "legacy approval cannot replace checkpointed signed history"
			return status
		}
		return verifyLegacy(status, *record.Legacy, current, currentErr, context)
	}
	digests, err := validateHistory(*record.History, context, scope)
	if err != nil {
		status.Reason = err.Error()
		return status
	}
	latest := record.History.Events[len(record.History.Events)-1]
	latestDigest := digests[len(digests)-1]
	status.Operation = latest.Payload.Operation
	status.Sequence = latest.Payload.Sequence
	status.EventDigest = latestDigest
	status.Files = append([]FileHash(nil), latest.Payload.Files...)
	if !checkpointExpected {
		status.State = StateMissingHistory
		status.Reason = "external checkpoint is missing for signed history"
		return status
	}
	if checkpoint.Sequence != latest.Payload.Sequence || checkpoint.EventDigest != latestDigest || checkpoint.Operation != latest.Payload.Operation || checkpoint.ContentDigest != latest.Payload.ContentDigest {
		status.State = StateReplayCheckpointMismatch
		status.Reason = "signed history tip does not match the external checkpoint"
		return status
	}
	if context.monotonic != nil {
		if !anchorExists {
			status.State = StateMissingHistory
			status.Reason = "protected monotonic checkpoint is missing for signed history"
			return status
		}
		_, expectedAnchor, buildErr := buildMonotonicAnchor(latest.Payload)
		if buildErr != nil {
			status.Reason = buildErr.Error()
			return status
		}
		if !bytes.Equal(anchorBody, expectedAnchor) || anchor.Sequence != latest.Payload.Sequence {
			status.State = StateReplayCheckpointMismatch
			status.Reason = "signed history tip does not match the protected monotonic checkpoint"
			return status
		}
	}
	if latest.Payload.Operation == OperationRevoke {
		status.State = StateRevoked
		return status
	}
	if currentErr != nil || current.ContentDigest != latest.Payload.ContentDigest || !equalFileHashes(current.Files, latest.Payload.Files) {
		status.State = StateStale
		status.Reason = "covered content changed after approval"
		return status
	}
	status.State = StateApproved
	return status
}

func verifyLegacy(status ScopeStatus, attestation Attestation, current Payload, currentErr error, context verificationContext) ScopeStatus {
	if attestation.Version != AttestationVersion || attestation.Payload.Version != AttestationVersion || attestation.Payload.IssuedAt.IsZero() {
		status.Reason = "legacy attestation version or issue time is invalid"
		return status
	}
	if currentErr != nil {
		status.State = StateStale
		status.Reason = "covered content changed after approval"
		return status
	}
	expected := current
	expected.IssuedAt = attestation.Payload.IssuedAt
	expectedBody, _ := CanonicalPayload(expected)
	actualBody, _ := CanonicalPayload(attestation.Payload)
	if string(expectedBody) != string(actualBody) {
		status.State = StateStale
		status.Reason = "content, policy, repository, scope, or signer changed"
		return status
	}
	signature, err := base64.StdEncoding.DecodeString(attestation.Signature)
	if err != nil {
		status.Reason = "signature is not valid base64"
		return status
	}
	hash := sha256.Sum256(actualBody)
	if !ecdsa.VerifyASN1(context.key, hash[:], signature) {
		status.Reason = "signature verification failed"
		return status
	}
	status.State = StateApproved
	status.Operation = OperationApprove
	status.Files = append([]FileHash(nil), attestation.Payload.Files...)
	return status
}

func nextEventPosition(context verificationContext, scope Scope, status ScopeStatus) (uint64, string) {
	if status.State == StateInvalidTampered || status.State == StateReplayCheckpointMismatch {
		return 0, ""
	}
	record, err := loadScopeRecord(context.root, scope)
	if err != nil {
		return 0, ""
	}
	checkpointExpected := false
	if context.checkpoint != nil {
		_, checkpointExpected = context.checkpoint.Scopes[scope.ID]
	}
	if !record.Exists {
		if checkpointExpected {
			return 0, ""
		}
		return 1, ""
	}
	if record.Legacy != nil {
		if checkpointExpected {
			return 0, ""
		}
		return 1, ""
	}
	if !checkpointExpected || record.History == nil || len(record.History.Events) == 0 {
		return 0, ""
	}
	latest := record.History.Events[len(record.History.Events)-1]
	digest, err := eventDigest(latest)
	if err != nil {
		return 0, ""
	}
	return latest.Payload.Sequence + 1, digest
}

func equalFileHashes(left, right []FileHash) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}

func parsePublicKey(root TrustRoot) (*ecdsa.PublicKey, error) {
	block, _ := pem.Decode([]byte(root.PublicKeyPEM))
	if block == nil {
		return nil, fmt.Errorf("external trust root public key is invalid")
	}
	parsed, err := x509.ParsePKIXPublicKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("parse external public key: %w", err)
	}
	key, ok := parsed.(*ecdsa.PublicKey)
	if !ok || key.Curve.Params().Name != "P-256" {
		return nil, fmt.Errorf("external public key must be P-256")
	}
	fingerprint := sha256.Sum256(block.Bytes)
	encoded := "sha256:" + hex.EncodeToString(fingerprint[:])
	if encoded != root.KeyFingerprint || encoded != root.SignerID {
		return nil, fmt.Errorf("external signer fingerprint mismatch")
	}
	return key, nil
}
