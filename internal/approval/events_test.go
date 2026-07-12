package approval

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

type recordingSigner struct {
	*testSigner
	reasons []string
	err     error
	onSign  func()
}

func (signer *recordingSigner) SignPayload(payload []byte, reason string) ([]byte, error) {
	signer.reasons = append(signer.reasons, reason)
	if signer.err != nil {
		return nil, signer.err
	}
	if signer.onSign != nil {
		signer.onSign()
	}
	return signer.testSigner.SignPayload(payload, reason)
}

type approvalFixture struct {
	root       string
	policy     string
	trust      string
	checkpoint string
	signer     *recordingSigner
}

func newApprovalFixture(t *testing.T) approvalFixture {
	t.Helper()
	root := t.TempDir()
	trust := filepath.Join(t.TempDir(), "trusted.json")
	checkpoint := filepath.Join(t.TempDir(), "checkpoint.json")
	write(t, filepath.Join(root, "src", "button.ts"), "export const button = true\n")
	policy := writePolicy(t, root, "github.com/DotNaos/ui", "source-review", "button", "src", ".project/approvals/button.json")
	_, _, digest, err := LoadPolicy(root, policy)
	if err != nil {
		t.Fatal(err)
	}
	signer := &recordingSigner{testSigner: newTestSigner(t)}
	writeTrust(t, trust, "github.com/DotNaos/ui", "source-review", digest, signer.testSigner)
	return approvalFixture{root: root, policy: policy, trust: trust, checkpoint: checkpoint, signer: signer}
}

func TestSignedApprovalLifecycleAndReplayProtection(t *testing.T) {
	fixture := newApprovalFixture(t)
	prepared, err := PrepareWithMonotonic(fixture.root, fixture.policy, fixture.trust, fixture.checkpoint, "button", fixture.signer)
	if err != nil {
		t.Fatal(err)
	}
	if prepared.State != StateMissingHistory || prepared.NextSequence != 1 || prepared.PreviousEventDigest != "" {
		t.Fatalf("initial preparation = %+v", prepared)
	}
	approved, err := Approve(fixture.root, fixture.policy, fixture.trust, fixture.checkpoint, "button", prepared.ContentDigest, fixture.signer)
	if err != nil {
		t.Fatal(err)
	}
	assertLifecycleState(t, fixture, StateApproved, 1, OperationApprove)
	approvedHistory, _ := os.ReadFile(filepath.Join(fixture.root, approved.Attestation))
	approvedCheckpoint, _ := os.ReadFile(fixture.checkpoint)

	revoked, err := Revoke(fixture.root, fixture.policy, fixture.trust, fixture.checkpoint, "button", approved.ContentDigest, fixture.signer)
	if err != nil {
		t.Fatal(err)
	}
	if revoked.Sequence != 2 || revoked.EventDigest == approved.EventDigest {
		t.Fatalf("revocation result = %+v", revoked)
	}
	assertLifecycleState(t, fixture, StateRevoked, 2, OperationRevoke)
	revokedHistory, _ := os.ReadFile(filepath.Join(fixture.root, revoked.Attestation))
	revokedCheckpoint, _ := os.ReadFile(fixture.checkpoint)

	write(t, fixture.checkpoint, string(approvedCheckpoint))
	assertLifecycleState(t, fixture, StateReplayCheckpointMismatch, 2, OperationRevoke)
	write(t, fixture.checkpoint, string(revokedCheckpoint))

	write(t, filepath.Join(fixture.root, revoked.Attestation), string(approvedHistory))
	assertLifecycleState(t, fixture, StateReplayCheckpointMismatch, 1, OperationApprove)
	write(t, filepath.Join(fixture.root, revoked.Attestation), string(revokedHistory))

	write(t, fixture.checkpoint, string(approvedCheckpoint))
	write(t, filepath.Join(fixture.root, revoked.Attestation), string(approvedHistory))
	assertLifecycleState(t, fixture, StateReplayCheckpointMismatch, 1, OperationApprove)
	write(t, fixture.checkpoint, string(revokedCheckpoint))
	write(t, filepath.Join(fixture.root, revoked.Attestation), string(revokedHistory))

	reapproved, err := Approve(fixture.root, fixture.policy, fixture.trust, fixture.checkpoint, "button", revoked.ContentDigest, fixture.signer)
	if err != nil {
		t.Fatal(err)
	}
	if reapproved.Sequence != 3 {
		t.Fatalf("reapproval result = %+v", reapproved)
	}
	assertLifecycleState(t, fixture, StateApproved, 3, OperationApprove)
	if len(fixture.signer.reasons) != 3 {
		t.Fatalf("prompt count = %d, want 3", len(fixture.signer.reasons))
	}
	for index, expected := range []string{"APPROVE", "REVOKE", "APPROVE"} {
		reason := fixture.signer.reasons[index]
		for _, binding := range []string{expected + " button", "github.com/DotNaos/ui", "Policy: source-review", approved.ContentDigest} {
			if !strings.Contains(reason, binding) {
				t.Fatalf("prompt %d missing %q: %q", index, binding, reason)
			}
		}
	}
}

