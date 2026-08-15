package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"

	"github.com/DotNaos/project-space/internal/projectstorage"
)

func codexWorktreeEvidence() projectstorage.EvidenceCheck {
	var inventory []localCodexThread
	var inventoryErr error
	once := sync.Once{}
	return func(ctx context.Context, candidate projectstorage.PurgeCandidate) (projectstorage.EvidenceResult, error) {
		once.Do(func() {
			inventory, inventoryErr = listLocalCodexThreads(ctx)
		})
		if inventoryErr != nil {
			return projectstorage.EvidenceResult{}, fmt.Errorf("list Codex tasks: %w", inventoryErr)
		}
		blockers := make([]projectstorage.Blocker, 0)
		for _, session := range inventory {
			if session.ID == candidate.OwnerThreadID || pathContains(candidate.Path, session.CWD) {
				blockers = append(blockers, projectstorage.Blocker{
					Code: "codex_thread_unarchived", Message: "Codex task " + session.ID + " still uses this worktree.",
				})
			}
		}
		return projectstorage.EvidenceResult{Blockers: blockers}, nil
	}
}

func processWorktreeEvidence() projectstorage.EvidenceCheck {
	once := sync.Once{}
	paths := []string{}
	var inventoryErr error
	return func(ctx context.Context, candidate projectstorage.PurgeCandidate) (projectstorage.EvidenceResult, error) {
		once.Do(func() { paths, inventoryErr = openProcessPaths(ctx) })
		blockers, err := processPathEvidence(paths, inventoryErr, candidate.Path, "worktree")
		return projectstorage.EvidenceResult{Blockers: blockers}, err
	}
}

func openProcessPaths(ctx context.Context) ([]string, error) {
	command := exec.CommandContext(ctx, "lsof", "-Fn")
	output, err := command.Output()
	if err != nil {
		return nil, fmt.Errorf("inspect process file usage: %w", err)
	}
	paths := make([]string, 0)
	for _, line := range strings.Split(string(output), "\n") {
		if strings.HasPrefix(line, "n") {
			paths = append(paths, strings.TrimPrefix(line, "n"))
		}
	}
	return paths, nil
}

func processPathEvidence(paths []string, inventoryErr error, path, label string) ([]projectstorage.Blocker, error) {
	if inventoryErr != nil {
		return nil, inventoryErr
	}
	for _, openPath := range paths {
		if pathContains(path, openPath) {
			return []projectstorage.Blocker{{Code: "process_active", Message: "A running process has a working directory or open file inside this " + label + "."}}, nil
		}
	}
	return nil, nil
}

type pullRequestRepository struct {
	NameWithOwner string `json:"nameWithOwner"`
}

type pullRequestRecord struct {
	HeadRefName    string                 `json:"headRefName"`
	HeadRefOID     string                 `json:"headRefOid"`
	HeadRepository *pullRequestRepository `json:"headRepository"`
	IsDraft        bool                   `json:"isDraft"`
	MergedAt       *string                `json:"mergedAt"`
	Number         int                    `json:"number"`
	State          string                 `json:"state"`
	URL            string                 `json:"url"`
}

type worktreeEvidenceCommand func(context.Context, string, string, ...string) (string, error)

func integrationWorktreeEvidence(policy worktreePurgePolicy) projectstorage.EvidenceCheck {
	return integrationWorktreeEvidenceWithCommand(policy, commandOutput)
}

