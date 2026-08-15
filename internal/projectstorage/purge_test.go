package projectstorage

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestWorktreePurgePlanRequiresCleanManagedInactiveIntegratedEvidence(t *testing.T) {
	mainPath, worktreePath := managedWorktree(t)
	target := auditTarget(t, mainPath, worktreePath)
	if err := os.WriteFile(filepath.Join(worktreePath, ".env"), []byte("local\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	runGit(t, worktreePath, "status", "--short")
	called := false

	plan, err := PlanWorktreePurge(context.Background(), "github:1", "DotNaos/example", mainPath, target.ID, PurgeOptions{
		Meter: fixedMeter(100),
		Checks: []EvidenceCheck{
			func(context.Context, PurgeCandidate) ([]Blocker, error) {
				called = true
				return []Blocker{blocker("codex_thread_active", "The owning Codex task is not archived.")}, nil
			},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if plan.Purgeable || plan.Candidate == nil || plan.Candidate.OwnerThreadID == "" {
		t.Fatalf("plan = %#v", plan)
	}
	codes := summarizeBlockers(plan.Blockers)
	if !strings.Contains(codes, "ignored_local_data") || called {
		t.Fatalf("blockers = %#v called=%v", plan.Blockers, called)
	}
}

func TestWorktreePurgePlanRunsExternalEvidenceAfterLocalGates(t *testing.T) {
	mainPath, worktreePath := managedWorktree(t)
	target := auditTarget(t, mainPath, worktreePath)
	plan, err := PlanWorktreePurge(context.Background(), "github:1", "DotNaos/example", mainPath, target.ID, PurgeOptions{
		Meter: fixedMeter(100),
		Checks: []EvidenceCheck{func(context.Context, PurgeCandidate) ([]Blocker, error) {
			return []Blocker{blocker("codex_thread_active", "The owning Codex task is not archived.")}, nil
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if plan.Purgeable || !strings.Contains(summarizeBlockers(plan.Blockers), "codex_thread_active") {
		t.Fatalf("plan = %#v", plan)
	}
}

func TestStatusBlockersCollapseRepeatedChangeKinds(t *testing.T) {
	blockers := statusBlockers("1 .M N... file-a\n1 M. N... file-b\n? one\n? two\n! .env\n! node_modules/\n")
	if len(blockers) != 3 {
		t.Fatalf("blockers = %#v", blockers)
	}
	summary := summarizeBlockers(blockers)
	for _, code := range []string{"working_tree_changes", "untracked_changes", "ignored_local_data"} {
		if !strings.Contains(summary, code) {
			t.Fatalf("blockers = %#v", blockers)
		}
	}
}

func TestPlanAllWorktreePurgesReportsSafeAndSkippedCounts(t *testing.T) {
	mainPath, _ := managedWorktree(t)
	batch, err := PlanAllWorktreePurges(context.Background(), "github:1", "DotNaos/example", mainPath, PurgeOptions{
		Meter: fixedMeter(100),
	})
	if err != nil {
		t.Fatal(err)
	}
	if batch.PurgeableCount != 1 || batch.SkippedCount != 0 || batch.PurgeableBytes != 100 || len(batch.Plans) != 1 {
		t.Fatalf("batch = %#v", batch)
	}
}

func TestWorktreePurgeRejectsAHeadChangedAfterReview(t *testing.T) {
	mainPath, worktreePath := managedWorktree(t)
	target := auditTarget(t, mainPath, worktreePath)
	if err := os.WriteFile(filepath.Join(worktreePath, "changed.txt"), []byte("new\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	runGit(t, worktreePath, "add", "changed.txt")
	runGit(t, worktreePath, "commit", "-m", "Change head")
	_, err := PurgeWorktree(
		context.Background(), "github:1", "DotNaos/example", mainPath,
		target.ID, target.HeadSHA, PurgeOptions{Checks: passingWorktreeChecks(), Meter: fixedMeter(100)},
	)
	if err == nil || !strings.Contains(err.Error(), "head changed") {
		t.Fatalf("err = %v", err)
	}
}

func TestWorktreePurgeRemovesCheckoutButRetainsBranch(t *testing.T) {
	mainPath, worktreePath := managedWorktree(t)
	if err := os.Mkdir(filepath.Join(worktreePath, "node_modules"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(worktreePath, "node_modules", "cache"), []byte("generated"), 0o600); err != nil {
		t.Fatal(err)
	}
	target := auditTarget(t, mainPath, worktreePath)
	result, err := PurgeWorktree(
		context.Background(), "github:1", "DotNaos/example", mainPath,
		target.ID, target.HeadSHA,
		PurgeOptions{Checks: passingWorktreeChecks(), Meter: fixedMeter(100)},
	)
	if err != nil {
		t.Fatal(err)
	}
	if !result.Verified || result.State != "purged" || !result.FreeSpaceMeasured {
		t.Fatalf("result = %#v", result)
	}
	if _, err := os.Stat(worktreePath); !os.IsNotExist(err) {
		t.Fatalf("worktree still exists: %v", err)
	}
	if strings.TrimSpace(runGit(t, mainPath, "show-ref", "--verify", "refs/heads/feature/storage")) == "" {
		t.Fatal("local branch was not retained")
	}
}

func managedWorktree(t *testing.T) (string, string) {
	t.Helper()
	projects := filepath.Join(t.TempDir(), "projects")
	mainPath := filepath.Join(projects, "example")
	if err := os.MkdirAll(mainPath, 0o700); err != nil {
		t.Fatal(err)
	}
	runGit(t, mainPath, "init", "-b", "main")
	runGit(t, mainPath, "config", "user.email", "test@example.com")
	runGit(t, mainPath, "config", "user.name", "Test")
	if err := os.WriteFile(filepath.Join(mainPath, "README.md"), []byte("test\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(mainPath, ".gitignore"), []byte(".env\nnode_modules\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	runGit(t, mainPath, "add", "README.md", ".gitignore")
	runGit(t, mainPath, "commit", "-m", "Initial")
	runGit(t, mainPath, "config", "extensions.worktreeConfig", "true")
	worktreePath := filepath.Join(projects, ".worktrees", "example", "feature", "storage")
	if err := os.MkdirAll(filepath.Dir(worktreePath), 0o700); err != nil {
		t.Fatal(err)
	}
	runGit(t, mainPath, "worktree", "add", "-b", "feature/storage", worktreePath, "main")
	runGit(t, worktreePath, "config", "--worktree", "project.worktreeManaged", "true")
	runGit(t, worktreePath, "config", "--worktree", "project.codexThreadId", "01a00423-c6b0-7eb0-8050-d829c4801763")
	return canonical(t, mainPath), canonical(t, worktreePath)
}

func auditTarget(t *testing.T, mainPath, worktreePath string) Entry {
	t.Helper()
	report, err := Audit(context.Background(), "github:1", "DotNaos/example", mainPath, Options{Meter: fixedMeter(100)})
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range report.Worktrees {
		if samePath(entry.Path, worktreePath) {
			return entry
		}
	}
	t.Fatal("managed worktree missing from audit")
	return Entry{}
}

func fixedMeter(value int64) Meter {
	return func(context.Context, string) (int64, error) { return value, nil }
}

func passingWorktreeChecks() []EvidenceCheck {
	pass := func(context.Context, PurgeCandidate) ([]Blocker, error) { return nil, nil }
	return []EvidenceCheck{pass, pass, pass}
}
