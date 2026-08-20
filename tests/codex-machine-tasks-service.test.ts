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
  taskSession,
  threadId
} from './fixtures/codex-machine-tasks-service';

describe('Codex machine-task service', () => {
  test('resolves a complete dry-run plan without reserving or starting a task', async () => {
    const store = memoryStore();
    let issueDryRun = false;
    let starts = 0;
    const result = await service({
      issue: async (input) => {
        issueDryRun = input.dryRun === true;
        return {
          branch: 'issue-262-build-codex-machine-task-core-and-cli',
          commit: 'a'.repeat(40),
          issue: { number: 262, url: 'https://github.com/DotNaos/project-space/issues/262' },
          repository: { id: 'R_test', nameWithOwner: 'DotNaos/project-space' }
        };
      },
      plan: async () => ({
        environment: { id: 'environment-local', name: 'Local Environment' },
        workspace: {
          branch: 'issue-262-build-codex-machine-task-core-and-cli',
          commit: 'a'.repeat(40),
          id: 'workspace-local'
        }
      }),
      start: async () => {
        starts += 1;
        return { state: 'confirmed', threadId, worktreeId: 'must-not-start' };
      },
      store
    }).start({ userId: 'user-owner' }, { ...request, dryRun: true });

    expect(result).toEqual(expect.objectContaining({ state: 'ready', target: expect.anything() }));
    expect(result.state === 'ready' && result.plan).toEqual(expect.objectContaining({
      base: { branch: 'issue-262-build-codex-machine-task-core-and-cli', commit: 'a'.repeat(40) },
      environment: { id: 'environment-local', name: 'Local Environment' },
      issue: expect.objectContaining({ number: 262 }),
      operation: { id: request.operationId, state: 'ready' },
      workspace: expect.objectContaining({ id: 'workspace-local' })
    }));
    expect(issueDryRun).toBeTrue();
    expect(starts).toBe(0);
    expect(store.operations.size).toBe(0);
  });

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

  test('auto-steers only the exact active turn and replays the same operation', async () => {
    const calls: Array<{ delivery: string; expectedTurnId?: string; operationId: string }> = [];
    let reads = 0;
    const tasks = service({
      read: async () => {
        reads += 1;
        if (reads > 1) throw new Error('session discovery unavailable');
        return {
          openedReadOnly: true,
          session: {
            ...taskSession('active'),
            activity: { currentTurnId: 'turn-active' }
          },
          turns: [{ id: 'turn-active', status: 'in-progress' }]
        };
      },
      send: async (input) => {
        calls.push(input);
        return {
          operationId: input.operationId,
          replayed: false,
          status: 'accepted',
          threadId,
          turnId: 'turn-active'
        };
      }
    });
    const message = {
      delivery: 'auto' as const,
      message: 'Adjust the current implementation.',
      operationId: 'send-auto-steer',
      physicalMachineId: 'physical-local',
      threadId
    };
    expect(await tasks.send({ userId: 'user-owner' }, message)).toMatchObject({
      state: 'accepted', turnId: 'turn-active'
    });
    expect(await tasks.send({ userId: 'user-owner' }, message)).toMatchObject({
      state: 'accepted', turnId: 'turn-active'
    });
    expect(calls).toEqual([expect.objectContaining({
      delivery: 'steer', expectedTurnId: 'turn-active'
    })]);
    expect(reads).toBe(1);
  });

  test('replays a completed send before consulting disconnected target inventory', async () => {
    let inventoryAvailable = true;
    const tasks = service({
      inventory: async () => {
        if (!inventoryAvailable) throw new Error('inventory disconnected');
        return {
          connectors: [connector()],
          physicalMachines: [{
            connectorIds: ['connector-local'], id: 'physical-local', name: 'Mac'
          }]
        };
      }
    });
    const request = {
      message: 'Replay this exact result offline.',
      operationId: 'send-offline-replay',
      physicalMachineId: 'physical-local',
      threadId
    };
    const first = await tasks.send({ userId: 'user-owner' }, request);
    inventoryAvailable = false;
    expect(await tasks.send({ userId: 'user-owner' }, request)).toEqual(first);
    await expect(tasks.send({ userId: 'user-owner' }, {
      ...request, message: 'Changed input must still conflict.'
    })).rejects.toBeInstanceOf(CodexMachineTasksConflictError);
  });

  test('reconciles an auto send with its persisted exact-turn decision', async () => {
    let reads = 0;
    const reconciliations: Array<{ delivery?: string; expectedTurnId?: string }> = [];
    const tasks = service({
      read: async () => {
        reads += 1;
        if (reads > 1) throw new Error('must not reinterpret the operation');
        return {
          openedReadOnly: true,
          session: {
            ...taskSession('active'),
            activity: { currentTurnId: 'turn-original' }
          },
          turns: [{ id: 'turn-original', status: 'in-progress' }]
        };
      },
      send: async (input) => {
        throw new Error(`lost response for ${input.operationId}`);
      },
      reconcileSend: async (input) => {
        reconciliations.push(input);
        return {
          operationId: 'send-auto-crash',
          replayed: true,
          status: 'accepted',
          threadId,
          turnId: 'turn-original'
        };
      }
    });
    const message = {
      delivery: 'auto' as const,
      message: 'Keep steering this exact turn.',
      operationId: 'send-auto-crash',
      physicalMachineId: 'physical-local',
      threadId
    };
    expect(await tasks.send({ userId: 'user-owner' }, message)).toMatchObject({
      state: 'uncertain'
    });
    expect(await tasks.send({ userId: 'user-owner' }, message)).toMatchObject({
      state: 'accepted', turnId: 'turn-original'
    });
    expect(reads).toBe(1);
    expect(reconciliations).toEqual([expect.objectContaining({
      delivery: 'steer', expectedTurnId: 'turn-original'
    })]);
  });

  test('persists, replays, and dispatches a queued message after the thread becomes idle', async () => {
    let status: 'active' | 'idle' = 'active';
    let generation = 7;
    let releaseRetry!: () => void;
    let resolveDispatched!: () => void;
    const dispatched = new Promise<void>((resolve) => { resolveDispatched = resolve; });
    const tasks = service({
      generationFor: () => generation,
      queueRetryDelay: () => new Promise<void>((resolve) => {
        releaseRetry = () => { generation = 8; status = 'idle'; resolve(); };
      }),
      read: async () => ({
        openedReadOnly: true,
        session: taskSession(status),
        turns: status === 'active' ? [{ id: 'turn-active', status: 'in-progress' }] : []
      }),
      send: async (input) => {
        expect(input).toMatchObject({ delivery: 'new-turn', generation: 8 });
        expect(input.operationId).toMatch(/^queue:dispatch:/);
        resolveDispatched();
        return {
          operationId: input.operationId,
          replayed: false,
          status: 'accepted',
          threadId,
          turnId: 'turn-queued'
        };
      }
    });
    const message = {
      delivery: 'queue' as const,
      message: 'Run this after the active turn.',
      operationId: 'send-queued-once',
      physicalMachineId: 'physical-local',
      threadId
    };
    const queued = await tasks.send({ userId: 'user-owner' }, message);
    expect(queued).toMatchObject({ state: 'queued' });
    expect(await tasks.send({ userId: 'user-owner' }, message)).toEqual(queued);
    while (!releaseRetry) await Promise.resolve();
    releaseRetry();
    await dispatched;
    await Promise.resolve();
    expect(await tasks.send({ userId: 'user-owner' }, message)).toMatchObject({
      state: 'accepted', target: { connector: { generation: 8 } }, turnId: 'turn-queued'
    });
  });

  test('keeps queue delivery durable when another turn wins the idle dispatch race', async () => {
    let reads = 0;
    let sends = 0;
    const tasks = service({
      queueRetryDelay: () => new Promise<void>(() => undefined),
      read: async () => ({
        openedReadOnly: true,
        session: taskSession(reads++ === 0 ? 'idle' : 'active'),
        turns: reads > 1 ? [{ id: 'turn-racing', status: 'in-progress' }] : []
      }),
      send: async (input) => {
        sends += 1;
        return {
          operationId: input.operationId,
          reason: 'thread_active' as const,
          replayed: false,
          status: 'rejected' as const,
          threadId
        };
      }
    });
    const request = {
      delivery: 'queue' as const,
      message: 'Keep this queued through the race.',
      operationId: 'send-queued-race',
      physicalMachineId: 'physical-local',
      threadId
    };
    expect(await tasks.send({ userId: 'user-owner' }, request)).toMatchObject({ state: 'queued' });
    expect(await tasks.send({ userId: 'user-owner' }, request)).toMatchObject({ state: 'queued' });
    expect(sends).toBe(1);
  });

  test('resumes a queue dispatch after losing its response', async () => {
    const store = memoryStore();
    const message = {
      delivery: 'queue' as const,
      message: 'Resume this queued operation once.',
      operationId: 'send-queued-recover',
      physicalMachineId: 'physical-local',
      threadId
    };
    const stalled = service({
      store,
      read: async () => ({
        openedReadOnly: true,
        session: taskSession('active'),
        turns: [{ id: 'turn-active', status: 'in-progress' }]
      }),
      queueRetryDelay: () => new Promise<void>(() => undefined)
    });
    expect(await stalled.send({ userId: 'user-owner' }, message)).toMatchObject({ state: 'queued' });
    const operation = store.sends.get(message.operationId)!;
    expect(await store.resumeQueuedSend(operation)).toBe(1);

    let firstAttempt!: () => void;
    let recovered!: () => void;
    const attempted = new Promise<void>((resolve) => { firstAttempt = resolve; });
    const recovery = new Promise<void>((resolve) => { recovered = resolve; });
    let reconciliations = 0;
    let dispatchOperationId: string | undefined;
    const resumed = service({
      store,
      reconcileSend: async (input) => {
        expect(input).toMatchObject({ delivery: 'new-turn', generation: 7 });
        reconciliations += 1;
        dispatchOperationId ??= input.operationId;
        expect(input.operationId).toBe(dispatchOperationId);
        if (reconciliations === 1) {
          firstAttempt();
          return {
            operationId: input.operationId,
            replayed: true,
            status: 'ambiguous',
            threadId
          };
        }
        recovered();
        return {
          operationId: input.operationId,
          replayed: true,
          status: 'accepted',
          threadId,
          turnId: 'turn-recovered'
        };
      }
    });
    await attempted;
    while (store.sends.get(message.operationId)?.state !== 'uncertain') await Promise.resolve();
    expect(await resumed.send({ userId: 'user-owner' }, message)).toMatchObject({ state: 'queued' });
    await recovery;
    for (let index = 0; index < 5; index += 1) await Promise.resolve();
    expect(await resumed.send({ userId: 'user-owner' }, message)).toMatchObject({
      state: 'accepted', turnId: 'turn-recovered'
    });
    expect(reconciliations).toBe(2);
  });

  test('reconciles the parent operation after crashing before a queue transition', async () => {
    const store = memoryStore();
    const message = {
      delivery: 'queue' as const,
      message: 'Recover the initial queue reservation.',
      operationId: 'send-queue-initial-crash',
      physicalMachineId: 'physical-local',
      threadId
    };
    const stalled = service({
      store,
      read: async () => ({
        openedReadOnly: true, session: taskSession('active'),
        turns: [{ id: 'turn-active', status: 'in-progress' }]
      }),
      queueRetryDelay: () => new Promise<void>(() => undefined)
    });
    expect(await stalled.send({ userId: 'user-owner' }, message)).toMatchObject({ state: 'queued' });
    const operation = store.sends.get(message.operationId)!;
    store.sends.set(message.operationId, { ...operation, dispatchAttempt: 0, state: 'pending' });

    let reconciled!: () => void;
    const recovery = new Promise<void>((resolve) => { reconciled = resolve; });
    const resumed = service({
      store,
      reconcileSend: async (input) => {
        expect(input.operationId).toBe(message.operationId);
        reconciled();
        return {
          operationId: input.operationId, replayed: true, status: 'accepted', threadId,
          turnId: 'turn-parent-recovered'
        };
      }
    });
    await recovery;
    for (let index = 0; index < 5; index += 1) await Promise.resolve();
    expect(await resumed.send({ userId: 'user-owner' }, message)).toMatchObject({
      state: 'accepted', turnId: 'turn-parent-recovered'
    });
  });

  test('never dispatches a queued message to a stale non-durable generation', async () => {
    let generation = 7;
    let releaseRetry!: () => void;
    let sends = 0;
    const tasks = service({
      durableGenerationFor: () => false,
      generationFor: () => generation,
      queueRetryDelay: () => new Promise<void>((resolve) => {
        releaseRetry = resolve;
      }),
      read: async () => ({
        openedReadOnly: true,
        session: taskSession('active'),
        turns: [{ id: 'turn-active', status: 'in-progress' }]
      }),
      send: async (input) => {
        sends += 1;
        return {
          operationId: input.operationId,
          replayed: false,
          status: 'accepted',
          threadId,
          turnId: 'must-not-run'
        };
      }
    });
    const message = {
      delivery: 'queue' as const,
      message: 'Do not cross generations.',
      operationId: 'send-queued-stale',
      physicalMachineId: 'physical-local',
      threadId
    };
    expect(await tasks.send({ userId: 'user-owner' }, message)).toMatchObject({ state: 'queued' });
    while (!releaseRetry) await Promise.resolve();
    generation = 8;
    releaseRetry();
    for (let index = 0; index < 10; index += 1) await Promise.resolve();
    expect(await tasks.send({ userId: 'user-owner' }, message)).toMatchObject({
      reason: 'stale_connector', state: 'blocked'
    });
    expect(sends).toBe(0);
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
      state: 'accepted',
      turnId: 'turn-reconciled'
    }));
    expect(reconciliations).toBe(1);
  });

  test('retries same-operation reconciliation and fences a different turn until resolved', async () => {
    const store = memoryStore();
    let sends = 0;
    let reconciliations = 0;
    const tasks = service({
      store,
      send: async () => {
        sends += 1;
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
    })).toEqual(expect.objectContaining({ reason: 'thread_active', state: 'blocked' }));
    expect(sends).toBe(1);

    expect(await tasks.send({ userId: 'user-owner' }, uncertainRequest)).toEqual(
      expect.objectContaining({ state: 'accepted', turnId: 'turn-reconciled' })
    );
    expect(reconciliations).toBe(2);
    expect(sends).toBe(1);
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
      state: 'accepted',
      target: expect.objectContaining({ connector: expect.objectContaining({ generation: 9 }) }),
      turnId: 'turn-after-restart'
    }));
  });

  test('recovers an orphaned pending send only while its stored generation is current', async () => {
    const store = memoryStore();
    store.reserveSend = async () => ({
      durableOperations: true,
      generation: 6,
      kind: 'pending'
    });
    let dispatchedGeneration = 0;
    const result = await service({
      generationFor: () => 6,
      store,
      send: async (input) => {
        dispatchedGeneration = input.generation;
        return {
          operationId: 'send-pending', replayed: true, status: 'accepted', threadId,
          turnId: 'turn-pending'
        };
      }
    }).send({ userId: 'user-owner' }, {
      message: 'Continue pending', operationId: 'send-pending',
      physicalMachineId: 'physical-local', threadId
    });

    expect(dispatchedGeneration).toBe(6);
    expect(result).toEqual(expect.objectContaining({
      state: 'accepted',
      target: expect.objectContaining({ connector: expect.objectContaining({ generation: 6 }) })
    }));
  });

  test('reconciles a stale pending send without dispatching to its old generation', async () => {
    const store = memoryStore();
    store.reserveSend = async () => ({
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
