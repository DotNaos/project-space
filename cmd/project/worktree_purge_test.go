package main

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/DotNaos/project-space/internal/projectstorage"
)

func TestWorktreePurgeDefaultsToDryRunAndPrintsBlockers(t *testing.T) {
	local := t.TempDir()
	dependencies := worktreePurgeDependencies{
		Checks:      func(context.Context, worktreePurgePolicy) ([]projectstorage.EvidenceCheck, error) { return nil, nil },
		LoadCatalog: catalogLoader(testProjectCatalog(local)),
		Plan: func(context.Context, string, string, string, string, projectstorage.PurgeOptions) (projectstorage.PurgePlan, error) {
			return projectstorage.PurgePlan{
				Blockers:      []projectstorage.Blocker{{Code: "codex_thread_unarchived", Message: "Task still uses this worktree."}},
				Candidate:     &projectstorage.PurgeCandidate{Branch: "issue-1", WorktreeID: "wt_1234567890abcdef12345678"},
				SchemaVersion: 1,
			}, nil
		},
		Purge: func(context.Context, string, string, string, string, string, projectstorage.PurgeOptions) (projectstorage.PurgeResult, error) {
			t.Fatal("dry-run invoked purge")
			return projectstorage.PurgeResult{}, nil
		},
	}
	output := executeProjectsFeatureCommand(
		t, newWorktreePurgeCommandWithDependencies(dependencies),
		"--project", "project-space", "--id", "wt_1234567890abcdef12345678",
	)
	if !strings.Contains(output, "BLOCKED") || !strings.Contains(output, "codex_thread_unarchived") {
		t.Fatalf("output = %s", output)
	}
}

func TestWorktreePurgeApplyRequiresExpectedHeadAndReturnsVerifiedResult(t *testing.T) {
	local := t.TempDir()
	called := false
	dependencies := worktreePurgeDependencies{
		Checks:      func(context.Context, worktreePurgePolicy) ([]projectstorage.EvidenceCheck, error) { return nil, nil },
		LoadCatalog: catalogLoader(testProjectCatalog(local)),
		Plan:        projectstorage.PlanWorktreePurge,
		Purge: func(_ context.Context, _, _, _, id, head string, _ projectstorage.PurgeOptions) (projectstorage.PurgeResult, error) {
			called = true
			return projectstorage.PurgeResult{
				HeadSHA: head, MeasuredBytesRemoved: 123, Path: "/tmp/worktree",
				SchemaVersion: 1, State: "purged", Verified: true, WorktreeID: id,
			}, nil
		},
	}
	head := strings.Repeat("a", 40)
	output := executeProjectsFeatureCommand(
		t, newWorktreePurgeCommandWithDependencies(dependencies),
		"--project", "project-space", "--id", "wt_1234567890abcdef12345678",
		"--expect-head", head, "--apply", "--format", "json",
	)
	if !called {
		t.Fatal("purge was not called")
	}
	var result projectstorage.PurgeResult
	if err := json.Unmarshal([]byte(output), &result); err != nil {
		t.Fatal(err)
	}
	if !result.Verified || result.WorktreeID != "wt_1234567890abcdef12345678" {
		t.Fatalf("result = %#v", result)
	}
}

