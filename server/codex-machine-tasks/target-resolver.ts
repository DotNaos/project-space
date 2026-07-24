import type {
  CodexMachineTaskBlockedReason,
  CodexMachineTaskTarget
} from '../../src/shared/codex-machine-tasks-api';
import type {
  MachineRecord,
  PhysicalMachineRecord
} from '../../src/shared/project-space-api';
import type { MachineRuntimeStatusResult } from '../../src/shared/connector-runtime-api';
import { evaluateMachineReadiness } from '../machine-readiness/model';

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
  connectors: readonly MachineRecord[];
  generationFor(connectorId: string): number | undefined;
  physicalMachineId?: string;
  physicalMachineName?: string;
  physicalMachines: readonly PhysicalMachineRecord[];
  runtimeStatuses?: ReadonlyMap<string, MachineRuntimeStatusResult>;
  userCanUseConnector?(connectorId: string): boolean;
}): CodexMachineTaskTarget {
  const physicalMachine = selectPhysicalMachine(input);
  const readiness = evaluateMachineReadiness({
    ...input,
    checkedAt: new Date(0).toISOString()
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
    physicalMachine: { id: physicalMachine.id, name: physicalMachine.name }
  };
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
