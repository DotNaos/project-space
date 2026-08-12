//go:build !windows

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"path/filepath"
	"testing"

	"github.com/DotNaos/project-space/internal/worktreecheckout"
	"github.com/DotNaos/project-space/internal/worktreeownership"
)

func TestWorktreePrepareControlBindsExactMaterializationAndOmitsPath(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	request := controlGatewayOperationRequest{
		Branch: "issue-658-safe", Commit: "0123456789abcdef0123456789abcdef01234567",
		EnvironmentID: controlTestIdentity().EnvironmentID, Operation: "worktree.prepare.v1",
		OperationID: "prepare-1", Repository: "DotNaos/project-space",
		WorkspaceID:           "123e4567-e89b-42d3-a456-426614174001",
		WorktreeOwnerThreadID: "019ff2a1-7f21-7f22-98c9-f47c47b4238b",
	}
	path := filepath.Join(home, "projects", ".worktrees", "project-space", request.Branch)
	var output bytes.Buffer
	err := executeWorktreePrepareControlWith(&output, controlTestIdentity(), request,
		func(_ context.Context, input worktreecheckout.Request) (worktreecheckout.Result, error) {
			if input.WorktreesRoot != filepath.Join(home, "projects", ".worktrees") ||
				input.Repository != request.Repository || input.Branch != request.Branch || input.Commit != request.Commit {
				t.Fatalf("materialize input changed: %#v", input)
			}
			return worktreecheckout.Result{Branch: input.Branch, Commit: input.Commit, Path: path, Repository: input.Repository, Status: "created"}, nil
		},
		func(input worktreeownership.ExactClaimOptions) (worktreeownership.Result, error) {
			if input.StartPath != path || input.ThreadID != request.WorktreeOwnerThreadID || input.WorkspaceID != request.WorkspaceID {
				t.Fatalf("claim input changed: %#v", input)
			}
			return worktreeownership.Result{Branch: request.Branch, Owner: input.ThreadID, Status: "claimed", WorkspaceID: input.WorkspaceID}, nil
		})
	if err != nil {
		t.Fatal(err)
	}
	var result map[string]any
	if json.Unmarshal(output.Bytes(), &result) != nil {
		t.Fatal("invalid result")
	}
	if result["state"] != "ready" || result["workspaceId"] != request.WorkspaceID || result["branch"] != request.Branch {
		t.Fatalf("unexpected result: %#v", result)
	}
	for _, forbidden := range []string{"path", "repository", "worktreeOwnerThreadId"} {
		if _, present := result[forbidden]; present {
			t.Fatalf("leaked %s", forbidden)
		}
	}
}
