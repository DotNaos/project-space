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

  test('revalidates runtime maintenance after reservation and before dispatch', async () => {
    const store = memoryStore();
    let inventoryCalls = 0;
    let starts = 0;
    const tasks = service({
      inventory: async () => {
        inventoryCalls += 1;
        return {
          connectors: [connector()],
          physicalMachines: [{
            connectorIds: ['connector-local'], id: 'physical-local', name: 'Mac'
          }],
          ...(inventoryCalls === 1 ? {} : {
            runtimeStatuses: new Map([['connector-local', {
              capabilities: ['codex.machine-tasks.v1', 'runtime.update'],
              machineId: 'connector-local',
              online: true,
              update: {
                operation: {
                  createdAt: '2026-08-10T00:00:00.000Z',
                  id: 'runtime-update-race',
                  machineId: 'connector-local',
                  operation: 'update',
                  requestedByUserId: 'system:connector-auto-update',
                  state: 'queued',
                  updatedAt: '2026-08-10T00:00:00.000Z'
                },
                state: 'update-pending'
              }
            }]])
          })
        };
      },
      start: async () => {
        starts += 1;
        return { state: 'confirmed', threadId, worktreeId: 'must-not-start' };
      },
      store
    });

    expect(await tasks.start({ userId: 'user-owner' }, request)).toMatchObject({
      reason: 'machine_not_ready', state: 'blocked'
    });
    expect(inventoryCalls).toBe(2);
    expect(starts).toBe(0);
    expect(store.operations.has(request.operationId)).toBe(false);
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
