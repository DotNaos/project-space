package main

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/DotNaos/project-space/internal/projectstorage"
)

func TestEvaluatePullRequestEvidenceDistinguishesRecoveryStates(t *testing.T) {
	mergedAt := "2026-08-15T12:00:00Z"
	candidate := projectstorage.PurgeCandidate{
		Branch: "issue-765-safe-wip", HeadSHA: strings.Repeat("a", 40), Repository: "DotNaos/project-space",
	}
	exact := func(state string) pullRequestRecord {
		return pullRequestRecord{
			HeadRefName: candidate.Branch, HeadRefOID: candidate.HeadSHA,
			HeadRepository: &pullRequestRepository{NameWithOwner: candidate.Repository},
			Number:         765, State: state, URL: "https://github.com/DotNaos/project-space/pull/766",
		}
	}

	tests := []struct {
		name         string
		records      []pullRequestRecord
		policy       worktreePurgePolicy
		wantBlocker  string
		wantRecovery string
	}{
		{name: "merged exact head", records: func() []pullRequestRecord {
			record := exact("MERGED")
			record.MergedAt = &mergedAt
			return []pullRequestRecord{record}
		}(), wantRecovery: "merged"},
		{name: "open exact head requires opt in", records: []pullRequestRecord{exact("OPEN")}, wantBlocker: "open_pull_request_requires_opt_in"},
		{name: "open exact head with opt in", records: []pullRequestRecord{exact("OPEN")}, policy: worktreePurgePolicy{IncludeOpenPRs: true}, wantRecovery: "open-pr-backed"},
		{name: "draft open exact head with opt in", records: func() []pullRequestRecord {
			record := exact("OPEN")
			record.IsDraft = true
			return []pullRequestRecord{record}
		}(), policy: worktreePurgePolicy{IncludeOpenPRs: true}, wantRecovery: "open-pr-backed"},
		{name: "closed unmerged exact head", records: []pullRequestRecord{exact("CLOSED")}, policy: worktreePurgePolicy{IncludeOpenPRs: true}, wantBlocker: "pull_request_not_merged"},
		{name: "different head", records: func() []pullRequestRecord {
			record := exact("OPEN")
			record.HeadRefOID = strings.Repeat("b", 40)
			return []pullRequestRecord{record}
		}(), policy: worktreePurgePolicy{IncludeOpenPRs: true}, wantBlocker: "pull_request_not_found"},
		{name: "fork head", records: func() []pullRequestRecord {
			record := exact("OPEN")
			record.HeadRepository.NameWithOwner = "someone/project-space"
			return []pullRequestRecord{record}
		}(), policy: worktreePurgePolicy{IncludeOpenPRs: true}, wantBlocker: "pull_request_head_repository_mismatch"},
		{name: "no pull request", policy: worktreePurgePolicy{IncludeOpenPRs: true}, wantBlocker: "pull_request_not_found"},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			result := evaluatePullRequestEvidence(candidate, test.records, test.policy)
			if test.wantBlocker != "" {
				if len(result.Blockers) != 1 || result.Blockers[0].Code != test.wantBlocker || len(result.Evidence) != 0 {
					t.Fatalf("result = %#v", result)
				}
				return
			}
			if len(result.Blockers) != 0 || len(result.Evidence) != 1 || result.Evidence[0].RecoveryState != test.wantRecovery {
				t.Fatalf("result = %#v", result)
			}
			if result.Evidence[0].PullRequest != 765 || result.Evidence[0].URL == "" {
				t.Fatalf("evidence = %#v", result.Evidence[0])
			}
		})
	}
}

