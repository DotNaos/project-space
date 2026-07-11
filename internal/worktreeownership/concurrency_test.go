package worktreeownership

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

type ownershipOutcome struct {
	result Result
	err    error
}

func TestSameThreadCannotClaimSecondWorktree(t *testing.T) {
	mainPath := setupRepository(t)
	firstPath := addStandardWorktree(t, mainPath, "task-first-claim")
	secondPath := addStandardWorktree(t, mainPath, "task-second-claim")
	if _, err := Claim(ClaimOptions{StartPath: firstPath, ThreadID: firstThread}); err != nil {
		t.Fatal(err)
	}

	_, err := Claim(ClaimOptions{StartPath: secondPath, ThreadID: firstThread})
	if err == nil || !strings.Contains(err.Error(), firstPath) {
		t.Fatalf("expected conflict pointing to %s, got %v", firstPath, err)
	}
	if owner := readWorktreeConfig(secondPath, ownerConfigKey); owner != "" {
		t.Fatalf("second worktree was unexpectedly assigned to %q", owner)
	}
}

func TestConcurrentSameThreadClaimsExactlyOneWorktree(t *testing.T) {
	mainPath := setupRepository(t)
	paths := []string{
		addStandardWorktree(t, mainPath, "task-concurrent-first"),
		addStandardWorktree(t, mainPath, "task-concurrent-second"),
	}
	outcomes := make(chan ownershipOutcome, len(paths))
	start := make(chan struct{})
	var wait sync.WaitGroup
	for _, path := range paths {
		path := path
		wait.Add(1)
		go func() {
			defer wait.Done()
			<-start
			result, err := Claim(ClaimOptions{StartPath: path, ThreadID: firstThread})
			outcomes <- ownershipOutcome{result: result, err: err}
		}()
	}
	close(start)
	wait.Wait()
	close(outcomes)

	winners := 0
	winnerPath := ""
	for outcome := range outcomes {
		if outcome.err == nil {
			winners++
			winnerPath = outcome.result.Path
			continue
		}
		if !strings.Contains(outcome.err.Error(), "already owns worktree") {
			t.Fatalf("unexpected losing claim error: %v", outcome.err)
		}
	}
	if winners != 1 {
		t.Fatalf("got %d successful claims, want exactly one", winners)
	}
	if owners := managedOwnerPaths(t, mainPath, firstThread); len(owners) != 1 || owners[0] != winnerPath {
		t.Fatalf("unexpected final owners: %v, winner %s", owners, winnerPath)
	}
}