func TestLegacyApprovalRequiresFreshEventBeforeCheckpointing(t *testing.T) {
	fixture := newApprovalFixture(t)
	policy, _, digest, err := LoadPolicy(fixture.root, fixture.policy)
	if err != nil {
		t.Fatal(err)
	}
	payload, err := BuildPayload(fixture.root, policy, digest, policy.Scopes[0], mustSignerID(t, fixture.signer))
	if err != nil {
		t.Fatal(err)
	}
	payload.IssuedAt = time.Now().UTC()
	canonical, _ := CanonicalPayload(payload)
	signature, _ := fixture.signer.testSigner.SignPayload(canonical, "legacy")
	legacy := Attestation{Version: AttestationVersion, Payload: payload, Signature: base64.StdEncoding.EncodeToString(signature)}
	legacyBody, _ := json.MarshalIndent(legacy, "", "  ")
	write(t, filepath.Join(fixture.root, policy.Scopes[0].Attestation), string(legacyBody))
	assertLifecycleState(t, fixture, StateApproved, 0, OperationApprove)

	revoked, err := Revoke(fixture.root, fixture.policy, fixture.trust, fixture.checkpoint, "button", payload.ContentDigest, fixture.signer)
	if err != nil {
		t.Fatal(err)
	}
	if revoked.Sequence != 1 {
		t.Fatalf("legacy migration revocation = %+v", revoked)
	}
	write(t, filepath.Join(fixture.root, policy.Scopes[0].Attestation), string(legacyBody))
	assertLifecycleState(t, fixture, StateReplayCheckpointMismatch, 0, "")
}

func TestContentChangesAndCancellationNeverCreateApprovalTruth(t *testing.T) {
	fixture := newApprovalFixture(t)
	prepared, err := Prepare(fixture.root, fixture.policy, fixture.trust, fixture.checkpoint, "button")
	if err != nil {
		t.Fatal(err)
	}
	write(t, filepath.Join(fixture.root, "src", "button.ts"), "changed before approval\n")
	if _, err := Approve(fixture.root, fixture.policy, fixture.trust, fixture.checkpoint, "button", prepared.ContentDigest, fixture.signer); err == nil || !strings.Contains(err.Error(), "changed after preparation") {
		t.Fatalf("expected prepared digest mismatch, got %v", err)
	}
	if len(fixture.signer.reasons) != 0 {
		t.Fatal("content mismatch requested authentication")
	}

	prepared, _ = Prepare(fixture.root, fixture.policy, fixture.trust, fixture.checkpoint, "button")
	fixture.signer.err = errors.New("authentication canceled")
	if _, err := Approve(fixture.root, fixture.policy, fixture.trust, fixture.checkpoint, "button", prepared.ContentDigest, fixture.signer); err == nil {
		t.Fatal("canceled approval succeeded")
	}
	if _, err := os.Stat(filepath.Join(fixture.root, ".project/approvals/button.json")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("canceled approval wrote history: %v", err)
	}
	if _, err := os.Stat(fixture.checkpoint); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("canceled approval wrote checkpoint: %v", err)
	}
	fixture.signer.err = nil
	approved, err := Approve(fixture.root, fixture.policy, fixture.trust, fixture.checkpoint, "button", prepared.ContentDigest, fixture.signer)
	if err != nil {
		t.Fatal(err)
	}
	historyBeforeCancel, _ := os.ReadFile(filepath.Join(fixture.root, approved.Attestation))
	checkpointBeforeCancel, _ := os.ReadFile(fixture.checkpoint)
	fixture.signer.err = errors.New("authentication canceled")
	if _, err := Revoke(fixture.root, fixture.policy, fixture.trust, fixture.checkpoint, "button", approved.ContentDigest, fixture.signer); err == nil {
		t.Fatal("canceled revocation succeeded")
	}
	historyAfterCancel, _ := os.ReadFile(filepath.Join(fixture.root, approved.Attestation))
	checkpointAfterCancel, _ := os.ReadFile(fixture.checkpoint)
	if string(historyAfterCancel) != string(historyBeforeCancel) || string(checkpointAfterCancel) != string(checkpointBeforeCancel) {
		t.Fatal("canceled revocation changed signed history or checkpoint")
	}
	assertLifecycleState(t, fixture, StateApproved, 1, OperationApprove)
	fixture.signer.err = nil
	write(t, filepath.Join(fixture.root, "src", "button.ts"), "changed after approval\n")
	assertLifecycleState(t, fixture, StateStale, 1, OperationApprove)
	if _, err := Revoke(fixture.root, fixture.policy, fixture.trust, fixture.checkpoint, "button", approved.ContentDigest, fixture.signer); err == nil {
		t.Fatal("stale approval was revoked as if current")
	}
}

