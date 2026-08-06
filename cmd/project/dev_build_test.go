package main

import (
	"bytes"
	"fmt"
	"strings"
	"testing"
	"time"
)

func TestDispatchDevBuildUsesExactCurrentPRHeadAndSelectedPlatforms(t *testing.T) {
	var workflowArgs []string
	headSHA := strings.Repeat("a", 40)
	runner := func(_ string, _ []byte, name string, args ...string) (string, error) {
		command := strings.Join(append([]string{name}, args...), " ")
		switch command {
		case "git remote get-url origin":
			return "git@github.com:DotNaos/project-space.git\n", nil
		case "gh api repos/DotNaos/project-space":
			return `{"full_name":"DotNaos/project-space","default_branch":"main","permissions":{"push":true}}`, nil
		case "gh api repos/DotNaos/project-space/pulls/466":
			return previewPullRequestJSON(466, "open", "main", "DotNaos/project-space", headSHA), nil
		default:
			if strings.HasPrefix(command, "gh workflow run ") {
				workflowArgs = append([]string(nil), args...)
				return "", nil
			}
			return "", fmt.Errorf("unexpected command: %s", command)
		}
	}

	result, err := dispatchDevBuild("/repo", devBuildOptions{
		PullRequest: 466,
		Platforms:   []string{"windows-x64", "linux-x64"},
	}, previewDependencies{run: runner, random: bytes.NewReader(nil), now: time.Now})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{
		"workflow", "run", "build-pr-tools.yml",
		"--repo", "DotNaos/project-space", "--ref", "main",
		"-f", "pull_request=466", "-f", "requested_head_sha=" + headSHA,
		"-f", "linux_x64=true", "-f", "macos_arm64=false", "-f", "windows_x64=true",
	}
	if strings.Join(workflowArgs, "\x00") != strings.Join(want, "\x00") {
		t.Fatalf("workflow args = %#v, want %#v", workflowArgs, want)
	}
	if result.PullRequest.HeadSHA != headSHA ||
		strings.Join(result.Platforms, ",") != "linux-x64,windows-x64" {
		t.Fatalf("unexpected dispatch result: %#v", result)
	}
}

func TestDispatchDevBuildRejectsUnsafeSourceAndPlatforms(t *testing.T) {
	for _, test := range []struct {
		name      string
		platforms []string
		pull      string
		want      string
	}{
		{
			name: "fork", platforms: []string{"linux-x64"},
			pull: previewPullRequestJSON(466, "open", "main", "someone/project-space", strings.Repeat("a", 40)),
			want: "fork previews are not allowed",
		},
		{
			name: "closed", platforms: []string{"linux-x64"},
			pull: previewPullRequestJSON(466, "closed", "main", "DotNaos/project-space", strings.Repeat("a", 40)),
			want: "must be open and unmerged",
		},
		{
			name: "unsupported platform", platforms: []string{"solaris-sparc"},
			pull: previewPullRequestJSON(466, "open", "main", "DotNaos/project-space", strings.Repeat("a", 40)),
			want: "unsupported development platform",
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			runner := devBuildGitHubTestRunner(
				`{"full_name":"DotNaos/project-space","default_branch":"main","permissions":{"push":true}}`,
				test.pull,
			)
			_, err := dispatchDevBuild("/repo", devBuildOptions{
				PullRequest: 466, Platforms: test.platforms,
			}, previewDependencies{run: runner})
			if err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("error = %v, want containing %q", err, test.want)
			}
		})
	}
}

func TestDevBuildCommandDefaultsToLinuxAndPrintsJSON(t *testing.T) {
	var output bytes.Buffer
	cmd := newDevBuildCreateCommand(previewDependencies{run: devBuildGitHubTestRunner(
		`{"full_name":"DotNaos/project-space","default_branch":"main","permissions":{"push":true}}`,
		previewPullRequestJSON(466, "open", "main", "DotNaos/project-space", strings.Repeat("a", 40)),
	)})
	cmd.SetOut(&output)
	cmd.SetArgs([]string{"--pr", "466", "--format", "json"})
	if err := cmd.Execute(); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(output.String(), `"platforms": [`+"\n"+`    "linux-x64"`) ||
		!strings.Contains(output.String(), `"headSha": "`+strings.Repeat("a", 40)+`"`) {
		t.Fatalf("unexpected JSON output: %s", output.String())
	}
}

func devBuildGitHubTestRunner(repositoryJSON string, pullJSON string) previewCommandRunner {
	return func(_ string, _ []byte, name string, args ...string) (string, error) {
		command := strings.Join(append([]string{name}, args...), " ")
		switch command {
		case "git remote get-url origin":
			return "https://github.com/DotNaos/project-space.git", nil
		case "gh api repos/DotNaos/project-space":
			return repositoryJSON, nil
		case "gh api repos/DotNaos/project-space/pulls/466":
			return pullJSON, nil
		default:
			if strings.HasPrefix(command, "gh workflow run build-pr-tools.yml ") {
				return "", nil
			}
			return "", fmt.Errorf("unexpected command: %s", command)
		}
	}
}
