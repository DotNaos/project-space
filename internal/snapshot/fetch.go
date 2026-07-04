package snapshot

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

type Source struct {
	Root    string
	Commit  string
	Fetched bool
}

func FetchTemplate(template string, version string, commit string) (Source, error) {
	owner, repo, err := SplitTemplateRepository(template)
	if err != nil {
		return Source{}, err
	}
	cacheRoot, err := templateCacheRoot()
	if err != nil {
		return Source{}, err
	}
	ref := templateFetchRef(version, commit)
	remoteURL := "https://github.com/" + owner + "/" + repo + ".git"
	return FetchTemplateFromGit(remoteURL, ref, cacheRoot, owner, repo)
}

func FetchTemplateFromGit(remoteURL string, ref string, cacheRoot string, owner string, repo string) (Source, error) {
	parent := filepath.Join(cacheRoot, owner, repo)
	if err := os.MkdirAll(parent, 0o755); err != nil {
		return Source{}, err
	}
	if ref != "" && isLikelyCommit(ref) {
		cached := filepath.Join(parent, ref)
		if HasTemplateManifest(cached) {
			return Source{Root: cached, Commit: ref, Fetched: true}, nil
		}
	}
	tempRoot, err := os.MkdirTemp(parent, ".tmp-")
	if err != nil {
		return Source{}, err
	}
	if err := os.RemoveAll(tempRoot); err != nil {
		return Source{}, err
	}
	defer os.RemoveAll(tempRoot)
	if err := cloneTemplateRemote(remoteURL, ref, tempRoot); err != nil {
		return Source{}, err
	}
	commit, err := GitOutput(tempRoot, "rev-parse", "HEAD")
	if err != nil {
		return Source{}, err
	}
	commit = strings.TrimSpace(commit)
	targetRoot := filepath.Join(parent, commit)
	if HasTemplateManifest(targetRoot) {
		return Source{Root: targetRoot, Commit: commit, Fetched: true}, nil
	}
	if err := os.Rename(tempRoot, targetRoot); err != nil {
		if HasTemplateManifest(targetRoot) {
			return Source{Root: targetRoot, Commit: commit, Fetched: true}, nil
		}
		return Source{}, err
	}
	return Source{Root: targetRoot, Commit: commit, Fetched: true}, nil
}

func HasTemplateManifest(templateRoot string) bool {
	_, err := os.Stat(filepath.Join(templateRoot, "template", "manifest.yaml"))
	return err == nil
}

func cloneTemplateRemote(remoteURL string, ref string, targetRoot string) error {
	args := []string{"clone", "--depth", "1"}
	if ref != "" {
		args = append(args, "--branch", ref)
	}
	args = append(args, remoteURL, targetRoot)
	if err := gitCommand("", args...); err == nil {
		return nil
	}
	if err := os.RemoveAll(targetRoot); err != nil {
		return err
	}
	if err := gitCommand("", "clone", remoteURL, targetRoot); err != nil {
		return err
	}
	if ref != "" {
		return gitCommand(targetRoot, "checkout", ref)
	}
	return nil
}

func templateCacheRoot() (string, error) {
	if value := os.Getenv("PROJECT_SPACE_TEMPLATE_CACHE"); value != "" {
		return filepath.Abs(value)
	}
	cacheDir, err := os.UserCacheDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(cacheDir, "project-space", "templates"), nil
}

func templateFetchRef(version string, commit string) string {
	if commit != "" && commit != "local" {
		return commit
	}
	if version != "" && version != "local" {
		return version
	}
	return ""
}

func SplitTemplateRepository(template string) (string, string, error) {
	parts := strings.Split(template, "/")
	if len(parts) != 2 || !safeRepositoryPart(parts[0]) || !safeRepositoryPart(parts[1]) {
		return "", "", fmt.Errorf("template %q must be a GitHub repository in owner/repo form", template)
	}
	return parts[0], parts[1], nil
}

func safeRepositoryPart(value string) bool {
	if value == "" || value == "." || value == ".." {
		return false
	}
	for _, char := range value {
		if (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') || (char >= '0' && char <= '9') || char == '-' || char == '_' || char == '.' {
			continue
		}
		return false
	}
	return true
}

func isLikelyCommit(value string) bool {
	if len(value) < 7 {
		return false
	}
	for _, char := range value {
		if (char >= 'a' && char <= 'f') || (char >= 'A' && char <= 'F') || (char >= '0' && char <= '9') {
			continue
		}
		return false
	}
	return true
}

func GitOutput(workDir string, args ...string) (string, error) {
	command := exec.Command("git", args...)
	if workDir != "" {
		command.Dir = workDir
	}
	output, err := command.Output()
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			return "", fmt.Errorf("git %s: %s", strings.Join(args, " "), strings.TrimSpace(string(exitErr.Stderr)))
		}
		return "", err
	}
	return string(output), nil
}

func gitCommand(workDir string, args ...string) error {
	_, err := GitOutput(workDir, args...)
	return err
}
