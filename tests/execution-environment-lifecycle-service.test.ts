import { describe, expect, mock, test } from 'bun:test';

import {
  createExecutionEnvironmentLifecycleService,
  type ExecutionEnvironmentActiveExecutionGuard,
  type ExecutionEnvironmentLifecycleAuthorization
} from '../server/execution-environment-lifecycle/service';
import type {
  ExecutionEnvironmentLifecycleProvider,
  ExecutionEnvironmentProviderObservation
} from '../server/execution-environment-lifecycle/provider';
import {
  MemoryEnvironmentLifecycleStore,
  type EnvironmentProviderBinding
} from '../server/execution-environment-lifecycle/store';

const checkedAt = '2026-08-09T10:00:00.000Z';
const actor = { userId: 'user-owner' };
const provisionRequest = {
  branch: 'issue-536-codespace',
  operationId: 'operation-provision-536',
  provider: 'github_codespaces' as const,
  repositoryId: 'repository-project-space',
  task: 536
};
const binding: EnvironmentProviderBinding = {
  branch: provisionRequest.branch,
  environmentId: '00000000-0000-4000-8000-000000000536',
  id: '00000000-0000-4000-8000-000000000053',
  lifecycleState: 'running',
  nativeState: 'Available',
  observedAt: checkedAt,
  providerKind: 'github_codespaces',
  providerResourceId: 'reliable-space-536',
  repositoryFullName: 'DotNaos/project-space',
  task: 536,
  userId: actor.userId
};

function observation(
  overrides: Partial<ExecutionEnvironmentProviderObservation> = {}
): ExecutionEnvironmentProviderObservation {
  return {
    environmentId: binding.environmentId,
    lifecycleState: 'running',
    message: 'The Codespace is ready.',
    nativeState: 'Available',
    observedAt: checkedAt,
    outcome: 'confirmed',
    providerResourceName: binding.providerResourceId,
    readiness: { state: 'ready' },
    ...overrides
  };
}

function providerFixture() {
  const current = { status: observation() };
  const provision = mock(async () => observation());
  const start = mock(async () => observation({ lifecycleState: 'starting', nativeState: 'Starting' }));
  const stop = mock(async () => observation({ lifecycleState: 'stopping', nativeState: 'Stopping' }));
  const remove = mock(async () => observation({
    environmentId: undefined,
    lifecycleState: 'deleted',
    nativeState: undefined,
    providerResourceName: undefined,
    readiness: { state: 'unavailable' }
  }));
  const status = mock(async () => current.status);
  const provider: ExecutionEnvironmentLifecycleProvider = {
    delete: remove,
    kind: 'github_codespaces',
    provision,
    start,
    status,
    stop
  };
  return { current, provider, provision, remove, start, status, stop };
}

function serviceFixture(options: {
  guardState?: 'active' | 'safe' | 'uncertain';
  provider?: ReturnType<typeof providerFixture>;
  store?: MemoryEnvironmentLifecycleStore;
} = {}) {
  const store = options.store ?? new MemoryEnvironmentLifecycleStore();
  const provider = options.provider ?? providerFixture();
  const authorization: ExecutionEnvironmentLifecycleAuthorization = {
    authorizeBinding: async ({ actor: selected, binding: selectedBinding }) => (
      selected.userId === selectedBinding.userId
    ),
    resolveProvision: async ({ actor: selected }) => selected.userId === actor.userId
      ? { repositoryFullName: 'DotNaos/project-space' }
      : undefined
  };
  const executionGuard: ExecutionEnvironmentActiveExecutionGuard = {
    check: mock(async () => ({ state: options.guardState ?? 'safe' }))
  };
  return {
    executionGuard,
    provider,
    service: createExecutionEnvironmentLifecycleService({
      authorization,
      createId: () => '00000000-0000-4000-8000-000000000999',
      executionGuard,
      now: () => new Date(checkedAt),
      providers: [provider.provider],
      store
    }),
    store
  };
}

async function storedFixture(options: Parameters<typeof serviceFixture>[0] = {}) {
  const fixture = serviceFixture(options);
  await fixture.store.saveBinding(binding);
  return fixture;
}

