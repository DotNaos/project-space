package main

import "testing"

func TestGitHubRepositoryRef(t *testing.T) {
	tests := map[string]string{
		"https://github.com/DotNaos/example":     "DotNaos/example",
		"https://github.com/DotNaos/example.git": "DotNaos/example",
	}
	for input, want := range tests {
		got, err := githubRepositoryRef(input)
		if err != nil {
			t.Fatalf("githubRepositoryRef(%q) returned error: %v", input, err)
		}
		if got != want {
			t.Fatalf("githubRepositoryRef(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestGitHubRepositoryRefRejectsUnsupportedURLs(t *testing.T) {
	if _, err := githubRepositoryRef("https://example.com/DotNaos/example"); err == nil {
		t.Fatal("expected unsupported host error")
	}
	if _, err := githubRepositoryRef("https://github.com/DotNaos"); err == nil {
		t.Fatal("expected unsupported path error")
	}
}

func TestGitHubRepositoryName(t *testing.T) {
	got, err := githubRepositoryName("/tmp/my-app")
	if err != nil {
		t.Fatalf("githubRepositoryName returned error: %v", err)
	}
	if got != "my-app" {
		t.Fatalf("githubRepositoryName = %q, want my-app", got)
	}
}

func TestGitHubRepositoryVisibilityFlag(t *testing.T) {
	tests := map[string]string{
		"":        "--private",
		"private": "--private",
		"public":  "--public",
	}
	for input, want := range tests {
		if got := githubRepositoryVisibilityFlag(input); got != want {
			t.Fatalf("githubRepositoryVisibilityFlag(%q) = %q, want %q", input, got, want)
		}
	}
}
