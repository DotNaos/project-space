package main

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"

	"github.com/DotNaos/project-space/internal/worktreecheckout"
	"github.com/DotNaos/project-space/internal/worktreeownership"
)

type controlWorktreePrepareResult struct {
	Branch                 string `json:"branch"`
	CheckedAt              string `json:"checkedAt"`
	Commit                 string `json:"commit"`
	Operation              string `json:"operation"`
	OperationID            string `json:"operationId"`
	SchemaVersion          int    `json:"schemaVersion"`
	State                  string `json:"state"`
	TargetIdentityRevision string `json:"targetIdentityRevision"`
	Type                   string `json:"type"`
	WorkspaceID            string `json:"workspaceId"`
}

func executeWorktreePrepareControl(output io.Writer, identity controlGatewayIdentity, request controlGatewayOperationRequest) error {
	return executeWorktreePrepareControlWith(output, identity, request, worktreecheckout.Materialize, worktreeownership.ClaimExact)
}

func executeWorktreePrepareControlWith(
	output io.Writer,
	identity controlGatewayIdentity,
	request controlGatewayOperationRequest,
	materialize func(context.Context, worktreecheckout.Request) (worktreecheckout.Result, error),
	claim func(worktreeownership.ExactClaimOptions) (worktreeownership.Result, error),
) error {
	if request.Operation != "worktree.prepare.v1" || !controlWorkspaceIDPattern.MatchString(request.WorkspaceID) ||
		!controlWorkspaceIDPattern.MatchString(request.WorktreeOwnerThreadID) ||
		!controlCommitPattern.MatchString(request.Commit) || !validControlText(request.Branch, 255) ||
		!repositoryPattern.MatchString(request.Repository) {
		return fmt.Errorf("invalid control operation")
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return fmt.Errorf("managed worktree root is unavailable")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	materialized, err := materialize(ctx, worktreecheckout.Request{
		Repository: request.Repository, Branch: request.Branch, Commit: request.Commit,
		WorktreesRoot: filepath.Join(home, "projects", ".worktrees"),
	})
	if err != nil {
		return fmt.Errorf("Worktree preparation failed")
	}
	claimed, err := claim(worktreeownership.ExactClaimOptions{
		StartPath: materialized.Path, TaskName: request.Branch,
		ThreadID: request.WorktreeOwnerThreadID, WorkspaceID: request.WorkspaceID,
	})
	if err != nil || claimed.WorkspaceID != request.WorkspaceID || claimed.Branch != request.Branch {
		return fmt.Errorf("Worktree ownership confirmation failed")
	}
	return writeControlFrame(output, controlWorktreePrepareResult{
		Branch: request.Branch, CheckedAt: time.Now().UTC().Format(time.RFC3339Nano),
		Commit: request.Commit, Operation: request.Operation, OperationID: request.OperationID,
		SchemaVersion: controlSchemaVersion, State: "ready",
		TargetIdentityRevision: identity.TargetIdentityRevision, Type: "result", WorkspaceID: request.WorkspaceID,
	})
}