func integrationWorktreeEvidenceWithCommand(
	policy worktreePurgePolicy,
	run worktreeEvidenceCommand,
) projectstorage.EvidenceCheck {
	refreshOnce, pullRequestsOnce := sync.Once{}, sync.Once{}
	var refreshErr, pullRequestsErr error
	records := []pullRequestRecord{}
	return func(ctx context.Context, candidate projectstorage.PurgeCandidate) (projectstorage.EvidenceResult, error) {
		refreshOnce.Do(func() {
			if _, err := run(ctx, candidate.Path, "git", "fetch", "--prune", "origin"); err != nil {
				refreshErr = fmt.Errorf("refresh origin before GitHub recovery check: %w", err)
			}
		})
		if refreshErr != nil {
			return projectstorage.EvidenceResult{}, refreshErr
		}

		pullRequestsOnce.Do(func() {
			output, err := run(
				ctx, candidate.Path, "gh", "pr", "list", "--repo", candidate.Repository,
				"--state", "all", "--limit", "1000",
				"--json", "number,state,isDraft,mergedAt,headRefName,headRefOid,headRepository,url",
			)
			if err != nil {
				pullRequestsErr = fmt.Errorf("load pull request evidence: %w", err)
				return
			}
			if json.Unmarshal([]byte(output), &records) != nil {
				pullRequestsErr = errors.New("load pull request evidence: invalid GitHub response")
			}
		})
		if pullRequestsErr != nil {
			return projectstorage.EvidenceResult{}, pullRequestsErr
		}
		result := evaluatePullRequestEvidence(candidate, records, policy)
		if !hasRecoveryState(result.Evidence, "open-pr-backed") {
			return result, nil
		}
		remoteHead, err := run(
			ctx, candidate.Path, "git", "rev-parse", "--verify", "refs/remotes/origin/"+candidate.Branch+"^{commit}",
		)
		if err != nil || strings.TrimSpace(remoteHead) != candidate.HeadSHA {
			return projectstorage.EvidenceResult{Blockers: []projectstorage.Blocker{{
				Code: "remote_head_mismatch", Message: "The exact open pull request head is not preserved by its origin branch.",
			}}}, nil
		}
		return result, nil
	}
}

func hasRecoveryState(evidence []projectstorage.Evidence, state string) bool {
	for _, item := range evidence {
		if item.RecoveryState == state {
			return true
		}
	}
	return false
}

func evaluatePullRequestEvidence(
	candidate projectstorage.PurgeCandidate,
	records []pullRequestRecord,
	policy worktreePurgePolicy,
) projectstorage.EvidenceResult {
	exact := make([]pullRequestRecord, 0)
	for _, record := range records {
		if record.HeadRefName == candidate.Branch && record.HeadRefOID == candidate.HeadSHA {
			exact = append(exact, record)
		}
	}
	if len(exact) == 0 {
		return blockedEvidence("pull_request_not_found", "No pull request has this exact branch and head commit.")
	}

	sameRepository := make([]pullRequestRecord, 0, len(exact))
	for _, record := range exact {
		if record.HeadRepository != nil && strings.EqualFold(record.HeadRepository.NameWithOwner, candidate.Repository) {
			sameRepository = append(sameRepository, record)
		}
	}
	if len(sameRepository) == 0 {
		return blockedEvidence("pull_request_head_repository_mismatch", "The exact pull request head is not owned by this repository.")
	}

	for _, record := range sameRepository {
		if record.State == "MERGED" && record.MergedAt != nil {
			return githubRecoveryEvidence(record, "merged")
		}
	}
	for _, record := range sameRepository {
		if record.State != "OPEN" || record.MergedAt != nil {
			continue
		}
		if policy.IncludeOpenPRs {
			return githubRecoveryEvidence(record, "open-pr-backed")
		}
		return blockedEvidence(
			"open_pull_request_requires_opt_in",
			fmt.Sprintf("Pull request #%d is open; rerun with --include-open-prs to allow deletion of its clean local worktree.", record.Number),
		)
	}
	return blockedEvidence("pull_request_not_merged", "The exact pull request is closed without being merged.")
}

func githubRecoveryEvidence(record pullRequestRecord, state string) projectstorage.EvidenceResult {
	message := fmt.Sprintf("Pull request #%d preserves the exact worktree head on GitHub.", record.Number)
	return projectstorage.EvidenceResult{Evidence: []projectstorage.Evidence{{
		Code: "github_pr_recovery", Message: message, PullRequest: record.Number,
		RecoveryState: state, URL: record.URL,
	}}}
}

func blockedEvidence(code, message string) projectstorage.EvidenceResult {
	return projectstorage.EvidenceResult{Blockers: []projectstorage.Blocker{{Code: code, Message: message}}}
}

func commandOutput(ctx context.Context, directory, name string, args ...string) (string, error) {
	command := exec.CommandContext(ctx, name, args...)
	command.Dir = directory
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

func pathContains(parent, child string) bool {
	if strings.TrimSpace(child) == "" {
		return false
	}
	parent, parentErr := filepath.Abs(filepath.Clean(parent))
	child, childErr := filepath.Abs(filepath.Clean(child))
	if parentErr != nil || childErr != nil {
		return false
	}
	relative, err := filepath.Rel(parent, child)
	return err == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator))
}
