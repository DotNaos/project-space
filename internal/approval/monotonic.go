package approval

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
)

func monotonicAnchorKey(policy Policy, scope Scope) string {
	identity := policy.Repository + "\x00" + policy.PolicyID + "\x00" + scope.ID
	digest := sha256.Sum256([]byte(identity))
	return "sha256:" + hex.EncodeToString(digest[:])
}

func buildMonotonicAnchor(payload Payload) (MonotonicAnchor, []byte, error) {
	canonical, err := CanonicalPayload(payload)
	if err != nil {
		return MonotonicAnchor{}, nil, err
	}
	digest := sha256.Sum256(canonical)
	anchor := MonotonicAnchor{
		Version: AnchorVersion, Repository: payload.Repository, PolicyID: payload.PolicyID,
		PolicyDigest: payload.PolicyDigest, ScopeID: payload.ScopeID, SignerID: payload.SignerID,
		Sequence: payload.Sequence, Operation: payload.Operation, ContentDigest: payload.ContentDigest,
		PreviousEventDigest: payload.PreviousEventDigest, PayloadDigest: "sha256:" + hex.EncodeToString(digest[:]),
	}
	body, err := json.Marshal(anchor)
	return anchor, body, err
}

func readMonotonicAnchor(context verificationContext, scope Scope) (MonotonicAnchor, []byte, bool, error) {
	if context.monotonic == nil {
		return MonotonicAnchor{}, nil, false, nil
	}
	body, exists, err := context.monotonic.ReadCheckpoint(monotonicAnchorKey(context.policy, scope))
	if err != nil || !exists {
		return MonotonicAnchor{}, body, exists, err
	}
	var anchor MonotonicAnchor
	if err := decodeExactJSON(body, &anchor); err != nil {
		return MonotonicAnchor{}, body, true, fmt.Errorf("parse protected monotonic checkpoint: %w", err)
	}
	if anchor.Version != AnchorVersion || anchor.Repository != context.policy.Repository || anchor.PolicyID != context.policy.PolicyID || anchor.PolicyDigest != context.policyDigest || anchor.ScopeID != scope.ID || anchor.SignerID != context.trust.SignerID || anchor.Sequence == 0 || !validOperation(anchor.Operation) || !validContentDigest(anchor.ContentDigest) || !validSHA256Digest(anchor.PayloadDigest) {
		return MonotonicAnchor{}, body, true, fmt.Errorf("protected monotonic checkpoint is invalid")
	}
	return anchor, body, true, nil
}

func monotonicAnchorMatches(context verificationContext, scope Scope, payload Payload) (bool, error) {
	_, actual, exists, err := readMonotonicAnchor(context, scope)
	if err != nil || !exists {
		return false, err
	}
	_, expected, err := buildMonotonicAnchor(payload)
	if err != nil {
		return false, err
	}
	return bytes.Equal(actual, expected), nil
}
