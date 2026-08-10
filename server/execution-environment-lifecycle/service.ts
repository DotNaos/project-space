import { randomUUID } from 'node:crypto';

import {
  type DeleteExecutionEnvironmentRequest,
  type ExecutionEnvironmentLifecycleAction,
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
  ExecutionEnvironmentLifecycleProvider,
  ExecutionEnvironmentProviderObservation,
  ExecutionEnvironmentProviderTarget
} from './provider';
import {
  blockedForBinding,
  blockedProvision,
  missing,
  operationForMutation,
  operationForProvision,
  reconciles,
  reservationResult,
  resultFromObservation,
  safeText,
  stored,
  uncertainForBinding
} from './service-results';

export interface ExecutionEnvironmentLifecycleActor {
  userId: string;
}

export interface ExecutionEnvironmentLifecycleAuthorization {
  authorizeBinding(input: {
    action: Exclude<ExecutionEnvironmentLifecycleAction, 'provision' | 'status'> | 'status';
    actor: ExecutionEnvironmentLifecycleActor;
    binding: EnvironmentProviderBinding;
  }): Promise<boolean>;
  resolveProvision(input: {
    actor: ExecutionEnvironmentLifecycleActor;
    request: ProvisionExecutionEnvironmentRequest;
  }): Promise<{ repositoryFullName: string } | undefined>;
}

export interface ExecutionEnvironmentActiveExecutionGuard {
  check(input: {
    action: 'delete' | 'stop';
    actor: ExecutionEnvironmentLifecycleActor;
    binding: EnvironmentProviderBinding;
    providerStateConfirmed: true;
  }): Promise<{ state: 'active' | 'safe' | 'uncertain' }>;
}

export interface ExecutionEnvironmentLifecycleBindingProjection {
  environmentId?: string;
  lifecycle: {
    nativeState?: string;
    normalized: EnvironmentProviderBinding['lifecycleState'];
    observedAt: string;
  };
  provider: {
    kind: string;
    resource: { name: string };
  };
}

export interface ExecutionEnvironmentLifecycleService {
  delete(
    actor: ExecutionEnvironmentLifecycleActor,
    request: DeleteExecutionEnvironmentRequest
  ): Promise<ExecutionEnvironmentLifecycleResult>;
  list(userId: string): Promise<ExecutionEnvironmentLifecycleBindingProjection[]>;
  provision(
    actor: ExecutionEnvironmentLifecycleActor,
    request: ProvisionExecutionEnvironmentRequest
  ): Promise<ExecutionEnvironmentLifecycleResult>;
  start(
    actor: ExecutionEnvironmentLifecycleActor,
    request: ExecutionEnvironmentMutationRequest
  ): Promise<ExecutionEnvironmentLifecycleResult>;
  status(
    actor: ExecutionEnvironmentLifecycleActor,
    environmentId: string
  ): Promise<ExecutionEnvironmentLifecycleResult>;
  stop(
    actor: ExecutionEnvironmentLifecycleActor,
    request: StopExecutionEnvironmentRequest
  ): Promise<ExecutionEnvironmentLifecycleResult>;
}

export interface ExecutionEnvironmentLifecycleServiceDependencies {
  authorization: ExecutionEnvironmentLifecycleAuthorization;
  createId?: () => string;
  executionGuard: ExecutionEnvironmentActiveExecutionGuard;
  now?: () => Date;
  providers: readonly ExecutionEnvironmentLifecycleProvider[];
  store: EnvironmentLifecycleStore;
}

