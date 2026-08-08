package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestDispatchPreviewUsesTrustedMainWorkflowAndValidatedPR(t *testing.T) {
	runner := func(_ string, _ []byte, name string, args ...string) (string, error) {
		command := strings.Join(append([]string{name}, args...), " ")
		if command == "git -c safe.directory=/repo remote get-url origin" {
			return "git@github.com:DotNaos/project-space.git\n", nil
		}
		return "", fmt.Errorf("unexpected command: %s", command)
	}
	var dispatchedPath string
	var dispatchedBody []byte
	api := previewGitHubTestRequester(
		`{"full_name":"DotNaos/project-space","default_branch":"main","permissions":{"push":true}}`,
		previewPullRequestJSON(263, "open", "main", "DotNaos/project-space", strings.Repeat("a", 40)),
		func(method, path string, body []byte) ([]byte, error) {
			if method != http.MethodPost {
				return nil, fmt.Errorf("unexpected dispatch method: %s", method)
			}
			dispatchedPath = path
			dispatchedBody = body
			return nil, nil
		},
	)
	result, err := dispatchPreview("/repo", "deploy", 263, previewDependencies{
		run: runner, githubAPI: api, random: bytes.NewReader(bytes.Repeat([]byte{0x12}, 16)), now: time.Now,
	})
	if err != nil {
		t.Fatal(err)
	}
	if dispatchedPath != "/repos/DotNaos/project-space/actions/workflows/deploy-preview.yml/dispatches" {
		t.Fatalf("dispatch path = %q", dispatchedPath)
	}
	var payload struct {
		Ref    string            `json:"ref"`
		Inputs map[string]string `json:"inputs"`
	}
	if err := json.Unmarshal(dispatchedBody, &payload); err != nil {
		t.Fatal(err)
	}
	wantInputs := map[string]string{"action": "deploy", "pr": "263", "operation_id": "preview-12121212121212121212121212121212"}
	if payload.Ref != "main" || len(payload.Inputs) != len(wantInputs) {
		t.Fatalf("dispatch payload = %#v", payload)
	}
	for key, value := range wantInputs {
		if payload.Inputs[key] != value {
			t.Fatalf("dispatch payload = %#v, want %v", payload, wantInputs)
		}
	}
	body := string(dispatchedBody)
	for _, untrusted := range []string{strings.Repeat("a", 40), "feature/preview", "projects.os-home.net"} {
		if strings.Contains(body, untrusted) {
			t.Fatalf("workflow dispatch included untrusted or derived value %q: %s", untrusted, body)
		}
	}
	if result.ExpectedLiveURL != "https://pr-263.projects.os-home.net" || result.Workflow.Ref != "main" || result.Workflow.State != "queued" {
		t.Fatalf("unexpected dispatch result: %#v", result)
	}
}

// TestResolvePreviewRepositoryScopesGitSafeDirectoryToProjectRoot guards against a regression of
// https://github.com/DotNaos/project-space/issues/516: the deployment container mounts the repo
// at a path (e.g. /workspace/backend-repo) owned by a different UID than the process runs as, so
// plain `git remote get-url origin` fails with "detected dubious ownership". The fix scopes a
// `-c safe.directory=<projectRoot>` exception to exactly the directory being read, instead of
// mutating global git config.
func TestResolvePreviewRepositoryScopesGitSafeDirectoryToProjectRoot(t *testing.T) {
	const projectRoot = "/workspace/backend-repo"
	var capturedArgs []string
	runner := func(dir string, _ []byte, name string, args ...string) (string, error) {
		if dir != projectRoot {
			t.Fatalf("run dir = %q, want %q", dir, projectRoot)
		}
		if name != "git" {
			t.Fatalf("unexpected command: %s %s", name, strings.Join(args, " "))
		}
		capturedArgs = args
		return "git@github.com:DotNaos/project-space.git\n", nil
	}
	repository, err := resolvePreviewRepository(projectRoot, runner)
	if err != nil {
		t.Fatal(err)
	}
	if repository != "DotNaos/project-space" {
		t.Fatalf("repository = %q, want %q", repository, "DotNaos/project-space")
	}
	wantArgs := []string{"-c", "safe.directory=" + projectRoot, "remote", "get-url", "origin"}
	if strings.Join(capturedArgs, "\x00") != strings.Join(wantArgs, "\x00") {
		t.Fatalf("git args = %#v, want %#v", capturedArgs, wantArgs)
	}
}

