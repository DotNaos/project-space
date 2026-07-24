import type {
  MachineReadinessFixRequest,
  MachineReadinessFixResult,
  MachineReadinessResult,
  MachineReadinessSelector
} from '../../src/shared/machine-readiness-api';
import { MACHINE_READINESS_API_VERSION } from '../../src/shared/machine-readiness-api';
import type {
  MachineRecord,
  PhysicalMachineRecord
} from '../../src/shared/project-space-api';
import type {
  MachineRuntimeOperationRequest,
  MachineRuntimeOperationResult,
  MachineRuntimeStatusResult
} from '../../src/shared/connector-runtime-api';
import { evaluateMachineReadiness } from './model';

export type MachineReadinessServiceErrorCode =
  | 'invalid-request'
  | 'no-repair'
  | 'stale-plan'
  | 'unauthorized';

export class MachineReadinessServiceError extends Error {
  constructor(
    readonly code: MachineReadinessServiceErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'MachineReadinessServiceError';
  }
}

export interface MachineReadinessServiceOptions {
  generationFor(connectorId: string): number | undefined;
  inventory(userId: string): Promise<{
    connectors: MachineRecord[];
    physicalMachines: PhysicalMachineRecord[];
  }>;
  runtimeStatus(connectorId: string, userId: string): Promise<MachineRuntimeStatusResult>;
  startRuntimeOperation(
    connectorId: string,
    request: MachineRuntimeOperationRequest,
    userId: string
  ): Promise<MachineRuntimeOperationResult>;
}

export function createMachineReadinessService(options: MachineReadinessServiceOptions) {
  async function diagnose(
    actor: { userId: string },
    selector: MachineReadinessSelector
  ): Promise<MachineReadinessResult> {
    if (!actor.userId) {
      throw new MachineReadinessServiceError('unauthorized', 'Authentication is required.');
    }
    const inventory = await options.inventory(actor.userId);
    const selectedPhysical = inventory.physicalMachines.filter((machine) =>
      selector.physicalMachineId
        ? machine.id === selector.physicalMachineId
        : selector.physicalMachineName
          ? machine.name === selector.physicalMachineName
          : false
    );
    const connectorIds = new Set(
      selectedPhysical.flatMap((machine) => selector.connectorId
        ? machine.connectorIds.filter((id) => id === selector.connectorId)
        : machine.connectorIds)
    );
    const statuses = new Map<string, MachineRuntimeStatusResult>();
    await Promise.all([...connectorIds].map(async (connectorId) => {
      try {
        statuses.set(
          connectorId,
          await options.runtimeStatus(connectorId, actor.userId)
        );
      } catch {
        // The canonical model keeps missing or unavailable evidence uncertain.
      }
    }));
    return evaluateMachineReadiness({
      ...selector,
      ...inventory,
      generationFor: options.generationFor,
      runtimeStatuses: statuses
    });
  }

  return {
    diagnose,

    async fix(
      actor: { userId: string },
      request: MachineReadinessFixRequest
    ): Promise<MachineReadinessFixResult> {
      const before = await diagnose(actor, request);
      if (!before.plan) {
        if (before.ready) {
          return {
            apiVersion: MACHINE_READINESS_API_VERSION,
            diagnosis: before,
            operationId: request.operationId,
            state: 'converged'
          };
        }
        throw new MachineReadinessServiceError(
          'no-repair',
          'Doctor has no safe managed repair for the current readiness state.'
        );
      }
      if (before.plan.id !== request.planId) {
        throw new MachineReadinessServiceError(
          'stale-plan',
          'Machine readiness changed; review the new Doctor plan before confirming.'
        );
      }
      const action = before.plan.actions[0];
      if (before.plan.actions.length !== 1 || !action ||
          (action.kind !== 'update-connector' && action.kind !== 'restart-connector') ||
          (action.operation !== 'update' && action.operation !== 'restart') ||
          (action.kind === 'update-connector' &&
            (action.operation !== 'update' || !action.releaseId)) ||
          (action.kind === 'restart-connector' &&
            (action.operation !== 'restart' || action.releaseId !== undefined))) {
        throw new MachineReadinessServiceError(
          'no-repair',
          'Doctor will not execute an unsupported or unconstrained repair plan.'
        );
      }
      const started = await options.startRuntimeOperation(action.connectorId, {
        operation: action.operation,
        ...(action.releaseId ? { releaseId: action.releaseId } : {})
      }, actor.userId);
      const diagnosis = await diagnose(actor, request);
      return {
        apiVersion: MACHINE_READINESS_API_VERSION,
        diagnosis,
        operationId: request.operationId,
        runtimeOperation: started.operation,
        state: repairState(diagnosis)
      };
    }
  };
}

function repairState(
  result: MachineReadinessResult
): MachineReadinessFixResult['state'] {
  if (result.state === 'ready' || result.state === 'repaired') return 'repaired';
  if (result.state === 'rolled-back') return 'rolled-back';
  if (result.state === 'recovery-required') return 'recovery-required';
  if (result.state === 'failed') return 'failed';
  if (result.state === 'manually-blocked' || result.state === 'unsupported' ||
      result.state === 'authorization-required' || result.state === 'unauthorized' ||
      result.state === 'ambiguous') return 'blocked';
  if (result.state === 'repairing' || result.state === 'rolling-back') {
    return 'repairing';
  }
  return 'verification-pending';
}
