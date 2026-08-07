package approval

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
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
)

type testSigner struct {
	key       *ecdsa.PrivateKey
	mu        sync.Mutex
	anchors   map[string][]byte
	commitErr error
}

func newTestSigner(t *testing.T) *testSigner {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return &testSigner{key: key, anchors: make(map[string][]byte)}
}
func (s *testSigner) SignerID() (string, error) {
	der, _ := x509.MarshalPKIXPublicKey(&s.key.PublicKey)
	sum := sha256.Sum256(der)
	return "sha256:" + hex.EncodeToString(sum[:]), nil
}
func (s *testSigner) PublicKeyPEM() (string, error) {
	der, _ := x509.MarshalPKIXPublicKey(&s.key.PublicKey)
	return string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der})), nil
}
func (s *testSigner) SignPayload(payload []byte, _ string) ([]byte, error) {
	digest := sha256.Sum256(payload)
	return ecdsa.SignASN1(rand.Reader, s.key, digest[:])
}
func (s *testSigner) ReadCheckpoint(key string) ([]byte, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	body, exists := s.anchors[key]
	return append([]byte(nil), body...), exists, nil
}
func (s *testSigner) CommitCheckpoint(_ []byte, _ []byte, key string, expected, next []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.commitErr != nil {
		return s.commitErr
	}
	current, exists := s.anchors[key]
	if (expected == nil && exists) || (expected != nil && (!exists || !bytes.Equal(current, expected))) {
		return errors.New("protected checkpoint changed")
	}
	s.anchors[key] = append([]byte(nil), next...)
	return nil
}

func TestApprovalThreatCases(t *testing.T) {
	root := t.TempDir()
	trustPath := filepath.Join(t.TempDir(), "trusted.json")
	signer := newTestSigner(t)
	write(t, filepath.Join(root, "src", "button.ts"), "export const button = true\n")
	write(t, filepath.Join(root, "src", "ignored.snap"), "generated\n")
	write(t, filepath.Join(root, "src", "generated", "nested.snap"), "generated\n")
	policyPath := writePolicy(t, root, "github.com/DotNaos/ui", "source-review", "button", "src", ".project/approvals/button.json")
	_, _, digest, err := LoadPolicy(root, policyPath)
	if err != nil {
		t.Fatal(err)
	}
	writeTrust(t, trustPath, "github.com/DotNaos/ui", "source-review", digest, signer)
	if _, err := Sign(root, policyPath, trustPath, "button", signer); err != nil {
		t.Fatal(err)
	}
	assertState(t, root, policyPath, trustPath, true, "approved")
	write(t, filepath.Join(root, "src", "generated", "nested.snap"), "changed generated output\n")
	assertState(t, root, policyPath, trustPath, true, "approved")

	t.Run("tampered content is stale", func(t *testing.T) {
		write(t, filepath.Join(root, "src", "button.ts"), "tampered\n")
		assertState(t, root, policyPath, trustPath, false, "stale")
		write(t, filepath.Join(root, "src", "button.ts"), "export const button = true\n")
	})
	t.Run("added covered file is stale", func(t *testing.T) {
		write(t, filepath.Join(root, "src", "new.ts"), "new\n")
		assertState(t, root, policyPath, trustPath, false, "stale")
		os.Remove(filepath.Join(root, "src", "new.ts"))
	})
	t.Run("renamed covered file is stale", func(t *testing.T) {
		oldPath := filepath.Join(root, "src", "button.ts")
		newPath := filepath.Join(root, "src", "renamed.ts")
		if err := os.Rename(oldPath, newPath); err != nil {
			t.Fatal(err)
		}
		assertState(t, root, policyPath, trustPath, false, "stale")
		if err := os.Rename(newPath, oldPath); err != nil {
			t.Fatal(err)
		}
	})
	t.Run("missing approval fails", func(t *testing.T) {
		path := filepath.Join(root, ".project/approvals/button.json")
		body, _ := os.ReadFile(path)
		os.Remove(path)
		assertState(t, root, policyPath, trustPath, false, StateMissingHistory)
		os.WriteFile(path, body, 0o644)
	})
	t.Run("signature tamper fails", func(t *testing.T) {
		path := filepath.Join(root, ".project/approvals/button.json")
		body, _ := os.ReadFile(path)
		var history History
		json.Unmarshal(body, &history)
		latest := len(history.Events) - 1
		history.Events[latest].Signature = strings.Repeat("A", len(history.Events[latest].Signature))
		changed, _ := json.Marshal(history)
		os.WriteFile(path, changed, 0o644)
		assertState(t, root, policyPath, trustPath, false, StateInvalidTampered)
		os.WriteFile(path, body, 0o644)
	})
	t.Run("trailing attestation value fails", func(t *testing.T) {
		path := filepath.Join(root, ".project/approvals/button.json")
		body, _ := os.ReadFile(path)
		os.WriteFile(path, append(body, []byte("{}")...), 0o644)
		assertState(t, root, policyPath, trustPath, false, StateInvalidTampered)
		os.WriteFile(path, body, 0o644)
	})
	t.Run("attestation symlink fails", func(t *testing.T) {
		if runtime.GOOS == "windows" {
			t.Skip("symlink creation requires elevated Windows privileges")
		}
		path := filepath.Join(root, ".project/approvals/button.json")
		body, _ := os.ReadFile(path)
		external := filepath.Join(t.TempDir(), "button.json")
		os.WriteFile(external, body, 0o644)
		os.Remove(path)
		if err := os.Symlink(external, path); err != nil {
			t.Fatal(err)
		}
		assertState(t, root, policyPath, trustPath, false, StateInvalidTampered)
		os.Remove(path)
		os.WriteFile(path, body, 0o644)
	})
	t.Run("policy change rejected by external root", func(t *testing.T) {
		body, _ := os.ReadFile(filepath.Join(root, policyPath))
		changed := strings.Replace(string(body), "Button", "Changed", 1)
		os.WriteFile(filepath.Join(root, policyPath), []byte(changed), 0o644)
		if _, err := Verify(root, policyPath, trustPath); err == nil {
			t.Fatal("policy replacement was trusted")
		}
		os.WriteFile(filepath.Join(root, policyPath), body, 0o644)
	})
	t.Run("key replacement rejected", func(t *testing.T) {
		attacker := newTestSigner(t)
		if _, err := Sign(root, policyPath, trustPath, "button", attacker); err == nil {
			t.Fatal("attacker signer was accepted")
		}
	})
	t.Run("copied approval rejected in another repository", func(t *testing.T) {
		other := t.TempDir()
		write(t, filepath.Join(other, "src", "button.ts"), "export const button = true\n")
		otherPolicy := writePolicy(t, other, "github.com/DotNaos/project-template", "source-review", "button", "src", ".project/approvals/button.json")
		body, _ := os.ReadFile(filepath.Join(root, ".project/approvals/button.json"))
		write(t, filepath.Join(other, ".project/approvals/button.json"), string(body))
		if _, err := Verify(other, otherPolicy, trustPath); err == nil {
			t.Fatal("copied repository approval was trusted")
		}
	})
	t.Run("wrong signer trust root rejected", func(t *testing.T) {
		wrong := filepath.Join(t.TempDir(), "wrong.json")
		writeTrust(t, wrong, "github.com/DotNaos/ui", "source-review", digest, newTestSigner(t))
		assertState(t, root, policyPath, wrong, false, StateInvalidTampered)
	})
}

