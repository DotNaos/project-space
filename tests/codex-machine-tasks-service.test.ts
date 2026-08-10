import { describe, expect, test } from 'bun:test';

import {
  CodexMachineTasksConflictError,
  codexAttachToken
} from '../server/codex-machine-tasks/service';
import { CodexMachineTaskIssueError } from '../server/codex-machine-tasks/issue-provider';
import {
  connector,
  memoryStore,
  request,
  service,
  threadId
} from './fixtures/codex-machine-tasks-service';

describe('Codex machine-task service', () => {
  test('confirms a target-created persistent thread and replays identical starts', async () => {
    const store = memoryStore();
    let starts = 0;
    const tasks = service({
      start: async () => {
        starts += 1;
        return { state: 'confirmed', threadId, worktreeId: 'wt_confirmed' };
      },
      store
    });

    const first = await tasks.start({ userId: 'user-owner' }, request);
    const replay = await tasks.start({ userId: 'user-owner' }, request);

    expect(first).toEqual(expect.objectContaining({ state: 'confirmed' }));
    expect(first.state === 'confirmed' && first.task).toEqual(expect.objectContaining({
      canonicalTaskUrl: `https://projects.example/codex/machines/connector-local/threads/${threadId}`,
      threadId,
      worktree: { branch: 'issue-262-build-codex-machine-task-core-and-cli', id: 'wt_confirmed' }
    }));
    expect(replay).toEqual(first);
    expect(await tasks.start({ userId: 'user-owner' }, {
      ...request,
      operationId: 'start-262-local-again'
    })).toEqual({ ...first, operationId: 'start-262-local-again' });
    expect(starts).toBe(1);
  });

  test('resolves an existing issue task to its stable action without creating a duplicate', async () => {
    const store = memoryStore();
    const tasks = service({ store });
    const started = await tasks.start({ userId: 'user-owner' }, request);

    expect(started.state).toBe('confirmed');
    expect(await tasks.existing({ userId: 'user-owner' }, {
      connectorId: 'connector-local',
      issue: 262,
      repositoryId: 'DotNaos/project-space'
    })).toEqual(expect.objectContaining({
      action: 'continue',
      state: 'confirmed',
      task: expect.objectContaining({ threadId })
    }));
    expect(store.operations.size).toBe(1);
  });

  test('surfaces unresolved duplicate starts as an attention action', async () => {
    const store = memoryStore();
    await service({
      start: async () => ({ state: 'uncertain' }),
      store
    }).start({ userId: 'user-owner' }, request);

    expect(await service({ store }).existing({ userId: 'user-owner' }, {
      connectorId: 'connector-local',
      issue: 262,
      repositoryId: 'R_test'
    })).toEqual(expect.objectContaining({
      message: expect.stringContaining('recovery'),
      state: 'attention'
    }));
  });

  test('replays a completed start before consulting live target or GitHub state', async () => {
    const store = memoryStore();
    const first = await service({ store }).start({ userId: 'user-owner' }, request);
    let inventoryCalls = 0;
    let issueCalls = 0;
    const replay = await service({
      inventory: async () => {
        inventoryCalls += 1;
        throw new Error('connector inventory is unavailable');
      },
      issue: async () => {
        issueCalls += 1;
        throw new CodexMachineTaskIssueError('offline', 'GitHub is unavailable.');
      },
      store
    }).start({ userId: 'user-owner' }, request);

    expect(replay).toEqual(first);
    expect(inventoryCalls).toBe(0);
    expect(issueCalls).toBe(0);
  });

  test('rejects changed start input before consulting live target state', async () => {
    const store = memoryStore();
    await service({ store }).start({ userId: 'user-owner' }, request);
    let inventoryCalls = 0;
    await expect(service({
      inventory: async () => {
        inventoryCalls += 1;
        throw new Error('connector inventory is unavailable');
      },
      store
    }).start({ userId: 'user-owner' }, { ...request, issue: 263 }))
      .rejects.toBeInstanceOf(CodexMachineTasksConflictError);
    expect(inventoryCalls).toBe(0);
  });

  test('resolves --here from the authenticated caller connector without guessing', async () => {
    const result = await service().start({
      callerMachineId: 'connector-local',
      userId: 'user-owner'
    }, {
      issue: 262,
      operationId: 'start-here'
    });
    expect(result).toEqual(expect.objectContaining({ state: 'confirmed' }));
    expect(result.state === 'confirmed' && result.task.connector.id).toBe('connector-local');
    expect(result.state === 'confirmed' && result.task.physicalMachine.id).toBe('physical-local');
  });

  test('blocks worktree failure and preserves uncertain start without blind retry', async () => {
    const failed = await service({
      start: async () => ({ message: 'Could not prepare worktree.', state: 'worktree_failure' })
    }).start({ userId: 'user-owner' }, request);
    expect(failed).toEqual(expect.objectContaining({
      reason: 'worktree_failure', state: 'blocked'
    }));

    const store = memoryStore();
    let starts = 0;
    const uncertainTasks = service({
      start: async () => {
        starts += 1;
        return { state: 'uncertain' };
      },
      store
    });
    expect(await uncertainTasks.start({ userId: 'user-owner' }, request)).toEqual(
      expect.objectContaining({ reconcile: 'required', state: 'uncertain' })
    );
    expect(await uncertainTasks.start({ userId: 'user-owner' }, request)).toEqual(
      expect.objectContaining({ reconcile: 'required', state: 'uncertain' })
    );
    expect(await uncertainTasks.start({ userId: 'user-owner' }, {
      ...request,
      operationId: 'start-262-local-new-operation'
    })).toEqual(expect.objectContaining({ reconcile: 'required', state: 'uncertain' }));
    expect(starts).toBe(3);
  });

  test('does not relabel a reserved start when the physical connector changes', async () => {
    const store = memoryStore();
    await service({
      start: async () => ({ state: 'uncertain' }),
      store
    }).start({ userId: 'user-owner' }, request);
    let issueCalls = 0;
    let starts = 0;
    const replacement = {
      ...connector(),
      id: 'connector-replacement',
      name: 'Replacement connector'
    };

    const result = await service({
      generationFor: () => 8,
      inventory: async () => ({
        connectors: [replacement],
        physicalMachines: [{
          connectorIds: [replacement.id],
          id: 'physical-local',
          name: 'Mac'
        }]
      }),
      issue: async () => {
        issueCalls += 1;
        throw new Error('the retry must not prepare a different target');
      },
      start: async () => {
        starts += 1;
        return { state: 'confirmed', threadId, worktreeId: 'wrong-target' };
      },
      store
    }).start({ userId: 'user-owner' }, request);

    expect(result).toEqual(expect.objectContaining({
      operationId: request.operationId,
      reconcile: 'required',
      state: 'uncertain'
    }));
    expect(result.state === 'uncertain' && result.target).toBeUndefined();
    expect(issueCalls).toBe(0);
    expect(starts).toBe(0);
  });

  test('allows a safe retry after a known not-dispatched start failure', async () => {
    const store = memoryStore();
    let attempts = 0;
    const tasks = service({
      start: async () => {
        attempts += 1;
        return attempts === 1
          ? { state: 'offline' }
          : { state: 'confirmed', threadId, worktreeId: 'wt_retry' };
      },
      store
    });

    expect(await tasks.start({ userId: 'user-owner' }, request)).toEqual(
      expect.objectContaining({ reason: 'offline', state: 'blocked' })
    );
    expect(await tasks.start({ userId: 'user-owner' }, request)).toEqual(
      expect.objectContaining({ state: 'confirmed' })
    );
    expect(attempts).toBe(2);
  });

  test('keeps an uncertain start fenced when its reconciliation goes offline', async () => {
    const store = memoryStore();
    let attempts = 0;
    const tasks = service({
      start: async () => {
        attempts += 1;
        return attempts === 1 ? { state: 'uncertain' } : { state: 'offline' };
      },
      store
    });

    expect(await tasks.start({ userId: 'user-owner' }, request)).toEqual(
      expect.objectContaining({ state: 'uncertain' })
    );
    expect(await tasks.start({ userId: 'user-owner' }, request)).toEqual(
      expect.objectContaining({ state: 'uncertain' })
    );
    expect(store.operations.get(request.operationId)?.state).toBe('uncertain');
    expect(attempts).toBe(2);
  });

  test('releases only the exact uncertain start after explicit recovery confirmation', async () => {
    const store = memoryStore();
    let attempts = 0;
    const tasks = service({
      start: async () => {
        attempts += 1;
        return attempts === 1
          ? { state: 'uncertain' }
          : { state: 'confirmed', threadId, worktreeId: 'wt_recovered' };
      },
      store
    });

    expect(await tasks.start({ userId: 'user-owner' }, request)).toEqual(
      expect.objectContaining({ state: 'uncertain' })
    );
    await expect(tasks.recoverStart({ userId: 'user-owner' }, {
      ...request,
      issue: 263
    })).rejects.toBeInstanceOf(CodexMachineTasksConflictError);
    expect(await tasks.recoverStart({ userId: 'user-owner' }, request)).toEqual({
      apiVersion: 1,
      operationId: request.operationId,
      state: 'released'
    });
    expect(await tasks.start({ userId: 'user-owner' }, {
      ...request,
      operationId: 'start-after-confirmed-recovery'
    })).toEqual(expect.objectContaining({ state: 'confirmed' }));
    expect(attempts).toBe(2);
  });

  test('recovers an identical uncertain start after the client loses its operation id', async () => {
    const store = memoryStore();
    let attempts = 0;
    const tasks = service({
      start: async () => {
        attempts += 1;
        return attempts === 1
          ? { state: 'uncertain' }
          : { state: 'confirmed', threadId, worktreeId: 'wt_reconciled' };
      },
      store
    });

    expect(await tasks.start({ userId: 'user-owner' }, request)).toEqual(
      expect.objectContaining({ state: 'uncertain' })
    );
    expect(await tasks.start({ userId: 'user-owner' }, {
      ...request,
      operationId: 'different-start-operation'
    })).toEqual(expect.objectContaining({
      operationId: 'different-start-operation',
      state: 'confirmed'
    }));
    expect(await tasks.start({ userId: 'user-owner' }, request)).toEqual(
      expect.objectContaining({ state: 'confirmed' })
    );
    expect(attempts).toBe(2);
  });

  test('does not recover an uncertain start after its immutable revision changes', async () => {
    const store = memoryStore();
    await service({
      start: async () => ({ state: 'uncertain' }),
      store
    }).start({ userId: 'user-owner' }, request);
    let dispatched = false;
    const result = await service({
      issue: async () => ({
        branch: 'issue-262-build-codex-machine-task-core-and-cli',
        commit: 'b'.repeat(40),
        issue: { number: 262, url: 'https://github.com/DotNaos/project-space/issues/262' },
        repository: { id: 'R_test', nameWithOwner: 'DotNaos/project-space' }
      }),
      start: async () => {
        dispatched = true;
        return { state: 'confirmed', threadId, worktreeId: 'wrong-revision' };
      },
      store
    }).start({ userId: 'user-owner' }, {
      ...request,
      operationId: 'different-revision-operation'
    });

    expect(dispatched).toBeFalse();
    expect(result).toEqual(expect.objectContaining({ state: 'uncertain' }));
  });

  test('re-dispatches the original idempotent start after an orphaned pending reservation', async () => {
    const store = memoryStore();
    await expect(service({
      start: async () => { throw new Error('central process stopped'); },
      store
    }).start({ userId: 'user-owner' }, request)).rejects.toThrow();

    await expect(service({ store }).start({ userId: 'user-owner' }, request)).resolves.toEqual(
      expect.objectContaining({ state: 'confirmed' })
    );
  });

  test('keeps an unchanged uncertain start on its original generation after reconnect', async () => {
    const store = memoryStore();
    expect(await service({
      start: async () => ({ state: 'uncertain' }),
      store
    }).start({ userId: 'user-owner' }, request)).toEqual(
      expect.objectContaining({ state: 'uncertain' })
    );
    let retriedGeneration = 0;
    const retry = await service({
      generationFor: () => 8,
      start: async (input) => {
        retriedGeneration = input.generation;
        return { state: 'uncertain' };
      },
      store
    }).start({ userId: 'user-owner' }, request);
    expect(retriedGeneration).toBe(7);
    expect(retry).toEqual(expect.objectContaining({
      state: 'uncertain',
      target: expect.objectContaining({ connector: expect.objectContaining({ generation: 7 }) })
    }));
  });

  test('reports the replacement generation after durable start reconciliation', async () => {
    const store = memoryStore();
    expect(await service({
      start: async () => ({ state: 'uncertain' }),
      store
    }).start({ userId: 'user-owner' }, request)).toEqual(
      expect.objectContaining({ state: 'uncertain' })
    );
    const result = await service({
      generationFor: () => 8,
      start: async () => ({ state: 'confirmed', threadId, worktreeId: 'wt_restarted' }),
      startedGeneration: () => 8,
      store
    }).start({ userId: 'user-owner' }, request);
    expect(result).toEqual(expect.objectContaining({
      state: 'confirmed',
      task: expect.objectContaining({ connector: expect.objectContaining({ generation: 8 }) })
    }));
  });

  test('recovers another identical operation on the generation where the unresolved start ran', async () => {
    const store = memoryStore();
    await service({
      start: async () => ({ state: 'uncertain' }),
      store
    }).start({ userId: 'user-owner' }, request);
    let dispatched = false;
    const result = await service({
      generationFor: () => 8,
      start: async () => {
        dispatched = true;
        return { state: 'confirmed', threadId, worktreeId: 'unexpected' };
      },
      store
    }).start({ userId: 'user-owner' }, {
      ...request,
      operationId: 'different-start-operation'
    });

    expect(dispatched).toBeTrue();
    expect(result).toEqual(expect.objectContaining({
      operationId: 'different-start-operation',
      state: 'confirmed',
      task: expect.objectContaining({ connector: expect.objectContaining({ generation: 7 }) })
    }));
  });

  test('rejects reusing an operation ID for different input', async () => {
    const tasks = service();
    await tasks.start({ userId: 'user-owner' }, request);
    await expect(tasks.start({ userId: 'user-owner' }, {
      ...request,
      issue: 263
    })).rejects.toBeInstanceOf(CodexMachineTasksConflictError);
  });

  test('issues a short local Unix attachment lease only to the owning caller connector', async () => {
    const tasks = service();
    const confirmed = await tasks.attach({
      callerMachineId: 'connector-local',
      userId: 'user-owner'
    }, {
      operationId: 'attach-local',
      physicalMachineId: 'physical-local',
      threadId
    });
    expect(confirmed).toEqual(expect.objectContaining({
      state: 'confirmed',
      threadId,
      transport: 'local-unix'
    }));
    expect(confirmed.state === 'confirmed' && confirmed.socketPath).toBeUndefined();

    expect(await tasks.attach({
      callerMachineId: 'different-caller',
      userId: 'user-owner'
    }, {
      operationId: 'attach-remote',
      physicalMachineId: 'physical-local',
      threadId
    })).toEqual(expect.objectContaining({ reason: 'offline', state: 'blocked' }));
  });

  test('issues a header-only remote WebSocket lease for an exact target', async () => {
    const tasks = service({
      attachments: {
        issue: () => ({
          endpointPath: `/api/codex/tasks/${threadId}/attach/socket`,
          expiresAt: '2026-07-17T12:00:00.000Z',
          token: 'secret-attach-capability'
        })
      }
    });
    const result = await tasks.attach({
      callerMachineId: 'connector-caller',
      userId: 'user-owner'
    }, {
      operationId: 'attach-remote',
      physicalMachineId: 'physical-local',
      threadId
    });

    expect(result).toEqual(expect.objectContaining({
      endpointPath: `/api/codex/tasks/${threadId}/attach/socket`,
      state: 'confirmed',
      transport: 'websocket-tunnel'
    }));
    expect((result as typeof result & { [codexAttachToken]?: string })[codexAttachToken])
      .toBe('secret-attach-capability');
    expect(JSON.stringify(result)).not.toContain('secret-attach-capability');
  });

  test('returns active, approval, input, and uncertain send states structurally', async () => {
    const base = {
      message: 'Continue',
      operationId: 'send-one',
      physicalMachineId: 'physical-local',
      threadId,
      wait: true
    };
    expect(await service({
      send: async () => ({
        operationId: 'send-one', replayed: false, status: 'rejected', threadId
      })
    }).send({ userId: 'user-owner' }, base)).toEqual(expect.objectContaining({
      reason: 'thread_active', state: 'blocked'
    }));
    expect(await service({
      wait: async () => ({
        event: {
          eventId: 'approval', requestId: 'request-one', turnId: 'turn-one',
          type: 'approval-requested'
        }
      })
    }).send({ userId: 'user-owner' }, base)).toEqual(expect.objectContaining({
      reason: 'approval_required', state: 'blocked'
    }));
    expect(await service({
      wait: async () => ({
        event: {
          eventId: 'input', requestId: 'request-two', turnId: 'turn-one',
          type: 'user-input-requested'
        }
      })
    }).send({ userId: 'user-owner' }, base)).toEqual(expect.objectContaining({
      reason: 'input_required', state: 'blocked'
    }));
    expect(await service({
      send: async () => ({
        operationId: 'send-one', replayed: false, status: 'ambiguous', threadId
      })
    }).send({ userId: 'user-owner' }, base)).toEqual(expect.objectContaining({
      reconcile: 'required', state: 'uncertain'
    }));
  });

  test('requires an explicit choice while active and sends immediately while idle', async () => {
    let sends = 0;
    const active = service({
      inspect: async () => ({ activeTurnId: 'turn-active', status: 'active' }),
      send: async () => {
        sends += 1;
        return {
          operationId: 'send-active', replayed: false, status: 'accepted', threadId,
          turnId: 'turn-new'
        };
      }
    });
    expect(await active.send({ userId: 'user-owner' }, {
      message: 'Continue', operationId: 'send-active', physicalMachineId: 'physical-local', threadId
    })).toEqual(expect.objectContaining({ reason: 'thread_active', state: 'blocked' }));
    expect(sends).toBe(0);

    expect(await service().send({ userId: 'user-owner' }, {
      message: 'Continue', operationId: 'send-idle', physicalMachineId: 'physical-local', threadId
    })).toEqual(expect.objectContaining({ delivery: 'sent', state: 'sent', turnId: 'turn-one' }));
  });

  test('steers only the exact active turn verified by read', async () => {
    let dispatched: { delivery: 'new-turn' | 'steer'; expectedTurnId?: string } | undefined;
    const tasks = service({
      inspect: async () => ({ activeTurnId: 'turn-active', status: 'active' }),
      send: async (input) => {
        dispatched = input;
        return {
          operationId: input.operationId, replayed: false, status: 'accepted', threadId,
          turnId: 'turn-active'
        };
      }
    });
    expect(await tasks.send({ userId: 'user-owner' }, {
      expectedTurnId: 'turn-active', message: 'Adjust course', mode: 'steer',
      operationId: 'steer-active', physicalMachineId: 'physical-local', threadId
    })).toEqual(expect.objectContaining({
      delivery: 'steered', state: 'steered', turnId: 'turn-active'
    }));
    expect(dispatched).toEqual(expect.objectContaining({
      delivery: 'steer', expectedTurnId: 'turn-active'
    }));

    dispatched = undefined;
    expect(await tasks.send({ userId: 'user-owner' }, {
      expectedTurnId: 'turn-stale', message: 'Adjust course', mode: 'steer',
      operationId: 'steer-stale', physicalMachineId: 'physical-local', threadId
    })).toEqual(expect.objectContaining({ reason: 'turn_changed', state: 'blocked' }));
    expect(dispatched).toBeUndefined();
  });

  test('queues durably while active, dispatches after idle, and replays the outcome', async () => {
    const store = memoryStore();
    let active = true;
    let releaseIdle!: () => void;
    let reportWaiting!: () => void;
    const idle = new Promise<void>((resolve) => { releaseIdle = resolve; });
    const waiting = new Promise<void>((resolve) => { reportWaiting = resolve; });
    const tasks = service({
      inspect: async () => active
        ? { activeTurnId: 'turn-active', status: 'active' }
        : { status: 'idle' },
      send: async (input) => ({
        operationId: input.operationId, replayed: false, status: 'accepted', threadId,
        turnId: 'turn-queued'
      }),
      store,
      waitUntilIdle: async () => {
        reportWaiting();
        await idle;
      }
    });
    const request = {
      message: 'Do this next', mode: 'queue' as const, operationId: 'queue-next',
      physicalMachineId: 'physical-local', threadId
    };
    expect(await tasks.send({ userId: 'user-owner' }, request)).toEqual(expect.objectContaining({
      delivery: 'queued', state: 'queued'
    }));
    await waiting;
    expect(store.sends.get('queue-next')?.state).toBe('queued');

    active = false;
    releaseIdle();
    for (let attempt = 0; attempt < 20 && store.sends.get('queue-next')?.state !== 'completed'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(store.sends.get('queue-next')?.state).toBe('completed');
    expect(await tasks.send({ userId: 'user-owner' }, request)).toEqual(expect.objectContaining({
      delivery: 'sent', state: 'sent', turnId: 'turn-queued'
    }));
  });

  test('recovers a claimed queued message after service restart', async () => {
    const store = memoryStore();
    store.sends.set('queue-restart', {
      connectorId: 'connector-local',
      durableOperations: true,
      fingerprint: 'a'.repeat(64),
      generation: 7,
      operationId: 'queue-restart',
      request: {
        message: 'Resume this queued work.', mode: 'queue',
        target: { physicalMachineId: 'physical-local' }
      },
      state: 'pending',
      threadId,
      userId: 'user-owner'
    });
    let sends = 0;
    const tasks = service({
      send: async (input) => {
        sends += 1;
        return {
          operationId: input.operationId, replayed: true, status: 'accepted', threadId,
          turnId: 'turn-after-restart'
        };
      },
      store
    });

    await tasks.resumeQueued();
    for (let attempt = 0; attempt < 20 && store.sends.get('queue-restart')?.state !== 'completed'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(sends).toBe(1);
    expect(store.sends.get('queue-restart')).toMatchObject({
      result: { delivery: 'sent', state: 'sent', turnId: 'turn-after-restart' },
      state: 'completed'
    });
  });

  test('keeps a newer queue request behind an older queued request while idle', async () => {
    const store = memoryStore();
    store.sends.set('queue-older', {
      connectorId: 'connector-local', durableOperations: true, fingerprint: 'b'.repeat(64),
      generation: 7, operationId: 'queue-older',
      request: {
        message: 'Older work', mode: 'queue', target: { physicalMachineId: 'physical-local' }
      },
      state: 'queued', threadId, userId: 'user-owner'
    });
    const dispatched: string[] = [];
    const dispatchedMessages: string[] = [];
    const tasks = service({
      send: async (input) => {
        dispatched.push(input.operationId);
        dispatchedMessages.push(input.message);
        return {
          operationId: input.operationId, replayed: false, status: 'accepted', threadId,
          turnId: `turn-${input.operationId}`
        };
      },
      store
    });

    expect(await tasks.send({ userId: 'user-owner' }, {
      message: 'Newer work', mode: 'queue', operationId: 'queue-newer',
      physicalMachineId: 'physical-local', threadId
    })).toEqual(expect.objectContaining({ delivery: 'queued', state: 'queued' }));
    for (let attempt = 0; attempt < 20 && dispatched.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(dispatchedMessages[0]).toBe('Older work');
    expect(dispatched[0]).toStartWith('queue-dispatch:');
  });

  test('requeues when the connector disappears before queued dispatch', async () => {
    const store = memoryStore();
    let active = true;
    let attempts = 0;
    const dispatchIds: string[] = [];
    const ledger = new Map<string, {
      operationId: string;
      reason?: 'unavailable';
      replayed: boolean;
      status: 'accepted' | 'rejected';
      threadId: string;
      turnId?: string;
    }>();
    const tasks = service({
      inspect: async () => active
        ? { activeTurnId: 'turn-active', status: 'active' }
        : { status: 'idle' },
      send: async (input) => {
        attempts += 1;
        dispatchIds.push(input.operationId);
        const replayed = ledger.get(input.operationId);
        if (replayed) return { ...replayed, replayed: true };
        const result = ledger.size === 0
          ? {
              operationId: input.operationId, reason: 'unavailable' as const,
              replayed: false, status: 'rejected' as const, threadId
            }
          : {
              operationId: input.operationId, replayed: false, status: 'accepted' as const,
              threadId, turnId: 'turn-retried'
            };
        ledger.set(input.operationId, result);
        return result;
      },
      store,
      waitUntilIdle: async () => { active = false; }
    });

    expect(await tasks.send({ userId: 'user-owner' }, {
      message: 'Retry after reconnect', mode: 'queue', operationId: 'queue-reconnect',
      physicalMachineId: 'physical-local', threadId
    })).toEqual(expect.objectContaining({ state: 'queued' }));
    for (let attempt = 0; attempt < 30 && store.sends.get('queue-reconnect')?.state !== 'completed';
      attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(attempts).toBe(2);
    expect(new Set(dispatchIds).size).toBe(2);
    expect(store.sends.get('queue-reconnect')).toMatchObject({
      result: { state: 'sent', turnId: 'turn-retried' }, state: 'completed'
    });
  });

  test('queues when an idle task becomes active before immediate queue dispatch', async () => {
    const store = memoryStore();
    let attempts = 0;
    const tasks = service({
      send: async (input) => {
        attempts += 1;
        return attempts === 1
          ? {
              operationId: input.operationId, reason: 'thread_active' as const,
              replayed: false, status: 'rejected' as const, threadId
            }
          : {
              operationId: input.operationId, replayed: false, status: 'accepted' as const,
              threadId, turnId: 'turn-after-race'
            };
      },
      store
    });

    expect(await tasks.send({ userId: 'user-owner' }, {
      message: 'Keep this queued', mode: 'queue', operationId: 'queue-idle-race',
      physicalMachineId: 'physical-local', threadId
    })).toEqual(expect.objectContaining({ delivery: 'queued', state: 'queued' }));
    for (let attempt = 0; attempt < 30 && store.sends.get('queue-idle-race')?.state !== 'completed';
      attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(attempts).toBe(2);
    expect(store.sends.get('queue-idle-race')).toMatchObject({
      result: { state: 'sent', turnId: 'turn-after-race' }, state: 'completed'
    });
  });

  test('restores FIFO when restart finds a newer queue request pending before enqueue', async () => {
    const store = memoryStore();
    store.sends.set('queue-older-crash', {
      connectorId: 'connector-local', dispatchAttempt: 0, durableOperations: true,
      fingerprint: 'c'.repeat(64), generation: 7, operationId: 'queue-older-crash',
      request: {
        message: 'Older work', mode: 'queue', target: { physicalMachineId: 'physical-local' }
      },
      state: 'queued', threadId, userId: 'user-owner'
    });
    store.sends.set('queue-newer-crash', {
      connectorId: 'connector-local', dispatchAttempt: 0, durableOperations: true,
      fingerprint: 'd'.repeat(64), generation: 7, operationId: 'queue-newer-crash',
      request: {
        message: 'Newer work', mode: 'queue', target: { physicalMachineId: 'physical-local' }
      },
      state: 'pending', threadId, userId: 'user-owner'
    });
    const dispatched: string[] = [];
    const dispatchedMessages: string[] = [];
    const tasks = service({
      send: async (input) => {
        dispatched.push(input.operationId);
        dispatchedMessages.push(input.message);
        return {
          operationId: input.operationId, replayed: false, status: 'accepted', threadId,
          turnId: `turn-${dispatched.length}`
        };
      },
      store
    });

    await tasks.resumeQueued();
    for (let attempt = 0; attempt < 30 && dispatched.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(dispatchedMessages[0]).toBe('Older work');
    expect(dispatched[0]).toStartWith('queue-dispatch:');
    expect(store.sends.get('queue-older-crash')?.state).toBe('completed');
  });

  test('releases a new wait reservation when observation fails before dispatch', async () => {
    const store = memoryStore();
    const result = await service({
      read: async () => { throw new Error('stream unavailable'); },
      store
    }).send({ userId: 'user-owner' }, {
      message: 'Wait for completion', operationId: 'wait-before-dispatch',
      physicalMachineId: 'physical-local', threadId, wait: true
    });

    expect(result).toEqual(expect.objectContaining({ reason: 'offline', state: 'blocked' }));
    expect(store.sends.has('wait-before-dispatch')).toBeFalse();
  });

  test('reconciles a first ambiguous send through the same connector generation', async () => {
    let reconciliations = 0;
    const result = await service({
      reconcileSend: async (input) => {
        reconciliations += 1;
        expect(input.generation).toBe(7);
        return {
          operationId: 'send-reconcile',
          replayed: true,
          status: 'accepted',
          threadId,
          turnId: 'turn-reconciled'
        };
      },
      send: async () => ({
        operationId: 'send-reconcile',
        replayed: false,
        status: 'ambiguous',
        threadId
      })
    }).send({ userId: 'user-owner' }, {
      message: 'Continue once',
      operationId: 'send-reconcile',
      physicalMachineId: 'physical-local',
      threadId
    });

    expect(result).toEqual(expect.objectContaining({
      state: 'sent',
      turnId: 'turn-reconciled'
    }));
    expect(reconciliations).toBe(1);
  });

  test('retries same-operation reconciliation without letting old uncertainty fence fresh sends', async () => {
    const store = memoryStore();
    let sends = 0;
    let reconciliations = 0;
    const tasks = service({
      store,
      send: async (input) => {
        sends += 1;
        if (input.operationId === 'send-other') {
          return {
            operationId: input.operationId, replayed: false, status: 'accepted', threadId,
            turnId: 'turn-other'
          };
        }
        return {
          operationId: 'send-uncertain', replayed: false, status: 'ambiguous', threadId
        };
      },
      reconcileSend: async () => {
        reconciliations += 1;
        return reconciliations < 2
          ? { operationId: 'send-uncertain', replayed: true, status: 'ambiguous', threadId }
          : {
              operationId: 'send-uncertain', replayed: true, status: 'accepted', threadId,
              turnId: 'turn-reconciled'
            };
      }
    });
    const uncertainRequest = {
      message: 'Continue exactly once', operationId: 'send-uncertain',
      physicalMachineId: 'physical-local', threadId
    };
    expect(await tasks.send({ userId: 'user-owner' }, uncertainRequest)).toEqual(
      expect.objectContaining({ state: 'uncertain' })
    );
    expect(await tasks.send({ userId: 'user-owner' }, {
      ...uncertainRequest, message: 'A different turn', operationId: 'send-other'
    })).toEqual(expect.objectContaining({ state: 'sent', turnId: 'turn-other' }));
    expect(sends).toBe(2);

    expect(await tasks.send({ userId: 'user-owner' }, uncertainRequest)).toEqual(
      expect.objectContaining({ state: 'sent', turnId: 'turn-reconciled' })
    );
    expect(reconciliations).toBe(2);
    expect(sends).toBe(2);
  });

  test('reports the replacement generation after durable restart reconciliation', async () => {
    const store = memoryStore();
    let generation = 7;
    let reconciliations = 0;
    const tasks = service({
      generationFor: () => generation,
      store,
      send: async () => ({
        operationId: 'send-generation-restart', replayed: false, status: 'ambiguous', threadId
      }),
      reconciledGeneration: () => generation,
      reconcileSend: async () => {
        reconciliations += 1;
        return reconciliations === 1
          ? {
              operationId: 'send-generation-restart', replayed: true,
              status: 'ambiguous', threadId
            }
          : {
              operationId: 'send-generation-restart', replayed: true, status: 'accepted', threadId,
              turnId: 'turn-after-restart'
            };
      }
    });
    const request = {
      message: 'Continue exactly once', operationId: 'send-generation-restart',
      physicalMachineId: 'physical-local', threadId
    };
    expect(await tasks.send({ userId: 'user-owner' }, request))
      .toEqual(expect.objectContaining({ state: 'uncertain' }));
    generation = 9;
    expect(await tasks.send({ userId: 'user-owner' }, request)).toEqual(expect.objectContaining({
      state: 'sent',
      target: expect.objectContaining({ connector: expect.objectContaining({ generation: 9 }) }),
      turnId: 'turn-after-restart'
    }));
  });

  test('recovers an orphaned pending send only while its stored generation is current', async () => {
    const store = memoryStore();
    store.reserveSend = async () => ({
      dispatchAttempt: 2,
      durableOperations: true,
      generation: 6,
      kind: 'pending'
    });
    let dispatchedGeneration = 0;
    let dispatchedOperationId = '';
    const result = await service({
      generationFor: () => 6,
      store,
      send: async (input) => {
        dispatchedGeneration = input.generation;
        dispatchedOperationId = input.operationId;
        return {
          operationId: 'send-pending', replayed: true, status: 'accepted', threadId,
          turnId: 'turn-pending'
        };
      }
    }).send({ userId: 'user-owner' }, {
      message: 'Continue pending', mode: 'queue', operationId: 'send-pending',
      physicalMachineId: 'physical-local', threadId
    });

    expect(dispatchedGeneration).toBe(6);
    expect(dispatchedOperationId).toStartWith('queue-dispatch:');
    expect(result).toEqual(expect.objectContaining({
      state: 'sent',
      target: expect.objectContaining({ connector: expect.objectContaining({ generation: 6 }) })
    }));
  });

  test('reconciles a stale pending send without dispatching to its old generation', async () => {
    const store = memoryStore();
    store.reserveSend = async () => ({
      dispatchAttempt: 0,
      durableOperations: true,
      generation: 6,
      kind: 'pending'
    });
    let sends = 0;
    let reconciliations = 0;
    const result = await service({
      generationFor: () => 7,
      reconcileSend: async (input) => {
        reconciliations += 1;
        expect(input.generation).toBe(6);
        return {
          operationId: 'send-pending', replayed: true, status: 'ambiguous', threadId
        };
      },
      send: async () => {
        sends += 1;
        return {
          operationId: 'send-pending', replayed: false, status: 'accepted', threadId,
          turnId: 'duplicate-turn'
        };
      },
      store
    }).send({ userId: 'user-owner' }, {
      message: 'Continue pending', operationId: 'send-pending',
      physicalMachineId: 'physical-local', threadId
    });

    expect(result).toEqual(expect.objectContaining({ state: 'uncertain' }));
    expect(reconciliations).toBe(1);
    expect(sends).toBe(0);
  });

  test('returns target and issue failures as structured blocked states', async () => {
    const offline = service({
      inventory: async () => ({
        connectors: [{ ...connector(), connector: { ...connector().connector, status: 'offline' } }],
        physicalMachines: [{ connectorIds: ['connector-local'], id: 'physical-local', name: 'Mac' }]
      })
    });
    expect(await offline.read({ userId: 'user-owner' }, {
      physicalMachineId: 'physical-local',
      threadId
    })).toEqual(expect.objectContaining({ reason: 'offline', state: 'blocked' }));
    expect(await offline.send({ userId: 'user-owner' }, {
      message: 'Continue',
      operationId: 'send-offline',
      physicalMachineId: 'physical-local',
      threadId
    })).toEqual(expect.objectContaining({
      operationId: 'send-offline', reason: 'offline', state: 'blocked'
    }));

    const unauthorizedIssue = service({
      issue: async () => {
        throw new CodexMachineTaskIssueError('unauthorized', 'Select an authorized repository.');
      }
    });
    expect(await unauthorizedIssue.start({ userId: 'user-owner' }, request)).toEqual(
      expect.objectContaining({ reason: 'unauthorized', state: 'blocked' })
    );
  });
});
