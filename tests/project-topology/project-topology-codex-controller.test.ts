import { describe, expect, test } from 'bun:test';
import type {
  CodexSessionOperationResult,
  CodexSessionsClient
} from '@/shared/codex-sessions-api';
import {
  createTopologyCodexTaskController,
  TopologyCodexControllerError
} from '../../src/features/project-topology/project-topology-codex-controller';
import {
  conversation,
  session
} from './project-topology-test-fixtures';

const origin = { machineId: 'machine-a', threadId: 'thread-a' };

describe('project topology production Codex controller', () => {
  test('reads and writes only the selected existing task identity', async () => {
    const calls: unknown[] = [];
    const client = clientStub(calls);
    const controller = createTopologyCodexTaskController(
      client,
      (operation) => `topology:${operation}:operation-a`
    );

    await controller.select(origin);
    await controller.continue(origin, 'Keep going');
    await controller.interrupt(origin, 'turn-a');

    expect(calls).toEqual([
      { kind: 'read', request: origin },
      {
        kind: 'continue',
        request: { ...origin, message: 'Keep going', operationId: 'topology:continue:operation-a' }
      },
      {
        kind: 'interrupt',
        request: { ...origin, operationId: 'topology:interrupt:operation-a', turnId: 'turn-a' }
      }
    ]);
  });

  test('fails closed on mismatched reads and operation results', async () => {
    const client = clientStub([]);
    client.read = async () => conversation(session('machine-b', 'thread-b', '/projects/other'));
    const controller = createTopologyCodexTaskController(
      client,
      () => 'topology:operation:mismatch'
    );

    await expect(controller.select(origin)).rejects.toBeInstanceOf(TopologyCodexControllerError);
    client.read = async () => conversation(session('machine-a', 'thread-a', '/projects/a'));
    client.continue = async () => operationResult('different-operation');
    await expect(controller.continue(origin, 'Continue')).rejects.toMatchObject({
      code: 'identity-mismatch'
    });

    client.interrupt = async (request) => ({
      ...operationResult(request.operationId),
      turnId: 'turn-other'
    });
    await expect(controller.interrupt(origin, 'turn-selected')).rejects.toMatchObject({
      code: 'identity-mismatch'
    });
  });

  test('surfaces ambiguous and rejected writes instead of reporting success', async () => {
    for (const status of ['ambiguous', 'rejected'] as const) {
      const client = clientStub([]);
      client.continue = async (request) => ({
        ...operationResult(request.operationId),
        status
      });
      const controller = createTopologyCodexTaskController(
        client,
        () => `topology:operation:${status}`
      );

      await expect(controller.continue(origin, 'Continue')).rejects.toMatchObject({
        code: status === 'ambiguous' ? 'operation-uncertain' : 'operation-rejected'
      });
    }
  });

  test('rejects malformed operation IDs before calling the client', async () => {
    const calls: unknown[] = [];
    const controller = createTopologyCodexTaskController(clientStub(calls), () => 'bad id');

    await expect(controller.continue(origin, 'Continue')).rejects.toMatchObject({
      code: 'operation-id-invalid'
    });
    expect(calls).toEqual([]);
  });
});

function clientStub(calls: unknown[]): CodexSessionsClient {
  const candidate = session('machine-a', 'thread-a', '/projects/a');
  const unsupported = async () => {
    throw new Error('Unsupported in this test.');
  };
  return {
    approve: unsupported,
    async continue(request) {
      calls.push({ kind: 'continue', request });
      return operationResult(request.operationId);
    },
    async interrupt(request) {
      calls.push({ kind: 'interrupt', request });
      return { ...operationResult(request.operationId), turnId: request.turnId };
    },
    list: unsupported,
    async read(request) {
      calls.push({ kind: 'read', request });
      return conversation(candidate);
    },
    respondToUserInput: unsupported,
    subscribe() {
      return () => {};
    }
  };
}

function operationResult(operationId: string): CodexSessionOperationResult {
  return {
    operationId,
    replayed: false,
    status: 'completed',
    threadId: origin.threadId
  };
}
