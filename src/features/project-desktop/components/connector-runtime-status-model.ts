import type { ConnectorRuntimeUpdateRecord } from '@/shared/project-space-api';

export type ConnectorRuntimeVisibleStatus =
  | 'update-available'
  | 'update-pending'
  | 'updating';

export interface ConnectorRuntimeStatusPresentation {
  label: 'Update available' | 'Update pending' | 'Updating';
  status: ConnectorRuntimeVisibleStatus;
}

function visibleStatus(
  update: ConnectorRuntimeUpdateRecord | undefined
): ConnectorRuntimeVisibleStatus | undefined {
  if (update?.operation?.operation === 'update' &&
      update.operation.state === 'rolling-back') return 'updating';
  if (update?.state === 'update-pending' || update?.operation?.state === 'queued') {
    return 'update-pending';
  }
  if (update?.state === 'updating') return 'updating';
  if (update?.operation?.operation === 'update' && (
    update.state === 'failed' || update.state === 'rollback' ||
    update.operation.state === 'failed' || update.operation.state === 'recovery-required' ||
    update.operation.state === 'rolled-back'
  )) return 'update-available';
  if (update?.state === 'update-available' || update?.state === 'update-required') {
    return 'update-available';
  }
  return undefined;
}

/**
 * Selects the most active visible state across one connector or a machine's
 * connector group. Active updates outrank queued work, which outranks a merely
 * available release.
 */
export function connectorRuntimeStatusPresentation(
  updates: readonly (ConnectorRuntimeUpdateRecord | undefined)[]
): ConnectorRuntimeStatusPresentation | undefined {
  const statuses = new Set(updates.map(visibleStatus));
  if (statuses.has('updating')) return { label: 'Updating', status: 'updating' };
  if (statuses.has('update-pending')) {
    return { label: 'Update pending', status: 'update-pending' };
  }
  if (statuses.has('update-available')) {
    return { label: 'Update available', status: 'update-available' };
  }
  return undefined;
}
