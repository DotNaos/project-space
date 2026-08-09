import { createHash } from 'node:crypto';

import {
  EXECUTION_ENVIRONMENT_LIFECYCLE_API_VERSION,
  type DeleteExecutionEnvironmentRequest,
  type ExecutionEnvironmentLifecycleAction,
  type ExecutionEnvironmentLifecycleBlockedReason,
  type ExecutionEnvironmentLifecycleOperationState,
  type ExecutionEnvironmentLifecycleResult,
  type ExecutionEnvironmentMutationRequest,
  type ProvisionExecutionEnvironmentRequest,
  type StopExecutionEnvironmentRequest
} from '../../src/shared/execution-environment-lifecycle-api';
import type {
  EnvironmentLifecycleOperation,
  EnvironmentLifecycleStore,
  EnvironmentProviderBinding
} from './store';
import type {
  ExecutionEnvironmentProviderObservation,
  ExecutionEnvironmentProviderTarget
} from './provider';

export function operationForProvision(
  actor: { userId: string },
  request: ProvisionExecutionEnvironmentRequest,
  target: ExecutionEnvironmentProviderTarget,
  binding: EnvironmentProviderBinding | undefined
): EnvironmentLifecycleOperation {
  return {
    action: 'provision',
    ...(binding ? { bindingId: binding.id, environmentId: binding.environmentId } : {}),
    fingerprint: fingerprint({ action: 'provision', ...target, provider: request.provider }),
    operationId: request.operationId,
    providerKind: request.provider,
    scopeKey: fingerprint({ provider: request.provider, target }),
    userId: actor.userId
  };
}

export function operationForMutation(
  actor: { userId: string },
  action: 'delete' | 'start' | 'stop',
  request: DeleteExecutionEnvironmentRequest | ExecutionEnvironmentMutationRequest | StopExecutionEnvironmentRequest,
  binding: EnvironmentProviderBinding
): EnvironmentLifecycleOperation {
  return {
    action,
    bindingId: binding.id,
    environmentId: request.environmentId,
    fingerprint: fingerprint({ action, environmentId: request.environmentId,
      ...('reason' in request && request.reason ? { reason: request.reason.trim() } : {}) }),
    operationId: request.operationId,
    providerKind: binding.providerKind,
    scopeKey: `environment:${request.environmentId}`,
    userId: actor.userId
  };
}

export function reconciles(
  action: 'delete' | 'provision' | 'start' | 'stop',
  observed: ExecutionEnvironmentProviderObservation
) {
  if (observed.outcome === 'uncertain') return false;
  if (action === 'delete') return ['deleted', 'missing'].includes(observed.lifecycleState);
  if (action === 'start') return ['running', 'starting'].includes(observed.lifecycleState);
  if (action === 'stop') return ['stopped', 'stopping'].includes(observed.lifecycleState);
  return Boolean(observed.providerResourceName) && !['missing', 'uncertain'].includes(observed.lifecycleState);
}

export function reservationResult(
  reservation: Awaited<ReturnType<EnvironmentLifecycleStore['reserve']>>,
  action: ExecutionEnvironmentLifecycleAction,
  operationId: string,
  providerKind: string,
  binding: EnvironmentProviderBinding | undefined,
  now: Date
) {
  if (reservation.kind === 'new' || reservation.kind === 'uncertain') return undefined;
  if (reservation.kind === 'replayed') {
    const replayed = lifecycleResult(reservation.result);
    return replayed ? {
      ...replayed,
      reconciliation: { checkedAt: now.toISOString(), state: 'replayed' as const }
    } : uncertainForBinding(action, operationId, binding, now);
  }
  if (reservation.kind === 'conflict') {
    return genericBlocked(action, operationId, providerKind, binding, 'operation_conflict', now);
  }
  return genericBlocked(action, operationId, providerKind, binding,
    'execution_state_uncertain', now, reservation.kind === 'pending' ? 'pending' : 'uncertain');
}

export function resultFromObservation(
  action: ExecutionEnvironmentLifecycleAction,
  operationId: string,
  observed: ExecutionEnvironmentProviderObservation,
  binding: EnvironmentProviderBinding | undefined,
  state: ExecutionEnvironmentLifecycleOperationState,
  checkedAt: Date
): ExecutionEnvironmentLifecycleResult {
  const environmentId = observed.environmentId ?? binding?.environmentId;
  const resourceName = observed.providerResourceName ?? binding?.providerResourceId;
  return {
    action,
    apiVersion: EXECUTION_ENVIRONMENT_LIFECYCLE_API_VERSION,
    ...(observed.blockedReason ? { blocked: { reason: observed.blockedReason } } : {}),
    ...(environmentId && resourceName ? {
      environment: { id: environmentId, kind: 'github_codespace', name: safeText(resourceName, 128) }
    } : {}),
    lifecycle: {
      ...(observed.nativeState ? { nativeState: safeText(observed.nativeState, 100) } : {}),
      normalized: observed.lifecycleState,
      observedAt: observed.observedAt
    },
    message: safeText(observed.message, 500),
    operationId,
    provider: {
      kind: 'github_codespaces',
      ...(resourceName ? { resource: {
        name: safeText(resourceName, 128),
        ...(observed.providerResourceUrl ? { url: observed.providerResourceUrl } : {})
      } } : {})
    },
    ...(observed.readiness ? { readiness: observed.readiness } : {}),
    ...(observed.reauthorization ? { reauthorization: observed.reauthorization } : {}),
    reconciliation: { checkedAt: checkedAt.toISOString(), state }
  };
}