func TestPolicyRejectsTraversalAndUnknownFields(t *testing.T) {
	root := t.TempDir()
	write(t, filepath.Join(root, "policy.yaml"), "version: 1\nrepository: x\npolicyId: p\nunknown: true\nscopes: []\n")
	if _, _, _, err := LoadPolicy(root, "policy.yaml"); err == nil {
		t.Fatal("unknown field accepted")
	}
	write(t, filepath.Join(root, "policy.yaml"), "version: 1\nrepository: x\npolicyId: p\nscopes:\n- id: x\n  label: X\n  paths: [../secret]\n  attestation: x.json\n")
	if _, _, _, err := LoadPolicy(root, "policy.yaml"); err == nil {
		t.Fatal("path traversal accepted")
	}
}

func TestPolicyRejectsSymlinksAndSelfReplacingAttestations(t *testing.T) {
	root := t.TempDir()
	policyPath := ".project/approvals/policy.yaml"
	write(t, filepath.Join(root, policyPath), "version: 1\nrepository: x\npolicyId: p\nscopes:\n- id: x\n  label: X\n  paths: [file]\n  attestation: "+policyPath+"\n")
	if _, _, _, err := LoadPolicy(root, policyPath); err == nil || !strings.Contains(err.Error(), "must not replace") {
		t.Fatalf("self-replacing attestation error = %v", err)
	}
	if runtime.GOOS == "windows" {
		return
	}
	external := filepath.Join(t.TempDir(), "policy.yaml")
	write(t, external, "version: 1\nrepository: x\npolicyId: p\nscopes:\n- id: x\n  label: X\n  paths: [file]\n  attestation: x.json\n")
	os.Remove(filepath.Join(root, policyPath))
	if err := os.Symlink(external, filepath.Join(root, policyPath)); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := LoadPolicy(root, policyPath); err == nil || !strings.Contains(err.Error(), "symlink") {
		t.Fatalf("symlinked policy error = %v", err)
	}
}

