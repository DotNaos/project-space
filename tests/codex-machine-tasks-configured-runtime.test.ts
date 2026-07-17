import { describe, expect, test } from 'bun:test';
import { WebSocket } from 'ws';

import {
  connectorReconciliationGeneration,
  waitForTerminal
} from '../server/codex-machine-tasks/configured-runtime';
import {
  registerConnectorSession,
  removeConnectorSession
} from '../server/connector-command-session-registry';
import { CODEX_MACHINE_TASKS_DURABLE_OPERATIONS_CAPABILITY } from '../server/codex-sessions-connector-contract';
import type { CodexSessionsRuntime } from '../server/codex-sessions/runtime';

const threadId = '019f6d33-6aad-7302-a45e-bb7a33fc399c';

function untilAborted(signal: AbortSignal, onAbort: () => void) {
  return new Promise<void>((resolve) => {
    const finish = () => {
      onAbort();
      resolve();
    };
    if (signal.aborted) finish();
    else signal.addEventListener('abort', finish, { once: true });
  });
}

describe('configured Codex machine-task runtime', () => {
  test('crosses a connector generation only when both generations prove durable operations', () => {
    const connectorId = 'connector-restarted';
    const socket = { readyState: WebSocket.OPEN } as WebSocket;
    const durableGeneration = registerConnectorSession(
      connectorId,
      socket,
      'test-token',
      [CODEX_MACHINE_TASKS_DURABLE_OPERATIONS_CAPABILITY]
    );
    expect(connectorReconciliationGeneration(connectorId, durableGeneration + 1, true))
      .toBe(durableGeneration);
    expect(connectorReconciliationGeneration(connectorId, durableGeneration + 1, false))
      .toBeUndefined();
    removeConnectorSession(connectorId, socket);

    const legacyGeneration = registerConnectorSession(connectorId, socket, 'test-token', []);
    expect(connectorReconciliationGeneration(connectorId, legacyGeneration, false))
      .toBe(legacyGeneration);
    expect(connectorReconciliationGeneration(connectorId, legacyGeneration + 1, true))
      .toBeUndefined();
    removeConnectorSession(connectorId, socket);
  });

  test('reconciles a turn that completed between stream readiness and the accepted result', async () => {
    const generations: number[] = [];
    let localAborted = false;
    let transportAborted = false;
    const sessions = {
      service: {
        async read(_actor, request) {
          generations.push(request.connectorGeneration ?? -1);
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
            turns: [{ id: 'turn-one', items: [], status: 'completed' as const }]
          };
        },
        async stream(_actor, request, _emit, signal, onReady) {
          generations.push(request.connectorGeneration ?? -1);
          onReady?.();
          await untilAborted(signal, () => { localAborted = true; });
        },
        async transportStream(_actor, request, signal) {
          generations.push(request.connectorGeneration ?? -1);
          request.onDispatched?.();
          await untilAborted(signal, () => { transportAborted = true; });
        }
      }
    } as unknown as CodexSessionsRuntime;

    const result = await waitForTerminal(sessions, {
      connectorId: 'connector-local',
      generation: 7,
      start: async () => ({
        operationId: 'send-operation',
        replayed: false,
        status: 'accepted',
        threadId,
        turnId: 'turn-one'
      }),
      threadId,
      userId: 'user-owner'
    });

    expect(result).toEqual(expect.objectContaining({
      event: {
        eventId: 'reconciled:turn-one',
        turnId: 'turn-one',
        type: 'turn-completed'
      },
      result: expect.objectContaining({ turnId: 'turn-one' })
    }));
    expect(generations).toEqual([7, 7, 7]);
    expect(localAborted).toBeTrue();
    expect(transportAborted).toBeTrue();
  });

  test('returns the latest pending interaction while opening a wait on a long thread', async () => {
    const sessions = {
      service: {
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
              status: 'active' as const,
              title: '#262'
            },
            turns: [{ id: 'turn-reconciled', items: [], status: 'in-progress' as const }]
          };
        },
        async stream(_actor, _request, emit, signal, onReady) {
          for (let index = 0; index < 499; index += 1) {
            emit({
              eventId: `old-${index}`,
              turnId: `old-turn-${index}`,
              type: 'turn-completed'
            }, index + 1);
          }
          emit({
            eventId: 'approval-stale',
            requestId: 'approval-request',
            turnId: 'turn-reconciled',
            type: 'approval-requested'
          }, 500);
          emit({
            eventId: 'input-latest',
            requestId: 'input-request',
            turnId: 'turn-reconciled',
            type: 'user-input-requested'
          }, 501);
          onReady?.();
          await untilAborted(signal, () => {});
        },
        async transportStream(_actor, request, signal) {
          request.onDispatched?.();
          await untilAborted(signal, () => {});
        }
      }
    } as unknown as CodexSessionsRuntime;

    const result = await Promise.race([
      waitForTerminal(sessions, {
        connectorId: 'connector-local',
        generation: 7,
        start: async () => ({
          operationId: 'send-operation',
          replayed: true,
          status: 'accepted',
          threadId,
          turnId: 'turn-reconciled'
        }),
        threadId,
        userId: 'user-owner'
      }),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('wait did not replay the latest interaction')), 500);
      })
    ]);

    expect(result).toEqual(expect.objectContaining({
      event: expect.objectContaining({
        eventId: 'input-latest',
        turnId: 'turn-reconciled',
        type: 'user-input-requested'
      }),
      sequence: 501
    }));
  });
});
