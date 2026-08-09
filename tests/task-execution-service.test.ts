import { describe, expect, it } from 'bun:test';

import type { AgentStatusResult } from '../src/shared/agent-runtime-api';
import type { ConfiguredComputeInventoryResult } from '../server/configured-compute-inventory';
import { MemoryTaskExecutionCapacityStore } from '../server/task-execution/capacity-store';
import { MemoryTaskExecutionStore } from '../server/task-execution/execution-store';
import { MemoryTaskHandoffStore } from '../server/task-execution/handoff-store';
import { MemoryTaskExecutionOperationStore } from '../server/task-execution/operation-store';
import { createTaskExecutionService } from '../server/task-execution/service';
import type { TaskExecutionServiceDependencies } from '../server/task-execution/service';

const environmentId = '10000000-0000-4000-8000-000000000001';
const threadId = '20000000-0000-4000-8000-000000000002';
const secondThreadId = '20000000-0000-4000-8000-000000000003';
const commit = 'a'.repeat(40);
const actor = { userId: 'user-a' };

describe('Task Execution service', () => {
  it('dry-runs the full target without creating durable state', async () => {
    const fixture = createFixture();
    fixture.setAuthorization('authorization-required');
    const result = await fixture.service.start(actor, startRequest({ dryRun: true }));
    expect(result).toMatchObject({
      blockedReason: 'agent_authorization_required',
      dryRun: true,
      prerequisites: { agentAuthorization: 'authorization-required' },
      state: 'blocked'
    });
    expect(await fixture.executionStore.list({
      includeArchived: true, limit: 10, ownerUserId: actor.userId
    })).toHaveLength(0);
    expect(fixture.counts.prepare).toBe(0);
    expect(fixture.counts.start).toBe(0);
  });

  it('dry-runs capacity and provider lifecycle without claiming either', async () => {
    const fixture = createFixture();
    const competing = await fixture.capacityStore.acquire({
      durationSeconds: 60,
      environmentId,
      executionId: '88888888-8888-4888-8888-888888888888',
      id: '77777777-7777-4777-8777-777777777777',
      ownerUserId: actor.userId
    });
    const capacityBlocked = await fixture.service.start(actor, startRequest({ dryRun: true }));
    expect(capacityBlocked).toMatchObject({
      blockedReason: 'capacity_unavailable',
      prerequisites: { capacity: 'unavailable' },
      state: 'blocked'
    });
    await fixture.capacityStore.release(actor.userId, competing.lease.id, competing.lease.executionId);

    fixture.setManagedStopped(true);
    const lifecycleBlocked = await fixture.service.start(actor, startRequest({ dryRun: true }));
    expect(lifecycleBlocked).toMatchObject({
      blockedReason: 'environment_not_running',
      prerequisites: { capacity: 'available', providerLifecycle: 'stopped' },
      state: 'blocked'
    });
    expect(fixture.counts.environmentStart).toBe(0);
    expect(await fixture.executionStore.list({
      includeArchived: true, limit: 10, ownerUserId: actor.userId
    })).toHaveLength(0);
  });

  it('starts once, binds exact identities, and replays the same operation', async () => {
    const fixture = createFixture();
    const request = startRequest();
    const first = await fixture.service.start(actor, request);
    expect(first).toMatchObject({
      execution: {
        connector: { generation: 7, id: 'connector-a' },
        environmentId,
        executor: { externalId: threadId },
        source: { branch: 'issue-548-task', commit, provider: 'github' },
        state: 'running',
        workspace: { state: 'ready' }
      },
      operationId: request.operationId
    });
    expect(await fixture.executionStore.readWorkspace(actor.userId, first.execution.id))
      .toMatchObject({
        target: { kind: 'project_worktree', reference: 'wt_aaaaaaaaaaaaaaaaaaaaaaaa' }
      });
    const replayed = await fixture.service.start(actor, request);
    expect(replayed).toMatchObject({ execution: { id: first.execution.id }, replayed: true });
    expect(fixture.counts.prepare).toBe(1);
    expect(fixture.counts.start).toBe(1);
  });

  it('admits only one dispatcher for concurrent identical starts', async () => {
    const fixture = createFixture();
    const request = startRequest();
    const [first, second] = await Promise.all([
      fixture.service.start(actor, request),
      fixture.service.start(actor, request)
    ]);
    expect(first).toMatchObject({ execution: { id: second.execution.id } });
    expect(fixture.counts.prepare).toBe(1);
    expect(fixture.counts.start).toBe(1);
  });

  it('rejects operation reuse with a changed Environment or Task', async () => {
    const fixture = createFixture();
    await fixture.service.start(actor, startRequest());
    await expect(fixture.service.start(actor, startRequest({
      environmentId: '99999999-9999-4999-8999-999999999999'
    }))).rejects.toThrow('operation ID');
    await expect(fixture.service.start(actor, startRequest({
      task: { number: 549, provider: 'github', repositoryId: '42' }
    }))).rejects.toThrow('operation ID');
    expect(fixture.counts.start).toBe(1);
  });

  it('resumes the same blocked Execution after managed authorization is ready', async () => {
    const fixture = createFixture();
    fixture.setAuthorization('authorization-required');
    const request = startRequest();
    const blocked = await fixture.service.start(actor, request);
    expect(blocked).toMatchObject({
      execution: { blockedReason: 'agent_authorization_required', state: 'blocked' }
    });
    expect(fixture.counts.start).toBe(0);

    fixture.setAuthorization('ready');
    const resumed = await fixture.service.start(actor, request);
    expect(resumed).toMatchObject({
      execution: { id: blocked.execution.id, state: 'running' }
    });
    expect(fixture.counts.prepare).toBe(1);
    expect(fixture.counts.start).toBe(1);
  });

  it('starts a stopped managed Environment once and resumes when its connector arrives', async () => {
    const fixture = createFixture();
    fixture.setManagedStopped(true);
    fixture.setConnectorOnline(false);
    const request = startRequest();
    const blocked = await fixture.service.start(actor, request);
    expect(blocked).toMatchObject({
      execution: { blockedReason: 'connector_required', state: 'blocked' }
    });
    expect(fixture.counts.environmentStart).toBe(1);
    expect(fixture.counts.start).toBe(0);

    fixture.setConnectorOnline(true);
    const resumed = await fixture.service.start(actor, request);
    expect(resumed).toMatchObject({ execution: { id: blocked.execution.id, state: 'running' } });
    expect(fixture.counts.environmentStart).toBe(1);
    expect(fixture.counts.start).toBe(1);
  });

  it('reconciles an uncertain Environment start with the same nested operation', async () => {
    const fixture = createFixture();
    fixture.setManagedStopped(true);
    fixture.setConnectorOnline(false);
    fixture.setEnvironmentStartUncertain(true);
    const request = startRequest();
    const first = await fixture.service.start(actor, request);
    expect(first.execution.state).toBe('uncertain');
    fixture.setEnvironmentStartUncertain(false);
    fixture.setConnectorOnline(true);
    const second = await fixture.service.start(actor, request);
    expect(second.execution.state).toBe('running');
    expect(fixture.counts.environmentStart).toBe(2);
    expect(new Set(fixture.environmentOperationIds).size).toBe(1);
    expect(fixture.counts.start).toBe(1);
  });

  it('reconciles an uncertain executor start using the same nested operation', async () => {
    const fixture = createFixture();
    fixture.setStartState('uncertain');
    const request = startRequest();
    const first = await fixture.service.start(actor, request);
    expect(first.execution.state).toBe('uncertain');
    fixture.setStartState('confirmed');
    const second = await fixture.service.start(actor, request);
    expect(second.execution.id).toBe(first.execution.id);
    expect(second.execution.state).toBe('running');
    expect(fixture.counts.start).toBe(2);
    expect(new Set(fixture.startOperationIds).size).toBe(1);
  });

  it('records a thrown executor start as uncertain and safely reconciles it', async () => {
    const fixture = createFixture();
    fixture.setStartThrows(true);
    const request = startRequest();
    const first = await fixture.service.start(actor, request);
    fixture.setStartThrows(false);
    const second = await fixture.service.start(actor, request);
    expect(first.execution.state).toBe('uncertain');
    expect(second.execution).toMatchObject({ id: first.execution.id, state: 'running' });
    expect(fixture.counts.start).toBe(2);
    expect(new Set(fixture.startOperationIds).size).toBe(1);
  });

  it('keeps a capacity block resumable without creating another Execution', async () => {
    const fixture = createFixture();
    const competing = await fixture.capacityStore.acquire({
      durationSeconds: 60,
      environmentId,
      executionId: '88888888-8888-4888-8888-888888888888',
      id: '77777777-7777-4777-8777-777777777777',
      ownerUserId: actor.userId
    });
    const request = startRequest();
    const blocked = await fixture.service.start(actor, request);
    expect(blocked).toMatchObject({
      execution: { blockedReason: 'capacity_unavailable', state: 'blocked' }
    });
    await fixture.capacityStore.release(
      actor.userId,
      competing.lease.id,
      competing.lease.executionId
    );
    const resumed = await fixture.service.start(actor, request);
    expect(resumed).toMatchObject({ execution: { id: blocked.execution.id, state: 'running' } });
    expect(fixture.counts.start).toBe(1);
  });

  it('sends idempotently through the bound executor', async () => {
    const fixture = createFixture();
    const started = await fixture.service.start(actor, startRequest());
    const request = {
      executionId: started.execution.id,
      message: 'Continue with the tests.',
      operationId: 'send-operation-001'
    };
    const first = await fixture.service.send(actor, request);
    const replayed = await fixture.service.send(actor, request);
    expect(first.execution.executor?.turnId).toBe('turn-2');
    expect(replayed.replayed).toBe(true);
    expect(fixture.counts.send).toBe(1);
  });

  it('reconciles an uncertain message with the same nested operation', async () => {
    const fixture = createFixture();
    const started = await fixture.service.start(actor, startRequest());
    const request = {
      executionId: started.execution.id,
      message: 'Continue with the tests.',
      operationId: 'send-operation-uncertain'
    };
    fixture.setSendState('uncertain');
    expect((await fixture.service.send(actor, request)).execution.state).toBe('uncertain');
    fixture.setSendState('accepted');
    expect((await fixture.service.send(actor, request)).execution.state).toBe('running');
    expect(fixture.counts.send).toBe(2);
    expect(new Set(fixture.sendOperationIds).size).toBe(1);
  });

  it('does not send new work after confirmed cancellation', async () => {
    const fixture = createFixture();
    const started = await fixture.service.start(actor, startRequest());
    await fixture.service.cancel(actor, {
      executionId: started.execution.id,
      operationId: 'cancel-before-send'
    });
    const refused = await fixture.service.send(actor, {
      executionId: started.execution.id,
      message: 'This must not run.',
      operationId: 'send-after-cancel'
    });
    expect(refused.execution.state).toBe('cancelled');
    expect(fixture.counts.send).toBe(0);
  });

  it('keeps capacity when cancellation cannot confirm an uncertain executor', async () => {
    const fixture = createFixture();
    fixture.setStartState('uncertain');
    const started = await fixture.service.start(actor, startRequest());
    const cancelled = await fixture.service.cancel(actor, {
      executionId: started.execution.id,
      operationId: 'cancel-uncertain-executor'
    });
    expect(cancelled.execution.state).toBe('uncertain');
    expect(await fixture.capacityStore.read(actor.userId, environmentId)).toMatchObject({
      executionId: started.execution.id,
      state: 'active'
    });
  });

  it('reconciles an uncertain cancellation and heals delayed capacity release', async () => {
    const fixture = createFixture();
    const started = await fixture.service.start(actor, startRequest());
    const request = {
      executionId: started.execution.id,
      operationId: 'cancel-operation-uncertain'
    };
    fixture.setActiveTurnId('turn-active');
    fixture.setInterruptStatus('ambiguous');
    expect((await fixture.service.cancel(actor, request)).execution.state).toBe('uncertain');
    fixture.setInterruptStatus('completed');
    fixture.setReleaseThrowsOnce(true);
    await expect(fixture.service.cancel(actor, request)).rejects.toThrow('release failed');
    expect((await fixture.service.cancel(actor, request)).execution.state).toBe('cancelled');
    expect(new Set(fixture.interruptOperationIds).size).toBe(1);
    expect(await fixture.capacityStore.read(actor.userId, environmentId)).toBeUndefined();
  });

  it('reconciles an uncertain approval with the same nested operation', async () => {
    const fixture = createFixture();
    const started = await fixture.service.start(actor, startRequest());
    fixture.setAttention('approval');
    await fixture.service.get(actor, { executionId: started.execution.id });
    const request = {
      approvalId: 'approval-1', decision: 'allow-once' as const,
      executionId: started.execution.id, itemId: 'item-1',
      operationId: 'approval-operation-uncertain',
      requestId: 'request-1', turnId: 'turn-1'
    };
    fixture.setSessionMutationStatus('ambiguous');
    expect((await fixture.service.respondApproval(actor, request)).execution.state)
      .toBe('waiting_for_approval');
    fixture.setSessionMutationStatus('completed');
    expect((await fixture.service.respondApproval(actor, request)).execution.state).toBe('running');
    expect(new Set(fixture.approvalOperationIds).size).toBe(1);
  });

  it('forwards exact approval and input identities, then cancels and archives', async () => {
    const fixture = createFixture();
    const started = await fixture.service.start(actor, startRequest());
    fixture.setAttention('approval');
    const approvalPending = await fixture.service.get(actor, { executionId: started.execution.id });
    expect(approvalPending.activity?.pendingRequests).toEqual([expect.objectContaining({
      requestId: 'request-1', turnId: 'turn-1', type: 'approval'
    })]);
    await fixture.service.respondApproval(actor, {
      approvalId: 'approval-1', decision: 'allow-once', executionId: started.execution.id,
      itemId: 'item-1', operationId: 'approval-operation-001',
      requestId: 'request-1', turnId: 'turn-1'
    });
    fixture.setAttention('input');
    await fixture.service.get(actor, { executionId: started.execution.id });
    await fixture.service.respondInput(actor, {
      answers: [{ questionId: 'question-1', value: 'yes' }],
      executionId: started.execution.id, operationId: 'input-operation-001',
      requestId: 'request-2', turnId: 'turn-1'
    });
    expect(fixture.approval).toMatchObject({
      approvalId: 'approval-1', connectorGeneration: 7, itemId: 'item-1',
      requestId: 'request-1', turnId: 'turn-1'
    });
    expect(fixture.input).toMatchObject({
      answers: [{ questionId: 'question-1', value: 'yes' }],
      connectorGeneration: 7, requestId: 'request-2'
    });

    const cancelled = await fixture.service.cancel(actor, {
      executionId: started.execution.id,
      operationId: 'cancel-operation-001',
      reason: 'No longer needed.'
    });
    expect(cancelled.execution.state).toBe('cancelled');
    expect(await fixture.capacityStore.read(actor.userId, environmentId)).toBeUndefined();
    const archived = await fixture.service.archive(actor, {
      executionId: started.execution.id,
      operationId: 'archive-operation-01'
    });
    expect(archived.execution.state).toBe('archived');
  });

  it('keeps list and executor lookup owner scoped', async () => {
    const fixture = createFixture();
    const started = await fixture.service.start(actor, startRequest());
    expect((await fixture.service.list(actor, { limit: 1 })).executions).toHaveLength(1);
    expect((await fixture.service.list({ userId: 'user-b' }, {})).executions).toHaveLength(0);
    expect(await fixture.service.readByExecutor(actor, 'codex', threadId)).toMatchObject({
      execution: { id: started.execution.id }
    });
    expect(await fixture.service.readByExecutor({ userId: 'user-b' }, 'codex', threadId)).toBeUndefined();
  });

  it('paginates stable owner inventory and wakes only for actionable attention', async () => {
    const fixture = createFixture();
    const first = await fixture.service.start(actor, startRequest());
    await fixture.service.cancel(actor, {
      executionId: first.execution.id,
      operationId: 'cancel-for-pagination'
    });
    const second = await fixture.service.start(actor, startRequest({
      operationId: 'start-operation-002'
    }));
    const firstPage = await fixture.service.list(actor, { includeArchived: true, limit: 1 });
    expect(firstPage.executions).toHaveLength(1);
    expect(firstPage.nextCursor).toBeTruthy();
    const secondPage = await fixture.service.list(actor, {
      cursor: firstPage.nextCursor,
      includeArchived: true,
      limit: 1
    });
    expect(secondPage.executions).toHaveLength(1);
    expect(secondPage.executions[0]?.id).not.toBe(firstPage.executions[0]?.id);

    expect(await fixture.service.wait(actor, {
      executions: [{ executionId: second.execution.id }],
      timeoutSeconds: 0
    })).toMatchObject({ timedOut: true });
    fixture.setAttention('approval');
    expect(await fixture.service.wait(actor, {
      executions: [{ executionId: second.execution.id }],
      timeoutSeconds: 0
    })).toMatchObject({
      executions: [{ execution: { state: 'waiting_for_approval' } }],
      timedOut: false
    });
  });

  it('leaves an active Execution unchanged when archive is refused', async () => {
    const fixture = createFixture();
    const started = await fixture.service.start(actor, startRequest());
    const refused = await fixture.service.archive(actor, {
      executionId: started.execution.id,
      operationId: 'archive-operation-active'
    });
    expect(refused.execution.state).toBe('running');
    const replayed = await fixture.service.archive(actor, {
      executionId: started.execution.id,
      operationId: 'archive-operation-active'
    });
    expect(replayed).toMatchObject({ execution: { state: 'running' }, replayed: true });
  });

  it('fails closed on lost live reads but keeps terminal history readable offline', async () => {
    const fixture = createFixture();
    const started = await fixture.service.start(actor, startRequest());
    fixture.setReadThrows(true);
    expect(await fixture.service.get(actor, { executionId: started.execution.id }))
      .toMatchObject({ execution: { blockedReason: 'connector_stale', state: 'blocked' } });

    fixture.setReadThrows(false);
    const recovered = await fixture.service.get(actor, { executionId: started.execution.id });
    expect(recovered.execution.state).toBe('running');
    await fixture.service.cancel(actor, {
      executionId: started.execution.id,
      operationId: 'cancel-before-offline-read'
    });
    fixture.setReadThrows(true);
    expect(await fixture.service.get(actor, { executionId: started.execution.id }))
      .toMatchObject({ execution: { state: 'cancelled' } });
  });
});