func TestProtectedCheckpointFailureRollsBackRepositoryAndExternalState(t *testing.T) {
	fixture := newApprovalFixture(t)
	prepared, err := PrepareWithMonotonic(
		fixture.root, fixture.policy, fixture.trust, fixture.checkpoint, "button", fixture.signer,
	)
	if err != nil {
		t.Fatal(err)
	}
	fixture.signer.commitErr = errors.New("protected checkpoint unavailable")
	if _, err := Approve(
		fixture.root, fixture.policy, fixture.trust, fixture.checkpoint, "button", prepared.ContentDigest, fixture.signer,
	); err == nil || !strings.Contains(err.Error(), "protected checkpoint") {
		t.Fatalf("protected checkpoint failure = %v", err)
	}
	if _, err := os.Stat(filepath.Join(fixture.root, ".project/approvals/button.json")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("failed operation left signed history: %v", err)
	}
	if _, err := os.Stat(fixture.checkpoint); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("failed operation left external checkpoint: %v", err)
	}
	if len(fixture.signer.anchors) != 0 {
		t.Fatal("failed operation advanced protected checkpoint")
	}
	fixture.signer.commitErr = nil
	if _, err := Approve(
		fixture.root, fixture.policy, fixture.trust, fixture.checkpoint, "button", prepared.ContentDigest, fixture.signer,
	); err != nil {
		t.Fatalf("retry after rollback: %v", err)
	}
	assertLifecycleState(t, fixture, StateApproved, 1, OperationApprove)
}

func TestContentChangeDuringAuthenticationWritesNothing(t *testing.T) {
	fixture := newApprovalFixture(t)
	prepared, _ := Prepare(fixture.root, fixture.policy, fixture.trust, fixture.checkpoint, "button")
	fixture.signer.onSign = func() {
		write(t, filepath.Join(fixture.root, "src", "button.ts"), "changed during prompt\n")
	}
	if _, err := Approve(fixture.root, fixture.policy, fixture.trust, fixture.checkpoint, "button", prepared.ContentDigest, fixture.signer); err == nil || !strings.Contains(err.Error(), "during system authentication") {
		t.Fatalf("authentication race was accepted: %v", err)
	}
	if _, err := os.Stat(filepath.Join(fixture.root, ".project/approvals/button.json")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("authentication race wrote history: %v", err)
	}
	if _, err := os.Stat(fixture.checkpoint); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("authentication race wrote checkpoint: %v", err)
	}
}

func TestHistoryChangeDuringAuthenticationDoesNotAdvanceCheckpoint(t *testing.T) {
	fixture := newApprovalFixture(t)
	prepared, _ := Prepare(fixture.root, fixture.policy, fixture.trust, fixture.checkpoint, "button")
	approved, err := Approve(fixture.root, fixture.policy, fixture.trust, fixture.checkpoint, "button", prepared.ContentDigest, fixture.signer)
	if err != nil {
		t.Fatal(err)
	}
	checkpointBefore, _ := os.ReadFile(fixture.checkpoint)
	historyPath := filepath.Join(fixture.root, approved.Attestation)
	fixture.signer.onSign = func() {
		body, _ := os.ReadFile(historyPath)
		write(t, historyPath, string(body)+" ")
	}
	if _, err := Revoke(fixture.root, fixture.policy, fixture.trust, fixture.checkpoint, "button", approved.ContentDigest, fixture.signer); err == nil || !strings.Contains(err.Error(), "history changed") {
		t.Fatalf("history authentication race was accepted: %v", err)
	}
	checkpointAfter, _ := os.ReadFile(fixture.checkpoint)
	if string(checkpointAfter) != string(checkpointBefore) {
		t.Fatal("history authentication race advanced external checkpoint")
	}
}