func TestIntegrationWorktreeEvidenceBlocksOpenPullRequestWhenRemoteHeadDiffers(t *testing.T) {
	candidate := projectstorage.PurgeCandidate{
		Branch: "issue-765-safe-wip", HeadSHA: strings.Repeat("a", 40), Repository: "DotNaos/project-space", Path: t.TempDir(),
	}
	record := pullRequestRecord{
		HeadRefName: candidate.Branch, HeadRefOID: candidate.HeadSHA,
		HeadRepository: &pullRequestRepository{NameWithOwner: candidate.Repository},
		Number:         766, State: "OPEN", URL: "https://github.com/DotNaos/project-space/pull/766",
	}
	payload, err := json.Marshal([]pullRequestRecord{record})
	if err != nil {
		t.Fatal(err)
	}
	githubCalled := false
	check := integrationWorktreeEvidenceWithCommand(worktreePurgePolicy{IncludeOpenPRs: true}, func(
		_ context.Context, _ string, name string, args ...string,
	) (string, error) {
		if name == "git" && len(args) > 0 && args[0] == "fetch" {
			return "", nil
		}
		if name == "git" && len(args) > 0 && args[0] == "rev-parse" {
			return strings.Repeat("b", 40) + "\n", nil
		}
		if name == "gh" {
			githubCalled = true
			return string(payload), nil
		}
		return "", errors.New("unexpected command")
	})

	result, err := check(context.Background(), candidate)
	if err != nil {
		t.Fatal(err)
	}
	if !githubCalled || len(result.Blockers) != 1 || result.Blockers[0].Code != "remote_head_mismatch" {
		t.Fatalf("result = %#v githubCalled=%v", result, githubCalled)
	}
}

func TestIntegrationWorktreeEvidenceAcceptsExactOpenPullRequestOnlyWithOptIn(t *testing.T) {
	candidate := projectstorage.PurgeCandidate{
		Branch: "issue-765-safe-wip", HeadSHA: strings.Repeat("a", 40), Repository: "DotNaos/project-space", Path: t.TempDir(),
	}
	record := pullRequestRecord{
		HeadRefName: candidate.Branch, HeadRefOID: candidate.HeadSHA,
		HeadRepository: &pullRequestRepository{NameWithOwner: candidate.Repository},
		Number:         766, State: "OPEN", URL: "https://github.com/DotNaos/project-space/pull/766",
	}
	payload, err := json.Marshal([]pullRequestRecord{record})
	if err != nil {
		t.Fatal(err)
	}
	check := integrationWorktreeEvidenceWithCommand(worktreePurgePolicy{IncludeOpenPRs: true}, func(
		_ context.Context, _ string, name string, args ...string,
	) (string, error) {
		if name == "git" && len(args) > 0 && args[0] == "fetch" {
			return "", nil
		}
		if name == "git" && len(args) > 0 && args[0] == "rev-parse" {
			return candidate.HeadSHA + "\n", nil
		}
		if name == "gh" {
			if !strings.Contains(strings.Join(args, " "), "headRepository") {
				t.Fatal("GitHub query omitted head repository ownership")
			}
			return string(payload), nil
		}
		return "", errors.New("unexpected command")
	})

	result, err := check(context.Background(), candidate)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Blockers) != 0 || len(result.Evidence) != 1 || result.Evidence[0].RecoveryState != "open-pr-backed" {
		t.Fatalf("result = %#v", result)
	}
}

func TestIntegrationWorktreeEvidenceUsesMergedPullRequestAfterRemoteBranchDeletion(t *testing.T) {
	mergedAt := "2026-08-15T12:00:00Z"
	candidate := projectstorage.PurgeCandidate{
		Branch: "issue-765-safe-wip", HeadSHA: strings.Repeat("a", 40), Repository: "DotNaos/project-space", Path: t.TempDir(),
	}
	record := pullRequestRecord{
		HeadRefName: candidate.Branch, HeadRefOID: candidate.HeadSHA,
		HeadRepository: &pullRequestRepository{NameWithOwner: candidate.Repository},
		MergedAt:       &mergedAt, Number: 766, State: "MERGED", URL: "https://github.com/DotNaos/project-space/pull/766",
	}
	payload, err := json.Marshal([]pullRequestRecord{record})
	if err != nil {
		t.Fatal(err)
	}
	remoteHeadChecked := false
	check := integrationWorktreeEvidenceWithCommand(worktreePurgePolicy{}, func(
		_ context.Context, _ string, name string, args ...string,
	) (string, error) {
		if name == "git" && len(args) > 0 && args[0] == "fetch" {
			return "", nil
		}
		if name == "git" && len(args) > 0 && args[0] == "rev-parse" {
			remoteHeadChecked = true
			return "", errors.New("remote branch was deleted")
		}
		if name == "gh" {
			return string(payload), nil
		}
		return "", errors.New("unexpected command")
	})

	result, err := check(context.Background(), candidate)
	if err != nil {
		t.Fatal(err)
	}
	if remoteHeadChecked || len(result.Blockers) != 0 || len(result.Evidence) != 1 || result.Evidence[0].RecoveryState != "merged" {
		t.Fatalf("result = %#v remoteHeadChecked=%v", result, remoteHeadChecked)
	}
}