export function blockedProvision(
  request: ProvisionExecutionEnvironmentRequest,
  reason: ExecutionEnvironmentLifecycleBlockedReason,
  now: Date
) {
  return genericBlocked('provision', request.operationId, request.provider, undefined, reason, now);
}

export function blockedForBinding(
  action: ExecutionEnvironmentLifecycleAction,
  operationId: string,
  binding: EnvironmentProviderBinding,
  reason: ExecutionEnvironmentLifecycleBlockedReason,
  now: Date,
  state: ExecutionEnvironmentLifecycleOperationState = 'confirmed'
) {
  return genericBlocked(action, operationId, binding.providerKind, binding, reason, now, state);
}

function genericBlocked(
  action: ExecutionEnvironmentLifecycleAction,
  operationId: string,
  providerKind: string,
  binding: EnvironmentProviderBinding | undefined,
  reason: ExecutionEnvironmentLifecycleBlockedReason,
  now: Date,
  state: ExecutionEnvironmentLifecycleOperationState = 'confirmed'
): ExecutionEnvironmentLifecycleResult {
  return {
    action,
    apiVersion: EXECUTION_ENVIRONMENT_LIFECYCLE_API_VERSION,
    blocked: { reason },
    ...(binding?.environmentId ? {
      environment: { id: binding.environmentId, kind: 'github_codespace', name: safeText(binding.providerResourceId, 128) }
    } : {}),
    lifecycle: {
      ...(binding?.nativeState ? { nativeState: safeText(binding.nativeState, 100) } : {}),
      normalized: binding?.lifecycleState ?? 'uncertain',
      observedAt: binding?.observedAt ?? now.toISOString()
    },
    message: messageFor(reason),
    operationId,
    provider: {
      kind: providerKind === 'github_codespaces' ? 'github_codespaces' : 'github_codespaces',
      ...(binding ? { resource: { name: safeText(binding.providerResourceId, 128) } } : {})
    },
    reconciliation: { checkedAt: now.toISOString(), state }
  };
}

export function missing(action: ExecutionEnvironmentLifecycleAction, operationId: string, now: Date) {
  return genericBlocked(action, operationId, 'github_codespaces', undefined, 'environment_not_found', now);
}

export function uncertainForBinding(
  action: ExecutionEnvironmentLifecycleAction,
  operationId: string,
  binding: EnvironmentProviderBinding | undefined,
  now: Date
) {
  return genericBlocked(action, operationId, binding?.providerKind ?? 'github_codespaces', binding,
    'execution_state_uncertain', now, 'uncertain');
}

export function stored(result: ExecutionEnvironmentLifecycleResult) {
  return result as unknown as { operationId: string; [key: string]: unknown };
}

function lifecycleResult(value: Record<string, unknown>): ExecutionEnvironmentLifecycleResult | undefined {
  return value.apiVersion === EXECUTION_ENVIRONMENT_LIFECYCLE_API_VERSION &&
    typeof value.operationId === 'string' && typeof value.action === 'string' &&
    Boolean(value.lifecycle) && Boolean(value.provider) && Boolean(value.reconciliation)
    ? value as unknown as ExecutionEnvironmentLifecycleResult
    : undefined;
}

function fingerprint(value: unknown) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function safeText(value: string, maximum: number) {
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, maximum);
}

function messageFor(reason: ExecutionEnvironmentLifecycleBlockedReason) {
  const messages: Record<ExecutionEnvironmentLifecycleBlockedReason, string> = {
    active_execution: 'Stop or cancel the active Task Execution before changing this Environment.',
    agent_authorization_required: 'The selected agent must be authorized first.',
    connector_approval_required: 'Approve the exact Environment connector before continuing.',
    environment_not_found: 'The execution Environment was not found for this account.',
    execution_state_uncertain: 'The Environment state cannot be changed safely until reconciliation completes.',
    not_authorized: 'This account is not authorized to manage the requested Environment.',
    operation_conflict: 'The operation ID was already used with different input.',
    provider_reauthorization_required: 'Reconnect GitHub with Codespaces access before continuing.',
    unsupported_provider: 'This Environment provider does not support this lifecycle action.'
  };
  return messages[reason];
}
