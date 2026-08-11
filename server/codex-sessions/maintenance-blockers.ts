import type { ConnectorRuntimeMaintenanceBlocker } from '../connector-runtime-maintenance-safety';
import type {
  CodexOperationSnapshot,
  CodexRpcId,
  CodexServerRequestMethod
} from './contracts';
import { rpcIdKey } from './validation';

export interface CodexPendingMaintenanceRequest {
  method: CodexServerRequestMethod;
  params: Record<string, unknown>;
  requestId: CodexRpcId;
  threadId: string;
  turnId?: string;
}

export function codexSessionMaintenanceBlockers(input: {
  activeTurns: ReadonlyMap<string, string>;
  operationSnapshot: CodexOperationSnapshot;
  pendingServerRequests: Iterable<CodexPendingMaintenanceRequest>;
  startingThreads: ReadonlySet<string>;
  unknownActiveTurn: string;
}): ConnectorRuntimeMaintenanceBlocker[] {
  const blockers: ConnectorRuntimeMaintenanceBlocker[] = [];
  for (const [threadId, turnId] of [...input.activeTurns].sort(([left], [right]) => (
    left.localeCompare(right)
  ))) {
    blockers.push({
      kind: 'codex-turn', state: 'active', threadId,
      ...(turnId === input.unknownActiveTurn ? {} : { turnId })
    });
  }
  for (const threadId of [...input.startingThreads].sort()) {
    blockers.push({ kind: 'codex-turn', state: 'starting', threadId });
  }
  for (const pending of [...input.pendingServerRequests].sort((left, right) => (
    rpcIdKey(left.requestId).localeCompare(rpcIdKey(right.requestId))
  ))) {
    blockers.push({
      kind: 'codex-request', requestId: pending.requestId,
      state: pending.method.includes('requestUserInput')
        ? 'waiting-for-user-input'
        : 'waiting-for-approval',
      threadId: pending.threadId,
      ...(pending.turnId ? { turnId: pending.turnId } : {})
    });
  }
  for (const operation of input.operationSnapshot
    .filter((entry) => entry.state === 'uncertain')
    .sort((left, right) => left.operationId.localeCompare(right.operationId))) {
    blockers.push({
      kind: 'codex-operation', operationId: operation.operationId, state: 'uncertain'
    });
  }
  return blockers;
}
