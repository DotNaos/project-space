import { generateKeyPairSync } from 'node:crypto';

import { describe, expect, test } from 'bun:test';

import { createCodexSessionsWireRequest } from '../server/codex-sessions-connector-contract';
import {
  CodexSessionsConnectorExecutor,
  CodexSessionsExecutorError
} from '../server/codex-sessions/connector-executor';
import type { CodexSessionEventListener } from '../server/codex-sessions/contracts';
import type { CodexSessionManager } from '../server/codex-sessions';

const keys = generateKeyPairSync('ed25519');
const machineId = 'machine-one';
const now = 1_720_000_000_000;
const threadId = '019f5a78-3c4c-7082-bb45-5411be7d9b9a';

class InspectionSessionManager {
  private readonly listeners = new Set<CodexSessionEventListener>();
  runtimeAvailable = true;
  runtimeEpoch = 3;
  status: 'active' | 'notLoaded' = 'notLoaded';
  turnStatuses: Array<'completed' | 'inProgress'> = ['completed'];

  subscribe(listener: CodexSessionEventListener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  runtimeEpochIsCurrent(runtimeEpoch: number) {
    return this.runtimeAvailable && runtimeEpoch === this.runtimeEpoch;
  }

  async readInspectionSnapshot(id: string) {
    return {
      loaded: { data: [id] },
      runtimeEpoch: this.runtimeEpoch,
      thread: {
        cwd: '/Users/oli/projects/project-space',
        id,
        name: 'Stored history',
        status: { type: this.status },
        turns: this.turnStatuses.map((status, index) => ({
          id: `turn-${index + 1}`,
          items: [],
          status
        })),
        updatedAt: 1_719_999_999
      }
    };
  }
}

function createExecutor(
  manager = new InspectionSessionManager(),
  generation: number | (() => number) = 4,
  resolveTaskLocation?: (cwd: string) => Promise<{ canonicalCwd: string; worktreeRoot: string }>
) {
  return new CodexSessionsConnectorExecutor({
    expectedGeneration: generation,
    expectedMachineId: machineId,
    machineName: 'os-macbook',
    manager: manager as unknown as CodexSessionManager,
    now: () => now,
    ...(resolveTaskLocation ? { resolveTaskLocation } : {}),
    verificationKey: keys.publicKey
  });
}

function signed(operationId: string) {
  return createCodexSessionsWireRequest({
    generation: 4,
    operation: 'inspect',
    operationId,
    payload: { machineId, threadId },
    userId: 'user-owner'
  }, keys.privateKey, {
    nonce: `nonce-${operationId}`,
    now
  });
}

describe('Codex connector inspection evidence', () => {
  test('uses only connector-resolved task locations with an opaque runtime revision', async () => {
    const executor = createExecutor(
      new InspectionSessionManager(),
      4,
      async (cwd) => ({
        canonicalCwd: `${cwd}-canonical`,
        worktreeRoot: `${cwd}-canonical`
      })
    );
    const result = await executor.execute('inspect', signed('operation-inspect-location'));
    if (result.operation !== 'inspect') throw new Error('unexpected result');

    expect(result.result.taskLocation).toEqual({
      canonicalCwd: '/Users/oli/projects/project-space-canonical',
      checkedAt: new Date(now).toISOString(),
      machineId,
      sessionRevision: result.result.sessionRevision,
      source: 'connector-realpath',
      threadId,
      worktreeRoot: '/Users/oli/projects/project-space-canonical'
    });
    expect(result.result.sessionRevision).toMatch(/^[0-9a-f]{64}$/);
    executor.close();
  });

  test('rejects inconsistent active-turn evidence', async () => {
    for (const setup of [
      { status: 'notLoaded' as const, turns: ['inProgress'] as const },
      { status: 'active' as const, turns: ['inProgress', 'inProgress'] as const }
    ]) {
      const manager = new InspectionSessionManager();
      manager.status = setup.status;
      manager.turnStatuses = [...setup.turns];
      const executor = createExecutor(manager, 4, async (cwd) => ({
        canonicalCwd: cwd,
        worktreeRoot: cwd
      }));

      await expect(executor.execute(
        'inspect',
        signed(`operation-inspect-${setup.status}`)
      )).rejects.toBeInstanceOf(CodexSessionsExecutorError);
      executor.close();
    }
  });

  test('rejects connector generation or App Server epoch changes during proof', async () => {
    for (const boundary of ['connector', 'runtime'] as const) {
      const manager = new InspectionSessionManager();
      let generation = 4;
      const executor = createExecutor(manager, () => generation, async (cwd) => {
        if (boundary === 'connector') generation += 1;
        else manager.runtimeAvailable = false;
        return { canonicalCwd: cwd, worktreeRoot: cwd };
      });

      await expect(executor.execute(
        'inspect',
        signed(`operation-inspect-${boundary}`)
      )).rejects.toBeInstanceOf(CodexSessionsExecutorError);
      executor.close();
    }
  });
});
