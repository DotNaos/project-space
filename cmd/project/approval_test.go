package main

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/DotNaos/project-space/internal/approval"
)

type commandTestSigner struct {
	key     *ecdsa.PrivateKey
	mu      sync.Mutex
	anchors map[string][]byte
}

func newCommandTestSigner(t *testing.T) *commandTestSigner {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return &commandTestSigner{key: key, anchors: make(map[string][]byte)}
}

func (signer *commandTestSigner) SignerID() (string, error) {
	der, _ := x509.MarshalPKIXPublicKey(&signer.key.PublicKey)
	digest := sha256.Sum256(der)
	return "sha256:" + hex.EncodeToString(digest[:]), nil
}

func (signer *commandTestSigner) PublicKeyPEM() (string, error) {
	der, _ := x509.MarshalPKIXPublicKey(&signer.key.PublicKey)
	return string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der})), nil
}

func (signer *commandTestSigner) SignPayload(payload []byte, _ string) ([]byte, error) {
	digest := sha256.Sum256(payload)
	return ecdsa.SignASN1(rand.Reader, signer.key, digest[:])
}
func (signer *commandTestSigner) ReadCheckpoint(key string) ([]byte, bool, error) {
	signer.mu.Lock()
	defer signer.mu.Unlock()
	body, exists := signer.anchors[key]
	return append([]byte(nil), body...), exists, nil
}
func (signer *commandTestSigner) CommitCheckpoint(_ []byte, _ []byte, key string, expected, next []byte) error {
	signer.mu.Lock()
	defer signer.mu.Unlock()
	current, exists := signer.anchors[key]
	if (expected == nil && exists) || (expected != nil && (!exists || !bytes.Equal(current, expected))) {
		return fmt.Errorf("protected checkpoint changed")
	}
	signer.anchors[key] = append([]byte(nil), next...)
	return nil
}

func TestApprovalVerifyFailsClosedWithoutExternalTrustRoot(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, ".project", "approvals"), 0o755); err != nil {
		t.Fatal(err)
	}
	policy := "version: 1\nrepository: example/repo\npolicyId: review\nscopes:\n  - id: source\n    label: Source\n    paths: [README.md]\n    attestation: .project/approvals/source.json\n"
	if err := os.WriteFile(filepath.Join(root, ".project", "approvals", "policy.yaml"), []byte(policy), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "README.md"), []byte("review\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	command := newRootCommand()
	command.SetArgs([]string{"approval", "verify", "--root", root, "--trust-root", filepath.Join(root, "missing.json")})
	if err := command.Execute(); err == nil || !strings.Contains(err.Error(), "trust root") {
		t.Fatalf("verify error = %v", err)
	}
}

func TestApprovalStatusRejectsUnknownFormat(t *testing.T) {
	command := newRootCommand()
	output := &bytes.Buffer{}
	command.SetOut(output)
	command.SetArgs([]string{"approval", "status", "--format", "yaml", "--trust-root", "/tmp/trust.json"})
	if err := command.Execute(); err == nil || !strings.Contains(err.Error(), "--format") {
		t.Fatalf("status error = %v", err)
	}
}

func TestValidateModesFailClosedWhenApprovalPolicyIsDeclared(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, ".project", "approvals"), 0o755); err != nil {
		t.Fatal(err)
	}
	policy := "version: 1\nrepository: example/repo\npolicyId: review\nscopes:\n  - id: source\n    label: Source\n    paths: [README.md]\n    attestation: .project/approvals/source.json\n"
	if err := os.WriteFile(filepath.Join(root, ".project", "approvals", "policy.yaml"), []byte(policy), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "README.md"), []byte("review\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Chdir(root)
	t.Setenv("PROJECT_APPROVAL_TRUST_ROOT", "")
	command := newRootCommand()
	command.SetArgs([]string{"validate", "README.md"})
	if err := command.Execute(); err == nil || !strings.Contains(err.Error(), "PROJECT_APPROVAL_TRUST_ROOT") {
		t.Fatalf("validate file error = %v", err)
	}
	command = newRootCommand()
	command.SetArgs([]string{"validate", "--quarantine", "--dry-run", "."})
	if err := command.Execute(); err == nil || !strings.Contains(err.Error(), "PROJECT_APPROVAL_TRUST_ROOT") {
		t.Fatalf("validate quarantine error = %v", err)
	}
}