export function createExecutionEnvironmentLifecycleService(
  dependencies: ExecutionEnvironmentLifecycleServiceDependencies
): ExecutionEnvironmentLifecycleService {
  const providers = new Map(dependencies.providers.map((provider) => [provider.kind, provider]));
  const createId = dependencies.createId ?? randomUUID;
  const now = dependencies.now ?? (() => new Date());

  return {
    delete: (actor, request) => mutate('delete', actor, request),
    async list(userId) {
      return (await dependencies.store.listBindings(userId)).map((binding) => ({
        ...(binding.environmentId ? { environmentId: binding.environmentId } : {}),
        lifecycle: {
          ...(binding.nativeState ? { nativeState: safeText(binding.nativeState, 100) } : {}),
          normalized: binding.lifecycleState,
          observedAt: binding.observedAt
        },
        provider: {
          kind: binding.providerKind,
          resource: { name: safeText(binding.providerResourceId, 128) }
        }
      }));
    },
    async provision(actor, request) {
      const resolved = await dependencies.authorization.resolveProvision({ actor, request });
      const provider = providers.get(request.provider);
      if (!resolved) return blockedProvision(request, 'not_authorized', now());
      if (!provider) return blockedProvision(request, 'unsupported_provider', now());
      const target = {
        branch: request.branch,
        repositoryFullName: resolved.repositoryFullName,
        task: request.task
      };
      let binding: EnvironmentProviderBinding | undefined;
      try {
        binding = await dependencies.store.readBindingByTask({
          ...target,
          providerKind: request.provider,
          userId: actor.userId
        });
      } catch {
        return blockedProvision(request, 'execution_state_uncertain', now());
      }
      const operation = operationForProvision(actor, request, target, binding);
      const reservation = await dependencies.store.reserve(operation);
      const early = reservationResult(reservation, 'provision', request.operationId, request.provider, binding, now());
      if (early) return early;
      if (reservation.kind === 'uncertain') {
        return reconcile(operation, provider, target, binding, 'provision');
      }
      try {
        const observed = binding
          ? await provider.status(binding, request.operationId)
          : await provider.provision(target, request.operationId);
        return finish(operation, provider, target, binding, observed, 'provision');
      } catch {
        return uncertainAfterDispatch(operation, binding, 'provision');
      }
    },
    start: (actor, request) => mutate('start', actor, request),
    async status(actor, environmentId) {
      const operationId = `status:${createId()}`;
      const binding = await dependencies.store.readBindingByEnvironment(actor.userId, environmentId);
      if (!binding) return missing('status', operationId, now());
      if (!await dependencies.authorization.authorizeBinding({ action: 'status', actor, binding })) {
        return missing('status', operationId, now());
      }
      const provider = providers.get(binding.providerKind as 'github_codespaces');
      if (!provider) return blockedForBinding('status', operationId, binding, 'unsupported_provider', now());
      try {
        let observed = await provider.status(binding, operationId);
        if (observed.lifecycleState === 'missing') {
          observed = { ...observed, lifecycleState: 'deleted' };
        }
        const saved = await saveObservation(binding, observed);
        return resultFromObservation('status', operationId, observed, saved ?? binding, 'confirmed', now());
      } catch {
        return uncertainForBinding('status', operationId, binding, now());
      }
    },
    stop: (actor, request) => mutate('stop', actor, request)
  };

  async function mutate(
    action: 'delete' | 'start' | 'stop',
    actor: ExecutionEnvironmentLifecycleActor,
    request: DeleteExecutionEnvironmentRequest | ExecutionEnvironmentMutationRequest | StopExecutionEnvironmentRequest
  ) {
    const binding = await dependencies.store.readBindingByEnvironment(actor.userId, request.environmentId);
    if (!binding) return missing(action, request.operationId, now());
    if (!await dependencies.authorization.authorizeBinding({ action, actor, binding })) {
      return missing(action, request.operationId, now());
    }
    const provider = providers.get(binding.providerKind as 'github_codespaces');
    if (!provider) return blockedForBinding(action, request.operationId, binding, 'unsupported_provider', now());
    const operation = operationForMutation(actor, action, request, binding);
    const reservation = await dependencies.store.reserve(operation);
    const early = reservationResult(reservation, action, request.operationId, provider.kind, binding, now());
    if (early) return early;
    if (reservation.kind === 'uncertain') {
      return reconcile(operation, provider, binding, binding, action);
    }
    let currentBinding = binding;
    if (action === 'delete' || action === 'stop') {
      let guard: Awaited<ReturnType<ExecutionEnvironmentActiveExecutionGuard['check']>>;
      try {
        const safetyObservation = await provider.status(
          binding,
          `safety:${request.operationId}`
        );
        if (safetyObservation.outcome !== 'confirmed') throw new Error('Provider state is uncertain.');
        const saved = await saveObservation(binding, safetyObservation);
        if (!saved) throw new Error('Provider state could not be persisted.');
        currentBinding = saved;
        guard = await dependencies.executionGuard.check({
          action,
          actor,
          binding: currentBinding,
          providerStateConfirmed: true
        });
      } catch {
        await dependencies.store.markRetryable(operation);
        return blockedForBinding(
          action,
          request.operationId,
          currentBinding,
          'execution_state_uncertain',
          now(),
          'pending'
        );
      }
      if (guard.state !== 'safe') {
        const reason = guard.state === 'active' ? 'active_execution' : 'execution_state_uncertain';
        const result = blockedForBinding(action, request.operationId, currentBinding, reason, now());
        await dependencies.store.complete(operation, stored(result));
        return result;
      }
    }
    try {
      const observed = await provider[action](currentBinding, request.operationId);
      return finish(operation, provider, currentBinding, currentBinding, observed, action);
    } catch {
      return uncertainAfterDispatch(operation, currentBinding, action);
    }
  }

  async function finish(
    operation: EnvironmentLifecycleOperation,
    provider: ExecutionEnvironmentLifecycleProvider,
    target: EnvironmentProviderBinding | ExecutionEnvironmentProviderTarget,
    binding: EnvironmentProviderBinding | undefined,
    observed: ExecutionEnvironmentProviderObservation,
    action: 'delete' | 'provision' | 'start' | 'stop'
  ) {
    if (observed.outcome === 'uncertain') {
      await dependencies.store.markUncertain(operation, true);
      return resultFromObservation(action, operation.operationId, observed, binding, 'uncertain', now());
    }
    if (observed.blockedReason === 'provider_reauthorization_required' && !observed.providerResourceName) {
      await dependencies.store.markRetryable(operation);
      return resultFromObservation(action, operation.operationId, observed, binding, 'pending', now());
    }
    const saved = await persistObservation(operation, provider, target, binding, observed);
    if (observed.providerResourceName && !saved) {
      await dependencies.store.markUncertain(operation, true);
      return uncertainForBinding(action, operation.operationId, binding, now());
    }
    const result = resultFromObservation(action, operation.operationId, observed, saved ?? binding, 'confirmed', now());
    await dependencies.store.complete(operation, stored(result));
    return result;
  }

  async function reconcile(
    operation: EnvironmentLifecycleOperation,
    provider: ExecutionEnvironmentLifecycleProvider,
    target: EnvironmentProviderBinding | ExecutionEnvironmentProviderTarget,
    binding: EnvironmentProviderBinding | undefined,
    action: 'delete' | 'provision' | 'start' | 'stop'
  ) {
    try {
      let observed = await provider.status(target, `status:${operation.operationId}`);
      if (!reconciles(action, observed)) {
        return resultFromObservation(action, operation.operationId, {
          ...observed,
          lifecycleState: 'uncertain',
          message: 'The earlier provider mutation is still being reconciled.',
          outcome: 'uncertain'
        }, binding, 'uncertain', now());
      }
      if (action === 'delete' && observed.lifecycleState === 'missing') {
        observed = { ...observed, lifecycleState: 'deleted' };
      }
      return finish(operation, provider, target, binding, observed, action);
    } catch {
      return uncertainForBinding(action, operation.operationId, binding, now());
    }
  }

  async function persistObservation(
    operation: EnvironmentLifecycleOperation,
    provider: ExecutionEnvironmentLifecycleProvider,
    target: EnvironmentProviderBinding | ExecutionEnvironmentProviderTarget,
    binding: EnvironmentProviderBinding | undefined,
    observed: ExecutionEnvironmentProviderObservation
  ) {
    if (!observed.providerResourceName && !binding) return undefined;
    const next = await saveObservation(binding ?? {
      branch: target.branch,
      id: createId(),
      lifecycleState: observed.lifecycleState,
      observedAt: observed.observedAt,
      providerKind: provider.kind,
      providerResourceId: observed.providerResourceName!,
      repositoryFullName: target.repositoryFullName,
      task: target.task,
      userId: operation.userId
    }, observed);
    if (!next) return undefined;
    const attached = await dependencies.store.attachBinding({
      ...operation,
      bindingId: next.id,
      ...(next.environmentId ? { environmentId: next.environmentId } : {})
    });
    return attached ? next : undefined;
  }

  async function saveObservation(
    binding: EnvironmentProviderBinding,
    observed: ExecutionEnvironmentProviderObservation
  ) {
    const saved = await dependencies.store.saveBinding({
      ...binding,
      ...(observed.environmentId ? { environmentId: observed.environmentId } : {}),
      lifecycleState: observed.lifecycleState,
      ...(observed.nativeState ? { nativeState: observed.nativeState } : {}),
      observedAt: observed.observedAt,
      providerResourceId: observed.providerResourceName ?? binding.providerResourceId
    });
    return saved.kind === 'saved' ? saved.binding : undefined;
  }

  async function uncertainAfterDispatch(
    operation: EnvironmentLifecycleOperation,
    binding: EnvironmentProviderBinding | undefined,
    action: 'delete' | 'provision' | 'start' | 'stop'
  ) {
    await dependencies.store.markUncertain(operation, true);
    return uncertainForBinding(action, operation.operationId, binding, now());
  }
}
