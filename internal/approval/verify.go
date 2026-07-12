package approval

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"
)

func Verify(root, policyPath, trustPath string) (Report, error) {
	if err := requireExternalTrustRoot(root, trustPath); err != nil {
		return Report{}, err
	}
	policy, _, policyDigest, err := LoadPolicy(root, policyPath)
	if err != nil {
		return Report{}, err
	}
	trust, err := LoadTrustRoot(trustPath)
	if err != nil {
		return Report{}, err
	}
	if trust.Repository != policy.Repository || trust.PolicyID != policy.PolicyID || trust.PolicyDigest != policyDigest {
		return Report{}, fmt.Errorf("external trust root does not authorize this repository policy")
	}
	key, err := parsePublicKey(trust)
	if err != nil {
		return Report{}, err
	}
	report := Report{Repository: policy.Repository, PolicyID: policy.PolicyID, OK: true}
	for _, scope := range policy.Scopes {
		status := verifyScope(root, policy, policyDigest, trust, key, scope)
		report.Scopes = append(report.Scopes, status)
		if status.State != "approved" {
			report.OK = false
		}
	}
	return report, nil
}

func verifyScope(root string, policy Policy, digest string, trust TrustRoot, key *ecdsa.PublicKey, scope Scope) ScopeStatus {
	status := ScopeStatus{ID: scope.ID, Label: scope.Label, State: "invalid", Attestation: scope.Attestation}
	path, err := confinedPath(root, scope.Attestation)
	if err != nil {
		status.Reason = err.Error()
		return status
	}
	if err := rejectSymlinkComponents(root, path); err != nil {
		status.Reason = err.Error()
		return status
	}
	body, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		status.State = "missing"
		status.Reason = "attestation is missing"
		return status
	}
	if err != nil {
		status.Reason = err.Error()
		return status
	}
	var att Attestation
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&att); err != nil {
		status.Reason = "attestation cannot be parsed"
		return status
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		status.Reason = "attestation must contain exactly one JSON object"
		return status
	}
	if err := requireDecoderEOF(decoder.Decode); err != nil {
		status.Reason = "attestation contains trailing data"
		return status
	}
	expected, err := BuildPayload(root, policy, digest, scope, trust.SignerID)
	if err != nil {
		status.Reason = err.Error()
		return status
	}
	if att.Version != AttestationVersion || att.Payload.Version != AttestationVersion {
		status.Reason = "attestation version is unsupported"
		return status
	}
	if att.Payload.IssuedAt.IsZero() {
		status.Reason = "attestation issuedAt is missing"
		return status
	}
	expected.IssuedAt = att.Payload.IssuedAt
	if att.Payload.Repository != expected.Repository || att.Payload.PolicyID != expected.PolicyID || att.Payload.ScopeID != expected.ScopeID || att.Payload.SignerID != expected.SignerID {
		status.Reason = "attestation belongs to another repository, policy, scope, or signer"
		return status
	}
	expectedBody, _ := CanonicalPayload(expected)
	actualBody, _ := CanonicalPayload(att.Payload)
	if string(expectedBody) != string(actualBody) {
		status.State = "stale"
		status.Reason = "content, policy, repository, scope, or signer changed"
		return status
	}
	signature, err := base64.StdEncoding.DecodeString(att.Signature)
	if err != nil {
		status.Reason = "signature is not valid base64"
		return status
	}
	hash := sha256.Sum256(actualBody)
	if !ecdsa.VerifyASN1(key, hash[:], signature) {
		status.Reason = "signature verification failed"
		return status
	}
	status.State = "approved"
	status.Reason = ""
	return status
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

func Sign(root, policyPath, trustPath, scopeID string, signer SignatureProvider) (string, error) {
	if err := requireExternalTrustRoot(root, trustPath); err != nil {
		return "", err
	}
	policy, _, digest, err := LoadPolicy(root, policyPath)
	if err != nil {
		return "", err
	}
	trust, err := LoadTrustRoot(trustPath)
	if err != nil {
		return "", err
	}
	if trust.Repository != policy.Repository || trust.PolicyID != policy.PolicyID || trust.PolicyDigest != digest {
		return "", fmt.Errorf("external trust root does not authorize this repository policy")
	}
	signerID, err := signer.SignerID()
	if err != nil {
		return "", err
	}
	publicKey, err := signer.PublicKeyPEM()
	if err != nil {
		return "", err
	}
	if signerID != trust.SignerID || publicKey != trust.PublicKeyPEM {
		return "", fmt.Errorf("Secure Enclave signer does not match external trust root")
	}
	var scope *Scope
	for i := range policy.Scopes {
		if policy.Scopes[i].ID == scopeID {
			scope = &policy.Scopes[i]
			break
		}
	}
	if scope == nil {
		return "", fmt.Errorf("unknown approval scope %q", scopeID)
	}
	payload, err := BuildPayload(root, policy, digest, *scope, signerID)
	if err != nil {
		return "", err
	}
	payload.IssuedAt = time.Now().UTC()
	canonical, _ := CanonicalPayload(payload)
	signature, err := signer.SignPayload(canonical, "Approve "+scope.Label+" in "+policy.Repository)
	if err != nil {
		return "", err
	}
	att := Attestation{Version: AttestationVersion, Payload: payload, Signature: base64.StdEncoding.EncodeToString(signature)}
	body, err := json.MarshalIndent(att, "", "  ")
	if err != nil {
		return "", err
	}
	body = append(body, '\n')
	path, _ := confinedPath(root, scope.Attestation)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return "", err
	}
	if err := rejectSymlinkComponents(root, path); err != nil {
		return "", err
	}
	temporary, err := os.CreateTemp(filepath.Dir(path), ".approval-*.tmp")
	if err != nil {
		return "", err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(0o600); err != nil {
		temporary.Close()
		return "", err
	}
	if _, err := temporary.Write(body); err != nil {
		temporary.Close()
		return "", err
	}
	if err := temporary.Sync(); err != nil {
		temporary.Close()
		return "", err
	}
	if err := temporary.Close(); err != nil {
		return "", err
	}
	if err := os.Rename(temporaryPath, path); err != nil {
		return "", err
	}
	return path, nil
}
