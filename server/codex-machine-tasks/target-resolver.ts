import type {
  CodexMachineTaskBlockedReason,
  CodexMachineTaskTarget
} from '../../src/shared/codex-machine-tasks-api';
import { CODEX_MACHINE_TASKS_CONNECTOR_CAPABILITY } from '../../src/shared/codex-machine-tasks-api';
import type {
  MachineRecord,
  PhysicalMachineRecord
} from '../../src/shared/project-space-api';

export class CodexMachineTaskTargetError extends Error {
  constructor(
    readonly reason: Extract<
      CodexMachineTaskBlockedReason,
      'connector_required' | 'offline' | 'stale_connector' | 'unauthorized'
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
  userCanUseConnector?(connectorId: string): boolean;
}): CodexMachineTaskTarget {
  const physicalMachine = selectPhysicalMachine(input);
  const connectorRecords = new Map(input.connectors.map((connector) => [connector.id, connector]));
  const members = physicalMachine.connectorIds
    .map((id) => connectorRecords.get(id))
    .filter((connector): connector is MachineRecord => Boolean(connector));
  const capable = members.filter((connector) => (
    connector.connector.status === 'online' &&
    connector.connector.capabilities?.includes(CODEX_MACHINE_TASKS_CONNECTOR_CAPABILITY)
  ));

  if (input.connectorId && !physicalMachine.connectorIds.includes(input.connectorId)) {
    throw new CodexMachineTaskTargetError(
      'unauthorized',
      'The connector does not belong to the selected physical machine.'
    );
  }
  if (input.connectorId && input.userCanUseConnector?.(input.connectorId) === false) {
    throw new CodexMachineTaskTargetError('unauthorized', 'Connector access is required.');
  }

  const selected = input.connectorId
    ? capable.find((connector) => connector.id === input.connectorId)
    : capable.length === 1 ? capable[0] : undefined;
  if (!selected) {
    if (!input.connectorId && capable.length > 1) {
      throw new CodexMachineTaskTargetError(
        'connector_required',
        'Choose the exact connector installation for this physical machine.'
      );
    }
    throw new CodexMachineTaskTargetError(
      'offline',
      'No online Codex-capable connector is available on this physical machine.'
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
