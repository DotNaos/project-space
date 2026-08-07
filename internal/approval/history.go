package approval

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"path/filepath"
	"strings"
	"time"
)

type scopeRecord struct {
	Body    []byte
	Exists  bool
	Legacy  *Attestation
	History *History
}

func loadScopeRecord(root string, scope Scope) (scopeRecord, error) {
	path, err := confinedPath(root, scope.Attestation)
	if err != nil {
		return scopeRecord{}, err
	}
	if err := rejectSymlinkComponents(root, path); err != nil {
		return scopeRecord{}, err
	}
	body, exists, err := readOptionalRootFile(root, scope.Attestation)
	if err != nil || !exists {
		return scopeRecord{Exists: exists}, err
	}
	var header struct {
		Version int `json:"version"`
	}
	if err := json.Unmarshal(body, &header); err != nil {
		return scopeRecord{}, fmt.Errorf("history cannot be parsed")
	}
	record := scopeRecord{Body: body, Exists: true}
	switch header.Version {
	case AttestationVersion:
		var legacy Attestation
		if err := decodeExactJSON(body, &legacy); err != nil {
			return scopeRecord{}, fmt.Errorf("legacy attestation cannot be parsed: %w", err)
		}
		record.Legacy = &legacy
	case HistoryVersion:
		var history History
		if err := decodeExactJSON(body, &history); err != nil {
			return scopeRecord{}, fmt.Errorf("history cannot be parsed: %w", err)
		}
		if len(history.Events) == 0 {
			return scopeRecord{}, fmt.Errorf("history contains no signed events")
		}
		record.History = &history
	default:
		return scopeRecord{}, fmt.Errorf("history version is unsupported")
	}
	return record, nil
}

func decodeExactJSON(body []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		return fmt.Errorf("must contain exactly one JSON object")
	}
	return nil
}

func validateHistory(history History, context verificationContext, scope Scope) ([]string, error) {
	digests := make([]string, 0, len(history.Events))
	previous := ""
	for index, event := range history.Events {
		digest, err := validateEvent(event, context, scope, uint64(index+1), previous)
		if err != nil {
			return nil, fmt.Errorf("event %d: %w", index+1, err)
		}
		digests = append(digests, digest)
		previous = digest
	}
	return digests, nil
}

func validateEvent(event Attestation, context verificationContext, scope Scope, sequence uint64, previous string) (string, error) {
	payload := event.Payload
	if event.Version != EventVersion || payload.Version != EventVersion {
		return "", fmt.Errorf("unsupported event version")
	}
	if !validOperation(payload.Operation) || payload.Sequence != sequence || payload.PreviousEventDigest != previous {
		return "", fmt.Errorf("operation, sequence, or previous event digest is invalid")
	}
	if payload.Repository != context.policy.Repository || payload.PolicyID != context.policy.PolicyID || payload.PolicyDigest != context.policyDigest || payload.ScopeID != scope.ID || payload.SignerID != context.trust.SignerID {
		return "", fmt.Errorf("event belongs to another repository, policy, scope, or signer")
	}
	if payload.IssuedAt.IsZero() || payload.IssuedAt.Location() != time.UTC {
		return "", fmt.Errorf("issuedAt must be a non-zero UTC timestamp")
	}
	if err := validateFileManifest(payload.Files); err != nil {
		return "", err
	}
	digest, err := digestFiles(payload.Files)
	if err != nil || digest != payload.ContentDigest {
		return "", fmt.Errorf("content digest does not match the signed file manifest")
	}
	canonical, err := CanonicalPayload(payload)
	if err != nil {
		return "", err
	}
	signature, err := base64.StdEncoding.DecodeString(event.Signature)
	if err != nil {
		return "", fmt.Errorf("signature is not valid base64")
	}
	hash := sha256.Sum256(canonical)
	if !ecdsa.VerifyASN1(context.key, hash[:], signature) {
		return "", fmt.Errorf("signature verification failed")
	}
	return eventDigest(event)
}

func eventDigest(event Attestation) (string, error) {
	body, err := json.Marshal(event)
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(body)
	return "sha256:" + hex.EncodeToString(digest[:]), nil
}

func validateFileManifest(files []FileHash) error {
	if len(files) == 0 {
		return fmt.Errorf("signed file manifest is empty")
	}
	previous := ""
	for _, file := range files {
		clean := filepath.ToSlash(filepath.Clean(file.Path))
		if file.Path != clean || clean == "." || filepath.IsAbs(file.Path) || strings.HasPrefix(clean, "../") || !validContentDigest(file.SHA256) {
			return fmt.Errorf("signed file manifest contains an invalid path or digest")
		}
		if previous != "" && file.Path <= previous {
			return fmt.Errorf("signed file manifest must be strictly sorted and unique")
		}
		previous = file.Path
	}
	return nil
}

func validOperation(operation string) bool {
	return operation == OperationApprove || operation == OperationRevoke
}

func validSHA256Digest(value string) bool {
	return strings.HasPrefix(value, "sha256:") && validContentDigest(strings.TrimPrefix(value, "sha256:"))
}

func validContentDigest(value string) bool {
	if len(value) != sha256.Size*2 {
		return false
	}
	_, err := hex.DecodeString(value)
	return err == nil
}
