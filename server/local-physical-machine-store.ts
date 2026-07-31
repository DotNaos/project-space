import { randomUUID } from 'node:crypto';

import type { PhysicalMachineRecord } from '../src/shared/project-space-api';

interface LocalPhysicalMachineSaveInput {
  allowedConnectorIds: readonly string[];
  connectorIds: readonly string[];
  kind: PhysicalMachineRecord['kind'];
  name: string;
  physicalMachineId?: string;
  userId: string;
}

export interface LocalPhysicalMachineStore {
  delete(userId: string, physicalMachineId: string): boolean;
  list(userId: string): PhysicalMachineRecord[];
  save(input: LocalPhysicalMachineSaveInput): PhysicalMachineRecord;
}

function cloneMachine(machine: PhysicalMachineRecord): PhysicalMachineRecord {
  return { ...machine, connectorIds: [...machine.connectorIds] };
}

export function createLocalPhysicalMachineStore(): LocalPhysicalMachineStore {
  const machinesByUser = new Map<string, PhysicalMachineRecord[]>();

  return {
    delete(userId, physicalMachineId) {
      const machines = machinesByUser.get(userId) ?? [];
      const target = machines.find((machine) => machine.id === physicalMachineId);
      if (!target || target.connectorIds.length > 0) return false;
      const remaining = machines.filter((machine) => machine.id !== physicalMachineId);
      machinesByUser.set(userId, remaining);
      return remaining.length !== machines.length;
    },

    list(userId) {
      return (machinesByUser.get(userId) ?? [])
        .map(cloneMachine)
        .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
    },

    save(input) {
      if (input.kind !== 'physical' && input.kind !== 'virtual') {
        throw new Error('Machine kind must be physical or virtual.');
      }
      const allowedConnectorIds = new Set(input.allowedConnectorIds);
      if (input.connectorIds.some((connectorId) => !allowedConnectorIds.has(connectorId))) {
        throw new Error('Only connector installations visible in this local workspace can be grouped.');
      }

      const physicalMachineId = input.physicalMachineId ?? randomUUID();
      const connectorIds = [...new Set(input.connectorIds)];
      const current = machinesByUser.get(input.userId) ?? [];
      const next = current
        .filter((machine) => machine.id !== physicalMachineId)
        .map((machine) => ({
          ...machine,
          connectorIds: machine.connectorIds.filter((id) => !connectorIds.includes(id))
        }));
      const machine = {
        connectorIds,
        id: physicalMachineId,
        kind: input.kind,
        name: input.name
      };
      machinesByUser.set(input.userId, [...next, machine]);
      return cloneMachine(machine);
    }
  };
}
