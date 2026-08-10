import { createHash } from 'node:crypto';

import type {
  AgentAuthorizationAction,
  AgentAuthorizationRequest,
  AgentAuthorizationResult,
  AgentAuthorizationState,
  AgentStatusResult,
  GetAgentStatusRequest
} from '../../src/shared/agent-runtime-api';
import { AGENT_RUNTIME_API_VERSION } from '../../src/shared/agent-runtime-api';
import type { CodexAuthorizationResult } from '../../src/shared/codex-authorization-api';
import type { ConfiguredComputeInventoryResult } from '../configured-compute-inventory';
import type { CodexAuthorizationRuntime } from '../codex-authorization/configured-runtime';
import type { MachineRecord } from '../../src/shared/project-space-api';
import type {
  AgentAuthorizationOperation,
  AgentAuthorizationOperationRecord,
  AgentAuthorizationOperationStore
} from './store';

const evidenceFreshForMs = 5 * 60_000;

export interface AgentRuntimeService {
  authorize(
    action: AgentAuthorizationAction,
    actor: { userId: string },
    request: AgentAuthorizationRequest
  ): Promise<AgentAuthorizationResult>;
  status(actor: { userId: string }, request: GetAgentStatusRequest): Promise<AgentStatusResult>;
}

export function createAgentRuntimeService(dependencies: {
  authorization: CodexAuthorizationRuntime;
  loadInventory(userId: string): Promise<ConfiguredComputeInventoryResult>;
  now?: () => Date;
  store: AgentAuthorizationOperationStore;
}): AgentRuntimeService {
  const now = dependencies.now ?? (() => new Date());

  return {
    async authorize(action, actor, request) {
      const checkedAt = now().toISOString();
      const storedCancel = action === 'cancel'
        ? await dependencies.store.read(actor.userId, request.operationId)
        : undefined;
      if (storedCancel && !sameRequestTarget(storedCancel, actor.userId, request)) {
        return authorizationResult(action, request, 'failed',
          'The operation ID was already used for another authorization target.', checkedAt);
      }
      if (storedCancel && isTerminalState(storedCancel.state)) {
        return fromRecord(action, request, storedCancel, checkedAt);
      }
      const selected = await selectTarget(dependencies.loadInventory, actor.userId, request.environmentId);
      if (!selected.connector || selected.generation === undefined || selected.state) {
        return authorizationResult(action, request, selected.state ?? 'unauthorized',
          selected.message, checkedAt);
      }
      const target = {
        ...selected,
        connector: selected.connector,
        generation: selected.generation
      };
      const operation = operationFor(actor.userId, request, target);
      if (action === 'start') {
        const reservation = await dependencies.store.reserve(operation);
        if (reservation.kind === 'conflict') {
          return authorizationResult(action, request, 'failed',
            'The operation ID was already used for another authorization target.', checkedAt);
        }
        if (reservation.kind === 'fenced' || reservation.kind === 'in_progress') {
          return authorizationResult(action, request, 'ambiguous',
            'Another authorization transition is still being reconciled.', checkedAt);
        }
        if (reservation.kind === 'replayed' && reservation.record.state !== 'ready') {
          return fromRecord(action, request, reservation.record, checkedAt);
        }
        const dispatchAction = reservation.kind === 'new' ? 'start' : 'status';
        return dispatch(dispatchAction, action, actor, request, target, operation,
          reservation.kind === 'new' ? undefined : reservation.record);
      }

      const record = storedCancel ?? await dependencies.store.read(actor.userId, request.operationId);
      if (!record) {
        return authorizationResult(action, request, 'authorization-required',
          'The authorization attempt was not found for this Environment.', checkedAt);
      }
      if (!sameTarget(record, operation)) {
        return authorizationResult(action, request, 'failed',
          'The operation ID was already used for another authorization target.', checkedAt);
      }
      if (record.connectorId && record.connectorId !== selected.connector.id) {
        return authorizationResult(action, request, 'ambiguous',
          'The original connector is no longer associated with this Environment.', checkedAt);
      }
      if (action === 'cancel' &&
          record.connectorGeneration !== undefined &&
          record.connectorGeneration !== selected.generation) {
        return authorizationResult(action, request, 'ambiguous',
          'The original connector generation is no longer available.', checkedAt);
      }
      if (action === 'cancel' && isTerminalState(record.state)) {
        return fromRecord(action, request, record, checkedAt);
      }
      return dispatch(action, action, actor, request, target, operation, record);
    },

    async status(actor, request) {
      const selected = await selectTarget(dependencies.loadInventory, actor.userId, request.environmentId);
      const authorization = selected.connector && !selected.state
        ? await dependencies.authorization.authorize(actor, {
            action: 'status',
            connectorId: selected.connector.id,
            environmentId: request.environmentId,
            operationId: statusOperationId(actor.userId, request.environmentId)
          })
        : undefined;
      const authorizationCheckedAt = authorization ? now().toISOString() : undefined;
      const authorizationState = authorization?.state ?? selected.state ?? 'unknown';
      return {
        agent: request.agent,
        apiVersion: AGENT_RUNTIME_API_VERSION,
        environmentId: request.environmentId,
        message: selected.message,
        runtime: runtimeRecord(selected, authorizationState, authorizationCheckedAt)
      };
    }
  };

  async function dispatch(
    dispatchAction: AgentAuthorizationAction,
    publicAction: AgentAuthorizationAction,
    actor: { userId: string },
    request: AgentAuthorizationRequest,
    selected: SelectedTarget & { connector: MachineRecord; generation: number },
    operation: AgentAuthorizationOperation,
    existing?: AgentAuthorizationOperationRecord
  ) {
    let result: CodexAuthorizationResult;
    try {
      result = await dependencies.authorization.authorize(actor, {
        action: dispatchAction,
        connectorId: selected.connector.id,
        environmentId: request.environmentId,
        operationId: connectorOperationId(actor.userId, request.environmentId, request.operationId)
      });
    } catch {
      if (dispatchAction === 'start') {
        await dependencies.store.markAmbiguous(operation, true, existing?.deadlineAt);
      }
      return authorizationResult(publicAction, request, 'ambiguous',
        'The authorization outcome could not be confirmed.', now().toISOString());
    }
    await persistResult(operation, result, existing);
    return projectResult(publicAction, request, result, now().toISOString());
  }

  async function persistResult(
    operation: AgentAuthorizationOperation,
    result: CodexAuthorizationResult,
    existing?: AgentAuthorizationOperationRecord
  ) {
    if (result.state === 'pending') {
      if (!trustedPending(result) && (!existing || !isTerminalState(existing.state))) {
        await dependencies.store.markAmbiguous(
          operation,
          true,
          validDeadline(result.deadlineAt) ? result.deadlineAt : existing?.deadlineAt
        );
      } else if (trustedPending(result) && (!existing || existing.state === 'dispatching')) {
        await dependencies.store.markPending(operation, result.deadlineAt!);
      }
      return;
    }
    if (result.state === 'ambiguous' && (!existing || !isTerminalState(existing.state))) {
      await dependencies.store.markAmbiguous(
        operation,
        true,
        result.deadlineAt ?? existing?.deadlineAt
      );
      return;
    }
    if (isTerminalState(result.state) && (!existing || !isTerminalState(existing.state))) {
      await dependencies.store.complete(
        operation,
        result.state as 'cancelled' | 'expired' | 'failed' | 'ready'
      );
      return;
    }
    if (result.state === 'authorization-required' &&
        (!existing || !isTerminalState(existing.state))) {
      await dependencies.store.markRetryable(operation);
      return;
    }
    if (!existing || existing.state === 'dispatching') {
      await dependencies.store.markRetryable(operation);
    }
  }
}

