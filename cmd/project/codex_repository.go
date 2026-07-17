package main

import (
	"context"
	"errors"
	"net/url"
	"os/exec"
	"regexp"
	"strings"
)

var githubRepositoryNamePattern = regexp.MustCompile(`^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`)

func resolveCurrentGitHubRepository(ctx context.Context) (string, error) {
	command := exec.CommandContext(ctx, "git", "remote", "get-url", "origin")
	output, err := command.Output()
	if err != nil {
		return "", errors.New("resolve the current GitHub origin; use --repository owner/name outside a checkout")
	}
	repository, err := parseGitHubRepositoryURL(strings.TrimSpace(string(output)))
	if err != nil {
		return "", errors.New("the current origin is not an exact GitHub repository; use --repository owner/name")
	}
	return repository, nil
}

func parseGitHubRepositoryURL(remote string) (string, error) {
	path := ""
	if strings.HasPrefix(remote, "git@github.com:") {
		path = strings.TrimPrefix(remote, "git@github.com:")
	} else {
		parsed, err := url.Parse(remote)
		hasPassword := false
		if parsed != nil && parsed.User != nil {
			_, hasPassword = parsed.User.Password()
		}
		if err != nil || (parsed.Scheme != "https" && parsed.Scheme != "ssh" && parsed.Scheme != "git") ||
			!strings.EqualFold(parsed.Hostname(), "github.com") || parsed.Port() != "" || parsed.RawQuery != "" || parsed.Fragment != "" ||
			hasPassword || parsed.User != nil && parsed.User.Username() != "git" {
			return "", errors.New("not a GitHub URL")
		}
		path = strings.TrimPrefix(parsed.Path, "/")
	}
	path = strings.TrimSuffix(path, ".git")
	if !githubRepositoryNamePattern.MatchString(path) {
		return "", errors.New("not an owner/name repository")
	}
	return path, nil
}
