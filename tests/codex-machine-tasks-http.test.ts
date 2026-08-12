import { createServer, type Server } from 'node:http';

import { afterEach, describe, expect, test } from 'bun:test';

import {
  createCodexMachineTasksHttpApi,
  type CodexMachineTasksHttpService
} from '../server/codex-machine-tasks/http';
import { codexAttachToken } from '../server/codex-machine-tasks/service';

const threadId = '019f6d33-6aad-7302-a45e-bb7a33fc399c';
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
  })));
});

function service() {
  const calls: Array<{ kind: string; request: unknown }> = [];
  const stub: CodexMachineTasksHttpService = {
    async attach(_actor, request) {
      calls.push({ kind: 'attach', request });
      return { apiVersion: 1, operationId: request.operationId, state: 'blocked' };
    },
    async existing(_actor, request) {
      calls.push({ kind: 'existing', request });
      return { apiVersion: 1, state: 'missing' };
    },
    async read(_actor, request) {
      calls.push({ kind: 'read', request });
      return { apiVersion: 1, state: 'confirmed' };
    },
    async recoverStart(_actor, request) {
      calls.push({ kind: 'recover-start', request });
      return { apiVersion: 1, operationId: request.operationId, state: 'released' };
    },
    async send(_actor, request) {
      calls.push({ kind: 'send', request });
      return { apiVersion: 1, operationId: request.operationId, state: 'accepted' };
    },
    async start(_actor, request) {
      calls.push({ kind: 'start', request });
      return { apiVersion: 1, operationId: request.operationId, state: 'ready' };
    },
    async stream() {}
  };
  return { calls, stub };
}

async function startApi(stub: CodexMachineTasksHttpService) {
  const api = createCodexMachineTasksHttpApi(stub, async () => ({
    callerMachineId: 'caller-local',
    userId: 'user-owner'
  }));
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (!await api(request, response, url)) response.writeHead(404).end();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing address.');
  return `http://127.0.0.1:${address.port}`;
}

function mutation(operationId: string, body: Record<string, unknown>) {
  return {
    body: JSON.stringify({ ...body, operationId }),
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': operationId },
    method: 'POST'
  };
}