func TestDispatchPreviewRejectsUnsafePullRequestsAndPermissions(t *testing.T) {
	tests := []struct {
		name       string
		repository string
		pull       string
		want       string
	}{
		{
			name:       "no write permission",
			repository: `{"full_name":"DotNaos/project-space","default_branch":"main","permissions":{"push":false}}`,
			pull:       previewPullRequestJSON(263, "open", "main", "DotNaos/project-space", strings.Repeat("a", 40)),
			want:       "write permission",
		},
		{
			name:       "fork",
			repository: `{"full_name":"DotNaos/project-space","default_branch":"main","permissions":{"push":true}}`,
			pull:       previewPullRequestJSON(263, "open", "main", "someone/project-space", strings.Repeat("a", 40)),
			want:       "fork previews are not allowed",
		},
		{
			name:       "wrong base",
			repository: `{"full_name":"DotNaos/project-space","default_branch":"main","permissions":{"push":true}}`,
			pull:       previewPullRequestJSON(263, "open", "beta", "DotNaos/project-space", strings.Repeat("a", 40)),
			want:       `must target "main"`,
		},
		{
			name:       "closed",
			repository: `{"full_name":"DotNaos/project-space","default_branch":"main","permissions":{"push":true}}`,
			pull:       previewPullRequestJSON(263, "closed", "main", "DotNaos/project-space", strings.Repeat("a", 40)),
			want:       "must be open and unmerged",
		},
		{
			name:       "short SHA",
			repository: `{"full_name":"DotNaos/project-space","default_branch":"main","permissions":{"push":true}}`,
			pull:       previewPullRequestJSON(263, "open", "main", "DotNaos/project-space", "abc123"),
			want:       "full lowercase 40-character",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := dispatchPreview("/repo", "deploy", 263, previewDependencies{
				run:       previewGitHubTestGitRunner,
				githubAPI: previewGitHubTestRequester(test.repository, test.pull, nil),
				random:    bytes.NewReader(make([]byte, 16)),
				now:       time.Now,
			})
			if err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("error = %v, want containing %q", err, test.want)
			}
		})
	}
}

func TestPreviewStatusJSONMatchesServerAdapterContract(t *testing.T) {
	item := previewStatusItem{
		RepositoryFullName: "DotNaos/project-space",
		PullRequestNumber:  263,
		PullRequestURL:     "https://github.com/DotNaos/project-space/pull/263",
		HeadBranch:         "issue-263-pr-preview-deployment",
		RequestedSHA:       strings.Repeat("a", 40),
		RunningSHA:         strings.Repeat("b", 40),
		LiveURL:            "https://pr-263.projects.os-home.net",
		PrototypeURL:       "https://pr-263.projects.os-home.net/prototype/desktop/",
		PrototypeMetaSHA:   strings.Repeat("b", 40),
		PrototypeHealthy:   true,
		State:              "ready",
		VerifiedAt:         "2026-07-22T10:01:00Z",
		UpdatedAt:          "2026-07-22T10:02:00Z",
		Message:            "Preview is healthy.",
	}
	var output bytes.Buffer
	cmd := newDeployPreviewStatusCommand(previewDependencies{})
	cmd.SetOut(&output)
	if err := printPreviewStatus(cmd, previewStatusReport{CheckedAt: "2026-07-22T10:03:00Z", Previews: []previewStatusItem{item}}, "json"); err != nil {
		t.Fatal(err)
	}
	var raw map[string]any
	if err := json.Unmarshal(output.Bytes(), &raw); err != nil {
		t.Fatal(err)
	}
	if len(raw) != 2 || raw["checkedAt"] != "2026-07-22T10:03:00Z" {
		t.Fatalf("unexpected top-level JSON: %#v", raw)
	}
	previews, ok := raw["previews"].([]any)
	if !ok || len(previews) != 1 {
		t.Fatalf("previews = %#v", raw["previews"])
	}
	preview := previews[0].(map[string]any)
	wantFields := []string{"repositoryFullName", "pullRequestNumber", "pullRequestUrl", "headBranch", "requestedSha", "runningSha", "liveUrl", "prototypeUrl", "prototypeMetaSha", "prototypeHealthy", "state", "verifiedAt", "updatedAt", "message"}
	if len(preview) != len(wantFields) {
		t.Fatalf("preview keys = %#v", preview)
	}
	for _, field := range wantFields {
		if _, exists := preview[field]; !exists {
			t.Errorf("missing field %q in %#v", field, preview)
		}
	}
}

