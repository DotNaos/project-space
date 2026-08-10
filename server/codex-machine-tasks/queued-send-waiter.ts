import type { CodexSessionStreamEvent } from '../../src/shared/codex-sessions-api';
import type { CodexSessionsRuntime } from '../codex-sessions/runtime';

export async function waitUntilCodexTurnFinishes(
  sessions: CodexSessionsRuntime,
  input: {
    connectorId: string;
    generation: number;
    threadId: string;
    turnId: string;
    userId: string;
  }
) {
  const controller = new AbortController();
  let markLocalReady!: () => void;
  let markTransportReady!: () => void;
  let markCompleted!: () => void;
  const localReady = new Promise<void>((resolve) => { markLocalReady = resolve; });
  const transportReady = new Promise<void>((resolve) => { markTransportReady = resolve; });
  const completed = new Promise<void>((resolve) => { markCompleted = resolve; });
  const emit = (event: CodexSessionStreamEvent) => {
    if (event.type === 'turn-completed' && event.turnId === input.turnId) markCompleted();
  };
  const streaming = Promise.all([
    sessions.service.stream(
      { userId: input.userId },
      {
        connectorGeneration: input.generation,
        machineId: input.connectorId,
        threadId: input.threadId
      },
      emit,
      controller.signal,
      markLocalReady
    ),
    sessions.service.transportStream(
      { userId: input.userId },
      {
        connectorGeneration: input.generation,
        machineId: input.connectorId,
        onDispatched: markTransportReady,
        threadId: input.threadId
      },
      controller.signal
    )
  ]);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.all([localReady, transportReady]),
      streaming.then(() => { throw new Error('Codex turn stream ended before it opened.'); })
    ]);
    const current = await sessions.service.read(
      { userId: input.userId },
      {
        connectorGeneration: input.generation,
        machineId: input.connectorId,
        threadId: input.threadId
      }
    );
    const turn = current.turns.find((candidate) => candidate.id === input.turnId);
    if (!turn || turn.status !== 'in-progress') return;
    const expired = new Promise<'expired'>((resolve) => {
      timeout = setTimeout(() => resolve('expired'), 30 * 60_000);
      timeout.unref?.();
    });
    const settled = await Promise.race([
      completed.then(() => 'completed' as const),
      streaming.then(() => 'ended' as const, () => 'ended' as const),
      expired
    ]);
    if (settled !== 'completed') throw new Error('Codex turn stream ended before the turn completed.');
  } finally {
    if (timeout) clearTimeout(timeout);
    controller.abort();
    await streaming.catch(() => undefined);
  }
}
