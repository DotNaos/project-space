package approval

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

func Sign(root, policyPath, trustPath, scopeID string, signer SignatureProvider) (string, error) {
	result, err := ApplyOperation(root, policyPath, trustPath, "", scopeID, OperationApprove, "", signer)
	return result.Attestation, err
}

func Approve(root, policyPath, trustPath, checkpointPath, scopeID, expectedContentDigest string, signer SignatureProvider) (OperationResult, error) {
	return ApplyOperation(root, policyPath, trustPath, checkpointPath, scopeID, OperationApprove, expectedContentDigest, signer)
}

func Revoke(root, policyPath, trustPath, checkpointPath, scopeID, expectedContentDigest string, signer SignatureProvider) (OperationResult, error) {
	return ApplyOperation(root, policyPath, trustPath, checkpointPath, scopeID, OperationRevoke, expectedContentDigest, signer)
}

func ApplyOperation(root, policyPath, trustPath, checkpointPath, scopeID, operation, expectedContentDigest string, signer SignatureProvider) (OperationResult, error) {
	if !validOperation(operation) {
		return OperationResult{}, fmt.Errorf("unsupported approval operation %q", operation)
	}
	monotonic, ok := signer.(MonotonicCheckpointProvider)
	if !ok {
		return OperationResult{}, fmt.Errorf("approval signer does not provide a protected monotonic checkpoint")
	}
	initial, err := loadVerificationContextWithMonotonic(root, policyPath, trustPath, checkpointPath, monotonic)
	if err != nil {
		return OperationResult{}, err
	}
	if err := os.MkdirAll(filepath.Dir(initial.checkpointPath), 0o700); err != nil {
		return OperationResult{}, err
	}
	release, err := acquireCheckpointLock(initial.checkpointPath)
	if err != nil {
		return OperationResult{}, err
	}
	defer release()
	context, err := loadVerificationContextWithMonotonic(root, policyPath, trustPath, initial.checkpointPath, monotonic)
	if err != nil {
		return OperationResult{}, err
	}
	scope, err := context.scope(scopeID)
	if err != nil {
		return OperationResult{}, err
	}
	status := verifyScope(context, scope)
	if err := validateTransition(context, scope, operation, status); err != nil {
		return OperationResult{}, err
	}
	record, err := loadScopeRecord(context.root, scope)
	if err != nil {
		return OperationResult{}, err
	}
	_, expectedAnchor, anchorExists, err := readMonotonicAnchor(context, scope)
	if err != nil {
		return OperationResult{}, err
	}
	if !anchorExists {
		expectedAnchor = nil
	}
	current, err := BuildPayload(context.root, context.policy, context.policyDigest, scope, context.trust.SignerID)
	if err != nil {
		return OperationResult{}, err
	}
	if expectedContentDigest != "" && expectedContentDigest != current.ContentDigest {
		return OperationResult{}, fmt.Errorf("covered content changed after preparation")
	}
	signerID, err := signer.SignerID()
	if err != nil {
		return OperationResult{}, err
	}
	publicKey, err := signer.PublicKeyPEM()
	if err != nil {
		return OperationResult{}, err
	}
	if signerID != context.trust.SignerID || publicKey != context.trust.PublicKeyPEM {
		return OperationResult{}, fmt.Errorf("Secure Enclave signer does not match external trust root")
	}
	nextSequence, previous := nextEventPosition(context, scope, status)
	if nextSequence == 0 {
		return OperationResult{}, fmt.Errorf("signed history is not in a state that can be extended")
	}
	payload := current
	payload.Version = EventVersion
	payload.Operation = operation
	payload.Sequence = nextSequence
	payload.PreviousEventDigest = previous
	payload.IssuedAt = time.Now().UTC()
	canonical, err := CanonicalPayload(payload)
	if err != nil {
		return OperationResult{}, err
	}
	reason := authenticationReason(payload, scope.Label)
	signature, err := signer.SignPayload(canonical, reason)
	if err != nil {
		return OperationResult{}, err
	}
	latest, err := BuildPayload(context.root, context.policy, context.policyDigest, scope, context.trust.SignerID)
	if err != nil || latest.ContentDigest != current.ContentDigest || !equalFileHashes(latest.Files, current.Files) {
		return OperationResult{}, fmt.Errorf("covered content changed during system authentication; no event was written")
	}
	latestRecord, err := loadScopeRecord(context.root, scope)
	if err != nil || latestRecord.Exists != record.Exists || !bytes.Equal(latestRecord.Body, record.Body) {
		return OperationResult{}, fmt.Errorf("signed history changed during system authentication; no event was written")
	}
	event := Attestation{Version: EventVersion, Payload: payload, Signature: base64.StdEncoding.EncodeToString(signature)}
	digest, err := validateEvent(event, context, scope, payload.Sequence, payload.PreviousEventDigest)
	if err != nil {
		return OperationResult{}, err
	}
	_, nextAnchor, err := buildMonotonicAnchor(payload)
	if err != nil {
		return OperationResult{}, err
	}
	history := History{Version: HistoryVersion}
	if record.History != nil {
		history.Events = append(history.Events, record.History.Events...)
	}
	history.Events = append(history.Events, event)
	historyBody, err := json.MarshalIndent(history, "", "  ")
	if err != nil {
		return OperationResult{}, err
	}
	historyBody = append(historyBody, '\n')
	historyPath, err := confinedPath(context.root, scope.Attestation)
	if err != nil {
		return OperationResult{}, err
	}
	if err := rejectSymlinkComponents(context.root, historyPath); err != nil {
		return OperationResult{}, err
	}
	if err := atomicWriteRootFile(context.root, scope.Attestation, historyBody, 0o600); err != nil {
		return OperationResult{}, err
	}
	checkpoint := newCheckpoint(context)
	if context.checkpoint != nil {
		checkpoint = *context.checkpoint
		checkpoint.Scopes = copyCheckpoints(context.checkpoint.Scopes)
	}
	checkpoint.Scopes[scope.ID] = ScopeCheckpoint{
		Sequence: payload.Sequence, EventDigest: digest, Operation: operation, ContentDigest: payload.ContentDigest,
	}
	if err := writeCheckpoint(context.checkpointPath, checkpoint); err != nil {
		rollbackErr := restoreRootFile(context.root, scope.Attestation, record.Body, record.Exists, 0o600)
		if rollbackErr != nil {
			return OperationResult{}, fmt.Errorf("write external checkpoint: %v; rollback signed history: %w", err, rollbackErr)
		}
		return OperationResult{}, fmt.Errorf("write external checkpoint: %w", err)
	}
	if err := monotonic.CommitCheckpoint(canonical, signature, monotonicAnchorKey(context.policy, scope), expectedAnchor, nextAnchor); err != nil {
		historyErr := restoreRootFile(context.root, scope.Attestation, record.Body, record.Exists, 0o600)
		checkpointErr := restoreExternalCheckpoint(context.checkpointPath, context.checkpoint)
		if historyErr != nil || checkpointErr != nil {
			return OperationResult{}, fmt.Errorf("commit protected monotonic checkpoint: %v; rollback history: %v; rollback external checkpoint: %v", err, historyErr, checkpointErr)
		}
		return OperationResult{}, fmt.Errorf("commit protected monotonic checkpoint: %w", err)
	}
	state := StateApproved
	if operation == OperationRevoke {
		state = StateRevoked
	}
	return OperationResult{
		Version: CheckpointVersion, Operation: operation, Repository: context.policy.Repository, PolicyID: context.policy.PolicyID,
		ScopeID: scope.ID, State: state, ContentDigest: payload.ContentDigest, SignerID: payload.SignerID,
		Sequence: payload.Sequence, EventDigest: digest, Attestation: scope.Attestation,
	}, nil
}