func TestDecodePreviewStatusFiltersRepositoryDeduplicatesAndRejectsUnsafeURL(t *testing.T) {
	sha := strings.Repeat("a", 40)
	input := strings.Join([]string{
		fmt.Sprintf(`{"repositoryFullName":"other/repo","pullRequestNumber":1,"requestedSha":"%s","state":"ready"}`, sha),
		fmt.Sprintf(`{"repositoryFullName":"DotNaos/project-space","pullRequestNumber":263,"requestedSha":"%s","state":"deploying","updatedAt":"2026-07-22T10:00:00Z"}`, sha),
		fmt.Sprintf(`{"repositoryFullName":"DotNaos/project-space","pullRequestNumber":263,"requestedSha":"%s","runningSha":"%s","liveUrl":"https://pr-263.projects.os-home.net","state":"ready","updatedAt":"2026-07-22T10:02:00Z"}`, sha, sha),
	}, "\n")
	items, err := decodePreviewStatus(strings.NewReader(input), "DotNaos/project-space")
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 || items[0].State != "ready" {
		t.Fatalf("items = %#v", items)
	}
	unsafe := fmt.Sprintf(`{"repositoryFullName":"DotNaos/project-space","pullRequestNumber":263,"requestedSha":"%s","liveUrl":"https://evil.example","state":"ready"}`, sha)
	if _, err := decodePreviewStatus(strings.NewReader(unsafe), "DotNaos/project-space"); err == nil || !strings.Contains(err.Error(), "liveUrl") {
		t.Fatalf("unsafe URL error = %v", err)
	}
	unsafeText := fmt.Sprintf(`{"repositoryFullName":"DotNaos/project-space","pullRequestNumber":263,"requestedSha":"%s","state":"ready","message":"unsafe\u001b[31m"}`, sha)
	if _, err := decodePreviewStatus(strings.NewReader(unsafeText), "DotNaos/project-space"); err == nil || !strings.Contains(err.Error(), "control characters") {
		t.Fatalf("unsafe text error = %v", err)
	}
	unsafePrototype := fmt.Sprintf(
		`{"repositoryFullName":"DotNaos/project-space","pullRequestNumber":263,"requestedSha":"%s","runningSha":"%s","prototypeUrl":"https://evil.example/prototype/desktop/","prototypeMetaSha":"%s","prototypeHealthy":true,"state":"ready"}`,
		sha, sha, sha,
	)
	if _, err := decodePreviewStatus(strings.NewReader(unsafePrototype), "DotNaos/project-space"); err == nil || !strings.Contains(err.Error(), "prototypeUrl") {
		t.Fatalf("unsafe prototype URL error = %v", err)
	}
}

func TestDecodePreviewStatusReadsForcedCommandRegistryEnvelope(t *testing.T) {
	sha := strings.Repeat("a", 40)
	input := fmt.Sprintf(
		`{"records":[{"repositoryFullName":"DotNaos/project-space","pullRequestNumber":263,"requestedSha":"%s","runningSha":"%s","liveUrl":"https://pr-263.projects.os-home.net","state":"ready"}]}`,
		sha,
		sha,
	)
	items, err := decodePreviewStatus(strings.NewReader(input), "DotNaos/project-space")
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 || items[0].State != "ready" || items[0].PullRequestNumber != 263 {
		t.Fatalf("items = %#v", items)
	}
}

func TestDecodePreviewStatusAllowsRemovedPreviewWithoutSHA(t *testing.T) {
	input := `{"repositoryFullName":"DotNaos/project-space","pullRequestNumber":263,"state":"removed","updatedAt":"2026-07-22T10:02:00Z"}`
	items, err := decodePreviewStatus(strings.NewReader(input), "DotNaos/project-space")
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 || items[0].RequestedSHA != "" || items[0].State != "removed" {
		t.Fatalf("items = %#v", items)
	}
}

func TestPreviewStatusCommandRequiresExactlyOneSelector(t *testing.T) {
	for _, args := range [][]string{{"--format", "json"}, {"--pr", "263", "--all"}} {
		cmd := newDeployPreviewStatusCommand(previewDependencies{})
		cmd.SetArgs(args)
		cmd.SetOut(&bytes.Buffer{})
		cmd.SetErr(&bytes.Buffer{})
		if err := cmd.Execute(); err == nil || !strings.Contains(err.Error(), "exactly one") {
			t.Fatalf("args %v error = %v", args, err)
		}
	}
}

