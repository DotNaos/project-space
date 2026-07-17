import { describe, expect, test } from 'bun:test';

import {
  CodexMachineTasksConflictError,
  codexAttachToken,
  createCodexMachineTasksService,
  type CodexMachineTaskSendOperation,
  type CodexMachineTaskStartOperation,
  type CodexMachineTasksStore
} from '../server/codex-machine-tasks/service';
import { CODEX_MACHINE_TASKS_CONNECTOR_CAPABILITY } from '../src/shared/codex-machine-tasks-api';
import type { MachineRecord } from '../src/shared/project-space-api';
import { CodexMachineTaskIssueError } from '../server/codex-machine-tasks/issue-provider';

const threadId = '019f6d33-6aad-7302-a45e-bb7a33fc399c';

function connector(): MachineRecord {
  return {
    connector: {
      capabilities: [CODEX_MACHINE_TASKS_CONNECTOR_CAPABILITY],
      installCommand: '',
      status: 'online'
    },
    id: 'connector-local',
    kind: 'connector',
    name: 'Local macOS',
    network: {},
    roles: [],
    sourcePath: ''
  };
}

function memoryStore(): CodexMachineTasksStore & { operations: Map<string, CodexMachineTaskStartOperation> } {
  const operations = new Map<string, CodexMachineTaskStartOperation>();
  const sends = new Map<string, CodexMachineTaskSendOperation & {
    result?: Awaited<ReturnType<ReturnType<typeof service>['send']>>;
    state: 'completed' | 'pending' | 'uncertain';
  }>();
  return {
    operations,
    async lookupStart(input) {
      const current = operations.get(input.operationId);
      if (!current) return { kind: 'missing' };
      if (current.fingerprint !== input.fingerprint) return { kind: 'conflict' };
      if (current.state === 'completed' && current.result) {
        return { kind: 'replayed', result: current.result };
      }
      return {
        connectorId: current.connectorId,
        durableOperations: current.durableOperations,
        generation: current.generation,
        kind: 'reserved',
        physicalMachineId: current.physicalMachineId,
        state: current.state === 'uncertain' ? 'uncertain' : 'pending'
      };
    },
    async reserveSend(operation) {
      const current = sends.get(operation.operationId);
      if (current) {
        if (current.fingerprint !== operation.fingerprint ||
          current.connectorId !== operation.connectorId || current.threadId !== operation.threadId) {
          return { kind: 'conflict' };
        }
        if (current.state === 'completed' && current.result) {
          return { kind: 'replayed', result: current.result };
        }
        return current.state === 'uncertain'
          ? {
              durableOperations: current.durableOperations,
              generation: current.generation,
              kind: 'uncertain'
            }
          : {
              durableOperations: current.durableOperations,
              generation: current.generation,
              kind: 'pending'
            };
      }
      if ([...sends.values()].some((candidate) => candidate.connectorId === operation.connectorId &&
        candidate.threadId === operation.threadId && candidate.state !== 'completed')) {
        return { kind: 'fenced' };
      }
      sends.set(operation.operationId, { ...operation, state: 'pending' });
      return { kind: 'new' };
    },
    async completeSend(operation, result) {
      sends.set(operation.operationId, { ...operation, result, state: 'completed' });
    },
    async markSendUncertain(operation) {
      sends.set(operation.operationId, { ...operation, state: 'uncertain' });
    },
    async releaseSend(operation) {
      sends.delete(operation.operationId);
    },
    async reserveStart(operation) {
      const current = operations.get(operation.operationId);
      if (current) {
        return current.fingerprint === operation.fingerprint
          ? current.result
            ? { kind: 'replayed', result: current.result }
            : current.state === 'uncertain'
              ? {
                  durableOperations: current.durableOperations,
                  generation: current.generation,
                  kind: 'uncertain',
                  sameOperation: true
                }
              : {
                  durableOperations: current.durableOperations,
                  generation: current.generation,
                  kind: 'pending',
                  sameOperation: true
                }
          : { kind: 'conflict' };
      }
      const associated = [...operations.values()].find((candidate) => (
        candidate.associationKey === operation.associationKey
      ));
      if (associated?.result) return { kind: 'replayed', result: associated.result };
      if (associated?.state === 'uncertain') {
        return {
          durableOperations: associated.durableOperations,
          generation: associated.generation,
          kind: 'uncertain',
          sameOperation: false
        };
      }
      if (associated) {
        return {
          durableOperations: associated.durableOperations,
          generation: associated.generation,
          kind: 'pending',
          sameOperation: false
        };
      }
      operations.set(operation.operationId, operation);
      return { kind: 'new' };
    },
    async completeStart(operation, result) {
      operations.set(operation.operationId, { ...operation, result, state: 'completed' });
    },
    async markStartUncertain(operation) {
      operations.set(operation.operationId, { ...operation, state: 'uncertain' });
    },
    async releaseStart(operation) {
      operations.delete(operation.operationId);
    }
  };
}

