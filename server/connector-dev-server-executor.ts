import type { KeyLike } from 'node:crypto';

import {
  ConnectorCommandReplayProtection,
  verifyConnectorCommandGrant
} from './connector-command-grant';
import {
  connectorDevServerErrorResult,
  connectorDevServerListErrorResult,
  isConnectorDevServerListResult,
  isConnectorDevServerListWireRequest,
  isConnectorDevServerResult,
  isConnectorDevServerWireRequest,
  type ConnectorDevServerAdapter,
  type ConnectorDevServerAnyWireRequest,
  type ConnectorDevServerListWireRequest,
  type ConnectorDevServerListResult,
  type ConnectorDevServerOperation,
  type ConnectorDevServerResult,
  type ConnectorDevServerWireRequest
} from './connector-dev-server-contract';
import type { ConnectorRuntimeMaintenanceAdmission } from './connector-runtime-maintenance-safety';

const maintenanceMessage = 'Connector runtime maintenance is in progress.';

function resultMatchesRequest(
  result: ConnectorDevServerResult,
  request: ConnectorDevServerWireRequest
) {
  return (
    result.machineId === request.machineId &&
    result.projectId === request.projectId &&
    result.worktreeId === request.worktreeId &&
    result.serverId === request.serverId &&
    result.runTarget === request.runTarget &&
    result.generation === request.grant.generation
  );
}

export class ConnectorDevServerCommandExecutor {
  private readonly replayProtection = new ConnectorCommandReplayProtection();

  constructor(
    private readonly adapter: ConnectorDevServerAdapter,
    private readonly verificationKey: KeyLike,
    private readonly expectedMachineId?: string,
    private readonly maintenanceAdmission?: ConnectorRuntimeMaintenanceAdmission
  ) {}

  execute(
    operation: 'list',
    request: ConnectorDevServerListWireRequest
  ): Promise<ConnectorDevServerListResult>;
  execute(
    operation: Exclude<ConnectorDevServerOperation, 'list'>,
    request: ConnectorDevServerWireRequest
  ): Promise<ConnectorDevServerResult>;
  execute(
    operation: ConnectorDevServerOperation,
    request: ConnectorDevServerAnyWireRequest
  ): Promise<ConnectorDevServerResult | ConnectorDevServerListResult>;
  async execute(
    operation: ConnectorDevServerOperation,
    request: ConnectorDevServerAnyWireRequest
  ): Promise<ConnectorDevServerResult | ConnectorDevServerListResult> {
    if (this.expectedMachineId && request.machineId !== this.expectedMachineId) {
      if (operation === 'list' && isConnectorDevServerListWireRequest(request)) {
        return connectorDevServerListErrorResult(request, request.grant.generation);
      }
      return connectorDevServerErrorResult(
        request as ConnectorDevServerWireRequest,
        request.grant.generation,
        'Connector command authorization failed.'
      );
    }
    let actor;
    try {
      actor = verifyConnectorCommandGrant(request.grant, request, operation, this.verificationKey, {
        replayProtection: this.replayProtection
      });
    } catch {
      if (operation === 'list' && isConnectorDevServerListWireRequest(request)) {
        return connectorDevServerListErrorResult(request, request.grant.generation);
      }
      return connectorDevServerErrorResult(
        request as ConnectorDevServerWireRequest,
        request.grant.generation,
        'Connector command authorization failed.'
      );
    }

    const mutates = operation === 'start' || operation === 'stop';
    const admission = mutates
      ? this.maintenanceAdmission?.tryBeginActivity('dev-server')
      : undefined;
    if (mutates && this.maintenanceAdmission && !admission) {
      return connectorDevServerErrorResult(
        request as ConnectorDevServerWireRequest,
        actor.generation,
        maintenanceMessage,
        'unavailable'
      );
    }

    try {
      if (operation === 'list') {
        if (!isConnectorDevServerListWireRequest(request)) {
          throw new Error('The connector received an invalid dev-server inventory request.');
        }
        const result = await this.adapter.listDevServers({
          actor,
          expectedHeadSha: request.expectedHeadSha,
          machineId: request.machineId,
          operation,
          projectId: request.projectId,
          worktreeId: request.worktreeId
        });
        if (
          !isConnectorDevServerListResult(result) ||
          result.machineId !== request.machineId ||
          result.projectId !== request.projectId ||
          result.worktreeId !== request.worktreeId ||
          result.generation !== request.grant.generation
        ) {
          return connectorDevServerListErrorResult(request, actor.generation);
        }
        return result;
      }
      if (!isConnectorDevServerWireRequest(request)) {
        throw new Error('The connector received an invalid dev-server command request.');
      }
      const result = await this.adapter.runDevServerCommand({
        actor,
        allowedHosts: request.allowedHosts,
        expectedHeadSha: request.expectedHeadSha,
        machineId: request.machineId,
        operation,
        projectId: request.projectId,
        runTarget: request.runTarget,
        serverId: request.serverId,
        worktreeId: request.worktreeId
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
      if (operation === 'list' && isConnectorDevServerListWireRequest(request)) {
        return connectorDevServerListErrorResult(request, actor.generation);
      }
      return connectorDevServerErrorResult(
        request as ConnectorDevServerWireRequest,
        actor.generation,
        error instanceof Error
          ? error.message
          : 'The connector could not run the dev-server command.'
      );
    } finally {
      admission?.release();
    }
  }
}