func TestWorktreePurgeOpenPullRequestsRequireExplicitPolicyFlag(t *testing.T) {
	local := t.TempDir()
	tests := []struct {
		name string
		args []string
		want bool
	}{
		{name: "default merged only", args: []string{"--project", "project-space", "--id", "wt_1234567890abcdef12345678"}},
		{name: "explicit open PR opt in", args: []string{"--project", "project-space", "--id", "wt_1234567890abcdef12345678", "--include-open-prs"}, want: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			seen := false
			dependencies := worktreePurgeDependencies{
				Checks: func(_ context.Context, policy worktreePurgePolicy) ([]projectstorage.EvidenceCheck, error) {
					seen = policy.IncludeOpenPRs
					return nil, nil
				},
				LoadCatalog: catalogLoader(testProjectCatalog(local)),
				Plan: func(context.Context, string, string, string, string, projectstorage.PurgeOptions) (projectstorage.PurgePlan, error) {
					return projectstorage.PurgePlan{
						Blockers: []projectstorage.Blocker{{Code: "pull_request_not_merged", Message: "blocked"}},
						Candidate: &projectstorage.PurgeCandidate{
							Branch: "issue-1", WorktreeID: "wt_1234567890abcdef12345678",
						},
						SchemaVersion: 1,
					}, nil
				},
			}
			executeProjectsFeatureCommand(t, newWorktreePurgeCommandWithDependencies(dependencies), test.args...)
			if seen != test.want {
				t.Fatalf("IncludeOpenPRs = %v, want %v", seen, test.want)
			}
		})
	}
}

func TestPathContainsRecognizesNestedTaskCwd(t *testing.T) {
	root := t.TempDir()
	if !pathContains(root, root+"/src") || pathContains(root, root+"-other") {
		t.Fatal("path containment is not boundary-aware")
	}
}

func TestWorktreeBatchApplyPurgesOnlyInitiallySafeCandidatesAndRechecks(t *testing.T) {
	local := t.TempDir()
	head := strings.Repeat("c", 40)
	checksCalls, purgeCalls := 0, 0
	safe := projectstorage.PurgePlan{
		Candidate: &projectstorage.PurgeCandidate{
			Branch: "safe", HeadSHA: head, Path: "/tmp/safe", WorktreeID: "wt_aaaaaaaaaaaaaaaaaaaaaaaa",
		},
		Purgeable: true, SchemaVersion: 1,
	}
	blocked := projectstorage.PurgePlan{
		Blockers: []projectstorage.Blocker{{Code: "untracked_changes", Message: "Untracked data would be removed."}},
		Candidate: &projectstorage.PurgeCandidate{
			Branch: "blocked", HeadSHA: head, Path: "/tmp/blocked", WorktreeID: "wt_bbbbbbbbbbbbbbbbbbbbbbbb",
		},
		SchemaVersion: 1,
	}
	dependencies := worktreePurgeDependencies{
		Checks: func(_ context.Context, policy worktreePurgePolicy) ([]projectstorage.EvidenceCheck, error) {
			checksCalls++
			if !policy.IncludeOpenPRs {
				t.Fatal("batch apply dropped the open pull request opt-in during a fresh safety check")
			}
			return nil, nil
		},
		LoadCatalog: catalogLoader(testProjectCatalog(local)),
		PlanAll: func(context.Context, string, string, string, projectstorage.PurgeOptions) (projectstorage.PurgeBatchPlan, error) {
			return projectstorage.PurgeBatchPlan{Plans: []projectstorage.PurgePlan{safe, blocked}, PurgeableCount: 1, SkippedCount: 1, SchemaVersion: 1}, nil
		},
		Purge: func(context.Context, string, string, string, string, string, projectstorage.PurgeOptions) (projectstorage.PurgeResult, error) {
			purgeCalls++
			return projectstorage.PurgeResult{FreeSpaceMeasured: true, FreeSpaceDeltaBytes: 50, State: "purged", Verified: true}, nil
		},
	}
	output := executeProjectsFeatureCommand(
		t, newWorktreePurgeCommandWithDependencies(dependencies),
		"--project", "project-space", "--all-safe", "--include-open-prs", "--apply", "--format", "json",
	)
	result := worktreeBatchResult{}
	if err := json.Unmarshal([]byte(output), &result); err != nil {
		t.Fatal(err)
	}
	if result.PurgedCount != 1 || result.SkippedCount != 1 || purgeCalls != 1 || checksCalls != 2 {
		t.Fatalf("result = %#v checks=%d purges=%d", result, checksCalls, purgeCalls)
	}
}