describe('Codex machine-task HTTP boundary', () => {
  test('looks up the durable issue task association before a start', async () => {
    const { calls, stub } = service();
    const origin = await startApi(stub);
    const response = await fetch(
      `${origin}/api/codex/tasks/existing?connectorId=connector-wsl&issue=572&repositoryId=${encodeURIComponent('DotNaos/project-space')}`
    );

    expect(response.status).toBe(200);
    expect(calls).toEqual([{
      kind: 'existing',
      request: {
        connectorId: 'connector-wsl',
        issue: 572,
        repositoryId: 'DotNaos/project-space'
      }
    }]);
  });

  test('passes exact physical and connector selectors to start', async () => {
    const { calls, stub } = service();
    const origin = await startApi(stub);
    const response = await fetch(`${origin}/api/codex/tasks/start`, mutation('start-262', {
      connectorId: 'connector-wsl',
      expectedBranch: 'issue-262-machine-task-core',
      expectedCommit: 'a'.repeat(40),
      expectedPullRequestNumber: 381,
      issue: 262,
      physicalMachineId: 'physical-pc',
      repositoryId: 'R_repo'
    }));
    expect(response.status).toBe(200);
    expect(calls).toEqual([{
      kind: 'start',
      request: {
        connectorId: 'connector-wsl',
        dryRun: false,
        expectedBranch: 'issue-262-machine-task-core',
        expectedCommit: 'a'.repeat(40),
        expectedPullRequestNumber: 381,
        issue: 262,
        operationId: 'start-262',
        physicalMachineId: 'physical-pc',
        physicalMachineName: undefined,
        repositoryId: 'R_repo'
      }
    }]);
  });

  test('accepts a human-readable physical machine name', async () => {
    const { calls, stub } = service();
    const origin = await startApi(stub);
    const response = await fetch(`${origin}/api/codex/tasks/start`, mutation('start-by-name', {
      issue: 262,
      physicalMachineName: 'Remote PC',
      repositoryId: 'R_repo'
    }));

    expect(response.status).toBe(200);
    expect(calls).toEqual([{
      kind: 'start',
      request: {
        connectorId: undefined,
        dryRun: false,
        expectedBranch: undefined,
        expectedCommit: undefined,
        expectedPullRequestNumber: undefined,
        issue: 262,
        operationId: 'start-by-name',
        physicalMachineId: undefined,
        physicalMachineName: 'Remote PC',
        repositoryId: 'R_repo'
      }
    }]);
  });

  test('passes the exact original start request to explicit recovery', async () => {
    const { calls, stub } = service();
    const origin = await startApi(stub);
    const response = await fetch(`${origin}/api/codex/tasks/start/recover`, mutation('recover-262', {
      connectorId: 'connector-wsl',
      expectedBranch: 'issue-262-machine-task-core',
      expectedCommit: 'a'.repeat(40),
      issue: 262,
      physicalMachineId: 'physical-pc',
      repositoryId: 'R_repo'
    }));

    expect(response.status).toBe(200);
    expect(calls).toEqual([{
      kind: 'recover-start',
      request: {
        connectorId: 'connector-wsl',
        dryRun: false,
        expectedBranch: 'issue-262-machine-task-core',
        expectedCommit: 'a'.repeat(40),
        expectedPullRequestNumber: undefined,
        issue: 262,
        operationId: 'recover-262',
        physicalMachineId: 'physical-pc',
        physicalMachineName: undefined,
        repositoryId: 'R_repo'
      }
    }]);
  });

  test('reads mutation bodies once and preserves local attach identity', async () => {
    const { calls, stub } = service();
    const origin = await startApi(stub);
    const attach = await fetch(
      `${origin}/api/codex/tasks/${threadId}/attach`,
      mutation('attach-one', { connectorId: 'caller-local', physicalMachineId: 'physical-local' })
    );
    expect(attach.status).toBe(200);
    expect(calls).toEqual([{
      kind: 'attach',
      request: {
        connectorId: 'caller-local',
        operationId: 'attach-one',
        physicalMachineId: 'physical-local',
        physicalMachineName: undefined,
        threadId
      }
    }]);
  });

  test('returns a remote attach capability only in the response header', async () => {
    const { stub } = service();
    stub.attach = async (_actor, request) => ({
      apiVersion: 1,
      endpointPath: `/api/codex/tasks/${threadId}/attach/socket`,
      expiresAt: '2026-07-17T12:00:00.000Z',
      operationId: request.operationId,
      state: 'confirmed',
      threadId,
      transport: 'websocket-tunnel',
      [codexAttachToken]: 'header-only-secret'
    });
    const origin = await startApi(stub);
    const response = await fetch(
      `${origin}/api/codex/tasks/${threadId}/attach`,
      mutation('attach-remote', { physicalMachineId: 'physical-remote' })
    );

    expect(response.headers.get('x-project-codex-attach-token')).toBe('header-only-secret');
    expect(await response.text()).not.toContain('header-only-secret');
  });

  test('forwards explicit delivery and fences steer without an exact active turn', async () => {
    const { calls, stub } = service();
    const origin = await startApi(stub);
    const queued = await fetch(
      `${origin}/api/codex/tasks/${threadId}/send`,
      mutation('send-queued', { delivery: 'queue', message: 'Run later.' })
    );
    const invalidSteer = await fetch(
      `${origin}/api/codex/tasks/${threadId}/send`,
      mutation('send-steer', { delivery: 'steer', message: 'Adjust now.' })
    );
    expect(queued.status).toBe(200);
    expect(invalidSteer.status).toBe(400);
    expect(calls).toContainEqual({
      kind: 'send',
      request: expect.objectContaining({
        delivery: 'queue', expectedTurnId: undefined, operationId: 'send-queued'
      })
    });
    expect(calls.filter(({ kind }) => kind === 'send')).toHaveLength(1);
  });

  test('requires the idempotency header for mutations', async () => {
    const { calls, stub } = service();
    const origin = await startApi(stub);
    const response = await fetch(`${origin}/api/codex/tasks/start`, {
      body: JSON.stringify({ issue: 262, operationId: 'start-262' }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST'
    });
    expect(response.status).toBe(400);
    expect(calls).toEqual([]);
  });

  test('ends an opened progress stream without trying to replace it with JSON', async () => {
    const { stub } = service();
    stub.stream = async (_actor, _request, _emit, _signal, onReady) => {
      onReady?.();
      throw new Error('stream disconnected');
    };
    const origin = await startApi(stub);
    const response = await fetch(
      `${origin}/api/codex/tasks/${threadId}/stream?physicalMachineId=physical-local`
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(await response.text()).toBe(': ready\n\n');
  });

  test('streams the versioned progress envelope consumed by CLI and UI', async () => {
    const { stub } = service();
    stub.stream = async (_actor, _request, emit, _signal, onReady) => {
      onReady?.();
      emit({ eventId: 'event-one', type: 'turn-completed' }, 17);
    };
    const origin = await startApi(stub);
    const response = await fetch(
      `${origin}/api/codex/tasks/${threadId}/stream?physicalMachineId=physical-local`
    );
    const body = await response.text();

    expect(body).toStartWith(': ready\n\n');
    expect(body).toContain('id: 17');
    expect(body).toContain('"apiVersion":1');
    expect(body).toContain('"type":"progress"');
    expect(body).toContain('"event":{"eventId":"event-one","type":"turn-completed"}');
  });
});
