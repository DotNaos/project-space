import { describe, expect, test } from 'bun:test';

import { resolveCodexBinary } from '../server/codex-sessions/binary-resolver';
import { CodexSessionManager } from '../server/codex-sessions';
import type { CodexSessionEvent } from '../server/codex-sessions/contracts';
import { presentCodexTurns } from '../server/codex-sessions/public-presenter';

const enabled = process.env.PROJECT_CODEX_REAL_PERSISTENCE === '1';
const realDescribe = enabled ? describe : describe.skip;

realDescribe('real persistent Codex App Server continuity', () => {
  test('a new client reads and continues the same thread after a complete restart', async () => {
    const binary = resolveCodexBinary();
    if (!binary.path) throw new Error(`No working Codex CLI: ${binary.attempted.join(', ')}`);
    const first = new CodexSessionManager({ binaryPath: binary.path });
    let threadId = '';
    try {
      const started = await first.startThread({
        cwd: process.cwd(),
        operationId: `real-thread-${crypto.randomUUID()}`
      });
      threadId = started.thread.id;
      const completion = nextCompletedTurn(first, threadId);
      const turn = await first.startTurn({
        operationId: `real-turn-${crypto.randomUUID()}`,
        prompt: 'Remember the codeword GALVEN. Reply with exactly STORED.',
        threadId
      });
      expect((await completion).turnId).toBe(turn.turn.id);
    } finally {
      await first.close();
    }

    const second = new CodexSessionManager({ binaryPath: binary.path });
    try {
      const before = presentCodexTurns((await second.readThread(threadId)).thread);
      expect(before.some((turn) => turn.items.some((item) => item.text?.includes('STORED')))).toBe(true);
      await second.resumeThread({
        operationId: `real-resume-${crypto.randomUUID()}`,
        threadId
      });
      const completion = nextCompletedTurn(second, threadId);
      const turn = await second.startTurn({
        operationId: `real-turn-${crypto.randomUUID()}`,
        prompt: 'What codeword did I ask you to remember? Reply with only the codeword.',
        threadId
      });
      expect((await completion).turnId).toBe(turn.turn.id);
      const after = presentCodexTurns((await second.readThread(threadId)).thread);
      expect(after.at(-1)?.items.some((item) => item.text?.trim() === 'GALVEN')).toBe(true);
    } finally {
      await second.close();
    }
  }, 5 * 60_000);
});

function nextCompletedTurn(manager: CodexSessionManager, threadId: string) {
  return new Promise<{ turnId: string }>((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error('Timed out waiting for the real Codex turn to complete.'));
    }, 4 * 60_000);
    const unsubscribe = manager.subscribe((event: CodexSessionEvent) => {
      if (event.method !== 'turn/completed' || !event.params || typeof event.params !== 'object') return;
      const params = event.params as { threadId?: unknown; turn?: { id?: unknown } };
      if (params.threadId !== threadId || typeof params.turn?.id !== 'string') return;
      clearTimeout(timeout);
      unsubscribe();
      resolve({ turnId: params.turn.id });
    });
  });
}
