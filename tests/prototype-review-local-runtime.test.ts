import { describe, expect, test } from 'bun:test';

import type { CodexSessionManager } from '../server/codex-sessions/manager';
import type { LocalProjectSpaceBackend } from '../server/local-project-space-backend';
import { createPrototypeReviewLocalRuntime } from '../server/prototype-review-local-runtime';

const repositoryRoot = process.cwd();
const threadId = '019fa483-564c-7b01-9d89-5f8ef37af7d0';

class LocalInspectionManager {
  subscribe() {
    return () => true;
  }

  async readInspectionSnapshot(id: string) {
    return {
      loaded: { data: [id] },
      runtimeEpoch: 1,
      thread: {
        cwd: repositoryRoot,
        id,
        name: '#356 · Juno · Build prototype canvases',
        status: { type: 'notLoaded' as const },
        turns: [],
        updatedAt: 1_722_166_400
      }
    };
  }

  async readThread(id: string) {
    return {
      thread: {
        cwd: repositoryRoot,
        id,
        name: '#356 · Juno · Build prototype canvases',
        status: { type: 'notLoaded' as const },
        turns: [],
        updatedAt: 1_722_166_400
      }
    };
  }

  runtimeEpochIsCurrent(epoch: number) {
    return epoch === 1;
  }

  async close() {}
}

const backend = {
  async getConnectorProjectRegistry() {
    return {
      connector: {
        machineId: 'os-macbook',
        machineName: 'MacBook'
      }
    };
  }
} as unknown as LocalProjectSpaceBackend;

function createRuntime(options: {
  environment?: NodeJS.ProcessEnv;
  issue?: number;
  ownerThreadId?: string;
  readWorktreeClaim?: () => Promise<{
    issue?: number;
    ownerThreadId: string;
    path: string;
    status: string;
  } | undefined>;
  worktreeRoot?: string;
} = {}) {
  return createPrototypeReviewLocalRuntime({
    backend,
    environment: options.environment ?? { CODEX_THREAD_ID: threadId },
    manager: new LocalInspectionManager() as unknown as CodexSessionManager,
    readWorktreeClaim: options.readWorktreeClaim ?? (async () => ({
        issue: options.issue ?? 356,
        ownerThreadId: options.ownerThreadId ?? threadId,
        path: options.worktreeRoot ?? repositoryRoot,
        status: 'ready'
      })),
    repositoryRoot,
  });
}

describe('prototype review local runtime', () => {
  test('binds the checkout to the exact local machine and Codex task', async () => {
    const runtime = await createRuntime();
    try {
      const context = await runtime.readContext('DotNaos/project-space', 356);
      expect(context.checkout).toMatchObject({
        repositoryFullName: 'DotNaos/project-space',
        state: 'available'
      });
      expect(context.codex).toEqual({
        machineId: 'os-macbook',
        machineName: 'MacBook',
        state: 'available',
        threadId
      });
    } finally {
      await runtime.close();
    }
  });

  test('derives the exact Codex task from the ready Project worktree claim', async () => {
    const runtime = await createRuntime({ environment: {} });
    try {
      const context = await runtime.readContext('DotNaos/project-space', 356);
      expect(context.checkout.state).toBe('available');
      expect(context.codex).toEqual({
        machineId: 'os-macbook',
        machineName: 'MacBook',
        state: 'available',
        threadId
      });
    } finally {
      await runtime.close();
    }
  });

  test('rejects a Codex task owned by another worktree', async () => {
    const runtime = await createRuntime({ worktreeRoot: '/tmp' });
    try {
      const context = await runtime.readContext('DotNaos/project-space', 356);
      expect(context.checkout.state).toBe('available');
      expect(context.codex).toEqual({
        reason: 'task-mismatch',
        state: 'unavailable'
      });
    } finally {
      await runtime.close();
    }
  });

  test('rejects a different issue even when the task and repository exist', async () => {
    const runtime = await createRuntime({ issue: 298 });
    try {
      expect(await runtime.readContext('DotNaos/project-space', 356)).toMatchObject({
        checkout: { state: 'available' },
        codex: { reason: 'task-mismatch', state: 'unavailable' }
      });
    } finally {
      await runtime.close();
    }
  });

  test('rejects a repository identity mismatch before exposing the task', async () => {
    const runtime = await createRuntime();
    try {
      expect(await runtime.readContext('DotNaos/other')).toMatchObject({
        checkout: { reason: 'repository-mismatch', state: 'unavailable' },
        codex: { reason: 'repository-mismatch', state: 'unavailable' }
      });
    } finally {
      await runtime.close();
    }
  });

  test('keeps a freshly verified claim across a transient Project CLI failure', async () => {
    let reads = 0;
    const runtime = await createRuntime({
      readWorktreeClaim: async () => {
        reads += 1;
        return reads === 1
          ? {
              issue: 356,
              ownerThreadId: threadId,
              path: repositoryRoot,
              status: 'ready'
            }
          : undefined;
      }
    });
    try {
      expect((await runtime.readContext('DotNaos/project-space', 356)).codex.state)
        .toBe('available');
      expect((await runtime.readContext('DotNaos/project-space', 356)).codex.state)
        .toBe('available');
      expect(reads).toBe(3);
    } finally {
      await runtime.close();
    }
  });
});
