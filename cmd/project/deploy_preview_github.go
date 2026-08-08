package main

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
)

var fullGitSHA = regexp.MustCompile(`^[0-9a-f]{40}$`)

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
	repositoryRecord, err := loadPreviewRepository(projectRoot, repository, deps.run)
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
	pull, err := loadPreviewPullRequest(projectRoot, repository, pullRequest, deps.run)
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
	args := []string{"--repo", repository, "--ref", previewWorkflowRef, "-f", "action=" + operation,
		"-f", fmt.Sprintf("pr=%d", pullRequest), "-f", "operation_id=" + operationID}
	if operation == "start" || operation == "stop" || operation == "touch" {
		args = append(args, "-f", "requested_head_sha="+pull.Head.SHA)
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
			if value.value != "" && value.value != "0" { args = append(args, "-f", value.key+"="+value.value) }
		}
	}
	return dispatchPreviewWorkflow(projectRoot, repository, operation, pullRequest, pull, operationID, args, deps)
}

func dispatchPreviewWorkflow(projectRoot, repository, operation string, pullRequest int, pull previewGitHubPullRequest, operationID string, args []string, deps previewDependencies) (previewDispatchResult, error) {
	workflowArgs := append([]string{"workflow", "run", previewWorkflowFile}, args...)
	if _, err := deps.run(projectRoot, nil, "gh", workflowArgs...); err != nil {
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

func loadPreviewRepository(projectRoot string, repository string, run previewCommandRunner) (previewGitHubRepository, error) {
	output, err := run(projectRoot, nil, "gh", "api", "repos/"+repository)
	if err != nil {
		return previewGitHubRepository{}, fmt.Errorf("load GitHub repository permissions: %w", err)
	}
	var record previewGitHubRepository
	if err := json.Unmarshal([]byte(output), &record); err != nil {
		return previewGitHubRepository{}, fmt.Errorf("decode GitHub repository response: %w", err)
	}
	return record, nil
}

func loadPreviewPullRequest(projectRoot string, repository string, pullRequest int, run previewCommandRunner) (previewGitHubPullRequest, error) {
	output, err := run(projectRoot, nil, "gh", "api", fmt.Sprintf("repos/%s/pulls/%d", repository, pullRequest))
	if err != nil {
		return previewGitHubPullRequest{}, fmt.Errorf("load GitHub pull request #%d: %w", pullRequest, err)
	}
	var record previewGitHubPullRequest
	if err := json.Unmarshal([]byte(output), &record); err != nil {
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
