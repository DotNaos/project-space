package workspacerun

import (
	"context"

	"github.com/DotNaos/project-space/internal/workspacesession"
)

type SessionMutationAdapter struct {
	Manager *Manager
}

func (adapter SessionMutationAdapter) MutateDevServer(
	ctx context.Context,
	request workspacesession.DevServerMutationRequest,
) (workspacesession.DevServerMutationOutput, error) {
	result, err := adapter.Manager.MutateDevServer(
		ctx, request.Directory, request.Operation, request.OperationID, request.ServerID, request.ExpectedServerGeneration,
		OperationOptions{
			ExpectedWorkspaceID: request.WorkspaceID, ExpectedCommit: request.ExpectedCommit,
			ExpectedDigest: request.ExpectedManifestDigest, ExpectedGeneration: request.ExpectedGeneration,
			TrustedGateway: true,
		},
	)
	return workspacesession.DevServerMutationOutput{
		ServerID: result.ServerID, ServerGeneration: result.ServerGeneration,
		State: result.State,
	}, err
}