function startRequest(overrides: Record<string, unknown> = {}) {
  return {
    environmentId,
    operationId: 'start-operation-001',
    task: { number: 548, provider: 'github' as const, repositoryId: '42' },
    ...overrides
  };
}

function createFixture() {
  let authorization: AgentStatusResult['runtime']['authorization']['state'] = 'ready';
  let startState: 'confirmed' | 'uncertain' = 'confirmed';
  let startThrows = false;
  let connectorOnline = true;
  let environmentStartUncertain = false;
  let managedStopped = false;
  let readThrows = false;
  let releaseThrowsOnce = false;
  let sendState: 'accepted' | 'uncertain' = 'accepted';
  let sessionMutationStatus: 'ambiguous' | 'completed' = 'completed';
  let activeTurnId: string | undefined;
  let interruptStatus: 'ambiguous' | 'completed' = 'completed';
  let attention: 'approval' | 'input' | undefined;
  const counts = { environmentStart: 0, prepare: 0, send: 0, start: 0 };
  let approval: unknown;
  let input: unknown;
  const environmentOperationIds: string[] = [];
  const approvalOperationIds: string[] = [];
  const interruptOperationIds: string[] = [];
  const sendOperationIds: string[] = [];
  const startOperationIds: string[] = [];
  const executionStore = new MemoryTaskExecutionStore();
  const capacityStore = new MemoryTaskExecutionCapacityStore();
  const dependencies: TaskExecutionServiceDependencies = {
    agentRuntime: {
      authorize: async () => { throw new Error('not used'); },
      status: async (_actor, request) => ({
        agent: 'codex', apiVersion: 1, environmentId: request.environmentId,
        message: 'Current agent evidence.',
        runtime: {
          authorization: { checkedAt: new Date().toISOString(), state: authorization },
          capabilities: ['codex.runtime.v1'], checkedAt: new Date().toISOString(),
          connector: { generation: 7, id: 'connector-a' }, state: 'ready'
        }
      })
    },
    capacity: {
      acquire: (request) => capacityStore.acquire(request),
      read: (userId, targetEnvironmentId) => capacityStore.read(userId, targetEnvironmentId),
      release: async (userId, leaseId, executionId) => {
        if (releaseThrowsOnce) {
          releaseThrowsOnce = false;
          throw new Error('release failed');
        }
        return capacityStore.release(userId, leaseId, executionId);
      },
      renew: (userId, leaseId, executionId, durationSeconds) =>
        capacityStore.renew(userId, leaseId, executionId, durationSeconds)
    },
    codex: {
      service: {
        read: async () => {
          if (readThrows) throw new Error('Connector is offline.');
          return confirmedRead(attention);
        },
        send: async (_actor: unknown, request: { operationId: string; threadId: string }) => {
          counts.send += 1;
          sendOperationIds.push(request.operationId);
          return sendState === 'uncertain'
            ? { apiVersion: 1, message: 'Unknown outcome.', operationId: request.operationId,
                reconcile: 'required', state: 'uncertain' }
            : { apiVersion: 1, operationId: request.operationId, state: 'accepted',
                target: target(), threadId: request.threadId, turnId: 'turn-2' };
        },
        start: async (_actor: unknown, request: { operationId: string }) => {
          counts.start += 1;
          startOperationIds.push(request.operationId);
          if (startThrows) throw new Error('The remote response was lost.');
          return startState === 'uncertain'
            ? { apiVersion: 1, message: 'Unknown outcome.', operationId: request.operationId,
                reconcile: 'required', state: 'uncertain' }
            : { apiVersion: 1, operationId: request.operationId, state: 'confirmed', task: {
                ...target(), canonicalTaskUrl: 'https://example.invalid/task',
                issue: { number: 548, url: 'https://example.invalid/548' },
                repository: { id: '42', nameWithOwner: 'DotNaos/project-space' },
                threadId: counts.start === 1 ? threadId : secondThreadId,
                worktree: { branch: 'issue-548-task', id: counts.start === 1
                  ? 'wt_aaaaaaaaaaaaaaaaaaaaaaaa' : 'wt_bbbbbbbbbbbbbbbbbbbbbbbb' }
              } };
        }
      },
      sessions: { service: {
        approve: async (_actor: unknown, request: unknown) => {
          approval = request;
          approvalOperationIds.push((request as { operationId: string }).operationId);
          if (sessionMutationStatus === 'completed') attention = undefined;
          return { operationId: 'approval', replayed: false, status: sessionMutationStatus,
            threadId, turnId: 'turn-1' };
        },
        inspect: async () => ({ activeTurnId }),
        interrupt: async (_actor: unknown, request: { operationId: string }) => {
          interruptOperationIds.push(request.operationId);
          return { operationId: 'cancel', replayed: false, status: interruptStatus, threadId };
        },
        reconcileApproval: async (_actor: unknown, request: unknown) => {
          approval = request;
          approvalOperationIds.push((request as { operationId: string }).operationId);
          if (sessionMutationStatus === 'completed') attention = undefined;
          return { operationId: 'approval', replayed: true, status: sessionMutationStatus,
            threadId, turnId: 'turn-1' };
        },
        reconcileInterrupt: async (_actor: unknown, request: { operationId: string }) => {
          interruptOperationIds.push(request.operationId);
          return { operationId: 'cancel', replayed: true, status: interruptStatus, threadId };
        },
        reconcileUserInput: async (_actor: unknown, request: unknown) => {
          input = request;
          if (sessionMutationStatus === 'completed') attention = undefined;
          return { operationId: 'input', replayed: true, status: sessionMutationStatus,
            threadId, turnId: 'turn-1' };
        },
        respondToUserInput: async (_actor: unknown, request: unknown) => {
          input = request;
          if (sessionMutationStatus === 'completed') attention = undefined;
          return { operationId: 'input', replayed: false, status: sessionMutationStatus,
            threadId, turnId: 'turn-1' };
        }
      } }
    } as TaskExecutionServiceDependencies['codex'],
    environmentLifecycle: {
      delete: async () => { throw new Error('not used'); },
      list: async () => managedStopped ? [{
        environmentId,
        lifecycle: { normalized: 'stopped' as const, observedAt: new Date().toISOString() },
        provider: { kind: 'github_codespaces', resource: { name: 'codespace-a' } }
      }] : [],
      provision: async () => { throw new Error('not used'); },
      start: async (_actor, request) => {
        counts.environmentStart += 1;
        environmentOperationIds.push(request.operationId);
        return {
          action: 'start' as const, apiVersion: 1 as const,
          ...(environmentStartUncertain ? { blocked: { reason: 'execution_state_uncertain' as const } } : {}),
          environment: { id: environmentId, kind: 'github_codespace' as const, name: 'codespace-a' },
          lifecycle: {
            normalized: environmentStartUncertain ? 'uncertain' as const : 'starting' as const,
            observedAt: new Date().toISOString()
          },
          message: environmentStartUncertain ? 'The provider outcome is uncertain.' : 'Codespace is starting.',
          operationId: request.operationId,
          provider: { kind: 'github_codespaces' as const, resource: { name: 'codespace-a' } },
          reconciliation: {
            checkedAt: new Date().toISOString(),
            state: environmentStartUncertain ? 'uncertain' as const : 'confirmed' as const
          }
        };
      },
      status: async () => ({
        action: 'status' as const, apiVersion: 1 as const,
        environment: { id: environmentId, kind: 'github_codespace' as const, name: 'codespace-a' },
        lifecycle: {
          normalized: managedStopped ? 'stopped' as const : 'running' as const,
          observedAt: new Date().toISOString()
        },
        message: 'Current provider state.', operationId: 'status:fixture',
        provider: { kind: 'github_codespaces' as const, resource: { name: 'codespace-a' } },
        reconciliation: { checkedAt: new Date().toISOString(), state: 'confirmed' as const }
      }),
      stop: async () => { throw new Error('not used'); }
    },
    handoffs: new MemoryTaskHandoffStore(),
    loadInventory: async () => inventory(connectorOnline),
    operations: new MemoryTaskExecutionOperationStore(),
    source: {
      prepare: async () => {
        counts.prepare += 1;
        return source(true);
      },
      resolve: async () => source(false)
    },
    store: executionStore
  };
  return {
    approvalOperationIds, capacityStore, counts, environmentOperationIds, executionStore,
    interruptOperationIds, sendOperationIds, startOperationIds,
    get approval() { return approval; },
    get input() { return input; },
    service: createTaskExecutionService(dependencies),
    setAttention(value: typeof attention) { attention = value; },
    setActiveTurnId(value: typeof activeTurnId) { activeTurnId = value; },
    setAuthorization(value: typeof authorization) { authorization = value; },
    setConnectorOnline(value: boolean) { connectorOnline = value; },
    setEnvironmentStartUncertain(value: boolean) { environmentStartUncertain = value; },
    setManagedStopped(value: boolean) { managedStopped = value; },
    setReadThrows(value: boolean) { readThrows = value; },
    setReleaseThrowsOnce(value: boolean) { releaseThrowsOnce = value; },
    setSendState(value: typeof sendState) { sendState = value; },
    setSessionMutationStatus(value: typeof sessionMutationStatus) { sessionMutationStatus = value; },
    setInterruptStatus(value: typeof interruptStatus) { interruptStatus = value; },
    setStartThrows(value: boolean) { startThrows = value; },
    setStartState(value: typeof startState) { startState = value; }
  };
}

