package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDiscoverLocalProjectPathsRequiresExactGitHubOrigin(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	projects := filepath.Join(home, "projects")
	valid := filepath.Join(projects, "project-space")
	wrong := filepath.Join(projects, "wrong")
	plain := filepath.Join(projects, "plain")
	for _, path := range []string{valid, wrong, plain} {
		if err := os.MkdirAll(path, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	testStorageGit(t, valid, "init", "-b", "main")
	testStorageGit(t, valid, "remote", "add", "origin", "git@github.com:DotNaos/project-space.git")
	testStorageGit(t, wrong, "init", "-b", "main")
	testStorageGit(t, wrong, "remote", "add", "origin", "https://example.com/DotNaos/wrong.git")

	discovered, err := discoverLocalProjectPaths(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	paths := discovered["dotnaos/project-space"]
	canonical, err := filepath.EvalSymlinks(valid)
	if err != nil {
		t.Fatal(err)
	}
	if len(paths) != 1 || paths[0] != canonical {
		t.Fatalf("discovered = %#v", discovered)
	}
	if _, exists := discovered["dotnaos/wrong"]; exists {
		t.Fatalf("non-GitHub origin was accepted: %#v", discovered)
	}
}

func testStorageGit(t *testing.T, directory string, args ...string) string {
	t.Helper()
	output, err := commandOutput(context.Background(), directory, "git", args...)
	if err != nil {
		t.Fatalf("git %s: %v", strings.Join(args, " "), err)
	}
	return output
}