interface SelectedTarget {
  checkedAt: string;
  connector?: MachineRecord;
  generation?: number;
  message: string;
  state?: 'ambiguous' | 'offline' | 'unauthorized' | 'unsupported';
}

async function selectTarget(
  loadInventory: (userId: string) => Promise<ConfiguredComputeInventoryResult>,
  userId: string,
  environmentId: string
): Promise<SelectedTarget> {
  const inventory = await loadInventory(userId);
  if (!inventory.snapshot.environments.some(({ id }) => id === environmentId)) {
    return { checkedAt: inventory.checkedAt, message: 'The Environment was not found.', state: 'unauthorized' };
  }
  if (inventory.snapshot.violations.length > 0) {
    return { checkedAt: inventory.checkedAt, message: 'Environment inventory is ambiguous.', state: 'ambiguous' };
  }
  const connectorIds = inventory.snapshot.connectors
    .filter((association) => association.environmentId === environmentId)
    .map((association) => association.connectorId);
  if (connectorIds.length > 1) {
    return { checkedAt: inventory.checkedAt, message: 'Select one exact Environment connector.', state: 'ambiguous' };
  }
  const connector = connectorIds.length === 1
    ? inventory.connectors.find(({ id }) => id === connectorIds[0])
    : undefined;
  if (!connector || connector.connector.status === 'offline') {
    return { checkedAt: inventory.checkedAt, message: 'The Environment connector is offline.', state: 'offline' };
  }
  const generation = inventory.generations.get(connector.id);
  if (!generation) {
    return { checkedAt: inventory.checkedAt, connector, message: 'Connector evidence is stale.', state: 'offline' };
  }
  const capabilities = connector.connector.capabilities ?? [];
  if (!capabilities.includes('codex.runtime.v1') ||
      !capabilities.includes('codex.account.device-login.v1')) {
    return { checkedAt: inventory.checkedAt, connector, generation,
      message: 'The managed Codex authorization runtime is unsupported.', state: 'unsupported' };
  }
  return { checkedAt: inventory.checkedAt, connector, generation, message: 'Codex runtime status is current.' };
}

