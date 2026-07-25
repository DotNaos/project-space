import { describe, expect, test } from 'bun:test';

import { startTurnWithReadReconciliation } from '../server/codex-sessions/reconciled-turn-start';
import { CodexOperationUncertainError } from '../server/codex-sessions/operation-ledger';

const input = {
  operationId: 'turn-operation',
  prompt: 'Inspect the repository read-only.',
  threadId: '019f6d33-6aad-7302-a45e-bb7a33fc399c'
};

describe('reconciled Codex turn start', () => {
  test('returns the directly confirmed turn', async () => {
    const manager = managerFixture({
      starts: [{ turn: { id: 'turn-confirmed' } }]
    });
    await expect(startTurnWithReadReconciliation(manager, input)).resolves.toEqual({
      turn: { id: 'turn-confirmed' }
    });
    expect(manager.calls).toEqual(['read', 'snapshot', 'start']);
  });

  test('retries the identical operation after read proves it was not applied', async () => {
    const manager = managerFixture({
      reads: [
        thread(['turn-old'], 'idle'),
        thread(['turn-old'], 'notLoaded')
      ],
      starts: [
        new CodexOperationUncertainError(),
        { turn: { id: 'turn-retried' } }
      ]
    });
    await expect(startTurnWithReadReconciliation(manager, input)).resolves.toEqual({
      turn: { id: 'turn-retried' }
    });
    expect(manager.calls).toEqual([
      'read', 'snapshot', 'start', 'read', 'not-applied', 'start'
    ]);
  });

  test('recovers the created turn without starting a duplicate', async () => {
    const manager = managerFixture({
      reads: [
        thread(['turn-old'], 'idle'),
        threadWithTurns([
          { id: 'turn-old' },
          turnRecordWithPrompt('turn-created', input.prompt)
        ], 'active')
      ],
      starts: [new CodexOperationUncertainError()]
    });
    await expect(startTurnWithReadReconciliation(manager, input)).resolves.toEqual({
      turn: { id: 'turn-created' }
    });
    expect(manager.calls).toEqual([
      'read', 'snapshot', 'start', 'read', 'completed:turn-created'
    ]);
  });

  test('reconciles a persisted uncertain turn by its exact stored prompt', async () => {
    const manager = managerFixture({
      snapshotState: 'uncertain',
      reads: [threadWithPrompt('turn-created', input.prompt, 'notLoaded')],
      starts: []
    });
    await expect(startTurnWithReadReconciliation(manager, input)).resolves.toEqual({
      turn: { id: 'turn-created' }
    });
    expect(manager.calls).toEqual(['read', 'snapshot', 'completed:turn-created']);
  });

  test('retries a persisted uncertain turn only after stored history proves absence', async () => {
    const manager = managerFixture({
      snapshotState: 'uncertain',
      reads: [thread(['turn-old'], 'notLoaded')],
      starts: [{ turn: { id: 'turn-retried' } }]
    });
    await expect(startTurnWithReadReconciliation(manager, input)).resolves.toEqual({
      turn: { id: 'turn-retried' }
    });
    expect(manager.calls).toEqual(['read', 'snapshot', 'not-applied', 'start']);
  });

  test('keeps the outcome uncertain when inspection cannot prove one result', async () => {
    const manager = managerFixture({
      reads: [
        thread(['turn-old'], 'idle'),
        thread(['turn-old'], 'active')
      ],
      starts: [new CodexOperationUncertainError()]
    });
    await expect(startTurnWithReadReconciliation(manager, input))
      .rejects.toBeInstanceOf(CodexOperationUncertainError);
    expect(manager.calls).toEqual(['read', 'snapshot', 'start', 'read']);
  });

  test('does not claim a concurrently added turn with different input', async () => {
    const manager = managerFixture({
      reads: [
        thread(['turn-old'], 'idle'),
        threadWithTurns([
          { id: 'turn-old' },
          turnRecordWithPrompt('turn-other', 'Different request')
        ], 'active')
      ],
      starts: [new CodexOperationUncertainError()]
    });
    await expect(startTurnWithReadReconciliation(manager, input))
      .rejects.toBeInstanceOf(CodexOperationUncertainError);
    expect(manager.calls).toEqual(['read', 'snapshot', 'start', 'read']);
  });
});

function thread(turnIds: string[], status: 'active' | 'idle' | 'notLoaded') {
  return {
    thread: {
      id: input.threadId,
      status: { type: status },
      turns: turnIds.map((id) => ({ id }))
    }
  };
}

function managerFixture(options: {
  reads?: Array<{
    thread: {
      id: string;
      status: { type: 'active' | 'idle' | 'notLoaded' };
      turns: Array<Record<string, unknown>>;
    };
  }>;
  snapshotState?: 'completed' | 'uncertain';
  starts: Array<Error | { turn: { id: string } }>;
}) {
  const calls: string[] = [];
  const reads = [...(options.reads ?? [thread([], 'idle')])];
  const starts = [...options.starts];
  return {
    calls,
    operationSnapshot() {
      calls.push('snapshot');
      return options.snapshotState
        ? [{
            fingerprint: 'fingerprint',
            operationId: input.operationId,
            state: options.snapshotState
          }]
        : [];
    },
    async readThread() {
      calls.push('read');
      return reads.shift() ?? thread([], 'idle');
    },
    async reconcileOperationCompleted(_operationId: string, result: { turn: { id: string } }) {
      calls.push(`completed:${result.turn.id}`);
    },
    async reconcileOperationNotApplied() {
      calls.push('not-applied');
    },
    async startTurn() {
      calls.push('start');
      const result = starts.shift();
      if (result instanceof Error) throw result;
      return result!;
    }
  };
}

function threadWithPrompt(
  turnId: string,
  prompt: string,
  status: 'active' | 'idle' | 'notLoaded'
) {
  return threadWithTurns([turnRecordWithPrompt(turnId, prompt)], status);
}

function turnRecordWithPrompt(turnId: string, prompt: string) {
  return {
    id: turnId,
    items: [{
      content: [{ text: prompt, type: 'text' }],
      id: 'user-message',
      type: 'userMessage'
    }]
  };
}

function threadWithTurns(
  turns: Array<Record<string, unknown>>,
  status: 'active' | 'idle' | 'notLoaded'
) {
  return {
    thread: {
      id: input.threadId,
      status: { type: status },
      turns
    }
  };
}
