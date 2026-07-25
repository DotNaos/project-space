import {
  isMachineResourceSnapshot,
  type MachineResourceSnapshot
} from '../src/shared/machine-resources-api';

export interface StoredMachineResourceSnapshot {
  receivedAt: string;
  snapshot: MachineResourceSnapshot;
}

const snapshots = new Map<string, StoredMachineResourceSnapshot>();

export function registerMachineResourceSnapshot(
  machineId: string,
  snapshot: MachineResourceSnapshot,
  receivedAt = new Date().toISOString()
) {
  if (
    !machineId ||
    snapshot.connectorId !== machineId ||
    !isMachineResourceSnapshot(snapshot) ||
    !Number.isFinite(Date.parse(receivedAt))
  ) {
    throw new Error('Machine resource snapshot is invalid.');
  }
  snapshots.set(machineId, {
    receivedAt,
    snapshot: structuredClone(snapshot)
  });
}

export function latestMachineResourceSnapshot(machineId: string) {
  const stored = snapshots.get(machineId);
  return stored ? structuredClone(stored) : undefined;
}

export function clearMachineResourceSnapshots() {
  snapshots.clear();
}