func TestApprovalLifecycleCommandsExposeStableJSON(t *testing.T) {
	root := t.TempDir()
	trustPath := filepath.Join(t.TempDir(), "trust.json")
	checkpointPath := filepath.Join(t.TempDir(), "checkpoint.json")
	if err := os.MkdirAll(filepath.Join(root, ".project", "approvals"), 0o755); err != nil {
		t.Fatal(err)
	}
	policyBody := "version: 1\nrepository: github.com/DotNaos/ui\npolicyId: source-review\nscopes:\n  - id: button\n    label: Button\n    paths: [src/button.ts]\n    attestation: .project/approvals/button.json\n"
	if err := os.WriteFile(filepath.Join(root, ".project", "approvals", "policy.yaml"), []byte(policyBody), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(root, "src"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "src", "button.ts"), []byte("button\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	_, _, policyDigest, err := approval.LoadPolicy(root, ".project/approvals/policy.yaml")
	if err != nil {
		t.Fatal(err)
	}
	signer := newCommandTestSigner(t)
	signerID, _ := signer.SignerID()
	publicKey, _ := signer.PublicKeyPEM()
	trustBody, _ := json.Marshal(approval.TrustRoot{
		Version: 1, Repository: "github.com/DotNaos/ui", PolicyID: "source-review", PolicyDigest: policyDigest,
		SignerID: signerID, PublicKeyPEM: publicKey, KeyFingerprint: signerID,
	})
	if err := os.WriteFile(trustPath, trustBody, 0o600); err != nil {
		t.Fatal(err)
	}
	previousSigner := newApprovalSigner
	newApprovalSigner = func() approvalSigner { return signer }
	t.Cleanup(func() { newApprovalSigner = previousSigner })

	base := []string{"--root", root, "--trust-root", trustPath, "--checkpoint", checkpointPath, "--format", "json"}
	preparedBody := executeApprovalJSON(t, append([]string{"approval", "prepare", "--scope", "button"}, base...))
	var prepared approval.Preparation
	if err := json.Unmarshal(preparedBody, &prepared); err != nil {
		t.Fatal(err)
	}
	if prepared.State != approval.StateMissingHistory || prepared.ContentDigest == "" || prepared.NextSequence != 1 {
		t.Fatalf("prepare = %+v", prepared)
	}

	signedBody := executeApprovalJSON(t, append([]string{"approval", "sign", "--scope", "button", "--expected-content-digest", prepared.ContentDigest}, base...))
	var signed approval.OperationResult
	if err := json.Unmarshal(signedBody, &signed); err != nil {
		t.Fatal(err)
	}
	if signed.State != approval.StateApproved || signed.Sequence != 1 || signed.Operation != approval.OperationApprove {
		t.Fatalf("sign = %+v", signed)
	}

	statusBody := executeApprovalJSON(t, append([]string{"approval", "status"}, base...))
	var report approval.Report
	if err := json.Unmarshal(statusBody, &report); err != nil {
		t.Fatal(err)
	}
	if !report.OK || report.Scopes[0].State != approval.StateApproved {
		t.Fatalf("status = %+v", report)
	}

	revokedBody := executeApprovalJSON(t, append([]string{"approval", "revoke", "--scope", "button", "--expected-content-digest", signed.ContentDigest}, base...))
	var revoked approval.OperationResult
	if err := json.Unmarshal(revokedBody, &revoked); err != nil {
		t.Fatal(err)
	}
	if revoked.State != approval.StateRevoked || revoked.Sequence != 2 || revoked.Operation != approval.OperationRevoke {
		t.Fatalf("revoke = %+v", revoked)
	}
}

func executeApprovalJSON(t *testing.T, arguments []string) []byte {
	t.Helper()
	command := newRootCommand()
	output := &bytes.Buffer{}
	command.SetOut(output)
	command.SetErr(&bytes.Buffer{})
	command.SetArgs(arguments)
	if err := command.Execute(); err != nil {
		t.Fatalf("project %s: %v", strings.Join(arguments, " "), err)
	}
	body := output.Bytes()
	var value any
	if err := json.Unmarshal(body, &value); err != nil {
		t.Fatalf("output is not one JSON object: %q: %v", body, err)
	}
	return body
}