function source(prepared: boolean) {
  return {
    body: 'Implement the task.', branch: 'issue-548-task', branchExists: prepared,
    commit: prepared ? commit : undefined, provider: 'github' as const,
    providerTaskId: '548', repositoryId: '42', repositoryName: 'DotNaos/project-space',
    taskId: 'github:DotNaos/project-space:548', title: 'Task execution tools'
  };
}

function target() {
  return {
    connector: { generation: 7, id: 'connector-a', name: 'Runner' },
    environment: { id: environmentId, name: 'Codespace' },
    physicalMachine: { id: environmentId, name: 'Compatibility' }
  };
}

function confirmedRead(attention?: 'approval' | 'input') {
  return {
    apiVersion: 1 as const,
    result: {
      openedReadOnly: true as const,
      ...(attention ? { pendingRequests: attention === 'approval' ? [{
        approvalId: 'permissions', canAllow: true, eventId: 'approval-event',
        kind: 'permissions' as const, requestId: 'request-1', turnId: 'turn-1',
        type: 'approval-requested' as const
      }] : [{
        eventId: 'input-event', questions: [{ id: 'question-1', prompt: 'Proceed?' }],
        requestId: 'request-2', turnId: 'turn-1', type: 'user-input-requested' as const
      }] } : {}),
      session: {
        archived: false, id: threadId, lastActivityAt: new Date().toISOString(),
        loadedByProjectSpace: true, machineId: 'connector-a', machineName: 'Runner',
        ...(attention ? { attention } : {}),
        status: 'active' as const, title: 'Task execution tools'
      },
      turns: []
    },
    state: 'confirmed' as const,
    target: target()
  };
}

function inventory(connectorOnline = true) {
  return {
    checkedAt: new Date().toISOString(),
    connectors: connectorOnline ? [{ id: 'connector-a', connector: { status: 'online' } }] : [],
    generations: connectorOnline ? new Map([['connector-a', 7]]) : new Map(),
    physicalMachines: [],
    snapshot: {
      connectors: connectorOnline
        ? [{ associatedAt: new Date().toISOString(), connectorId: 'connector-a', environmentId }]
        : [],
      environments: [{ id: environmentId, kind: 'github_codespace' }],
      hosts: [], platforms: [], violations: []
    }
  } as unknown as ConfiguredComputeInventoryResult;
}
