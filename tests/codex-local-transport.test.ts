import { describe, expect, test } from 'bun:test';

import { createLocalCodexTransport } from '../server/codex-sessions/local-transport';
import type { CodexSessionManager } from '../server/codex-sessions/manager';
import type { CodexSessionsTransport } from '../server/codex-sessions/service';
import type { LocalCodexTranscriptSource } from '../server/codex-sessions/transcript-reader';
import type { CodexSessionStreamEvent } from '../src/shared/codex-sessions-api';

const machineId = 'machine-local';
const threadId = '019fa483-564c-7b01-9d89-5f8ef37af7d0';

describe('local Codex transport', () => {
  test('delivers live App Server deltas and suppresses the later transcript copy', async () => {
    const events: CodexSessionStreamEvent[] = [];
    const controller = new AbortController();
    const transport = createTransport({
      streamFallback: async (_request, emit, signal) => {
        emit({
          delta: 'Streaming',
          eventId: 'live-delta',
          itemId: 'agent-live',
          type: 'agent-message-delta'
        });
        await aborted(signal);
      },
      transcript: transcriptThatEmits({
        eventId: 'transcript-copy',
        item: {
          id: 'agent-transcript',
          kind: 'agent-message',
          status: 'in-progress',
          text: 'Streaming'
        },
        type: 'item'
      })
    });

    const running = transport.stream!(
      { machineId, threadId, userId: 'owner' },
      (event) => events.push(event),
      controller.signal
    );
    await Bun.sleep(0);
    controller.abort();
    await running;

    expect(events).toEqual([
      expect.objectContaining({ delta: 'Streaming', type: 'agent-message-delta' })
    ]);
  });

  test('keeps transcript events when no live App Server subscription is producing data', async () => {
    const events: CodexSessionStreamEvent[] = [];
    const controller = new AbortController();
    const transport = createTransport({
      streamFallback: async (_request, _emit, signal) => aborted(signal),
      transcript: transcriptThatEmits({
        eventId: 'transcript-only',
        item: {
          id: 'agent-transcript',
          kind: 'agent-message',
          status: 'in-progress',
          text: 'Fallback text'
        },
        type: 'item'
      })
    });

    const running = transport.stream!(
      { machineId, threadId, userId: 'owner' },
      (event) => events.push(event),
      controller.signal
    );
    await Bun.sleep(0);
    controller.abort();
    await running;

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      item: { text: 'Fallback text' },
      type: 'item'
    });
  });
});

function createTransport(input: {
  streamFallback: NonNullable<CodexSessionsTransport['stream']>;
  transcript: LocalCodexTranscriptSource;
}) {
  return createLocalCodexTransport({
    createInvalidResponseError: () => new Error('invalid'),
    expectedGeneration: () => 1,
    expectedMachineId: machineId,
    inspectFallback: async () => {
      throw new Error('unused');
    },
    machineName: 'Local machine',
    manager: {
      async subscribeThread() {
        return { thread: { id: threadId, status: { type: 'active' } } };
      }
    } as CodexSessionManager,
    mutate: async () => {
      throw new Error('unused');
    },
    now: () => Date.now(),
    readFallback: async () => {
      throw new Error('unused');
    },
    streamFallback: input.streamFallback,
    threadId,
    transcript: input.transcript
  });
}

function transcriptThatEmits(event: CodexSessionStreamEvent): LocalCodexTranscriptSource {
  return {
    async read() {
      return { active: true, turns: [] };
    },
    async watch(_threadId, emit, signal) {
      emit(event);
      await aborted(signal);
    }
  };
}

function aborted(signal: AbortSignal) {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}
