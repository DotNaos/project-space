import { createHash } from 'node:crypto';

import type {
  CodexDaemonConnectorResult,
  CodexDaemonEvidence
} from '../../src/shared/codex-daemon-api';

interface ConnectorRuntimeCodexDaemonManager {
  execute(operation: 'ensure', operationId: string): Promise<CodexDaemonConnectorResult>;
  inspect(): Promise<CodexDaemonEvidence>;
  recoverMaintenanceSelectionOutcome?(): Promise<unknown>;
  restoreMaintenanceSelection(operationId: string): Promise<unknown>;
}

function daemonRepairOperationId(operationId: string) {
  const digest = createHash('sha256').update(operationId).digest('hex');
  return `connector-runtime:codex-ensure:${digest}`;
}

export async function inspectCodexDaemonForConnectorRuntime(input: {
  environment: NodeJS.ProcessEnv;
  manager: ConnectorRuntimeCodexDaemonManager;
}) {
  const managed = input.environment.PROJECT_SPACE_INSTALL_SOURCE === 'managed';
  if (managed) await input.manager.recoverMaintenanceSelectionOutcome?.();
  const operationId = input.environment
    .PROJECT_CONNECTOR_RUNTIME_MAINTENANCE_OPERATION_ID?.trim();
  const state = input.environment.PROJECT_CONNECTOR_RUNTIME_MAINTENANCE_STATE;
  if (!managed || !operationId) return input.manager.inspect();
  if (state === 'rolled-back') {
    // Registration must not acknowledge the connector rollback while the
    // process-global managed Codex selection still points at the rejected release.
    await input.manager.restoreMaintenanceSelection(operationId);
    return input.manager.inspect();
  }
  if (state !== 'pending-health-check') return input.manager.inspect();
  try {
    await input.manager.execute(
      'ensure',
      daemonRepairOperationId(operationId)
    );
  } catch {
    // The fresh inspection below becomes explicit reconnect evidence and remains fail closed.
  }
  // The operation ledger may replay an older completed result. Only evidence
  // observed after this repair attempt can authorize the pending runtime update.
  return input.manager.inspect();
}
