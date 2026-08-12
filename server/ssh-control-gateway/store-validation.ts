import type { SshGatewayOperationStore } from './contracts';
import { SshGatewayError } from './contracts';

export function validateReservation(
  input: Parameters<SshGatewayOperationStore['reserve']>[0]
) {
  const audit = input.audit;
  if (input.operationId !== audit.operationId ||
    input.targetEnvironmentId !== audit.targetEnvironmentId ||
    audit.capability !== 'project_cli' || audit.routeClass !== 'ssh_private_network' ||
    !/^status\.v1$|^workspace-runtime\.(?:start|inspect|suspend|resume|stop|clean|reconcile)\.v1$|^worktree\.prepare\.v1$/.test(audit.operation) ||
    audit.outcome !== 'accepted' || audit.completedAt ||
    !isUuid(input.targetEnvironmentId) || !isUuid(audit.routeId) ||
    !/^[A-Za-z0-9:._-]{1,256}$/.test(input.operationId) ||
    !/^[0-9a-f]{64}$/.test(input.fingerprint) ||
    !safeIdentity(input.ownerUserId) || !safeIdentity(audit.actorId) ||
    !safeIdentity(audit.gatewayId) || !safeIdentity(audit.targetIdentityRevision)) {
    throw new SshGatewayError('operation_conflict', 'Operation reservation identity is invalid.');
  }
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(value);
}

function safeIdentity(value: string) {
  return value === value.trim() && /^[A-Za-z0-9:._@-]{1,256}$/.test(value);
}