describe('execution Environment lifecycle service', () => {
  test('persists an owner-bound provision and replays only identical input', async () => {
    const fixture = serviceFixture();

    const created = await fixture.service.provision(actor, provisionRequest);
    expect(created).toMatchObject({
      environment: { id: binding.environmentId },
      lifecycle: { nativeState: 'Available', normalized: 'running' },
      reconciliation: { state: 'confirmed' }
    });
    expect(await fixture.service.list(actor.userId)).toHaveLength(1);
    expect(await fixture.service.list('different-user')).toEqual([]);

    const replayed = await fixture.service.provision(actor, provisionRequest);
    expect(replayed.reconciliation.state).toBe('replayed');
    expect(fixture.provider.provision).toHaveBeenCalledTimes(1);

    const conflict = await fixture.service.provision(actor, {
      ...provisionRequest,
      branch: 'different-branch'
    });
    expect(conflict.blocked?.reason).toBe('operation_conflict');
    expect(fixture.provider.provision).toHaveBeenCalledTimes(1);
  });

  test('reconciles an uncertain provision through status without creating twice', async () => {
    const provider = providerFixture();
    provider.provision.mockImplementationOnce(async () => observation({
      environmentId: undefined,
      lifecycleState: 'uncertain',
      nativeState: undefined,
      outcome: 'uncertain',
      providerResourceName: undefined,
      readiness: { state: 'unavailable' }
    }));
    const fixture = serviceFixture({ provider });

    const first = await fixture.service.provision(actor, provisionRequest);
    expect(first.reconciliation.state).toBe('uncertain');

    const reconciled = await fixture.service.provision(actor, provisionRequest);
    expect(reconciled).toMatchObject({
      environment: { id: binding.environmentId },
      reconciliation: { state: 'confirmed' }
    });
    expect(provider.provision).toHaveBeenCalledTimes(1);
    expect(provider.status).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['start', 'starting', 'Starting'],
    ['stop', 'stopped', 'Shutdown']
  ] as const)('reconciles an uncertain %s without redelivering it', async (
    action,
    lifecycleState,
    nativeState
  ) => {
    const provider = providerFixture();
    provider[action].mockImplementationOnce(async () => observation({
      lifecycleState: 'uncertain',
      outcome: 'uncertain'
    }));
    provider.current.status = observation({ lifecycleState, nativeState });
    const fixture = await storedFixture({ provider });
    const request = {
      environmentId: binding.environmentId!,
      operationId: `operation-${action}-uncertain`
    };

    expect((await fixture.service[action](actor, request)).reconciliation.state).toBe('uncertain');
    const reconciled = await fixture.service[action](actor, request);
    expect(reconciled).toMatchObject({
      lifecycle: { nativeState, normalized: lifecycleState },
      reconciliation: { state: 'confirmed' }
    });
    expect(provider[action]).toHaveBeenCalledTimes(1);
    expect(provider.status).toHaveBeenCalledTimes(action === 'stop' ? 2 : 1);
  });

  test('retries the same undelivered operation after provider reauthorization', async () => {
    const provider = providerFixture();
    provider.provision.mockImplementationOnce(async () => observation({
      blockedReason: 'provider_reauthorization_required',
      environmentId: undefined,
      lifecycleState: 'uncertain',
      nativeState: undefined,
      providerResourceName: undefined,
      readiness: { state: 'unavailable' },
      reauthorization: { provider: 'github', requiredScopes: ['codespace'] }
    }));
    const fixture = serviceFixture({ provider });

    const blocked = await fixture.service.provision(actor, provisionRequest);
    expect(blocked).toMatchObject({
      blocked: { reason: 'provider_reauthorization_required' },
      reauthorization: { provider: 'github', requiredScopes: ['codespace'] },
      reconciliation: { state: 'pending' }
    });
    const retried = await fixture.service.provision(actor, provisionRequest);
    expect(retried.reconciliation.state).toBe('confirmed');
    expect(provider.provision).toHaveBeenCalledTimes(2);
  });

  test('never redelivers an uncertain delete and fences competing operations', async () => {
    const provider = providerFixture();
    provider.remove.mockImplementationOnce(async () => observation({
      lifecycleState: 'uncertain',
      outcome: 'uncertain'
    }));
    provider.current.status = observation({ lifecycleState: 'running' });
    const fixture = await storedFixture({ provider });
    const request = { environmentId: binding.environmentId!, operationId: 'operation-delete-536' };

    expect((await fixture.service.delete(actor, request)).reconciliation.state).toBe('uncertain');
    expect((await fixture.service.delete(actor, request)).reconciliation.state).toBe('uncertain');
    expect(provider.remove).toHaveBeenCalledTimes(1);

    const fenced = await fixture.service.delete(actor, {
      ...request,
      operationId: 'operation-delete-competing'
    });
    expect(fenced.blocked?.reason).toBe('execution_state_uncertain');
    expect(provider.remove).toHaveBeenCalledTimes(1);

    provider.current.status = observation({
      environmentId: undefined,
      lifecycleState: 'missing',
      nativeState: undefined,
      providerResourceName: undefined,
      readiness: { state: 'unavailable' }
    });
    const reconciled = await fixture.service.delete(actor, request);
    expect(reconciled.lifecycle.normalized).toBe('deleted');
    expect(reconciled.reconciliation.state).toBe('confirmed');
    expect(provider.remove).toHaveBeenCalledTimes(1);
  });

  test('fails closed before stop or delete while execution evidence is active or uncertain', async () => {
    const active = await storedFixture({ guardState: 'active' });
    const stopped = await active.service.stop(actor, {
      environmentId: binding.environmentId!, operationId: 'operation-stop-active'
    });
    expect(stopped.blocked?.reason).toBe('active_execution');
    expect(active.provider.stop).not.toHaveBeenCalled();

    const uncertain = await storedFixture({ guardState: 'uncertain' });
    const removed = await uncertain.service.delete(actor, {
      environmentId: binding.environmentId!, operationId: 'operation-delete-uncertain-guard'
    });
    expect(removed.blocked?.reason).toBe('execution_state_uncertain');
    expect(uncertain.provider.remove).not.toHaveBeenCalled();
  });

  test('hides another owner binding as not found', async () => {
    const fixture = await storedFixture();
    const result = await fixture.service.start({ userId: 'different-user' }, {
      environmentId: binding.environmentId!, operationId: 'operation-owner-bound'
    });
    expect(result.blocked?.reason).toBe('environment_not_found');
    expect(fixture.provider.start).not.toHaveBeenCalled();
  });
});
