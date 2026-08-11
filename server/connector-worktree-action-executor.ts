import type { KeyLike } from 'node:crypto';
import {
  isConnectorWorktreeActionResult,
  isConnectorWorktreeActionWireRequest,
  type ConnectorWorktreeActionAdapter,
  type ConnectorWorktreeActionOperation,
  type ConnectorWorktreeActionResult,
  type ConnectorWorktreeActionWireRequest
} from './connector-worktree-action-contract';
import {
  verifyConnectorWorktreeActionGrant,
  WorktreeActionReplayProtection
} from './connector-worktree-action-grant';
import {
  ConnectorRuntimeMaintenanceBusyError,
  type ConnectorRuntimeMaintenanceAdmission
} from './connector-runtime-maintenance-safety';

export class ConnectorWorktreeActionExecutor {
  private readonly replay = new WorktreeActionReplayProtection();
  constructor(
    private readonly adapter: ConnectorWorktreeActionAdapter,
    private readonly key: KeyLike,
    private readonly expectedMachineId?: string,
    private readonly maintenanceAdmission?: ConnectorRuntimeMaintenanceAdmission
  ) {}
  async execute(
    operation: ConnectorWorktreeActionOperation,
    request: ConnectorWorktreeActionWireRequest
  ): Promise<ConnectorWorktreeActionResult> {
    if (this.expectedMachineId && request.machineId !== this.expectedMachineId)
      throw new Error('Connector received an invalid worktree action.');
    if (!isConnectorWorktreeActionWireRequest(request) || request.operation !== operation)
      throw new Error('Connector received an invalid worktree action.');
    const actor = verifyConnectorWorktreeActionGrant(request.grant, operation, request, this.key, {
      replay: this.replay
    });
    const mutates = operation !== 'setup.inspect';
    const admission = mutates ? this.maintenanceAdmission?.tryBeginActivity('worktree') : undefined;
    if (mutates && this.maintenanceAdmission && !admission) {
      throw new ConnectorRuntimeMaintenanceBusyError();
    }
    const { grant: _grant, ...trusted } = request;
    try {
      const result = await this.adapter.runWorktreeAction({ ...trusted, actor });
      if (
        !isConnectorWorktreeActionResult(result) ||
        result.machineId !== request.machineId ||
        result.projectId !== request.projectId ||
        result.operation !== operation ||
        result.generation !== actor.generation
      )
        throw new Error('Connector returned worktree action state for a different target.');
      if (
        request.operation === 'materialize' &&
        (result.operation !== 'materialize' ||
          result.branchName !== request.branchName ||
          result.commitSha !== request.commitSha)
      )
        throw new Error('Connector returned materialization state for a different branch.');
      if (
        request.operation !== 'materialize' &&
        (result.operation === 'materialize' || result.worktreeId !== request.worktreeId)
      )
        throw new Error('Connector returned setup state for a different worktree.');
      return result;
    } finally {
      admission?.release();
    }
  }
}
