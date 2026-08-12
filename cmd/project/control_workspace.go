package main

import (
	"context"
	"fmt"
	"io"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/DotNaos/project-space/internal/workspacerun"
)

var controlWorkspaceIDPattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
var controlDigestPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)
var controlCommitPattern = regexp.MustCompile(`^(?:[a-f0-9]{40}|[a-f0-9]{64})$`)
var controlGenerationPattern = regexp.MustCompile(`^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$`)

var workspaceControlOperations = map[string]string{
	"workspace-runtime.start.v1":     "start",
	"workspace-runtime.inspect.v1":   "inspect",
	"workspace-runtime.suspend.v1":   "suspend",
	"workspace-runtime.resume.v1":    "resume",
	"workspace-runtime.stop.v1":      "stop",
	"workspace-runtime.clean.v1":     "clean",
	"workspace-runtime.reconcile.v1": "reconcile",
}

func controlOperations() []string {
	return []string{
		"status.v1",
		"workspace-runtime.clean.v1",
		"workspace-runtime.inspect.v1",
		"workspace-runtime.reconcile.v1",
		"workspace-runtime.resume.v1",
		"workspace-runtime.start.v1",
		"workspace-runtime.stop.v1",
		"workspace-runtime.suspend.v1",
	}
}

type controlWorkspaceRuntimeResult struct {
	CheckedAt              string                    `json:"checkedAt"`
	Disposition            workspacerun.Disposition  `json:"disposition,omitempty"`
	Generation             string                    `json:"generation,omitempty"`
	ManifestDigest         string                    `json:"manifestDigest"`
	Mode                   workspacerun.Mode         `json:"mode"`
	Operation              string                    `json:"operation"`
	OperationID            string                    `json:"operationId"`
	SchemaVersion          int                       `json:"schemaVersion"`
	SourceHead             string                    `json:"sourceHead"`
	State                  workspacerun.RuntimeState `json:"state"`
	TargetIdentityRevision string                    `json:"targetIdentityRevision"`
	Type                   string                    `json:"type"`
	WorkspaceID            string                    `json:"workspaceId"`
}

func executeWorkspaceRuntimeControl(
	output io.Writer,
	identity controlGatewayIdentity,
	request controlGatewayOperationRequest,
	factory func() (workspaceRuntimeManager, error),
) error {
	operation, ok := workspaceControlOperations[request.Operation]
	directory, workspaceExists := identity.Workspaces[request.WorkspaceID]
	if !ok || !workspaceExists || !validWorkspaceControlRequest(request, operation) {
		return fmt.Errorf("invalid control operation")
	}
	manager, err := factory()
	if err != nil {
		return fmt.Errorf("Workspace runtime is unavailable")
	}
	options := workspacerun.OperationOptions{
		Mode: workspacerun.Mode(request.Mode), ExpectedWorkspaceID: request.WorkspaceID, ExpectedCommit: request.ExpectedCommit,
		ExpectedDigest: request.ExpectedManifestDigest, ExpectedGeneration: request.ExpectedGeneration,
		TrustedGateway: true,
	}
	streams := workspacerun.Streams{Out: io.Discard, Err: io.Discard}
	operationContext, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	var result workspacerun.Result
	switch operation {
	case "start":
		result, err = manager.Start(operationContext, directory, options, streams)
	case "inspect":
		result, err = manager.Inspect(operationContext, directory, options)
	case "suspend":
		result, err = manager.Suspend(operationContext, directory, options)
	case "resume":
		result, err = manager.Resume(operationContext, directory, options)
	case "stop":
		result, err = manager.Stop(operationContext, directory, options, streams)
	case "clean":
		result, err = manager.Clean(operationContext, directory, options)
	case "reconcile":
		result, err = manager.Reconcile(operationContext, directory, options)
	}
	if err != nil {
		return fmt.Errorf("Workspace runtime operation failed")
	}
	if result.Operation != operation || result.WorkspaceID != request.WorkspaceID || result.ManifestDigest != request.ExpectedManifestDigest ||
		result.SourceHead != request.ExpectedCommit || result.Mode != workspacerun.Mode(request.Mode) {
		return fmt.Errorf("Workspace runtime result binding changed")
	}
	if operation == "start" {
		if !controlGenerationPattern.MatchString(result.Generation) {
			return fmt.Errorf("Workspace runtime result generation is invalid")
		}
	} else if result.Generation != request.ExpectedGeneration {
		return fmt.Errorf("Workspace runtime result generation changed")
	}
	return writeControlFrame(output, controlWorkspaceRuntimeResult{
		CheckedAt: result.CheckedAt, Disposition: result.Disposition, Generation: result.Generation,
		ManifestDigest: result.ManifestDigest, Mode: result.Mode, Operation: request.Operation,
		OperationID: request.OperationID, SchemaVersion: controlSchemaVersion, SourceHead: result.SourceHead,
		State: result.State, TargetIdentityRevision: identity.TargetIdentityRevision,
		Type: "result", WorkspaceID: result.WorkspaceID,
	})
}

func validWorkspaceControlRequest(request controlGatewayOperationRequest, operation string) bool {
	if !controlWorkspaceIDPattern.MatchString(request.WorkspaceID) ||
		!controlCommitPattern.MatchString(request.ExpectedCommit) ||
		!controlDigestPattern.MatchString(request.ExpectedManifestDigest) ||
		(request.Mode != string(workspacerun.ModeProcess) && request.Mode != string(workspacerun.ModeDevcontainer)) {
		return false
	}
	if operation == "start" {
		return request.ExpectedGeneration == ""
	}
	return controlGenerationPattern.MatchString(request.ExpectedGeneration)
}

func validWorkspaceBindings(bindings map[string]string) bool {
	if len(bindings) > 128 {
		return false
	}
	for workspaceID, path := range bindings {
		if !controlWorkspaceIDPattern.MatchString(workspaceID) || path == "" || len(path) > 4096 ||
			!filepath.IsAbs(path) || filepath.Clean(path) != path || strings.TrimSpace(path) != path || strings.ContainsAny(path, "\x00\r\n") {
			return false
		}
	}
	return true
}
