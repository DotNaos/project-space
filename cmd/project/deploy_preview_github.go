package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"regexp"
	"strings"
)

var fullGitSHA = regexp.MustCompile(`^[0-9a-f]{40}$`)

const githubAPIBaseURL = "https://api.github.com"

// previewGitHubRequester calls the GitHub REST API directly over HTTPS using the caller's
// already-connected OAuth token, rather than shelling out to the gh CLI: the trusted-runtime
// server that dispatches previews has no gh binary installed (and no interactive `gh auth`
// session to give it one), so gh calls fail with "executable file not found in $PATH".
type previewGitHubRequester func(method string, path string, body []byte) ([]byte, error)

// requestGitHubAPI is the production previewGitHubRequester. The token comes from the
// GITHUB_TOKEN environment variable, which the trusted-runtime server (server/preview-hub-service.ts)
// sets from the caller's stored GitHub OAuth connection before spawning this binary.
func requestGitHubAPI(method string, path string, body []byte) ([]byte, error) {
	token := strings.TrimSpace(os.Getenv("GITHUB_TOKEN"))
	if token == "" {
		return nil, errors.New("GITHUB_TOKEN is not set; connect your GitHub account to dispatch previews")
	}
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	request, err := http.NewRequest(method, githubAPIBaseURL+path, reader)
	if err != nil {
		return nil, fmt.Errorf("build GitHub API request: %w", err)
	}
	request.Header.Set("Accept", "application/vnd.github+json")
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return nil, fmt.Errorf("call GitHub API: %w", err)
	}
	defer response.Body.Close()
	responseBody, err := io.ReadAll(response.Body)
	if err != nil {
		return nil, fmt.Errorf("read GitHub API response: %w", err)
	}
	if response.StatusCode >= 300 {
		return nil, fmt.Errorf("GitHub API request failed with status %d: %s", response.StatusCode, strings.TrimSpace(string(responseBody)))
	}
	return responseBody, nil
}

type previewGitHubRepository struct {
	FullName      string `json:"full_name"`
	DefaultBranch string `json:"default_branch"`
	Permissions   struct {
		Push bool `json:"push"`
	} `json:"permissions"`
}

type previewGitHubPullRequest struct {
	Number int                         `json:"number"`
	URL    string                      `json:"html_url"`
	State  string                      `json:"state"`
	Merged bool                        `json:"merged"`
	Base   previewGitHubPullRequestRef `json:"base"`
	Head   previewGitHubPullRequestRef `json:"head"`
}

type previewGitHubPullRequestRef struct {
	Ref  string `json:"ref"`
	SHA  string `json:"sha"`
	Repo *struct {
		FullName string `json:"full_name"`
	} `json:"repo"`
}

func dispatchPreview(projectRoot string, operation string, pullRequest int, deps previewDependencies) (previewDispatchResult, error) {
	return dispatchPreviewWithOptions(projectRoot, operation, previewOptions{PullRequest: pullRequest}, deps)
}

func dispatchPreviewWithOptions(projectRoot string, operation string, options previewOptions, deps previewDependencies) (previewDispatchResult, error) {
	pullRequest := options.PullRequest
	if pullRequest <= 0 {
		return previewDispatchResult{}, fmt.Errorf("--pr must be a positive pull request number")
	}
	if operation != "deploy" && operation != "destroy" && operation != "start" && operation != "stop" && operation != "touch" {
		return previewDispatchResult{}, fmt.Errorf("unsupported preview operation %q", operation)
	}
	repository, err := resolvePreviewRepository(projectRoot, deps.run)
	if err != nil {
		return previewDispatchResult{}, err
	}
	repositoryRecord, err := loadPreviewRepository(repository, deps.githubAPI)
	if err != nil {
		return previewDispatchResult{}, err
	}
	if !strings.EqualFold(repositoryRecord.FullName, repository) {
		return previewDispatchResult{}, fmt.Errorf("GitHub returned repository %q for origin %q", repositoryRecord.FullName, repository)
	}
	if repositoryRecord.DefaultBranch != previewWorkflowRef {
		return previewDispatchResult{}, fmt.Errorf("preview deployment requires repository default branch %q, got %q", previewWorkflowRef, repositoryRecord.DefaultBranch)
	}
	if !repositoryRecord.Permissions.Push {
		return previewDispatchResult{}, fmt.Errorf("GitHub write permission is required to dispatch preview deployments")
	}
	pull, err := loadPreviewPullRequest(repository, pullRequest, deps.githubAPI)
	if err != nil {
		return previewDispatchResult{}, err
	}
	if err := validatePreviewPullRequest(repository, pullRequest, pull, operation != "stop"); err != nil {
		return previewDispatchResult{}, err
	}
	operationID, err := newPreviewOperationID(deps.random)
	if err != nil {
		return previewDispatchResult{}, err
	}
	inputs := map[string]string{
		"action":       operation,
		"pr":           fmt.Sprintf("%d", pullRequest),
		"operation_id": operationID,
	}
	if operation == "start" || operation == "stop" || operation == "touch" {
		inputs["requested_head_sha"] = pull.Head.SHA
	}
	if operation == "start" {
		// Replacement details are passed only after the caller has explicitly selected
		// an online Preview and its current inventory revision.
		for _, value := range []struct{ key, value string }{
			{"inventory_revision", options.InventoryRevision},
			{"replacement_pr", fmt.Sprintf("%d", options.ReplacementPR)},
			{"replacement_repository", options.ReplacementRepository},
			{"replacement_head_sha", options.ReplacementHeadSHA},
		} {
			if value.value != "" && value.value != "0" { inputs[value.key] = value.value }
		}
	}
	return dispatchPreviewWorkflow(repository, operation, pullRequest, pull, operationID, inputs, deps)
}

