package worktreeownership

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

const (
	threadA = "019f49e1-cc3d-7243-bc12-75c74c786457"
	threadB = "019f4ee7-3d3b-7473-9a19-23aaa8a9c886"
)

func TestPrepareClaimsAndConfirmsLinkedWorktree(t *testing.T) {
	_, worktree := createRepositoryWithWorktree(t, "feature-owner")
	fixedTime := time.Date(2026, time.July, 11, 2, 30, 0, 0, time.UTC)

	claimed, err := Prepare(context.Background(), Options{
		Directory: worktree,
		ThreadID:  threadA,
		Now:       func() time.Time { return fixedTime },
	})
	if err != nil {
		t.Fatalf("claim worktree: %v", err)
	}
	if claimed.Ownership != OwnershipClaimed {
		t.Fatalf("ownership = %q, want %q", claimed.Ownership, OwnershipClaimed)
	}
	if claimed.ThreadID != threadA || claimed.ClaimedAt != fixedTime.Format(time.RFC3339) {
		t.Fatalf("unexpected claim result: %#v", claimed)
	}
	record := readClaimForTest(t, worktree)
	if record.ThreadID != threadA {
		t.Fatalf("owner = %q, want %q", record.ThreadID, threadA)
	}
	gitDirectory := runGit(t, worktree, "rev-parse", "--path-format=absolute", "--git-dir")
	info, err := os.Stat(claimPath(gitDirectory))
	if err != nil {
		t.Fatalf("stat claim: %v", err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("claim permissions = %v, want 0600", info.Mode().Perm())
	}
	if status := runGit(t, worktree, "status", "--porcelain"); status != "" {
		t.Fatalf("claim dirtied worktree: %q", status)
	}

	confirmed, err := Prepare(context.Background(), Options{
		Directory: worktree,
		ThreadID:  threadA,
		Now:       func() time.Time { return fixedTime.Add(time.Hour) },
	})
	if err != nil {
		t.Fatalf("confirm worktree: %v", err)
	}
	if confirmed.Ownership != OwnershipConfirmed {
		t.Fatalf("ownership = %q, want %q", confirmed.Ownership, OwnershipConfirmed)
	}
	if confirmed.ClaimedAt != fixedTime.Format(time.RFC3339) {
		t.Fatalf("confirmed claim time changed: %q", confirmed.ClaimedAt)
	}
}

func TestPrepareRejectsDifferentOwnerWithoutChangingIt(t *testing.T) {
	_, worktree := createRepositoryWithWorktree(t, "feature-conflict")
	if _, err := Prepare(context.Background(), Options{Directory: worktree, ThreadID: threadA}); err != nil {
		t.Fatalf("initial claim: %v", err)
	}

	_, err := Prepare(context.Background(), Options{Directory: worktree, ThreadID: threadB})
	var conflict *OwnerConflictError
	if !errors.As(err, &conflict) {
		t.Fatalf("error = %v, want OwnerConflictError", err)
	}
	if conflict.OwnerThreadID != threadA || conflict.CurrentThreadID != threadB {
		t.Fatalf("unexpected conflict: %#v", conflict)
	}
	if owner := readClaimForTest(t, worktree).ThreadID; owner != threadA {
		t.Fatalf("owner changed to %q", owner)
	}
}

func TestPrepareRequiresPersistentThreadBeforeAnyClaim(t *testing.T) {
	_, err := Prepare(context.Background(), Options{Directory: t.TempDir()})
	if err == nil || !strings.Contains(err.Error(), "no persistent Codex thread") {
		t.Fatalf("error = %v, want persistent-thread guidance", err)
	}

	_, err = Prepare(context.Background(), Options{Directory: t.TempDir(), ThreadID: "not-a-thread"})
	if err == nil || !strings.Contains(err.Error(), "not a valid persistent Codex thread ID") {
		t.Fatalf("error = %v, want invalid-thread guidance", err)
	}
}

func TestPrepareRejectsSharedMainWorktreeWithoutMutatingGitConfig(t *testing.T) {
	repository := createRepository(t)

	_, err := Prepare(context.Background(), Options{Directory: repository, ThreadID: threadA})
	if err == nil || !strings.Contains(err.Error(), "shared main worktree") {
		t.Fatalf("error = %v, want main-worktree guidance", err)
	}
	gitDirectory := runGit(t, repository, "rev-parse", "--path-format=absolute", "--git-dir")
	if _, stateErr := os.Stat(claimPath(gitDirectory)); !errors.Is(stateErr, os.ErrNotExist) {
		t.Fatalf("main rejection unexpectedly created ownership state: %v", stateErr)
	}
}

func TestPrepareDoesNotReplaceInvalidExistingOwnership(t *testing.T) {
	_, worktree := createRepositoryWithWorktree(t, "feature-invalid-owner")
	gitDirectory := runGit(t, worktree, "rev-parse", "--path-format=absolute", "--git-dir")
	path := claimPath(gitDirectory)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatalf("create state directory: %v", err)
	}
	if err := os.WriteFile(path, []byte("{invalid\n"), 0o600); err != nil {
		t.Fatalf("write invalid state: %v", err)
	}

	_, err := Prepare(context.Background(), Options{Directory: worktree, ThreadID: threadA})
	if err == nil || !strings.Contains(err.Error(), "metadata is invalid") {
		t.Fatalf("error = %v, want invalid-metadata guidance", err)
	}
	contents, readErr := os.ReadFile(path)
	if readErr != nil || string(contents) != "{invalid\n" {
		t.Fatalf("invalid ownership was replaced: contents=%q error=%v", contents, readErr)
	}
}