func TestMissingAndTamperedHistoryFailClosed(t *testing.T) {
	fixture := newApprovalFixture(t)
	prepared, _ := Prepare(fixture.root, fixture.policy, fixture.trust, fixture.checkpoint, "button")
	approved, err := Approve(fixture.root, fixture.policy, fixture.trust, fixture.checkpoint, "button", prepared.ContentDigest, fixture.signer)
	if err != nil {
		t.Fatal(err)
	}
	historyPath := filepath.Join(fixture.root, approved.Attestation)
	body, _ := os.ReadFile(historyPath)
	if err := os.Remove(historyPath); err != nil {
		t.Fatal(err)
	}
	assertLifecycleState(t, fixture, StateMissingHistory, 0, "")
	if _, err := Approve(fixture.root, fixture.policy, fixture.trust, fixture.checkpoint, "button", approved.ContentDigest, fixture.signer); err == nil || !strings.Contains(err.Error(), "cannot be replaced") {
		t.Fatalf("deleted checkpointed history was reset: %v", err)
	}
	write(t, historyPath, string(body))

	tampered := strings.Replace(string(body), `"operation": "approve"`, `"operation": "revoke"`, 1)
	write(t, historyPath, tampered)
	assertLifecycleState(t, fixture, StateInvalidTampered, 0, "")
	write(t, historyPath, string(body)+"{}")
	assertLifecycleState(t, fixture, StateInvalidTampered, 0, "")
}

func TestScopeHashRejectsSymlinkedParentsAndCanonicalizesAttestations(t *testing.T) {
	if testing.Short() {
		t.Skip("filesystem integration")
	}
	root := t.TempDir()
	external := t.TempDir()
	write(t, filepath.Join(external, "secret.ts"), "outside\n")
	if err := os.Symlink(external, filepath.Join(root, "linked")); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	write(t, filepath.Join(root, ".project/approvals/policy.yaml"), "version: 1\nrepository: example/repo\npolicyId: review\nscopes:\n- id: linked\n  label: Linked\n  paths: [linked/secret.ts]\n  attestation: .project/approvals/linked.json\n")
	policy, _, digest, err := LoadPolicy(root, ".project/approvals/policy.yaml")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := BuildPayload(root, policy, digest, policy.Scopes[0], "signer"); err == nil || !strings.Contains(err.Error(), "symlink") {
		t.Fatalf("symlinked parent was accepted: %v", err)
	}

	root = t.TempDir()
	write(t, filepath.Join(root, "src", "button.ts"), "button\n")
	write(t, filepath.Join(root, ".project/approvals/button.json"), "sidecar\n")
	write(t, filepath.Join(root, ".project/approvals/policy.yaml"), "version: 1\nrepository: example/repo\npolicyId: review\nscopes:\n- id: all\n  label: All\n  paths: [.]\n  attestation: .project/approvals/all.json\n- id: button\n  label: Button\n  paths: [src/button.ts]\n  attestation: ./.project/approvals/button.json\n")
	policy, _, digest, err = LoadPolicy(root, ".project/approvals/policy.yaml")
	if err != nil {
		t.Fatal(err)
	}
	payload, err := BuildPayload(root, policy, digest, policy.Scopes[0], "signer")
	if err != nil {
		t.Fatal(err)
	}
	for _, file := range payload.Files {
		if strings.Contains(file.Path, "approvals/button.json") {
			t.Fatalf("noncanonical declared attestation was hashed: %+v", payload.Files)
		}
	}
}

