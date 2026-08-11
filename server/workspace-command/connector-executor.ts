import type { KeyLike } from 'node:crypto';
import {
  isWorkspaceCommandConnectorResult,
  isWorkspaceCommandConnectorWireRequest,
  type WorkspaceCommandConnectorAdapter,
  type WorkspaceCommandConnectorOperation,
  type WorkspaceCommandConnectorResult,
  type WorkspaceCommandConnectorWireRequest
} from './connector-contract';
import {
  verifyWorkspaceCommandGrant,
  WorkspaceCommandReplayProtection
} from './connector-grant';
import {
  ConnectorRuntimeMaintenanceBusyError,
  type ConnectorRuntimeMaintenanceAdmission
} from '../connector-runtime-maintenance-safety';

export class WorkspaceCommandConnectorExecutor {
  private expectedGeneration?: number;
  private readonly replay = new WorkspaceCommandReplayProtection();
  constructor(
    private readonly adapter: WorkspaceCommandConnectorAdapter,
    private readonly verificationKey: KeyLike,
    private readonly machineId?: string,
    private readonly maintenanceAdmission?: ConnectorRuntimeMaintenanceAdmission
  ) {}

  setExpectedGeneration(generation?: number) {
    this.expectedGeneration = generation;
  }

  async execute(
    operation: WorkspaceCommandConnectorOperation,
    request: WorkspaceCommandConnectorWireRequest
  ): Promise<WorkspaceCommandConnectorResult> {
    if (this.machineId && request.machineId !== this.machineId)
      throw new Error('Connector received a workspace command for a different machine.');
    if (!isWorkspaceCommandConnectorWireRequest(request) || request.operation !== operation)
      throw new Error('Connector received an invalid workspace command.');
    const actor = verifyWorkspaceCommandGrant(
      request.grant, operation, request, this.verificationKey, { replay: this.replay }
    );
    if (this.expectedGeneration !== undefined && actor.generation !== this.expectedGeneration)
      throw new Error('Workspace command grant belongs to a stale connector generation.');
    const mutates = operation !== 'status';
    const admission = mutates ? this.maintenanceAdmission?.tryBeginActivity('workspace') : undefined;
    if (mutates && this.maintenanceAdmission && !admission) {
      throw new ConnectorRuntimeMaintenanceBusyError();
    }
    const { grant: _grant, ...trusted } = request;
    try {
      const result = await this.adapter.execute({ ...trusted, actor });
      if (!isWorkspaceCommandConnectorResult(result) || result.machineId !== request.machineId ||
          result.generation !== actor.generation || result.operation !== operation ||
          result.commandId !== request.commandId || result.environmentId !== request.environmentId ||
          result.executionId !== request.executionId || result.workspaceId !== request.workspaceId)
        throw new Error('Connector returned workspace command state for a different target.');
      return result;
    } finally {
      admission?.release();
    }
  }
}
