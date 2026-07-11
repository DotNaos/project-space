import type { KeyLike } from 'node:crypto';

import {
  ConnectorCommandReplayProtection,
  verifyConnectorCommandGrant
} from './connector-command-grant';
import {
  connectorDevServerErrorResult,
  isConnectorDevServerResult,
  type ConnectorDevServerAdapter,
  type ConnectorDevServerOperation,
  type ConnectorDevServerResult,
  type ConnectorDevServerWireRequest
} from './connector-dev-server-contract';

function resultMatchesRequest(
  result: ConnectorDevServerResult,
  request: ConnectorDevServerWireRequest
) {
  return (
    result.machineId === request.machineId &&
    result.projectId === request.projectId &&
    result.worktreeId === request.worktreeId &&
    result.runTarget === request.runTarget &&
    result.generation === request.grant.generation
  );
}

export class ConnectorDevServerCommandExecutor {
  private readonly replayProtection = new ConnectorCommandReplayProtection();

  constructor(
    private readonly adapter: ConnectorDevServerAdapter,
    private readonly verificationKey: KeyLike
  ) {}

  async execute(
    operation: ConnectorDevServerOperation,
    request: ConnectorDevServerWireRequest
  ): Promise<ConnectorDevServerResult> {
    let actor;
    try {
      actor = verifyConnectorCommandGrant(request.grant, request, operation, this.verificationKey, {
        replayProtection: this.replayProtection
      });
    } catch {
      return connectorDevServerErrorResult(
        request,
        request.grant.generation,
        'Connector command authorization failed.'
      );
    }

    try {
      const result = await this.adapter.runDevServerCommand({
        actor,
        allowedHosts: request.allowedHosts,
        machineId: request.machineId,
        operation,
        projectId: request.projectId,
        runTarget: request.runTarget,
        worktreeId: request.worktreeId,
        worktreePath: request.worktreePath
      });
      if (!isConnectorDevServerResult(result) || !resultMatchesRequest(result, request)) {
        return connectorDevServerErrorResult(
          request,
          actor.generation,
          'The connector returned dev-server state for a different target.'
        );
      }
      return result;
    } catch (error) {
      return connectorDevServerErrorResult(
        request,
        actor.generation,
        error instanceof Error ? error.message : 'The connector could not run the dev-server command.'
      );
    }
  }
}
