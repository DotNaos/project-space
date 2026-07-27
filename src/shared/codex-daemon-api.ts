export const CODEX_DAEMON_CONNECTOR_CAPABILITY = 'codex.app-server-daemon.v1';

export type CodexDaemonState =
  | 'ready'
  | 'missing'
  | 'stopped'
  | 'incompatible'
  | 'authorization-required'
  | 'remote-control-disabled'
  | 'pairing-required'
  | 'connecting'
  | 'unsupported'
  | 'uncertain';

export type CodexRemoteControlState =
  | 'disabled'
  | 'connecting'
  | 'connected'
  | 'errored'
  | 'unknown';

export interface CodexDaemonEvidence {
  appServerVersion?: string;
  authenticated: boolean;
  checkedAt: string;
  cliVersion?: string;
  compatible: boolean;
  environmentId?: string;
  installed: boolean;
  paired: boolean;
  reachable: boolean;
  remoteControlEnabled: boolean;
  remoteControlState: CodexRemoteControlState;
  running: boolean;
  state: CodexDaemonState;
}

export function codexDaemonEvidenceIsConsistent(evidence: CodexDaemonEvidence) {
  if (evidence.compatible && (!evidence.installed || !evidence.running)) return false;
  if (evidence.reachable && !evidence.running) return false;
  if (evidence.authenticated && !evidence.reachable) return false;
  if (evidence.remoteControlEnabled && !evidence.running) return false;
  if (evidence.paired && (
    !evidence.remoteControlEnabled ||
    evidence.remoteControlState !== 'connected' ||
    !evidence.environmentId
  )) return false;
  if (evidence.state !== 'ready') return true;
  return Boolean(
    evidence.authenticated &&
    evidence.compatible &&
    evidence.environmentId &&
    evidence.installed &&
    evidence.paired &&
    evidence.reachable &&
    evidence.remoteControlEnabled &&
    evidence.remoteControlState === 'connected' &&
    evidence.running
  );
}

export type CodexDaemonOperation = 'ensure' | 'restart' | 'status';
export type CodexDaemonResultState = 'completed' | 'blocked' | 'uncertain';

export function codexDaemonResultStateForEvidence(
  evidence: CodexDaemonEvidence
): CodexDaemonResultState {
  return evidence.state === 'ready'
    ? 'completed'
    : evidence.state === 'uncertain' || evidence.state === 'connecting'
      ? 'uncertain'
      : 'blocked';
}

export interface CodexDaemonConnectorRequest {
  machineId: string;
  operation: CodexDaemonOperation;
  operationId: string;
}

export interface CodexDaemonConnectorResult {
  evidence: CodexDaemonEvidence;
  operation: CodexDaemonOperation;
  operationId: string;
  state: CodexDaemonResultState;
}
