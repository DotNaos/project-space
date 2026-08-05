package worktreeownership

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRecoverReplacesExactOwnerOnPristineManagedWorktree(t *testing.T) {
	mainPath := setupRepository(t)
	worktreePath := addStandardWorktree(t, mainPath, "task-recover-owner")
	claimed, err := Claim(ClaimOptions{StartPath: worktreePath, ThreadID: firstThread})
	if err != nil {
		t.Fatal(err)
	}

	recovered, err := Recover(RecoverOptions{
		ExpectedOwnerThreadID: firstThread,
		ReplacementThreadID:   secondThread,
		StartPath:             worktreePath,
	})
	if err != nil {
		t.Fatal(err)
	}
	if recovered.Status != "recovered" || recovered.Owner != secondThread || recovered.Path != claimed.Path || recovered.Branch != claimed.Branch {
		t.Fatalf("unexpected recovery result: %#v", recovered)
	}
	if owner := readWorktreeConfig(worktreePath, ownerConfigKey); owner != secondThread {
		t.Fatalf("owner was not replaced: %q", owner)
	}
	if managed := readWorktreeConfig(worktreePath, managedConfigKey); managed != "true" {
		t.Fatalf("managed marker changed: %q", managed)
	}
}

func TestRecoverRejectsDirtyWorktreeAndPreservesOwner(t *testing.T) {
	mainPath := setupRepository(t)
	worktreePath := addStandardWorktree(t, mainPath, "task-dirty-recovery")
	if _, err := Claim(ClaimOptions{StartPath: worktreePath, ThreadID: firstThread}); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(worktreePath, "uncommitted.txt"), []byte("keep me\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	_, err := Recover(RecoverOptions{
		ExpectedOwnerThreadID: firstThread,
		ReplacementThreadID:   secondThread,
		StartPath:             worktreePath,
	})
	if err == nil || !strings.Contains(err.Error(), "contains changes") {
		t.Fatalf("expected dirty-worktree rejection, got %v", err)
	}
	if owner := readWorktreeConfig(worktreePath, ownerConfigKey); owner != firstThread {
		t.Fatalf("dirty worktree owner changed to %q", owner)
	}
}

func TestRecoverRejectsMismatchedExpectedOwner(t *testing.T) {
	mainPath := setupRepository(t)
	worktreePath := addStandardWorktree(t, mainPath, "task-owner-mismatch")
	if _, err := Claim(ClaimOptions{StartPath: worktreePath, ThreadID: firstThread}); err != nil {
		t.Fatal(err)
	}
	thirdThread := "019f4ef3-8e5f-7f19-b4b4-3f6ff21d0f52"

	_, err := Recover(RecoverOptions{
		ExpectedOwnerThreadID: thirdThread,
		ReplacementThreadID:   secondThread,
		StartPath:             worktreePath,
	})
	if err == nil || !strings.Contains(err.Error(), "no longer matches") {
		t.Fatalf("expected owner mismatch, got %v", err)
	}
	if owner := readWorktreeConfig(worktreePath, ownerConfigKey); owner != firstThread {
		t.Fatalf("mismatched recovery changed owner to %q", owner)
	}
}

func TestRecoverRejectsReplacementOwnerWithAnotherWorktree(t *testing.T) {
	mainPath := setupRepository(t)
	firstPath := addStandardWorktree(t, mainPath, "task-orphaned-owner")
	if _, err := Claim(ClaimOptions{StartPath: firstPath, ThreadID: firstThread}); err != nil {
		t.Fatal(err)
	}
	secondPath := addStandardWorktree(t, mainPath, "task-existing-replacement")
	if _, err := Claim(ClaimOptions{StartPath: secondPath, ThreadID: secondThread}); err != nil {
		t.Fatal(err)
	}

	_, err := Recover(RecoverOptions{
		ExpectedOwnerThreadID: firstThread,
		ReplacementThreadID:   secondThread,
		StartPath:             firstPath,
	})
	if err == nil || !strings.Contains(err.Error(), "already owns worktree") {
		t.Fatalf("expected existing-owner rejection, got %v", err)
	}
	if owner := readWorktreeConfig(firstPath, ownerConfigKey); owner != firstThread {
		t.Fatalf("orphaned owner changed to %q", owner)
	}
}
