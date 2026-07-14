import type {
  ConnectorRuntimeOperationRecord,
  ConnectorRuntimeOperationState,
  ConnectorRuntimeState,
  ConnectorRuntimeUpdateRecord,
  MachineRecord
} from '@/shared/project-space-api';

const terminalOperationStates = new Set<ConnectorRuntimeOperationState>([
  'failed',
  'rolled-back',
  'succeeded'
]);

export function isRuntimeOperationActive(operation?: ConnectorRuntimeOperationRecord) {
  return Boolean(operation && !terminalOperationStates.has(operation.state));
}

export function isRuntimeBusy(update?: ConnectorRuntimeUpdateRecord) {
  return (
    update?.state === 'checking' ||
    update?.state === 'updating' ||
    update?.state === 'restarting' ||
    isRuntimeOperationActive(update?.operation)
  );
}

export function canUpdateMachineRuntime(machine: MachineRecord) {
  const update = machine.connector.update;
  return (
    (machine.connector.status === 'local' || machine.connector.status === 'online') &&
    Boolean(update?.availableReleaseId) &&
    !isRuntimeBusy(update) &&
    (update?.state === 'update-available' ||
      update?.state === 'update-required' ||
      update?.state === 'failed')
  );
}

export function canRestartMachineRuntime(machine: MachineRecord) {
  return (
    (machine.connector.status === 'local' || machine.connector.status === 'online') &&
    machine.connector.update?.state !== 'unsupported' &&
    !isRuntimeBusy(machine.connector.update)
  );
}

export function runtimeStateLabel(state: ConnectorRuntimeState | undefined) {
  switch (state) {
    case 'up-to-date':
      return 'Up to date';
    case 'update-available':
      return 'Update available';
    case 'update-required':
      return 'Update required';
    case 'restart-required':
      return 'Restart required';
    case 'failed':
      return 'Last operation failed';
    case 'rollback':
      return 'Rolled back';
    case 'offline':
      return 'Offline';
    case 'unsupported':
      return 'Unsupported installation';
    case 'updating':
      return 'Updating';
    case 'restarting':
      return 'Restarting';
    case 'checking':
      return 'Checking for updates';
    case 'unknown':
    case undefined:
      return 'Version unknown';
  }
}

export function runtimeOperationLabel(operation?: ConnectorRuntimeOperationRecord) {
  if (!operation) return '';

  const labels: Record<ConnectorRuntimeOperationState, string> = {
    failed: 'Operation failed',
    'health-checking': 'Checking connector health',
    queued: 'Waiting to start',
    reconnecting: 'Waiting for the connector to reconnect',
    restarting: 'Restarting the connector',
    'rolled-back': 'Previous version restored',
    staging: 'Preparing the update',
    succeeded: operation.operation === 'restart' ? 'Restart complete' : 'Update complete',
    switching: 'Activating the update',
    validating: 'Validating the release',
    verified: 'Release verified'
  };

  return labels[operation.state];
}

export function runtimeVersionLabel(machine: MachineRecord) {
  const runtime = machine.connector.runtime;
  if (!runtime) return 'Version unknown';
  return `v${runtime.version}`;
}

export function runtimeUnavailableReason(
  machine: MachineRecord,
  operation: 'restart' | 'update'
) {
  const update = machine.connector.update;
  if (machine.connector.status !== 'local' && machine.connector.status !== 'online') {
    return 'The machine is offline.';
  }
  if (update?.state === 'unsupported') {
    return 'This installation cannot be managed from Project Space.';
  }
  if (isRuntimeBusy(update)) {
    return runtimeOperationLabel(update?.operation) || 'Another connector operation is active.';
  }
  if (operation === 'update' && !update?.availableReleaseId) {
    return 'No approved update is available.';
  }
  return '';
}