function operationFor(
  userId: string,
  request: AgentAuthorizationRequest,
  selected: SelectedTarget
): AgentAuthorizationOperation {
  return {
    agentKind: request.agent,
    ...(selected.generation ? { connectorGeneration: selected.generation } : {}),
    ...(selected.connector ? { connectorId: selected.connector.id } : {}),
    environmentId: request.environmentId,
    fingerprint: createHash('sha256').update(
      JSON.stringify({ agent: request.agent, environmentId: request.environmentId })
    ).digest('hex'),
    operationId: request.operationId,
    userId
  };
}

function sameTarget(
  record: AgentAuthorizationOperationRecord,
  operation: AgentAuthorizationOperation
) {
  return record.agentKind === operation.agentKind &&
    record.environmentId === operation.environmentId &&
    record.fingerprint === operation.fingerprint;
}

function sameRequestTarget(
  record: AgentAuthorizationOperationRecord,
  userId: string,
  request: AgentAuthorizationRequest
) {
  return sameTarget(record, operationFor(userId, request, {
    checkedAt: '',
    message: ''
  }));
}

function runtimeRecord(
  selected: SelectedTarget,
  authorizationState: AgentAuthorizationState | 'unknown',
  authorizationCheckedAt?: string
): AgentStatusResult['runtime'] {
  const daemon = selected.connector?.connector.daemon;
  const fresh = daemonEvidenceIsFresh(daemon?.checkedAt, selected.checkedAt);
  const capabilities = [...new Set((selected.connector?.connector.capabilities ?? [])
    .filter((value) => /^codex\.[A-Za-z0-9._-]{1,120}$/.test(value)))]
    .sort();
  const state = selected.state === 'ambiguous'
    ? 'ambiguous'
    : selected.state === 'offline'
      ? 'offline'
      : selected.state === 'unsupported'
        ? 'unsupported'
        : !daemon
          ? 'missing'
          : !fresh
            ? 'stale_evidence'
            : daemon.state;
  return {
    ...(daemon?.appServerVersion ? { appServerVersion: safeText(daemon.appServerVersion, 100) } : {}),
    authorization: {
      ...(authorizationCheckedAt ? { checkedAt: authorizationCheckedAt } : {}),
      state: authorizationState
    },
    capabilities,
    checkedAt: selected.checkedAt,
    ...(selected.connector ? {
      connector: {
        ...(selected.generation ? { generation: selected.generation } : {}),
        id: selected.connector.id
      }
    } : {}),
    state,
    ...(daemon?.cliVersion ? { version: safeText(daemon.cliVersion, 100) } : {})
  };
}

