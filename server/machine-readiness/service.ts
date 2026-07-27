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
import type {
  CodexDaemonConnectorResult,
  CodexDaemonEvidence,
  CodexDaemonOperation
} from '../../src/shared/codex-daemon-api';
import {
  codexDaemonEvidenceIsConsistent,
  codexDaemonResultStateForEvidence
} from '../../src/shared/codex-daemon-api';
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
  startDaemonOperation?(
    connectorId: string,
    operation: CodexDaemonOperation,
    operationId: string,
    userId: string
  ): Promise<CodexDaemonConnectorResult>;
  startRuntimeOperation(
    connectorId: string,
    request: MachineRuntimeOperationRequest,
    userId: string
  ): Promise<MachineRuntimeOperationResult>;
}

export function createMachineReadinessService(options: MachineReadinessServiceOptions) {
  async function diagnose(
    actor: { userId: string },
    selector: MachineReadinessSelector,
    daemonOverride?: { connectorId: string; evidence: CodexDaemonEvidence }
  ): Promise<MachineReadinessResult> {
    if (!actor.userId) {
      throw new MachineReadinessServiceError('unauthorized', 'Authentication is required.');
    }
    const inventory = withDaemonEvidence(
      await options.inventory(actor.userId),
      daemonOverride
    );
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
          ![
            'ensure-codex-daemon', 'restart-codex-daemon',
            'update-connector', 'restart-connector'
          ].includes(action.kind) ||
          !['ensure', 'update', 'restart'].includes(action.operation) ||
          (action.kind === 'update-connector' &&
            (action.operation !== 'update' || !action.releaseId)) ||
          (action.kind === 'restart-connector' &&
            (action.operation !== 'restart' || action.releaseId !== undefined)) ||
          (action.kind === 'ensure-codex-daemon' &&
            (action.operation !== 'ensure' || action.releaseId !== undefined)) ||
          (action.kind === 'restart-codex-daemon' &&
            (action.operation !== 'restart' || action.releaseId !== undefined))) {
        throw new MachineReadinessServiceError(
          'no-repair',
          'Doctor will not execute an unsupported or unconstrained repair plan.'
        );
      }
      const daemonAction = action.kind === 'ensure-codex-daemon' ||
        action.kind === 'restart-codex-daemon';
      if (daemonAction && !options.startDaemonOperation) {
        throw new MachineReadinessServiceError(
          'no-repair',
          'Doctor cannot dispatch the constrained managed daemon repair.'
        );
      }
      const daemonOperation = daemonAction
        ? await options.startDaemonOperation!(
            action.connectorId,
            action.operation as 'ensure' | 'restart',
            request.operationId,
            actor.userId
          )
        : undefined;
      const daemonVerification = daemonAction
        ? await options.startDaemonOperation!(
            action.connectorId,
            'status',
            daemonVerificationOperationId(request.operationId),
            actor.userId
          )
        : undefined;
      const started = daemonAction
        ? undefined
        : await options.startRuntimeOperation(action.connectorId, {
            operation: action.operation as 'restart' | 'update',
            ...(action.releaseId ? { releaseId: action.releaseId } : {})
          }, actor.userId);
      const diagnosis = await diagnose(
        actor,
        request,
        freshDaemonOverride(
          before,
          action.connectorId,
          daemonVerificationOperationId(request.operationId),
          daemonVerification
        )
      );
      return {
        apiVersion: MACHINE_READINESS_API_VERSION,
        diagnosis,
        ...(daemonOperation ? { daemonOperation } : {}),
        operationId: request.operationId,
        ...(started ? { runtimeOperation: started.operation } : {}),
        state: repairState(diagnosis)
      };
    }
  };
}

function daemonVerificationOperationId(operationId: string) {
  const digest = createHash('sha256').update(operationId).digest('hex').slice(0, 32);
  return `doctor:daemon-status:${digest}`;
}

function freshDaemonOverride(
  before: MachineReadinessResult,
  connectorId: string,
  operationId: string,
  operation: CodexDaemonConnectorResult | undefined
) {
  if (!operation || operation.operationId !== operationId ||
      operation.operation !== 'status' ||
      operation.state !== codexDaemonResultStateForEvidence(operation.evidence) ||
      !codexDaemonEvidenceIsConsistent(operation.evidence)) return undefined;
  const priorCheckedAt = before.checks.find((check) =>
    check.connectorId === connectorId
  )?.daemon?.checkedAt;
  const priorTime = priorCheckedAt ? Date.parse(priorCheckedAt) : Number.NaN;
  const evidenceTime = Date.parse(operation.evidence.checkedAt);
  if (!Number.isFinite(priorTime) || !Number.isFinite(evidenceTime) ||
      evidenceTime <= priorTime || evidenceTime > Date.now() + 5 * 60_000) return undefined;
  return { connectorId, evidence: operation.evidence };
}

function withDaemonEvidence(
  inventory: { connectors: MachineRecord[]; physicalMachines: PhysicalMachineRecord[] },
  override: { connectorId: string; evidence: CodexDaemonEvidence } | undefined
) {
  if (!override) return inventory;
  return {
    ...inventory,
    connectors: inventory.connectors.map((machine) => {
      if (machine.id !== override.connectorId) return machine;
      const capabilities = new Set(machine.connector.capabilities ?? []);
      if (override.evidence.state === 'ready') capabilities.add('codex.machine-tasks.v1');
      return {
        ...machine,
        connector: {
          ...machine.connector,
          capabilities: [...capabilities],
          daemon: override.evidence
        }
      };
    })
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
import { createHash } from 'node:crypto';