func dispatchPreviewWorkflow(repository, operation string, pullRequest int, pull previewGitHubPullRequest, operationID string, inputs map[string]string, deps previewDependencies) (previewDispatchResult, error) {
	payload, err := json.Marshal(struct {
		Ref    string            `json:"ref"`
		Inputs map[string]string `json:"inputs"`
	}{Ref: previewWorkflowRef, Inputs: inputs})
	if err != nil {
		return previewDispatchResult{}, fmt.Errorf("encode preview workflow dispatch: %w", err)
	}
	dispatchPath := fmt.Sprintf("/repos/%s/actions/workflows/%s/dispatches", repository, previewWorkflowFile)
	if _, err := deps.githubAPI(http.MethodPost, dispatchPath, payload); err != nil {
		return previewDispatchResult{}, fmt.Errorf("dispatch trusted preview workflow: %w", err)
	}
	return previewDispatchResult{
		Operation: operation, OperationID: operationID, RepositoryFullName: repository,
		PullRequest: previewPullRequestEvidence{Number: pull.Number, URL: pull.URL, State: pull.State, BaseRef: pull.Base.Ref, HeadRef: pull.Head.Ref, HeadSHA: pull.Head.SHA},
		PreviewID: previewID(repository, pullRequest), ExpectedLiveURL: previewLiveURL(pullRequest),
		Workflow: previewWorkflowDispatch{File: previewWorkflowFile, Ref: previewWorkflowRef, State: "queued"},
	}, nil
}

func resolvePreviewRepository(projectRoot string, run previewCommandRunner) (string, error) {
	// Scope the safe.directory exception to exactly this invocation's projectRoot rather than
	// mutating global git config, so a UID/ownership mismatch on the mounted repo path (e.g. the
	// deployment container's /workspace/backend-repo) doesn't fail with "detected dubious
	// ownership". Mirrors the equivalent fix on the Node side in server/local-git-client.ts.
	output, err := run(projectRoot, nil, "git", "-c", "safe.directory="+projectRoot, "remote", "get-url", "origin")
	if err != nil {
		return "", fmt.Errorf("resolve GitHub origin: %w", err)
	}
	repository, err := parseGitHubRepositoryURL(strings.TrimSpace(output))
	if err != nil {
		return "", fmt.Errorf("origin must be an exact GitHub owner/name repository: %w", err)
	}
	return repository, nil
}

func loadPreviewRepository(repository string, api previewGitHubRequester) (previewGitHubRepository, error) {
	output, err := api(http.MethodGet, "/repos/"+repository, nil)
	if err != nil {
		return previewGitHubRepository{}, fmt.Errorf("load GitHub repository permissions: %w", err)
	}
	var record previewGitHubRepository
	if err := json.Unmarshal(output, &record); err != nil {
		return previewGitHubRepository{}, fmt.Errorf("decode GitHub repository response: %w", err)
	}
	return record, nil
}

func loadPreviewPullRequest(repository string, pullRequest int, api previewGitHubRequester) (previewGitHubPullRequest, error) {
	output, err := api(http.MethodGet, fmt.Sprintf("/repos/%s/pulls/%d", repository, pullRequest), nil)
	if err != nil {
		return previewGitHubPullRequest{}, fmt.Errorf("load GitHub pull request #%d: %w", pullRequest, err)
	}
	var record previewGitHubPullRequest
	if err := json.Unmarshal(output, &record); err != nil {
		return previewGitHubPullRequest{}, fmt.Errorf("decode GitHub pull request response: %w", err)
	}
	return record, nil
}

func validatePreviewPullRequest(repository string, requestedNumber int, pull previewGitHubPullRequest, requireOpen bool) error {
	if pull.Number != requestedNumber {
		return fmt.Errorf("GitHub returned pull request #%d for requested #%d", pull.Number, requestedNumber)
	}
	if requireOpen && (pull.State != "open" || pull.Merged) {
		return fmt.Errorf("pull request #%d must be open and unmerged for preview deployment", pull.Number)
	}
	if pull.Base.Ref != previewWorkflowRef {
		return fmt.Errorf("pull request #%d must target %q, got %q", pull.Number, previewWorkflowRef, pull.Base.Ref)
	}
	if pull.Base.Repo == nil || pull.Head.Repo == nil ||
		!strings.EqualFold(pull.Base.Repo.FullName, repository) ||
		!strings.EqualFold(pull.Head.Repo.FullName, repository) {
		return fmt.Errorf("pull request #%d must use branches from %s; fork previews are not allowed", pull.Number, repository)
	}
	if !fullGitSHA.MatchString(pull.Head.SHA) {
		return fmt.Errorf("pull request #%d head SHA must be a full lowercase 40-character Git SHA", pull.Number)
	}
	if strings.TrimSpace(pull.Head.Ref) == "" || !safePreviewText(pull.Head.Ref, 256) {
		return fmt.Errorf("pull request #%d has an invalid head branch", pull.Number)
	}
	return nil
}
