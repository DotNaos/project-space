package projectstorage

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func TestAuditMeasuresMainAndRegisteredWorktreesWithoutDoubleCounting(t *testing.T) {
	mainPath := createRepository(t)
	worktreePath := filepath.Join(t.TempDir(), "feature")
	runGit(t, mainPath, "worktree", "add", "-b", "feature/storage", worktreePath, "main")

	sizes := map[string]int64{canonical(t, mainPath): 40, canonical(t, worktreePath): 60}
	report, err := Audit(context.Background(), "github:1", "DotNaos/example", mainPath, Options{
		Meter: func(_ context.Context, path string) (int64, error) { return sizes[canonical(t, path)], nil },
		Now:   func() time.Time { return time.Date(2026, 8, 15, 10, 0, 0, 0, time.UTC) },
	})
	if err != nil {
		t.Fatal(err)
	}
	if !report.Complete || report.MainBytes != 40 || report.WorktreeBytes != 60 || report.TotalBytes != 100 {
		t.Fatalf("report = %#v", report)
	}
	if len(report.Worktrees) != 2 || !report.Worktrees[0].IsMain || report.Worktrees[1].Branch != "feature/storage" {
		t.Fatalf("worktrees = %#v", report.Worktrees)
	}
	if report.Worktrees[1].ID[:3] != "wt_" || report.Worktrees[1].Kind != "external" {
		t.Fatalf("linked worktree = %#v", report.Worktrees[1])
	}
}

func TestAuditMarksSizeFailureIncomplete(t *testing.T) {
	mainPath := createRepository(t)
	report, err := Audit(context.Background(), "github:1", "DotNaos/example", mainPath, Options{
		Meter: func(context.Context, string) (int64, error) { return 0, os.ErrPermission },
	})
	if err != nil {
		t.Fatal(err)
	}
	if report.Complete || len(report.Worktrees) != 1 || report.Worktrees[0].SizeState != "unavailable" {
		t.Fatalf("report = %#v", report)
	}
}

func createRepository(t *testing.T) string {
	t.Helper()
	path := t.TempDir()
	runGit(t, path, "init", "-b", "main")
	runGit(t, path, "config", "user.email", "test@example.com")
	runGit(t, path, "config", "user.name", "Test")
	if err := os.WriteFile(filepath.Join(path, "README.md"), []byte("test\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	runGit(t, path, "add", "README.md")
	runGit(t, path, "commit", "-m", "Initial")
	return canonical(t, path)
}

func runGit(t *testing.T, path string, args ...string) string {
	t.Helper()
	command := exec.Command("git", append([]string{"-C", path}, args...)...)
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, output)
	}
	return string(output)
}

func canonical(t *testing.T, path string) string {
	t.Helper()
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		t.Fatal(err)
	}
	return filepath.Clean(resolved)
}