func TestConcurrentClaimsProduceOneOwnerAndOneConflict(t *testing.T) {
	_, worktree := createRepositoryWithWorktree(t, "feature-race")
	type outcome struct {
		result Result
		err    error
	}
	start := make(chan struct{})
	outcomes := make(chan outcome, 2)
	var wait sync.WaitGroup
	for _, threadID := range []string{threadA, threadB} {
		wait.Add(1)
		go func() {
			defer wait.Done()
			<-start
			result, err := Prepare(context.Background(), Options{Directory: worktree, ThreadID: threadID})
			outcomes <- outcome{result: result, err: err}
		}()
	}
	close(start)
	wait.Wait()
	close(outcomes)

	claimed := 0
	conflicted := 0
	for outcome := range outcomes {
		if outcome.err == nil && outcome.result.Ownership == OwnershipClaimed {
			claimed++
			continue
		}
		var conflict *OwnerConflictError
		if errors.As(outcome.err, &conflict) {
			conflicted++
			continue
		}
		t.Fatalf("unexpected concurrent outcome: result=%#v error=%v", outcome.result, outcome.err)
	}
	if claimed != 1 || conflicted != 1 {
		t.Fatalf("claimed=%d conflicted=%d, want one each", claimed, conflicted)
	}
}

func createRepositoryWithWorktree(t *testing.T, branch string) (string, string) {
	t.Helper()
	repository := createRepository(t)
	worktree := filepath.Join(t.TempDir(), branch)
	runGit(t, repository, "worktree", "add", "-b", branch, worktree)
	return repository, worktree
}

func readClaimForTest(t *testing.T, worktree string) claimRecord {
	t.Helper()
	gitDirectory := runGit(t, worktree, "rev-parse", "--path-format=absolute", "--git-dir")
	record, exists, err := readClaim(gitDirectory)
	if err != nil {
		t.Fatalf("read claim: %v", err)
	}
	if !exists {
		t.Fatal("claim does not exist")
	}
	return record
}

func createRepository(t *testing.T) string {
	t.Helper()
	repository := t.TempDir()
	runGit(t, repository, "init", "--initial-branch=main")
	runGit(t, repository, "config", "user.email", "codex@example.test")
	runGit(t, repository, "config", "user.name", "Codex Test")
	if err := os.WriteFile(filepath.Join(repository, "README.md"), []byte("test\n"), 0o600); err != nil {
		t.Fatalf("write fixture: %v", err)
	}
	runGit(t, repository, "add", "README.md")
	runGit(t, repository, "commit", "-m", "Initial commit")
	return repository
}

func runGit(t *testing.T, directory string, args ...string) string {
	t.Helper()
	commandArgs := append([]string{"-C", directory}, args...)
	command := exec.Command("git", commandArgs...)
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, output)
	}
	return strings.TrimSpace(string(output))
}
