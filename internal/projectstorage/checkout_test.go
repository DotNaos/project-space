package projectstorage

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCheckoutPurgePlanBlocksLinkedWorktreesBeforeExternalEvidence(t *testing.T) {
	mainPath, _ := managedWorktree(t)
	projectsRoot := filepath.Dir(mainPath)
	called := false
	plan, err := PlanCheckoutPurge(context.Background(), "github:1", "DotNaos/example", mainPath, CheckoutOptions{
		AuthorizedRoot: projectsRoot,
		Checks: []CheckoutEvidenceCheck{func(context.Context, CheckoutCandidate) ([]Blocker, error) {
			called = true
			return []Blocker{blocker("codex_thread_unarchived", "A Codex task still uses the checkout.")}, nil
		}},
		Meter: fixedMeter(100),
	})
	if err != nil {
		t.Fatal(err)
	}
	if plan.Purgeable {
		t.Fatalf("plan = %#v", plan)
	}
	codes := summarizeBlockers(plan.Blockers)
	if !strings.Contains(codes, "linked_worktrees") || called {
		t.Fatalf("blockers = %#v called=%v", plan.Blockers, called)
	}
}

func TestCheckoutPurgePlanRunsExternalEvidenceAfterLocalGates(t *testing.T) {
	projectsRoot, mainPath := reconstructibleCheckout(t)
	plan, err := PlanCheckoutPurge(context.Background(), "github:1", "DotNaos/example", mainPath, CheckoutOptions{
		AuthorizedRoot: projectsRoot, Meter: fixedMeter(100),
		Checks: []CheckoutEvidenceCheck{func(context.Context, CheckoutCandidate) ([]Blocker, error) {
			return []Blocker{blocker("codex_thread_unarchived", "A Codex task still uses the checkout.")}, nil
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if plan.Purgeable || !strings.Contains(summarizeBlockers(plan.Blockers), "codex_thread_unarchived") {
		t.Fatalf("plan = %#v", plan)
	}
}

func TestCheckoutPurgeWritesRecoveryManifestAndRemovesOnlyCheckout(t *testing.T) {
	projectsRoot, mainPath := reconstructibleCheckout(t)
	lockDirectory := filepath.Join(t.TempDir(), "locks")
	recoveryDirectory := filepath.Join(t.TempDir(), "recovery")
	head := strings.TrimSpace(runGit(t, mainPath, "rev-parse", "HEAD"))
	result, err := PurgeCheckout(
		context.Background(), "github:1", "DotNaos/example", mainPath, head,
		CheckoutOptions{
			AuthorizedRoot: projectsRoot, LockDirectory: lockDirectory,
			Checks: passingCheckoutChecks(), Meter: fixedMeter(123), RecoveryDir: recoveryDirectory,
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	if !result.Verified || result.MeasuredBytesRemoved != 123 || !result.FreeSpaceMeasured {
		t.Fatalf("result = %#v", result)
	}
	if _, err := os.Lstat(mainPath); !os.IsNotExist(err) {
		t.Fatalf("checkout still exists: %v", err)
	}
	contents, err := os.ReadFile(result.ManifestPath)
	if err != nil {
		t.Fatal(err)
	}
	manifest := CheckoutRecoveryManifest{}
	if err := json.Unmarshal(contents, &manifest); err != nil {
		t.Fatal(err)
	}
	if manifest.Repository != "DotNaos/example" || manifest.HeadSHA != head || manifest.DefaultRef != "origin/main" ||
		manifest.RemoteURL != "https://github.com/DotNaos/example.git" || manifest.MeasuredBytes != 123 {
		t.Fatalf("manifest = %#v", manifest)
	}
}

func TestCheckoutPurgeBlocksLocalOnlyIgnoredData(t *testing.T) {
	projectsRoot, mainPath := reconstructibleCheckout(t)
	if err := os.WriteFile(filepath.Join(mainPath, ".env"), []byte("secret\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	plan, err := PlanCheckoutPurge(context.Background(), "github:1", "DotNaos/example", mainPath, CheckoutOptions{
		AuthorizedRoot: projectsRoot, Meter: fixedMeter(100),
	})
	if err != nil {
		t.Fatal(err)
	}
	if plan.Purgeable || !strings.Contains(summarizeBlockers(plan.Blockers), "ignored_local_data") {
		t.Fatalf("plan = %#v", plan)
	}
}

func TestCheckoutPurgeBlocksCustomLocalRepositoryConfiguration(t *testing.T) {
	projectsRoot, mainPath := reconstructibleCheckout(t)
	runGit(t, mainPath, "config", "custom.machine-setting", "keep-me")
	plan, err := PlanCheckoutPurge(context.Background(), "github:1", "DotNaos/example", mainPath, CheckoutOptions{
		AuthorizedRoot: projectsRoot, Meter: fixedMeter(100),
	})
	if err != nil {
		t.Fatal(err)
	}
	if plan.Purgeable || !strings.Contains(summarizeBlockers(plan.Blockers), "local_repository_config") {
		t.Fatalf("plan = %#v", plan)
	}
}

func TestCheckoutPurgeRejectsAHeadChangedAfterReview(t *testing.T) {
	projectsRoot, mainPath := reconstructibleCheckout(t)
	oldHead := strings.TrimSpace(runGit(t, mainPath, "rev-parse", "HEAD"))
	if err := os.WriteFile(filepath.Join(mainPath, "next.txt"), []byte("next\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	runGit(t, mainPath, "add", "next.txt")
	runGit(t, mainPath, "-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-m", "Next")
	_, err := PurgeCheckout(
		context.Background(), "github:1", "DotNaos/example", mainPath, oldHead,
		CheckoutOptions{
			AuthorizedRoot: projectsRoot, LockDirectory: filepath.Join(t.TempDir(), "locks"),
			Checks: passingCheckoutChecks(), Meter: fixedMeter(100), RecoveryDir: filepath.Join(t.TempDir(), "recovery"),
		},
	)
	if err == nil || !strings.Contains(err.Error(), "head changed") {
		t.Fatalf("err = %v", err)
	}
}

func reconstructibleCheckout(t *testing.T) (string, string) {
	t.Helper()
	root := t.TempDir()
	projectsRoot := filepath.Join(root, "projects")
	mainPath := filepath.Join(projectsRoot, "example")
	remotePath := filepath.Join(root, "remote.git")
	if err := os.MkdirAll(mainPath, 0o700); err != nil {
		t.Fatal(err)
	}
	runGit(t, root, "init", "--bare", remotePath)
	runGit(t, mainPath, "init", "-b", "main")
	if err := os.WriteFile(filepath.Join(mainPath, ".gitignore"), []byte(".env\nnode_modules\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(mainPath, "README.md"), []byte("test\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	runGit(t, mainPath, "add", ".")
	runGit(t, mainPath, "-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-m", "Initial")
	runGit(t, mainPath, "remote", "add", "origin", remotePath)
	runGit(t, mainPath, "push", "-u", "origin", "main")
	runGit(t, remotePath, "symbolic-ref", "HEAD", "refs/heads/main")
	runGit(t, mainPath, "remote", "set-head", "origin", "--auto")
	return canonical(t, projectsRoot), canonical(t, mainPath)
}

func passingCheckoutChecks() []CheckoutEvidenceCheck {
	pass := func(context.Context, CheckoutCandidate) ([]Blocker, error) { return nil, nil }
	return []CheckoutEvidenceCheck{pass, pass, pass}
}