function projectResult(
  action: AgentAuthorizationAction,
  request: AgentAuthorizationRequest,
  result: CodexAuthorizationResult,
  checkedAt: string
): AgentAuthorizationResult {
  const pending = trustedPending(result);
  const state = result.state === 'pending' && !pending ? 'ambiguous' : result.state;
  return authorizationResult(action, request, state,
    safeText(result.message, 500), checkedAt, pending ? {
      deadlineAt: result.deadlineAt!,
      polling: { recommendedAfterSeconds: 5, tool: 'get_agent_authorization' as const },
      userCode: result.userCode!,
      verificationUrl: result.verificationUrl!
    } : undefined);
}

function fromRecord(
  action: AgentAuthorizationAction,
  request: AgentAuthorizationRequest,
  record: AgentAuthorizationOperationRecord,
  checkedAt: string
) {
  const state = record.state === 'dispatching' || record.state === 'retryable'
    ? 'ambiguous'
    : record.state;
  return authorizationResult(action, request, state,
    'The stored authorization result was replayed.', checkedAt,
    record.deadlineAt ? { deadlineAt: record.deadlineAt } : undefined);
}

function authorizationResult(
  action: AgentAuthorizationAction,
  request: AgentAuthorizationRequest,
  state: AgentAuthorizationState,
  message: string,
  checkedAt: string,
  extras?: Partial<AgentAuthorizationResult>
): AgentAuthorizationResult {
  return {
    action,
    agent: request.agent,
    apiVersion: AGENT_RUNTIME_API_VERSION,
    checkedAt,
    environmentId: request.environmentId,
    message,
    operationId: request.operationId,
    state,
    ...extras
  };
}

function statusOperationId(userId: string, environmentId: string) {
  return connectorOperationId(userId, environmentId, 'status');
}

function connectorOperationId(userId: string, environmentId: string, operationId: string) {
  const digest = createHash('sha256')
    .update(JSON.stringify({ environmentId, operationId, userId }))
    .digest('hex');
  return `agent:authorization:${digest}`;
}

function daemonEvidenceIsFresh(checkedAt: string | undefined, inventoryCheckedAt: string) {
  const evidence = Date.parse(checkedAt ?? '');
  const inventory = Date.parse(inventoryCheckedAt);
  return Number.isFinite(evidence) && Number.isFinite(inventory) &&
    evidence <= inventory + evidenceFreshForMs && inventory - evidence <= evidenceFreshForMs;
}

function validDeadline(value: string | undefined) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function validUserCode(value: string | undefined) {
  return typeof value === 'string' && /^[A-Z0-9][A-Z0-9-]{3,31}$/.test(value);
}

function trustedVerificationUrl(value: string | undefined) {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.toString() === 'https://auth.openai.com/codex/device';
  } catch {
    return false;
  }
}

function trustedPending(result: CodexAuthorizationResult) {
  return result.state === 'pending' &&
    validDeadline(result.deadlineAt) &&
    validUserCode(result.userCode) &&
    trustedVerificationUrl(result.verificationUrl);
}

function safeText(value: string, maximum: number) {
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, maximum);
}

function isTerminalState(
  state: AgentAuthorizationState | AgentAuthorizationOperationRecord['state']
): state is 'cancelled' | 'expired' | 'failed' | 'ready' {
  return state === 'cancelled' || state === 'expired' || state === 'failed' || state === 'ready';
}
