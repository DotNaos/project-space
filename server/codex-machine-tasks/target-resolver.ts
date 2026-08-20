import type {
  CodexMachineTaskBlockedReason,
  CodexMachineTaskReadRequest,
  CodexMachineTaskTarget,
  CodexMachineTaskUnavailableResult
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
    message: string,
    readonly unavailable?: CodexMachineTaskUnavailableResult
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
  computeInventory?: ComputeInventorySnapshot;
  connectors: readonly MachineRecord[];
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
    const unavailable = unavailableHostAssociation(input, matches.length);
    if (unavailable) {
      throw new CodexMachineTaskTargetError(
        'unauthorized',
        unavailableMessage(unavailable.state),
        unavailable
      );
    }
    throw new CodexMachineTaskTargetError(
      'unauthorized',
      'Select one exact physical machine.'
    );
  }
  return matches[0]!;
}

function unavailableHostAssociation(
  input: {
    computeInventory?: ComputeInventorySnapshot;
    connectorId?: string;
    connectors: readonly MachineRecord[];
    physicalMachineId?: string;
    physicalMachineName?: string;
  },
  selectableMatches: number
): CodexMachineTaskUnavailableResult | undefined {
  if (selectableMatches !== 0 || !input.computeInventory) {
    return undefined;
  }
  // Diagnostic metadata is derived only from the already owner-scoped
  // inventory. An absent or duplicate Host stays indistinguishable from an
  // unauthorized cross-owner selector.
  const activeConnectorIds = new Set(input.connectors.map(({ id }) => id));
  const activeAssociations = input.computeInventory.connectors
    .filter(({ connectorId }) => activeConnectorIds.has(connectorId))
  const selectedHosts = input.physicalMachineId
    ? input.computeInventory.hosts.filter(({ id }) => id === input.physicalMachineId)
    : input.physicalMachineName
      ? input.computeInventory.hosts.filter(({ name }) => name === input.physicalMachineName)
      : [];
  const activeEnvironmentIds = selectedHosts.length === 1
    ? new Set(activeAssociations.map(({ environmentId }) => environmentId))
    : !input.physicalMachineId && !input.physicalMachineName && input.connectorId &&
        input.connectors.filter(({ id }) => id === input.connectorId).length === 1
      ? new Set(activeAssociations
          .filter(({ connectorId }) => connectorId === input.connectorId)
          .map(({ environmentId }) => environmentId))
      : undefined;
  if (!activeEnvironmentIds) return undefined;
  const environments = input.computeInventory.environments.filter((environment) =>
    activeEnvironmentIds.has(environment.id) &&
    (selectedHosts.length === 0 || environment.platformId === selectedHosts[0]!.platformId)
  );
  const precise = environments.length === 1 ? environments[0] : undefined;
  const state = precise?.hostAssociation.resolution === 'conflict'
    ? 'conflicting'
    : precise?.hostAssociation.resolution === 'unresolved'
      ? 'unresolved'
      : 'missing';
  return { kind: 'environment_host_association', state };
}

function unavailableMessage(state: CodexMachineTaskUnavailableResult['state']) {
  switch (state) {
    case 'missing':
      return 'No user-owned Environment has verified association evidence for the selected Host. Assign this Host to the intended Environment, then retry.';
    case 'unresolved':
      return 'Host selection is unavailable because a user-owned Workspace Environment has unresolved Host association evidence. Assign the selected Host to the intended Environment, then retry.';
    case 'conflicting':
      return 'Host selection is unavailable because a user-owned Workspace Environment has conflicting Host association evidence. Resolve the Host association in Compute, then retry.';
  }
}
