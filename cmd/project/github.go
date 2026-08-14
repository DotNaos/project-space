package main

import (
	"bytes"
	"errors"
	"fmt"
	"net/url"
	"os/exec"
	"path/filepath"
	"strings"
)

type createGitHubRepositoryOptions struct {
	Visibility string
}

type createGitHubRepositoryResult struct {
	URL string
}

func createGitHubRepository(projectRoot string, options createGitHubRepositoryOptions) (createGitHubRepositoryResult, error) {
	repoName, err := githubRepositoryName(projectRoot)
	if err != nil {
		return createGitHubRepositoryResult{}, err
	}
	if _, err := exec.LookPath("gh"); err != nil {
		return createGitHubRepositoryResult{}, errors.New("gh is required for --github")
	}
	if _, err := exec.LookPath("git"); err != nil {
		return createGitHubRepositoryResult{}, errors.New("git is required for --github")
	}
	output, err := runCommand("", nil, "gh", "repo", "create", repoName, githubRepositoryVisibilityFlag(options.Visibility))
	if err != nil {
		return createGitHubRepositoryResult{}, fmt.Errorf("create GitHub repository: %w", err)
	}
	repoURL := firstNonEmptyLine(output)
	if repoURL == "" {
		repoURL, err = repositoryURL(repoName)
		if err != nil {
			return createGitHubRepositoryResult{}, err
		}
	}
	if err := initializeAndPushRepository(projectRoot, repoURL); err != nil {
		return createGitHubRepositoryResult{}, err
	}
	return createGitHubRepositoryResult{URL: repoURL}, nil
}

func githubRepositoryVisibilityFlag(visibility string) string {
	if visibility == "public" {
		return "--public"
	}
	return "--private"
}

func githubRepositoryName(projectRoot string) (string, error) {
	name := filepath.Base(filepath.Clean(projectRoot))
	if name == "" || name == "." || name == string(filepath.Separator) {
		return "", fmt.Errorf("cannot derive GitHub repository name from %q", projectRoot)
	}
	return name, nil
}

func repositoryURL(repoName string) (string, error) {
	output, err := runCommand("", nil, "gh", "repo", "view", repoName, "--json", "url", "--jq", ".url")
	if err != nil {
		return "", fmt.Errorf("read GitHub repository URL: %w", err)
	}
	repoURL := firstNonEmptyLine(output)
	if repoURL == "" {
		return "", errors.New("GitHub repository URL was empty")
	}
	return repoURL, nil
}

func initializeAndPushRepository(projectRoot string, repoURL string) error {
	commands := [][]string{
		{"git", "init"},
		{"git", "branch", "-M", "main"},
		{"git", "add", "-A"},
		{"git", "commit", "-m", "Initial project"},
		{"git", "remote", "add", "origin", repoURL},
		{"git", "push", "-u", "origin", "main"},
	}
	for _, command := range commands {
		if _, err := runCommand(projectRoot, nil, command[0], command[1:]...); err != nil {
			return fmt.Errorf("%s: %w", strings.Join(command, " "), err)
		}
	}
	return nil
}

func githubRepositoryRef(repoURL string) (string, error) {
	parsed, err := url.Parse(repoURL)
	if err != nil {
		return "", fmt.Errorf("parse GitHub repository URL: %w", err)
	}
	if parsed.Host != "github.com" {
		return "", fmt.Errorf("unsupported GitHub repository URL %q", repoURL)
	}
	path := strings.Trim(strings.TrimSuffix(parsed.Path, ".git"), "/")
	parts := strings.Split(path, "/")
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return "", fmt.Errorf("unsupported GitHub repository URL %q", repoURL)
	}
	return parts[0] + "/" + parts[1], nil
}

func firstNonEmptyLine(output string) string {
	for _, line := range strings.Split(output, "\n") {
		line = strings.TrimSpace(line)
		if line != "" {
			return line
		}
	}
	return ""
}

var runExternalCommand = executeCommand

func runCommand(dir string, stdin []byte, name string, args ...string) (string, error) {
	return runExternalCommand(dir, stdin, name, args...)
}

func executeCommand(dir string, stdin []byte, name string, args ...string) (string, error) {
	command := exec.Command(name, args...)
	command.Dir = dir
	if stdin != nil {
		command.Stdin = bytes.NewReader(stdin)
	}
	output, err := command.CombinedOutput()
	if err != nil {
		message := strings.TrimSpace(string(output))
		if message == "" {
			message = err.Error()
		}
		return "", errors.New(message)
	}
	return string(output), nil
}
