package workspacerun

import (
	"context"
	"errors"
	"fmt"
	"reflect"

	"github.com/DotNaos/project-space/internal/projectrun"
)

// reconcileDevServerLedger classifies all Project Serve sessions before any
// cleanup. It may adopt only the exact session named by a previously persisted
// start intent, or confirm absence after a persisted stop intent.
func (manager *Manager) reconcileDevServerLedger(ctx context.Context, record *runtimeRecord) error {
	listing, listErr := manager.project.ObserveSessions(ctx)
	if listErr != nil || listing.ErrorCount != 0 {
		return errors.Join(listErr, fmt.Errorf("read-only Workspace dev-server inventory is incomplete"))
	}
	expected := map[string]bool{}
	for _, name := range record.ExpectedDevServers {
		expected[name] = true
	}
	exact := map[string]projectrun.ServeResult{}
	unhealthy := map[string]projectrun.ServeResult{}
	seen := map[string]bool{}
	for _, session := range listing.Sessions {
		relevantName := expected[session.Script]
		sameCheckout := session.Directory == record.Directory && relevantName
		sameBinding := session.WorkspaceID == record.WorkspaceID && session.RuntimeGeneration == record.Generation
		if !sameCheckout && !sameBinding {
			continue
		}
		if !sameCheckout || !sameBinding {
			return fmt.Errorf("dev server %q has foreign or unhealthy Workspace evidence", session.Script)
		}
		if seen[session.Script] {
			return fmt.Errorf("dev server %q has ambiguous Workspace evidence", session.Script)
		}
		seen[session.Script] = true
		if session.LastError != nil || (session.State != projectrun.StateRunning && session.State != projectrun.StateLocalOnly) {
			unhealthy[session.Script] = session
		} else {
			exact[session.Script] = session
		}
	}

	next := append([]ManagedDevServer{}, record.DevServers...)
	operation := record.DevServerOperation
	if operation != nil {
		_, unhealthyPresent := unhealthy[operation.Name]
		if unhealthyPresent {
			if _, err := manager.project.StopExpected(ctx, record.Directory, operation.Name, record.WorkspaceID, record.Generation); err != nil {
				return fmt.Errorf("finish interrupted dev-server %s: %w", operation.Action, err)
			}
			delete(unhealthy, operation.Name)
			next = withoutDevServer(next, operation.Name)
		}
		candidate, present := exact[operation.Name]
		switch operation.Action {
		case devServerStarting:
			if present && !unhealthyPresent {
				next = append(next, serverFromResult(operation.Name, candidate))
			}
		case devServerStopping:
			if present {
				if _, err := manager.project.StopExpected(ctx, record.Directory, operation.Name, record.WorkspaceID, record.Generation); err != nil {
					return fmt.Errorf("finish interrupted dev-server stop: %w", err)
				}
				delete(exact, operation.Name)
			}
			if !present || unhealthyPresent {
				next = withoutDevServer(next, operation.Name)
			}
		}
	}
	if len(unhealthy) != 0 {
		return errors.Join(listErr, fmt.Errorf("unhealthy dev-server evidence remains outside the persisted operation"))
	}
	for _, persisted := range next {
		candidate, present := exact[persisted.Name]
		if !present {
			next = withoutDevServer(next, persisted.Name)
			continue
		}
		if err := exactServer(*record, candidate, persisted); err != nil {
			return err
		}
		delete(exact, persisted.Name)
	}
	if operation != nil && operation.Action == devServerStarting {
		delete(exact, operation.Name)
	}
	if len(exact) != 0 {
		return fmt.Errorf("unrecorded dev-server resource exists for Workspace generation")
	}
	changed := !reflect.DeepEqual(record.DevServers, next) || record.DevServerOperation != nil
	record.DevServers = next
	record.DevServerOperation = nil
	if changed {
		record.CheckedAt = manager.timestamp()
		return manager.store.save(*record)
	}
	return nil
}

func withoutDevServer(servers []ManagedDevServer, name string) []ManagedDevServer {
	result := make([]ManagedDevServer, 0, len(servers))
	for _, server := range servers {
		if server.Name != name {
			result = append(result, server)
		}
	}
	return result
}
