import type {
  CodexMachineTaskBlockedReason,
  CodexMachineTaskReadRequest,
  CodexMachineTaskTarget
} from '../../src/shared/codex-machine-tasks-api';
import type {
  MachineRecord,
  PhysicalMachineRecord
} from '../../src/shared/project-space-api';
import type { MachineRuntimeStatusResult } from '../../src/shared/connector-runtime-api';
import type { ComputeInventorySnapshot } from '../../src/shared/compute-environment-api';
import { evaluateMachineReadiness } from '../machine-readiness/model';
import type { CodexMachineTasksServiceOptions } from './contracts';

export type CodexMachineTaskTargetSelector = Pick<
  CodexMachineTaskReadRequest,
  'connectorId' | 'environmentId' | 'physicalMachineId' | 'physicalMachineName'
>;

export class CodexMachineTaskTargetError extends Error {
  constructor(
    readonly reason: Extract<
      CodexMachineTaskBlockedReason,
      'connector_required' | 'machine_not_ready' | 'offline' | 'stale_connector' | 'unauthorized'
    >,
    message: string
  ) {
    super(message);
    this.name = 'CodexMachineTaskTargetError';
  }
}

export function resolveCodexMachineTaskTarget(input: {
  connectorId?: string;
  computeInventory?: ComputeInventorySnapshot;
  connectors: readonly MachineRecord[];
  environmentId?: string;
  generationFor(connectorId: string): number | undefined;
  physicalMachineId?: string;
  physicalMachineName?: string;
  physicalMachines: readonly PhysicalMachineRecord[];
  runtimeStatuses?: ReadonlyMap<string, MachineRuntimeStatusResult>;
  userCanUseConnector?(connectorId: string): boolean;
}): CodexMachineTaskTarget {
  const environment = selectEnvironment(input);
  const physicalMachine = environment
    ? {
        connectorIds: input.computeInventory!.connectors
          .filter(({ environmentId }) => environmentId === environment.id)
          .map(({ connectorId }) => connectorId),
        id: environment.id,
        name: environment.name
      }
    : selectPhysicalMachine(input);
  const readiness = evaluateMachineReadiness({
    ...input,
    checkedAt: new Date(0).toISOString(),
    physicalMachineId: physicalMachine.id,
    physicalMachineName: undefined,
    physicalMachines: environment ? [physicalMachine] : input.physicalMachines
  });
  if (readiness.state === 'ambiguous') {
    throw new CodexMachineTaskTargetError(
      'connector_required',
      `${readiness.message} Run ${doctorCommand(physicalMachine)}.`
    );
  }
  if (readiness.state === 'unauthorized') {
    throw new CodexMachineTaskTargetError('unauthorized', readiness.message);
  }
  if (input.connectorId && input.userCanUseConnector?.(input.connectorId) === false) {
    throw new CodexMachineTaskTargetError('unauthorized', 'Connector access is required.');
  }
  if (!readiness.ready || !readiness.selectedConnectorId) {
    const reason = readiness.state === 'unreachable'
      ? 'offline'
      : readiness.state === 'uncertain'
        ? 'stale_connector'
        : 'machine_not_ready';
    throw new CodexMachineTaskTargetError(
      reason,
      `${readiness.message} Run ${doctorCommand(physicalMachine)}.`
    );
  }
  const selected = input.connectors.find(
    (connector) => connector.id === readiness.selectedConnectorId
  );
  if (!selected) {
    throw new CodexMachineTaskTargetError(
      'offline',
      `${readiness.message} Run ${doctorCommand(physicalMachine)}.`
    );
  }
  if (input.userCanUseConnector?.(selected.id) === false) {
    throw new CodexMachineTaskTargetError('unauthorized', 'Connector access is required.');
  }
  const generation = input.generationFor(selected.id);
  if (!generation) {
    throw new CodexMachineTaskTargetError(
      'stale_connector',
      'The connector session is stale and must reconnect.'
    );
  }

  return {
    connector: {
      ...(selected.environment
        ? { environment: selected.environment.label ?? selected.environment.kind }
        : {}),
      generation,
      id: selected.id,
      name: selected.name
    },
    ...(environment ? { environment: { id: environment.id, name: environment.name } } : {}),
    physicalMachine: { id: physicalMachine.id, name: physicalMachine.name }
  };
}

export async function resolveCodexMachineTaskServiceTarget(
  options: Pick<
    CodexMachineTasksServiceOptions,
    'generationFor' | 'inventory' | 'userCanUseConnector'
  >,
  userId: string,
  selector: CodexMachineTaskTargetSelector,
  callerMachineId?: string
) {
  const inventory = await options.inventory(userId);
  const callerPhysicalMachine = !selector.environmentId && !selector.physicalMachineId &&
    !selector.physicalMachineName && callerMachineId
    ? inventory.physicalMachines.find((machine) => machine.connectorIds.includes(callerMachineId))
    : undefined;
  return resolveCodexMachineTaskTarget({
    ...selector,
    connectorId: selector.connectorId ?? (callerPhysicalMachine ? callerMachineId : undefined),
    physicalMachineId: selector.physicalMachineId ?? callerPhysicalMachine?.id,
    ...inventory,
    generationFor: options.generationFor,
    userCanUseConnector: options.userCanUseConnector
      ? (connectorId) => options.userCanUseConnector!(userId, connectorId)
      : undefined
  });
}

function selectEnvironment(input: {
  computeInventory?: ComputeInventorySnapshot;
  connectorId?: string;
  environmentId?: string;
}) {
  if (!input.environmentId) return undefined;
  const environment = input.computeInventory?.environments.find(
    ({ id }) => id === input.environmentId
  );
  if (!environment) {
    throw new CodexMachineTaskTargetError('unauthorized', 'Select one exact environment.');
  }
  const connectorIds = input.computeInventory!.connectors
    .filter(({ environmentId }) => environmentId === environment.id)
    .map(({ connectorId }) => connectorId);
  if (input.connectorId && !connectorIds.includes(input.connectorId)) {
    throw new CodexMachineTaskTargetError(
      'unauthorized',
      'The selected connector does not belong to the selected environment.'
    );
  }
  if (connectorIds.length === 0) {
    throw new CodexMachineTaskTargetError('offline', 'The selected environment has no connector.');
  }
  return environment;
}

function doctorCommand(machine: PhysicalMachineRecord) {
  return `project doctor --machine-id ${machine.id}`;
}

function selectPhysicalMachine(input: {
  physicalMachineId?: string;
  physicalMachineName?: string;
  physicalMachines: readonly PhysicalMachineRecord[];
}) {
  const matches = input.physicalMachines.filter((machine) => (
    input.physicalMachineId
      ? machine.id === input.physicalMachineId
      : input.physicalMachineName
        ? machine.name === input.physicalMachineName
        : false
  ));
  if (matches.length !== 1) {
    throw new CodexMachineTaskTargetError(
      'unauthorized',
      'Select one exact physical machine.'
    );
  }
  return matches[0]!;
}
