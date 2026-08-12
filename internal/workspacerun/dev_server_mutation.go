package workspacerun

import (
	"context"
	"fmt"
	"regexp"

	"github.com/DotNaos/project-space/internal/projectrun"
)

var remoteOperationIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$`)

type projectPublisher interface {
	PublishExpected(context.Context, string, string, string, string, string, []string) (projectrun.ServeResult, error)
}

// MutateDevServer changes one manifest-declared server through the active
// Workspace runtime ledger. It never accepts a host path, command, argv, or
// environment from the remote request.
func (manager *Manager) MutateDevServer(
	ctx context.Context,
	directory string,
	operation string,
	operationID string,
	serverID string,
	expectedServerGeneration string,
	options OperationOptions,
) (DevServerMutationResult, error) {
	if operation != "start" && operation != "publish" && operation != "stop" ||
		!declarationNamePattern.MatchString(serverID) || !remoteOperationIDPattern.MatchString(operationID) {
		return DevServerMutationResult{}, fmt.Errorf("dev-server mutation is invalid")
	}
	identity, err := manager.identity.Resolve(ctx, directory)
	if err != nil {
		return DevServerMutationResult{}, err
	}
	if err := manager.checkout.Verify(ctx, identity, options); err != nil {
		return DevServerMutationResult{}, err
	}
	var result DevServerMutationResult
	err = manager.store.withLock(identity.WorkspaceID, func() error {
		recoveredPublish := false
		record, exists, err := manager.store.load(identity)
		if err != nil {
			return err
		}
		if !exists || record.State != StateRunning {
			return fmt.Errorf("active Workspace runtime is required")
		}
		if err := verifyStoredBinding(record, options); err != nil {
			return err
		}
		if !containsName(record.ExpectedDevServers, serverID) {
			return fmt.Errorf("dev server is not declared by the active Workspace runtime")
		}
		if operation == "publish" && completedPublishMatches(
			record.CompletedDevServerMutation, operationID, serverID, expectedServerGeneration,
		) {
			index := managedServerIndex(record.DevServers, serverID)
			if index < 0 || record.DevServers[index].ServerGeneration !=
				record.CompletedDevServerMutation.ResultServerGeneration {
				return fmt.Errorf("completed dev-server publish evidence changed")
			}
			result = devServerMutationResult(record.DevServers[index], "published")
			return manager.syncRuntimeSessionState(record)
		}
		requestedAction := devServerAction(operation + "ing")
		if operation == "stop" {
			requestedAction = devServerStopping
		}
		if record.DevServerOperation != nil {
			if record.DevServerOperation.Name != serverID || record.DevServerOperation.Action != requestedAction ||
				record.DevServerOperation.OperationID != operationID ||
				record.DevServerOperation.ServerGeneration != expectedServerGeneration {
				return fmt.Errorf("another dev-server mutation is unresolved")
			}
			if requestedAction == devServerPublishing {
				if err := manager.recoverPublishedServer(ctx, &record); err != nil {
					return err
				}
				recoveredPublish = true
			} else if err := manager.reconcileDevServerLedger(ctx, &record); err != nil {
				return err
			}
		}
		index := managedServerIndex(record.DevServers, serverID)
		switch operation {
		case "start":
			if index < 0 {
				if err := manager.startRemoteServer(ctx, &record, operationID, serverID); err != nil {
					return err
				}
				index = managedServerIndex(record.DevServers, serverID)
			} else if record.DevServers[index].ServerGeneration == "" {
				return fmt.Errorf("dev-server generation evidence is unavailable")
			}
			server := record.DevServers[index]
			result = devServerMutationResult(server, "ready")
		case "publish":
			if recoveredPublish {
				index = managedServerIndex(record.DevServers, serverID)
				if index < 0 {
					return fmt.Errorf("published dev-server evidence is missing")
				}
				result = devServerMutationResult(record.DevServers[index], "published")
				break
			}
			if index < 0 || expectedServerGeneration == "" ||
				record.DevServers[index].ServerGeneration != expectedServerGeneration {
				return fmt.Errorf("dev-server generation binding changed")
			}
			server := record.DevServers[index]
			if server.State == string(projectrun.StateRunning) {
				return fmt.Errorf("dev server is already published by another operation")
			}
			if server.State != string(projectrun.StateRunning) {
				record.DevServerOperation = &devServerOperation{
					Name: serverID, Action: devServerPublishing, OperationID: operationID,
					ServerGeneration: expectedServerGeneration,
				}
				record.CheckedAt = manager.timestamp()
				if err := manager.store.save(record); err != nil {
					return err
				}
				if err := manager.recoverPublishedServer(ctx, &record); err != nil {
					return err
				}
				index = managedServerIndex(record.DevServers, serverID)
				server = record.DevServers[index]
			}
			result = devServerMutationResult(server, "published")
		case "stop":
			if index < 0 {
				result = DevServerMutationResult{ServerID: serverID, ServerGeneration: expectedServerGeneration, State: "stopped"}
				break
			}
			server := record.DevServers[index]
			if expectedServerGeneration == "" || server.ServerGeneration != expectedServerGeneration {
				return fmt.Errorf("dev-server generation binding changed")
			}
			record.DevServerOperation = &devServerOperation{
				Name: serverID, Action: devServerStopping, OperationID: operationID,
				ServerGeneration: expectedServerGeneration,
			}
			record.CheckedAt = manager.timestamp()
			if err := manager.store.save(record); err != nil {
				return err
			}
			if _, err := manager.project.StopExpected(ctx, record.Directory, serverID, record.WorkspaceID, record.Generation); err != nil {
				return err
			}
			record.DevServers = withoutDevServer(record.DevServers, serverID)
			record.DevServerOperation = nil
			record.CheckedAt = manager.timestamp()
			if err := manager.store.save(record); err != nil {
				return err
			}
			result = DevServerMutationResult{ServerID: serverID, ServerGeneration: server.ServerGeneration, State: "stopped"}
		}
		return manager.syncRuntimeSessionState(record)
	})
	return result, err
}

func (manager *Manager) startRemoteServer(ctx context.Context, record *runtimeRecord, operationID, serverID string) error {
	record.DevServerOperation = &devServerOperation{
		Name: serverID, Action: devServerStarting, OperationID: operationID,
	}
	record.CheckedAt = manager.timestamp()
	if err := manager.store.save(*record); err != nil {
		return err
	}
	server, err := manager.project.StartWithOptions(ctx, record.Directory, serverID, projectrun.StartOptions{
		LocalOnly: true, APIs: projectrun.APIsModeSimulated, Data: projectrun.DataModeLocal,
		WorkspaceID: record.WorkspaceID, RuntimeGeneration: record.Generation,
		Environment: generationEnvironment(manager.store.generationHome(record.WorkspaceID, record.Generation), record.binding()),
	})
	if err != nil {
		return err
	}
	managed := serverFromResult(serverID, server)
	if err := exactServer(*record, server, managed); err != nil {
		return err
	}
	record.DevServers = append(record.DevServers, managed)
	record.DevServerOperation = nil
	record.CheckedAt = manager.timestamp()
	return manager.store.save(*record)
}

func (manager *Manager) recoverPublishedServer(ctx context.Context, record *runtimeRecord) error {
	operation := record.DevServerOperation
	if operation == nil || operation.Action != devServerPublishing {
		return fmt.Errorf("dev-server publish intent is missing")
	}
	listing, err := manager.project.ObserveSessions(ctx)
	if err != nil || listing.ErrorCount != 0 {
		return fmt.Errorf("read-only dev-server inventory is incomplete")
	}
	var candidate *projectrun.ServeResult
	for index := range listing.Sessions {
		observed := &listing.Sessions[index]
		sameCheckout := observed.Directory == record.Directory && observed.Script == operation.Name
		sameBinding := observed.WorkspaceID == record.WorkspaceID && observed.RuntimeGeneration == record.Generation
		if !sameCheckout && !sameBinding {
			continue
		}
		if !sameCheckout || !sameBinding || candidate != nil {
			return fmt.Errorf("dev-server publish evidence is foreign or ambiguous")
		}
		candidate = observed
	}
	publisher, ok := manager.project.(projectPublisher)
	if !ok {
		return fmt.Errorf("owned dev-server publication is unavailable")
	}
	environment := generationEnvironment(manager.store.generationHome(record.WorkspaceID, record.Generation), record.binding())
	var published projectrun.ServeResult
	if candidate != nil && candidate.State == projectrun.StateRunning && candidate.Mode == projectrun.ServeModeManaged {
		published = *candidate
	} else if candidate != nil {
		if candidate.ServerGeneration != operation.ServerGeneration {
			return fmt.Errorf("dev-server generation changed during publication")
		}
		published, err = publisher.PublishExpected(
			ctx, record.Directory, operation.Name, record.WorkspaceID, record.Generation,
			operation.ServerGeneration, environment,
		)
	} else {
		published, err = manager.project.StartWithOptions(ctx, record.Directory, operation.Name, projectrun.StartOptions{
			APIs: projectrun.APIsModeSimulated, Data: projectrun.DataModeLocal,
			WorkspaceID: record.WorkspaceID, RuntimeGeneration: record.Generation, Environment: environment,
		})
	}
	if err != nil {
		return err
	}
	managed := serverFromResult(operation.Name, published)
	if published.State != projectrun.StateRunning || published.Mode != projectrun.ServeModeManaged ||
		exactServer(*record, published, managed) != nil {
		return fmt.Errorf("published dev-server ownership evidence is invalid")
	}
	record.DevServers = withoutDevServer(record.DevServers, operation.Name)
	record.DevServers = append(record.DevServers, managed)
	record.CompletedDevServerMutation = &completedDevServerMutation{
		Name: operation.Name, Action: devServerPublishing, OperationID: operation.OperationID,
		ExpectedServerGeneration: operation.ServerGeneration,
		ResultServerGeneration:   managed.ServerGeneration,
	}
	record.DevServerOperation = nil
	record.CheckedAt = manager.timestamp()
	return manager.store.save(*record)
}

func completedPublishMatches(
	completed *completedDevServerMutation,
	operationID string,
	serverID string,
	expectedServerGeneration string,
) bool {
	return completed != nil && completed.Action == devServerPublishing &&
		completed.OperationID == operationID && completed.Name == serverID &&
		completed.ExpectedServerGeneration == expectedServerGeneration
}

func containsName(values []string, expected string) bool {
	for _, value := range values {
		if value == expected {
			return true
		}
	}
	return false
}

func managedServerIndex(values []ManagedDevServer, name string) int {
	for index := range values {
		if values[index].Name == name {
			return index
		}
	}
	return -1
}

func devServerMutationResult(server ManagedDevServer, state string) DevServerMutationResult {
	return DevServerMutationResult{
		ServerID: server.Name, ServerGeneration: server.ServerGeneration,
		State: state,
	}
}
