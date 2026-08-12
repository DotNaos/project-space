import type { ConnectorOverviewResult, MachineRecord } from '@/shared/project-space-api';
import {
  latestRuntimeFailure,
  runtimeOperationLabel
} from './machine-connector-runtime-model';

export function machineDetailVersionLabel(version: string | undefined) {
  return version ? `v${version}` : 'unknown';
}

export function machineDetailDaemonStateLabel(state: string | undefined) {
  if (!state) return 'not reported';
  return state.replaceAll('-', ' ');
}

export function machineDetailDisplayName(
  connector: ConnectorOverviewResult,
  machine: MachineRecord
) {
  const matches = (connector.physicalMachines ?? []).filter((physicalMachine) => (
    physicalMachine.connectorIds.includes(machine.id)
  ));
  return matches.length === 1 ? matches[0]!.name : machine.name;
}

export function machineDetailRuntimeReason(machine: MachineRecord) {
  const update = machine.connector.update;
  const needsReason = update?.state === 'update-pending' ||
    update?.state === 'failed' ||
    update?.state === 'rollback' ||
    update?.operation?.state === 'queued' ||
    update?.operation?.state === 'recovery-required' ||
    update?.operation?.state === 'rolling-back' ||
    update?.operation?.state === 'rolled-back';
  if (!needsReason) return undefined;
  return latestRuntimeFailure(update)?.message || runtimeOperationLabel(update?.operation) || undefined;
}
