package snapshot

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestFetchTemplateFromGitCachesByCommit(t *testing.T) {
	remoteRoot := writeGitTemplateRepository(t)
	cacheRoot := filepath.Join(t.TempDir(), "cache")

	source, err := FetchTemplateFromGit(remoteRoot, "v0.2.0", cacheRoot, "owner", "project-template")
	if err != nil {
		t.Fatalf("FetchTemplateFromGit returned error: %v", err)
	}
	if source.Root == "" || source.Commit == "" || !source.Fetched {
		t.Fatalf("unexpected fetch source: %#v", source)
	}
	if !HasTemplateManifest(source.Root) {
		t.Fatalf("cached template root is missing manifest: %s", source.Root)
	}
	wantCommit := strings.TrimSpace(runGitTest(t, remoteRoot, "rev-parse", "v0.2.0"))
	if source.Commit != wantCommit {
		t.Fatalf("commit = %q, want %q", source.Commit, wantCommit)
	}

	if err := os.RemoveAll(remoteRoot); err != nil {
		t.Fatal(err)
	}
	cached, err := FetchTemplateFromGit(remoteRoot, source.Commit, cacheRoot, "owner", "project-template")
	if err != nil {
		t.Fatalf("cached fetch returned error: %v", err)
	}
	if cached.Root != source.Root || cached.Commit != source.Commit {
		t.Fatalf("cached source = %#v, want root %s commit %s", cached, source.Root, source.Commit)
	}
}

func TestSplitTemplateRepositoryRequiresOwnerRepo(t *testing.T) {
	if _, _, err := SplitTemplateRepository("DotNaos/project-template"); err != nil {
		t.Fatalf("valid repository rejected: %v", err)
	}
	for _, value := range []string{"project-template", "../bad/repo", "owner/repo/extra", "owner/bad repo"} {
		if _, _, err := SplitTemplateRepository(value); err == nil {
			t.Fatalf("repository %q was accepted", value)
		}
	}
}

func writeGitTemplateRepository(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	runGitTest(t, root, "init", ".")
	runGitTest(t, root, "config", "user.email", "test@example.com")
	runGitTest(t, root, "config", "user.name", "Test User")
	mustWriteFile(t, filepath.Join(root, ".templateignore"), ".templateignore\ntemplate/**\n")
	mustWriteFile(t, filepath.Join(root, "template", "manifest.yaml"), "name: project-template\nversion: 0.2.0\nmodules:\n  - modules/core.yaml\n")
	mustWriteFile(t, filepath.Join(root, "template", "modules", "core.yaml"), "name: core.fullstack\ndescription: Core test module.\ndefault: true\nvalues:\n  project.slug:\n    type: string\n    required: true\nowns:\n  - README.md\n")
	mustWriteFile(t, filepath.Join(root, "README.md.template"), "# {{ project.slug }}\n")
	runGitTest(t, root, "add", ".")
	runGitTest(t, root, "commit", "-m", "initial template")
	runGitTest(t, root, "tag", "v0.2.0")
	return root
}

func runGitTest(t *testing.T, workDir string, args ...string) string {
	t.Helper()
	output, err := GitOutput(workDir, args...)
	if err != nil {
		t.Fatalf("git %s failed: %v", strings.Join(args, " "), err)
	}
	return output
}

func mustWriteFile(t *testing.T, path string, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}
