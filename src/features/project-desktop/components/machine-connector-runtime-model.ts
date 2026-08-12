import type {
  ConnectorRuntimeFailure,
  ConnectorRuntimeOperationName,
  ConnectorRuntimeOperationRecord,
  ConnectorRuntimeOperationState,
  ConnectorRuntimeState,
  ConnectorRuntimeUpdateRecord,
  MachineRecord
} from '@/shared/project-space-api';

const terminalOperationStates = new Set<ConnectorRuntimeOperationState>([
  'failed',
  'recovery-required',
  'rolled-back',
  'succeeded'
]);

type ConnectorRuntimeUiOperation = ConnectorRuntimeOperationName | 'stop';

const runtimeCapabilities: Record<ConnectorRuntimeUiOperation, string> = {
  restart: 'runtime.restart',
  stop: 'runtime.stop',
  update: 'runtime.update'
};

function isMachineOnline(machine: MachineRecord) {
  return machine.connector.status === 'local' || machine.connector.status === 'online';
}

export function hasMachineRuntimeCapability(
  machine: MachineRecord,
  operation: ConnectorRuntimeUiOperation
) {
  return machine.connector.capabilities?.includes(runtimeCapabilities[operation]) ?? false;
}

export function isSourceDevelopmentMachineRuntime(machine: MachineRecord) {
  return (
    machine.connector.profile?.channel === 'dev' &&
    machine.connector.profile.source === 'source'
  );
}

export function shouldShowMachineRuntimeStop(machine: MachineRecord) {
  return isSourceDevelopmentMachineRuntime(machine);
}

export function shouldShowMachineRuntimeRestart(machine: MachineRecord) {
  return !isSourceDevelopmentMachineRuntime(machine);
}

export function shouldShowManagedRuntimeReinstallNotice(machine: MachineRecord) {
  return (
    machine.connector.update?.state === 'unsupported' &&
    !isSourceDevelopmentMachineRuntime(machine)
  );
}

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
    isMachineOnline(machine) &&
    machine.connector.runtime?.source === 'managed' &&
    hasMachineRuntimeCapability(machine, 'update') &&
    Boolean(runtimeApprovedReleaseId(machine)) &&
    !isRuntimeBusy(update) &&
    (update?.state === 'update-available' ||
      update?.state === 'update-required' ||
      update?.state === 'failed' ||
      update?.state === 'rollback')
  );
}

export function canStopSourceDevelopmentMachineRuntime(machine: MachineRecord) {
  return (
    isMachineOnline(machine) &&
    isSourceDevelopmentMachineRuntime(machine) &&
    hasMachineRuntimeCapability(machine, 'stop') &&
    !isRuntimeBusy(machine.connector.update)
  );
}

export function canRestartMachineRuntime(machine: MachineRecord) {
  return (
    isMachineOnline(machine) &&
    hasMachineRuntimeCapability(machine, 'restart') &&
    machine.connector.runtime?.source === 'managed' &&
    machine.connector.update?.operation?.state !== 'recovery-required' &&
    !isRuntimeBusy(machine.connector.update)
  );
}

export function runtimeApprovedReleaseId(machine: MachineRecord) {
  const update = machine.connector.update;
  if (update?.availableReleaseId) return update.availableReleaseId;
  if (
    update?.operation?.operation === 'update' &&
    (update.operation.state === 'failed' || update.operation.state === 'rolled-back')
  ) {
    return update.operation.expectedReleaseId;
  }
  return undefined;
}

export function shouldShowMachineRuntimeUpdate(machine: MachineRecord) {
  const update = machine.connector.update;
  return (
    machine.connector.runtime?.source === 'managed' &&
    Boolean(runtimeApprovedReleaseId(machine)) && (
      runtimeRetryOperation(machine) === 'update' ||
      update?.state === 'update-available' ||
      update?.state === 'update-required' ||
      update?.state === 'failed' ||
      update?.state === 'rollback'
    )
  );
}

export function runtimeRetryOperation(
  machine: MachineRecord
): ConnectorRuntimeOperationName | undefined {
  const operation = machine.connector.update?.operation;
  return operation && (operation.state === 'failed' || operation.state === 'rolled-back')
    ? operation.operation
    : undefined;
}

export function latestRuntimeFailure(
  update?: ConnectorRuntimeUpdateRecord
): ConnectorRuntimeFailure | undefined {
  const failures = [update?.lastFailure, update?.operation?.lastFailure].filter(
    (failure): failure is ConnectorRuntimeFailure => Boolean(failure)
  );
  return failures.sort((left, right) => right.at.localeCompare(left.at))[0];
}

export function shouldPollRuntimeStatus(update?: ConnectorRuntimeUpdateRecord) {
  return isRuntimeBusy(update);
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
    'recovery-required': 'Connector recovery required',
    restarting: 'Restarting the connector',
    'rolled-back': 'Previous version restored',
    'rolling-back': 'Restoring the previous version',
    staging: 'Preparing the update',
    succeeded: operation.operation === 'restart' ? 'Restart complete' : 'Update complete',
    switching: 'Activating the update',
    validating: 'Validating the release',
    verified: 'Release verified'
  };

  return labels[operation.state];
}

export function runtimeOperationOutcomeMessage(
  machine: MachineRecord,
  operation?: ConnectorRuntimeOperationRecord
) {
  if (!operation || isRuntimeOperationActive(operation)) {
    return 'You can close this dialog. Progress will remain available after reloading.';
  }
  if (operation.state === 'failed' || operation.state === 'recovery-required') {
    return operation.lastFailure?.message ??
      `The connector ${operation.operation} failed. Review the last failure before retrying.`;
  }
  if (operation.state === 'rolled-back') {
    return operation.operation === 'update'
      ? 'The update did not pass its checks, so the previous connector version was restored.'
      : 'The connector recovered its previous working state.';
  }
  return `Running ${runtimeVersionLabel(machine)} on ${machine.name}.`;
}

export function runtimeVersionLabel(machine: MachineRecord) {
  const runtime = machine.connector.runtime;
  if (!runtime) return 'Version unknown';
  return `v${runtime.version}`;
}

export function runtimeUnavailableReason(
  machine: MachineRecord,
  operation: ConnectorRuntimeUiOperation
) {
  const update = machine.connector.update;
  if (machine.connector.status !== 'local' && machine.connector.status !== 'online') {
    return 'The machine is offline.';
  }
  if (operation === 'stop' && !isSourceDevelopmentMachineRuntime(machine)) {
    return 'Only source development connectors can be stopped from Project Space.';
  }
  if (operation !== 'stop' && update?.state === 'unsupported') {
    return 'This installation cannot be managed from Project Space. Recreate it through Environment setup.';
  }
  if (isRuntimeBusy(update)) {
    return runtimeOperationLabel(update?.operation) || 'Another connector operation is active.';
  }
  if (!hasMachineRuntimeCapability(machine, operation)) {
    if (operation === 'stop') {
      return 'This source connector does not report scoped stop support.';
    }
    return operation === 'update'
      ? 'This connector does not report managed update support.'
      : 'This connector does not report managed restart support.';
  }
  if (operation === 'update' && !runtimeApprovedReleaseId(machine)) {
    return 'No approved update is available.';
  }
  return '';
}