func TestReadPreviewStatusUsesDedicatedForcedCommandHost(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "deploy"), 0o755); err != nil {
		t.Fatal(err)
	}
	config := "host: deploy@example\npreview:\n  statusHost: project-space-preview-status\nenvironments:\n  prod:\n    default: true\n    branch: main\n    path: /opt/app\n    domain: example.com\n    apiDomain: api.example.com\n  beta:\n    branch: beta\n    path: /opt/app-beta\n    domain: beta.example.com\n    apiDomain: api.beta.example.com\n"
	if err := os.WriteFile(filepath.Join(root, "deploy", "deploy.yaml"), []byte(config), 0o600); err != nil {
		t.Fatal(err)
	}
	sha := strings.Repeat("a", 40)
	calledStatus := false
	runner := func(_ string, input []byte, name string, args ...string) (string, error) {
		command := strings.Join(append([]string{name}, args...), " ")
		switch command {
		case fmt.Sprintf("git -c safe.directory=%s remote get-url origin", root):
			return "https://github.com/DotNaos/project-space.git", nil
		case "ssh project-space-preview-status status-all":
			calledStatus = true
			if len(input) != 0 {
				t.Fatalf("status SSH received unexpected stdin: %q", input)
			}
			return fmt.Sprintf(`{"repositoryFullName":"DotNaos/project-space","pullRequestNumber":263,"requestedSha":"%s","state":"ready"}`, sha), nil
		default:
			return "", fmt.Errorf("unexpected command: %s", command)
		}
	}
	report, err := readPreviewStatus(root, 263, previewDependencies{run: runner, now: time.Now})
	if err != nil {
		t.Fatal(err)
	}
	if !calledStatus || len(report.Previews) != 1 || report.Previews[0].PullRequestNumber != 263 {
		t.Fatalf("unexpected report: %#v", report)
	}
}

func TestReadPreviewStatusRequiresDedicatedHost(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "deploy"), 0o755); err != nil {
		t.Fatal(err)
	}
	config := "host: deploy@example\nenvironments:\n  prod:\n    default: true\n    branch: main\n    path: /opt/app\n    domain: example.com\n    apiDomain: api.example.com\n  beta:\n    branch: beta\n    path: /opt/app-beta\n    domain: beta.example.com\n    apiDomain: api.beta.example.com\n"
	if err := os.WriteFile(filepath.Join(root, "deploy", "deploy.yaml"), []byte(config), 0o600); err != nil {
		t.Fatal(err)
	}
	runner := func(_ string, _ []byte, name string, args ...string) (string, error) {
		if name == "git" {
			return "https://github.com/DotNaos/project-space.git", nil
		}
		return "", fmt.Errorf("unexpected command: %s %s", name, strings.Join(args, " "))
	}
	_, err := readPreviewStatus(root, 263, previewDependencies{run: runner, now: time.Now})
	if err == nil || !strings.Contains(err.Error(), "preview.statusHost") {
		t.Fatalf("error = %v", err)
	}
}

func TestPreviewCommandRejectsUnknownFormatBeforeExternalCommands(t *testing.T) {
	called := false
	cmd := newDeployPreviewCommandWithDependencies(previewDependencies{
		run: func(_ string, _ []byte, _ string, _ ...string) (string, error) {
			called = true
			return "", nil
		},
		random: bytes.NewReader(make([]byte, 16)),
		now:    time.Now,
	})
	cmd.SetArgs([]string{"--pr", "263", "--format", "xml"})
	cmd.SetOut(&bytes.Buffer{})
	cmd.SetErr(&bytes.Buffer{})
	err := cmd.Execute()
	if err == nil || !strings.Contains(err.Error(), "unsupported output format") {
		t.Fatalf("error = %v", err)
	}
	if called {
		t.Fatal("external command ran before output format validation")
	}
}

func previewGitHubTestGitRunner(_ string, _ []byte, name string, args ...string) (string, error) {
	command := strings.Join(append([]string{name}, args...), " ")
	if command == "git -c safe.directory=/repo remote get-url origin" {
		return "https://github.com/DotNaos/project-space.git", nil
	}
	return "", fmt.Errorf("unexpected command: %s", command)
}

// previewGitHubTestRequester builds a previewGitHubRequester that serves the repository and pull
// request GET calls dispatchPreviewWithOptions makes before dispatching a workflow. Any POST
// (the workflow_dispatch call) is forwarded to onDispatch if provided, or rejected otherwise.
func previewGitHubTestRequester(repositoryJSON string, pullJSON string, onDispatch func(method, path string, body []byte) ([]byte, error)) previewGitHubRequester {
	return func(method, path string, body []byte) ([]byte, error) {
		switch {
		case method == http.MethodGet && path == "/repos/DotNaos/project-space":
			return []byte(repositoryJSON), nil
		case method == http.MethodGet && strings.HasPrefix(path, "/repos/DotNaos/project-space/pulls/"):
			return []byte(pullJSON), nil
		case onDispatch != nil:
			return onDispatch(method, path, body)
		default:
			return nil, fmt.Errorf("unexpected GitHub API request: %s %s", method, path)
		}
	}
}

func previewPullRequestJSON(number int, state string, base string, headRepository string, sha string) string {
	return fmt.Sprintf(`{"number":%d,"html_url":"https://github.com/DotNaos/project-space/pull/%d","state":%q,"merged":false,"base":{"ref":%q,"repo":{"full_name":"DotNaos/project-space"}},"head":{"ref":"feature/preview","sha":%q,"repo":{"full_name":%q}}}`, number, number, state, base, sha, headRepository)
}