func TestScopeHashCannotEscapeDuringSymlinkSwap(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink swapping requires elevated Windows privileges")
	}
	root := t.TempDir()
	external := t.TempDir()
	write(t, filepath.Join(root, "target", "file.ts"), "inside\n")
	write(t, filepath.Join(external, "file.ts"), "outside\n")
	write(t, filepath.Join(root, ".project/approvals/policy.yaml"), "version: 1\nrepository: example/repo\npolicyId: review\nscopes:\n- id: target\n  label: Target\n  paths: [target/file.ts]\n  attestation: .project/approvals/target.json\n")
	policy, _, digest, err := LoadPolicy(root, ".project/approvals/policy.yaml")
	if err != nil {
		t.Fatal(err)
	}
	externalHash := sha256.Sum256([]byte("outside\n"))
	externalDigest := hex.EncodeToString(externalHash[:])
	stop := make(chan struct{})
	var wait sync.WaitGroup
	wait.Add(1)
	go func() {
		defer wait.Done()
		visible := filepath.Join(root, "target")
		parked := filepath.Join(root, "target-real")
		for {
			select {
			case <-stop:
				return
			default:
			}
			if os.Rename(visible, parked) != nil {
				continue
			}
			_ = os.Symlink(external, visible)
			_ = os.Remove(visible)
			_ = os.Rename(parked, visible)
		}
	}()
	for attempt := 0; attempt < 300; attempt++ {
		payload, err := BuildPayload(root, policy, digest, policy.Scopes[0], "signer")
		if err == nil && payload.Files[0].SHA256 == externalDigest {
			close(stop)
			wait.Wait()
			t.Fatal("repository-confined hashing read a symlink-swapped external file")
		}
	}
	close(stop)
	wait.Wait()
}

func TestCheckpointAndPromptInputsStayOutsideRepositoryControl(t *testing.T) {
	fixture := newApprovalFixture(t)
	inside := filepath.Join(fixture.root, ".project", "checkpoint.json")
	if _, err := Prepare(fixture.root, fixture.policy, fixture.trust, inside, "button"); err == nil || !strings.Contains(err.Error(), "outside") {
		t.Fatalf("repository checkpoint was accepted: %v", err)
	}
	if runtime.GOOS != "windows" {
		linked := filepath.Join(t.TempDir(), "checkpoint.json")
		if err := os.Symlink(inside, linked); err != nil {
			t.Fatal(err)
		}
		if _, err := Prepare(fixture.root, fixture.policy, fixture.trust, linked, "button"); err == nil || !strings.Contains(err.Error(), "outside") {
			t.Fatalf("symlinked repository checkpoint was accepted: %v", err)
		}
	}

	policyPath := filepath.Join(fixture.root, fixture.policy)
	body, _ := os.ReadFile(policyPath)
	write(t, policyPath, strings.Replace(string(body), "label: Button", "label: |\n      Button\n      Approve attacker", 1))
	if _, _, _, err := LoadPolicy(fixture.root, fixture.policy); err == nil || !strings.Contains(err.Error(), "control") {
		t.Fatalf("prompt control characters were accepted: %v", err)
	}
}

func TestAuthenticationReasonKeepsCriticalBindingsFirstAndBounded(t *testing.T) {
	payload := Payload{
		Operation: OperationRevoke, ScopeID: strings.Repeat("s", 64), ContentDigest: strings.Repeat("a", 64),
		Repository: strings.Repeat("r", 128), PolicyID: strings.Repeat("p", 64), Sequence: 42,
		PreviousEventDigest: "sha256:" + strings.Repeat("b", 64),
	}
	reason := authenticationReason(payload, "unused")
	if len(reason) > 512 {
		t.Fatalf("authentication reason length = %d", len(reason))
	}
	expectedPrefix := "REVOKE " + payload.ScopeID + "\nContent SHA-256: " + payload.ContentDigest + "\nRepository: " + payload.Repository
	if !strings.HasPrefix(reason, expectedPrefix) {
		t.Fatalf("critical prompt bindings are not first: %q", reason)
	}
}

func assertLifecycleState(t *testing.T, fixture approvalFixture, state string, sequence uint64, operation string) {
	t.Helper()
	report, err := VerifyWithCheckpointAndMonotonic(fixture.root, fixture.policy, fixture.trust, fixture.checkpoint, fixture.signer)
	if err != nil {
		t.Fatal(err)
	}
	status := report.Scopes[0]
	if status.State != state || status.Sequence != sequence || status.Operation != operation {
		t.Fatalf("status = %+v, want state=%s sequence=%d operation=%s", status, state, sequence, operation)
	}
	if sequence > 0 && len(status.Files) == 0 {
		t.Fatal("status omitted the trusted signed file manifest")
	}
}

func mustSignerID(t *testing.T, signer *recordingSigner) string {
	t.Helper()
	id, err := signer.SignerID()
	if err != nil {
		t.Fatal(err)
	}
	return id
}
