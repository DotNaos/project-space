package main

import "testing"

func TestParseGitHubRepositoryURL(t *testing.T) {
	tests := map[string]string{
		"https://github.com/DotNaos/project-space.git":   "DotNaos/project-space",
		"git@github.com:DotNaos/project-space.git":       "DotNaos/project-space",
		"ssh://git@github.com/DotNaos/project-space.git": "DotNaos/project-space",
	}
	for remote, expected := range tests {
		actual, err := parseGitHubRepositoryURL(remote)
		if err != nil || actual != expected {
			t.Errorf("parse %q = %q, %v", remote, actual, err)
		}
	}
	for _, remote := range []string{
		"https://gitlab.com/DotNaos/project-space.git",
		"file://github.com/DotNaos/project-space",
		"https://user:secret@github.com/DotNaos/project-space",
		"https://github.com/DotNaos/project-space?credential=secret",
	} {
		if actual, err := parseGitHubRepositoryURL(remote); err == nil {
			t.Errorf("unsafe remote %q parsed as %q", remote, actual)
		}
	}
}