func TestParsersRejectTrailingDocuments(t *testing.T) {
	root := t.TempDir()
	write(t, filepath.Join(root, "policy.yaml"), "version: 1\nrepository: x\npolicyId: p\nscopes:\n- id: x\n  label: X\n  paths: [file]\n  attestation: x.json\n---\nversion: 1\n")
	if _, _, _, err := LoadPolicy(root, "policy.yaml"); err == nil {
		t.Fatal("trailing YAML document accepted")
	}
	write(t, filepath.Join(root, "trust.json"), `{"version":1} {"version":1}`)
	if _, err := LoadTrustRoot(filepath.Join(root, "trust.json")); err == nil {
		t.Fatal("trailing trust-root value accepted")
	}
}

func TestVerificationRejectsRepositoryOwnedTrustRoots(t *testing.T) {
	root := t.TempDir()
	trust := filepath.Join(root, ".project", "trust.json")
	write(t, trust, `{}`)
	if _, err := Verify(root, ".project/approvals/policy.yaml", trust); err == nil || !strings.Contains(err.Error(), "outside") {
		t.Fatalf("repository-owned trust root error = %v", err)
	}
	if runtime.GOOS == "windows" {
		return
	}
	externalLink := filepath.Join(t.TempDir(), "trust.json")
	if err := os.Symlink(trust, externalLink); err != nil {
		t.Fatal(err)
	}
	if _, err := Verify(root, ".project/approvals/policy.yaml", externalLink); err == nil || !strings.Contains(err.Error(), "outside") {
		t.Fatalf("symlinked repository trust root error = %v", err)
	}
	if runtime.GOOS == "darwin" {
		mixedCase := strings.ToUpper(root)
		if _, err := os.Stat(mixedCase); err != nil {
			t.Skip("test requires a case-insensitive macOS volume")
		}
		if _, err := Verify(root, ".project/approvals/policy.yaml", filepath.Join(mixedCase, ".project", "trust.json")); err == nil || !strings.Contains(err.Error(), "outside") {
			t.Fatalf("mixed-case repository trust root error = %v", err)
		}
	}
}

func TestScopeHashExcludesEveryDeclaredAttestation(t *testing.T) {
	root := t.TempDir()
	trustPath := filepath.Join(t.TempDir(), "trusted.json")
	policyPath := ".project/approvals/policy.yaml"
	write(t, filepath.Join(root, "src", "button.ts"), "button\n")
	write(t, filepath.Join(root, policyPath), "version: 1\nrepository: example/repo\npolicyId: review\nscopes:\n- id: all\n  label: All source\n  paths: [.]\n  attestation: .project/approvals/all.json\n- id: button\n  label: Button\n  paths: [src/button.ts]\n  attestation: .project/approvals/button.json\n")
	policy, _, digest, err := LoadPolicy(root, policyPath)
	if err != nil {
		t.Fatal(err)
	}
	signer := newTestSigner(t)
	writeTrust(t, trustPath, policy.Repository, policy.PolicyID, digest, signer)
	if _, err := Sign(root, policyPath, trustPath, "all", signer); err != nil {
		t.Fatal(err)
	}
	if _, err := Sign(root, policyPath, trustPath, "button", signer); err != nil {
		t.Fatal(err)
	}
	report, err := Verify(root, policyPath, trustPath)
	if err != nil {
		t.Fatal(err)
	}
	if !report.OK {
		t.Fatalf("signing one scope made another stale: %+v", report)
	}
}

func assertState(t *testing.T, root, policy, trust string, ok bool, state string) {
	t.Helper()
	report, err := Verify(root, policy, trust)
	if err != nil {
		if state == StateInvalidTampered && !ok {
			return
		}
		t.Fatal(err)
	}
	if report.OK != ok || report.Scopes[0].State != state {
		t.Fatalf("report=%+v", report)
	}
}
func writePolicy(t *testing.T, root, repo, policyID, scopeID, path, att string) string {
	t.Helper()
	relative := ".project/approvals/policy.yaml"
	body := "version: 1\nrepository: " + repo + "\npolicyId: " + policyID + "\nscopes:\n  - id: " + scopeID + "\n    label: Button\n    paths: [\"" + path + "\"]\n    ignore: [\"**/*.snap\"]\n    attestation: " + att + "\n"
	write(t, filepath.Join(root, relative), body)
	return relative
}
func writeTrust(t *testing.T, path, repo, policy, digest string, signer *testSigner) {
	t.Helper()
	id, _ := signer.SignerID()
	key, _ := signer.PublicKeyPEM()
	body, _ := json.Marshal(TrustRoot{Version: 1, Repository: repo, PolicyID: policy, PolicyDigest: digest, SignerID: id, PublicKeyPEM: key, KeyFingerprint: id})
	write(t, path, string(body))
}
func write(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}