func TestPrepareAfterClaimReusesClaimedWorktree(t *testing.T) {
	mainPath := setupRepository(t)
	claimedPath := addStandardWorktree(t, mainPath, "task-claimed-before-prepare")
	if _, err := Claim(ClaimOptions{StartPath: claimedPath, ThreadID: firstThread}); err != nil {
		t.Fatal(err)
	}
	before := len(listWorktreesForTest(t, mainPath))

	result, err := Prepare(PrepareOptions{
		StartPath: mainPath,
		TaskName:  "a later task in the same chat",
		ThreadID:  firstThread,
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != "ready" || result.Path != claimedPath {
		t.Fatalf("unexpected reused result: %#v", result)
	}
	if after := len(listWorktreesForTest(t, mainPath)); after != before {
		t.Fatalf("prepare created an extra worktree: before=%d after=%d", before, after)
	}
}

func TestConcurrentPreparesLeaveOneOwnedWorktree(t *testing.T) {
	mainPath := setupRepository(t)
	tasks := []string{"first concurrent task", "second concurrent task"}
	outcomes := make(chan ownershipOutcome, len(tasks))
	start := make(chan struct{})
	var wait sync.WaitGroup
	for _, task := range tasks {
		task := task
		wait.Add(1)
		go func() {
			defer wait.Done()
			<-start
			result, err := Prepare(PrepareOptions{StartPath: mainPath, TaskName: task, ThreadID: firstThread})
			outcomes <- ownershipOutcome{result: result, err: err}
		}()
	}
	close(start)
	wait.Wait()
	close(outcomes)

	successes := 0
	resultPath := ""
	for outcome := range outcomes {
		if outcome.err != nil {
			t.Fatalf("concurrent prepare failed: %v", outcome.err)
		}
		successes++
		if resultPath == "" {
			resultPath = outcome.result.Path
		} else if outcome.result.Path != resultPath {
			t.Fatalf("successful prepares returned different paths: %s and %s", resultPath, outcome.result.Path)
		}
	}
	if successes != 2 {
		t.Fatalf("got %d successful prepares, want both", successes)
	}
	owners := managedOwnerPaths(t, mainPath, firstThread)
	if len(owners) != 1 || owners[0] != resultPath {
		t.Fatalf("unexpected final owners: %v, result path %s", owners, resultPath)
	}
	if worktrees := listWorktreesForTest(t, mainPath); len(worktrees) != 2 {
		t.Fatalf("unused worktree was not cleaned up: %#v", worktrees)
	}
}

func TestPrepareRecoversPartialOwnerWithoutCreatingAnotherWorktree(t *testing.T) {
	mainPath := setupRepository(t)
	partialPath := addStandardWorktree(t, mainPath, "task-partial-owner")
	otherPath := addStandardWorktree(t, mainPath, "task-other-unowned")
	command(t, mainPath, "git", "config", "extensions.worktreeConfig", "true")
	command(t, partialPath, "git", "config", "--worktree", ownerConfigKey, firstThread)
	before := len(listWorktreesForTest(t, mainPath))

	result, err := Prepare(PrepareOptions{StartPath: mainPath, TaskName: "new task", ThreadID: firstThread})
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != "ready" || result.Path != partialPath {
		t.Fatalf("partial owner was not recovered: %#v", result)
	}
	if managed := readWorktreeConfig(partialPath, managedConfigKey); managed != "true" {
		t.Fatalf("partial owner was not completed: managed=%q", managed)
	}
	if after := len(listWorktreesForTest(t, mainPath)); after != before {
		t.Fatalf("recovery created an extra worktree: before=%d after=%d", before, after)
	}
	if _, err := Claim(ClaimOptions{StartPath: otherPath, ThreadID: firstThread}); err == nil || !strings.Contains(err.Error(), partialPath) {
		t.Fatalf("second claim did not respect recovered owner: %v", err)
	}
}

func TestClaimRecoversItsOwnPartialOwner(t *testing.T) {
	mainPath := setupRepository(t)
	partialPath := addStandardWorktree(t, mainPath, "task-partial-claim")
	command(t, mainPath, "git", "config", "extensions.worktreeConfig", "true")
	command(t, partialPath, "git", "config", "--worktree", ownerConfigKey, firstThread)

	result, err := Claim(ClaimOptions{StartPath: partialPath, ThreadID: firstThread})
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != "claimed" || readWorktreeConfig(partialPath, managedConfigKey) != "true" {
		t.Fatalf("partial claim was not completed: %#v", result)
	}
}

func TestUnreadableOwnershipConfigurationFailsClosed(t *testing.T) {
	mainPath := setupRepository(t)
	worktreePath := addStandardWorktree(t, mainPath, "task-invalid-config")
	gitDirectory := commandOutput(t, worktreePath, "git", "rev-parse", "--path-format=absolute", "--git-dir")
	if err := os.WriteFile(filepath.Join(gitDirectory, "config.worktree"), []byte("[invalid\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	before := len(listWorktreesForTest(t, mainPath))

	_, err := Prepare(PrepareOptions{StartPath: mainPath, TaskName: "must not start", ThreadID: firstThread})
	if err == nil || !strings.Contains(err.Error(), "read worktree configuration") {
		t.Fatalf("expected configuration read failure, got %v", err)
	}
	if after := len(listWorktreesForTest(t, mainPath)); after != before {
		t.Fatalf("config read failure created an extra worktree: before=%d after=%d", before, after)
	}
}

func TestConcurrentPrepareAndClaimLeaveOneOwner(t *testing.T) {
	mainPath := setupRepository(t)
	claimPath := addStandardWorktree(t, mainPath, "task-concurrent-claim-target")
	outcomes := make(chan ownershipOutcome, 2)
	start := make(chan struct{})
	var wait sync.WaitGroup
	wait.Add(2)
	go func() {
		defer wait.Done()
		<-start
		result, err := Claim(ClaimOptions{StartPath: claimPath, ThreadID: firstThread})
		outcomes <- ownershipOutcome{result: result, err: err}
	}()
	go func() {
		defer wait.Done()
		<-start
		result, err := Prepare(PrepareOptions{StartPath: mainPath, TaskName: "concurrent prepare", ThreadID: firstThread})
		outcomes <- ownershipOutcome{result: result, err: err}
	}()
	close(start)
	wait.Wait()
	close(outcomes)

	successes := 0
	resultPath := ""
	for outcome := range outcomes {
		if outcome.err != nil {
			if !strings.Contains(outcome.err.Error(), "already owns worktree") {
				t.Fatalf("unexpected concurrency error: %v", outcome.err)
			}
			continue
		}
		successes++
		if resultPath == "" {
			resultPath = outcome.result.Path
		} else if outcome.result.Path != resultPath {
			t.Fatalf("successful operations returned different owners: %s and %s", resultPath, outcome.result.Path)
		}
	}
	if successes == 0 {
		t.Fatal("both ownership operations failed")
	}
	if owners := managedOwnerPaths(t, mainPath, firstThread); len(owners) != 1 || owners[0] != resultPath {
		t.Fatalf("unexpected final owners: %v, result path %s", owners, resultPath)
	}
}

func TestDuplicateConfiguredOwnershipFailsClosed(t *testing.T) {
	mainPath := setupRepository(t)
	firstPath := addStandardWorktree(t, mainPath, "task-legacy-first")
	secondPath := addStandardWorktree(t, mainPath, "task-legacy-second")
	command(t, mainPath, "git", "config", "extensions.worktreeConfig", "true")
	if err := configureOwnership(firstPath, firstThread, "legacy first", 0); err != nil {
		t.Fatal(err)
	}
	if err := configureOwnership(secondPath, firstThread, "legacy second", 0); err != nil {
		t.Fatal(err)
	}

	for name, run := range map[string]func() error{
		"check": func() error {
			_, err := Check(CheckOptions{StartPath: firstPath, ThreadID: firstThread})
			return err
		},
		"claim": func() error {
			_, err := Claim(ClaimOptions{StartPath: firstPath, ThreadID: firstThread})
			return err
		},
		"prepare": func() error {
			_, err := Prepare(PrepareOptions{StartPath: mainPath, TaskName: "next", ThreadID: firstThread})
			return err
		},
	} {
		err := run()
		if err == nil || !strings.Contains(err.Error(), "multiple worktrees") {
			t.Fatalf("%s did not fail closed: %v", name, err)
		}
	}
}

func TestRemovedOwnedWorktreeDoesNotBlockReplacement(t *testing.T) {
	mainPath := setupRepository(t)
	first, err := Prepare(PrepareOptions{StartPath: mainPath, TaskName: "temporary", ThreadID: firstThread})
	if err != nil {
		t.Fatal(err)
	}
	command(t, mainPath, "git", "worktree", "remove", "--force", first.Path)
	command(t, mainPath, "git", "branch", "-D", first.Branch)

	replacement, err := Prepare(PrepareOptions{StartPath: mainPath, TaskName: "replacement", ThreadID: firstThread})
	if err != nil {
		t.Fatal(err)
	}
	if replacement.Status != "created" || replacement.Path == first.Path {
		t.Fatalf("unexpected replacement: old=%#v new=%#v", first, replacement)
	}
}

func managedOwnerPaths(t *testing.T, mainPath string, threadID string) []string {
	t.Helper()
	entries := listWorktreesForTest(t, mainPath)
	paths := make([]string, 0, len(entries))
	for _, entry := range entries {
		if readWorktreeConfig(entry.path, managedConfigKey) == "true" &&
			readWorktreeConfig(entry.path, ownerConfigKey) == threadID {
			paths = append(paths, entry.path)
		}
	}
	return paths
}

func listWorktreesForTest(t *testing.T, path string) []worktree {
	t.Helper()
	entries, err := listWorktrees(path)
	if err != nil {
		t.Fatal(err)
	}
	return entries
}