function service(options: {
  durableGenerationFor?: (connectorId: string, generation: number) => boolean;
  generationFor?: () => number;
  inventory?: () => Promise<{
    connectors: MachineRecord[];
    physicalMachines: Array<{ connectorIds: string[]; id: string; name: string }>;
  }>;
  attachments?: {
    issue(): { endpointPath: string; expiresAt: string; token: string };
  };
  issue?: () => Promise<{
    branch: string;
    commit: string;
    issue: { number: number; url: string };
    repository: { id: string; nameWithOwner: string };
  }>;
  send?: (input: { generation: number }) => Promise<{
    operationId: string;
    replayed: boolean;
    status: 'accepted' | 'ambiguous' | 'completed' | 'rejected';
    threadId: string;
    turnId?: string;
  }>;
  reconcileSend?: (input: { generation: number }) => Promise<{
    operationId: string;
    replayed: boolean;
    status: 'accepted' | 'ambiguous' | 'completed' | 'rejected';
    threadId: string;
    turnId?: string;
  }>;
  reconciledGeneration?: (input: { generation: number }) => number;
  start?: (input: { generation: number }) => Promise<
    | { state: 'confirmed'; threadId: string; worktreeId: string }
    | { state: 'offline' }
    | { message: string; state: 'worktree_failure' }
    | { state: 'uncertain' }
  >;
  startedGeneration?: (input: { generation: number }) => number;
  store?: CodexMachineTasksStore;
  wait?: () => Promise<{ event: {
    eventId: string;
    requestId?: string;
    turnId?: string;
    type: 'approval-requested' | 'turn-completed' | 'user-input-requested';
  } }>;
} = {}) {
  return createCodexMachineTasksService({
    ...(options.attachments ? { attachments: options.attachments } : {}),
    inventory: options.inventory ?? (async () => ({
      connectors: [connector()],
      physicalMachines: [{ connectorIds: ['connector-local'], id: 'physical-local', name: 'Mac' }]
    })),
    issue: options.issue ?? (async () => ({
      branch: 'issue-262-build-codex-machine-task-core-and-cli',
      commit: 'a'.repeat(40),
      issue: { number: 262, url: 'https://github.com/DotNaos/project-space/issues/262' },
      repository: { id: 'R_test', nameWithOwner: 'DotNaos/project-space' }
    })),
    generationFor: options.generationFor ?? (() => 7),
    durableGenerationFor: options.durableGenerationFor ?? (() => true),
    sessions: {
      async read() {
        return {
          openedReadOnly: true as const,
          session: {
            archived: false,
            id: threadId,
            lastActivityAt: '2026-07-17T00:00:00.000Z',
            loadedByProjectSpace: false,
            machineId: 'connector-local',
            machineName: 'Local macOS',
            status: 'idle' as const,
            title: '#262'
          },
          turns: []
        };
      },
      send: options.send ?? (async () => ({
        operationId: 'send-one',
        replayed: false,
        status: 'accepted',
        threadId,
        turnId: 'turn-one'
      })),
      ...(options.reconcileSend ? {
        async reconcileSend(input: { generation: number }) {
          return {
            generation: options.reconciledGeneration?.(input) ?? input.generation,
            result: await options.reconcileSend!(input)
          };
        }
      } : {}),
      wait: async (input) => ({
        result: await input.start(),
        ...(options.wait
          ? await options.wait()
          : { event: { eventId: 'done-one', turnId: 'turn-one', type: 'turn-completed' as const } })
      })
    },
    async start(input) {
      return {
        generation: options.startedGeneration?.(input) ?? input.generation,
        result: await (options.start?.(input) ?? Promise.resolve({
          state: 'confirmed' as const, threadId, worktreeId: 'wt_confirmed'
        }))
      };
    },
    store: options.store ?? memoryStore(),
    taskUrl: (machineId, id) => `https://projects.example/codex/machines/${machineId}/threads/${id}`
  });
}

const request = {
  issue: 262,
  operationId: 'start-262-local',
  physicalMachineId: 'physical-local'
};

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
    expect(starts).toBe(2);
  });

  test('keeps a reserved start uncertain when GitHub becomes unavailable', async () => {
    const store = memoryStore();
    await service({
      start: async () => ({ state: 'uncertain' }),
      store
    }).start({ userId: 'user-owner' }, request);

    const result = await service({
      issue: async () => {
        throw new CodexMachineTaskIssueError('offline', 'GitHub is unavailable.');
      },
      store
    }).start({ userId: 'user-owner' }, request);

    expect(result).toEqual(expect.objectContaining({
      operationId: request.operationId,
      reconcile: 'required',
      state: 'uncertain',
      target: expect.objectContaining({ connector: expect.objectContaining({ generation: 7 }) })
    }));
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

  test('reconciles an uncertain start only with the original operation id', async () => {
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
    })).toEqual(expect.objectContaining({ state: 'uncertain' }));
    expect(attempts).toBe(1);
    expect(await tasks.start({ userId: 'user-owner' }, request)).toEqual(
      expect.objectContaining({ state: 'confirmed' })
    );
    expect(attempts).toBe(2);
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

  test('reports another operation against the generation where the unresolved start ran', async () => {
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

    expect(dispatched).toBeFalse();
    expect(result).toEqual(expect.objectContaining({
      operationId: 'different-start-operation',
      state: 'uncertain',
      target: expect.objectContaining({ connector: expect.objectContaining({ generation: 7 }) })
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

  test('recovers an orphaned pending send only on its stored connector generation', async () => {
    const store = memoryStore();
    store.reserveSend = async () => ({
      durableOperations: true,
      generation: 6,
      kind: 'pending'
    });
    let dispatchedGeneration = 0;
    const result = await service({
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
