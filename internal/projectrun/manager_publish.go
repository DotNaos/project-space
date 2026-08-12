package projectrun

import (
	"context"
	"fmt"
)

// PublishExpected replaces one exact local-only Workspace server with a
// tailnet-published generation. The caller must persist its higher-level
// intent before entering this boundary because the replacement spans a stop
// and a start.
func (manager *Manager) PublishExpected(
	ctx context.Context,
	directory string,
	scriptName string,
	workspaceID string,
	runtimeGeneration string,
	serverGeneration string,
	environment []string,
) (ServeResult, error) {
	if workspaceID == "" || runtimeGeneration == "" || serverGeneration == "" {
		err := fmt.Errorf("expected Workspace, runtime, and server generation bindings are required")
		return manager.runtimeErrorResult("publish", directory, scriptName, err), err
	}
	identity, err := manager.identity.Resolve(ctx, directory, scriptName)
	if err != nil {
		return ServeResult{}, fmt.Errorf("serve publication identity is unavailable")
	}
	listing, err := manager.ObserveSessions(ctx)
	if err != nil || listing.ErrorCount != 0 {
		return ServeResult{}, fmt.Errorf("read-only serve ownership inventory is incomplete")
	}
	var current ServeResult
	found := false
	for _, observed := range listing.Sessions {
		sameCheckout := observed.ServerID == identity.ServerID && observed.Script == scriptName
		sameBinding := observed.WorkspaceID == workspaceID && observed.RuntimeGeneration == runtimeGeneration
		if !sameCheckout && !sameBinding {
			continue
		}
		if !sameCheckout || !sameBinding || found {
			return ServeResult{}, fmt.Errorf("serve publication evidence is foreign or ambiguous")
		}
		current, found = observed, true
	}
	if !found {
		return ServeResult{}, fmt.Errorf("expected serve session was not found")
	}
	if current.WorkspaceID != workspaceID || current.RuntimeGeneration != runtimeGeneration ||
		current.ServerGeneration != serverGeneration {
		err := fmt.Errorf("serve session belongs to a different Workspace or server generation")
		return current, err
	}
	if current.State == StateRunning && current.Mode == ServeModeManaged {
		current.Operation = "publish"
		current.Disposition = ServeDispositionReused
		return current, nil
	}
	if current.State != StateLocalOnly || current.Mode != ServeModeLocalOnly {
		err := fmt.Errorf("only an exact healthy local-only serve session can be published")
		return current, err
	}
	options := StartOptions{
		AllowedHosts: current.AllowedHosts, APIs: current.APIs, Data: current.Data,
		WorkspaceID: workspaceID, RuntimeGeneration: runtimeGeneration,
		Environment: append([]string{}, environment...),
	}
	if _, err := manager.StopExpected(ctx, directory, scriptName, workspaceID, runtimeGeneration); err != nil {
		return current, err
	}
	published, err := manager.StartWithOptions(ctx, directory, scriptName, options)
	published.Operation = "publish"
	return published, err
}
