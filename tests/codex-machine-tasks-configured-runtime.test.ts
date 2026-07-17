import { describe, expect, test } from 'bun:test';

import { waitForTerminal } from '../server/codex-machine-tasks/configured-runtime';
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
});