func restoreExternalCheckpoint(path string, previous *Checkpoint) error {
	if previous != nil {
		return writeCheckpoint(path, *previous)
	}
	err := os.Remove(path)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

func validateTransition(context verificationContext, scope Scope, operation string, status ScopeStatus) error {
	switch operation {
	case OperationApprove:
		if status.State == StateApproved {
			return fmt.Errorf("scope is already approved for the current content")
		}
		if status.State == StateMissingHistory {
			record, recordErr := loadScopeRecord(context.root, scope)
			checkpointExpected := false
			if context.checkpoint != nil {
				_, checkpointExpected = context.checkpoint.Scopes[scope.ID]
			}
			if recordErr != nil || record.Exists || checkpointExpected {
				return fmt.Errorf("missing or uncheckpointed signed history cannot be replaced")
			}
		} else if status.State != StateStale && status.State != StateRevoked {
			return fmt.Errorf("scope cannot be approved while state is %s", status.State)
		}
	case OperationRevoke:
		if status.State != StateApproved {
			return fmt.Errorf("scope can only be revoked from approved state; current state is %s", status.State)
		}
	}
	return nil
}

func authenticationReason(payload Payload, _ string) string {
	verb := "APPROVE"
	if payload.Operation == OperationRevoke {
		verb = "REVOKE"
	}
	previous := payload.PreviousEventDigest
	if previous == "" {
		previous = "none"
	}
	return fmt.Sprintf("%s %s\nContent SHA-256: %s\nRepository: %s\nPolicy: %s\nSequence: %d\nPrevious: %s", verb, payload.ScopeID, payload.ContentDigest, payload.Repository, payload.PolicyID, payload.Sequence, previous)
}

func copyCheckpoints(source map[string]ScopeCheckpoint) map[string]ScopeCheckpoint {
	copy := make(map[string]ScopeCheckpoint, len(source)+1)
	for scopeID, checkpoint := range source {
		copy[scopeID] = checkpoint
	}
	return copy
}

func validatePromptText(value, field string) error {
	if strings.TrimSpace(value) == "" {
		return fmt.Errorf("%s cannot be empty", field)
	}
	limit := 128
	if strings.Contains(field, "policyId") || strings.Contains(field, "scope id") {
		limit = 64
	}
	if len(value) > limit {
		return fmt.Errorf("%s is too long for a trusted authentication prompt", field)
	}
	for _, character := range value {
		if character < 0x20 || character == 0x7f || character == 0x2028 || character == 0x2029 || (character >= 0x202a && character <= 0x202e) || (character >= 0x2066 && character <= 0x2069) {
			return fmt.Errorf("%s contains control characters", field)
		}
	}
	return nil
}
