import type {
  ConnectorRuntimeFingerprint,
  ConnectorRuntimeOperationRecord
} from '../src/shared/connector-runtime-api';
import type { MachineRecord } from '../src/shared/project-space-api';
import {
  CODEX_RUNTIME_VERSION_CAPABILITY_PREFIX,
  codexRuntimeVersionFromCapabilities
} from '../src/shared/codex-runtime-release-contract';

export function connectorRuntimeDispatchFailure(code: string, now: string) {
  return {
    at: now,
    code,
    message: 'The connector could not start the requested maintenance operation.',
    rollbackAvailable: false
  };
}

export function connectorRuntimeDeferredFailure(code: string, now: string) {
  const messages: Record<string, string> = {
    busy: 'Update deferred until Codex work and machine changes are finished.',
    'codex-state-uncertain':
      'Update deferred because the connector cannot yet prove that Codex is idle.',
    'codex-turn-active': 'Update deferred until the active Codex turn finishes.',
    'codex-turn-starting': 'Update deferred until the starting Codex turn settles.',
    'codex-waiting-approval': 'Update deferred while Codex is waiting for approval.',
    'codex-waiting-input': 'Update deferred while Codex is waiting for user input.',
    'control-conflict': 'Update deferred while another connector control operation finishes.',
    'machine-mutation': 'Update deferred until the machine change finishes.',
    'maintenance-in-progress': 'Update deferred while runtime maintenance is already in progress.',
    unavailable: 'Update deferred until the connector is available again.'
  };
  const message = messages[code] ?? messages.busy!;
  return { at: now, code, message, rollbackAvailable: false };
}

export function connectorRuntimeOutcomeUnknownFailure(
  code: string,
  now: string,
  rollbackAvailable: boolean
) {
  return {
    at: now,
    code,
    message: 'The command was sent, but its result is unknown; reconnect evidence will decide it.',
    rollbackAvailable
  };
}

export function connectorCodexRuntimeMatchesExpected(
  machine: MachineRecord,
  expected: ConnectorRuntimeFingerprint | undefined
) {
  if (!expected?.capabilities.includes('codex.runtime.v1')) return true;
  const daemon = machine.connector.daemon;
  const expectedVersion = codexRuntimeVersionFromCapabilities(expected.capabilities);
  const hasVersionContract = expected.capabilities.some(
    (capability) => capability.startsWith(CODEX_RUNTIME_VERSION_CAPABILITY_PREFIX)
  );
  const baseReady = Boolean(
    daemon?.state === 'ready' && daemon.authenticated && daemon.compatible &&
    daemon.installed && daemon.reachable && daemon.running && daemon.cliVersion &&
    daemon.appServerVersion && daemon.cliVersion === daemon.appServerVersion
  );
  if (!hasVersionContract) return baseReady;
  if (!baseReady || !expectedVersion) return false;
  const capabilities = machine.connector.capabilities ?? [];
  return daemon!.backend === 'pid' && daemon!.cliVersion === expectedVersion &&
    daemon!.appServerVersion === expectedVersion &&
    daemon!.managedCodexVersion === expectedVersion &&
    capabilities.includes('codex.machine-tasks.v1') &&
    capabilities.includes('codex.sessions.model-selection.v1') &&
    capabilities.includes('codex.sessions.model-settings.v1') &&
    (!daemon!.remoteControlEnabled || (
      daemon!.paired && daemon!.remoteControlState === 'connected'
    ));
}

export function connectorCodexRuntimeIsReady(
  machine: MachineRecord,
  operation: ConnectorRuntimeOperationRecord
) {
  return operation.operation !== 'update' ||
    connectorCodexRuntimeMatchesExpected(machine, operation.expectedFingerprint);
}
