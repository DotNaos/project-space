import { createServer, type Server } from 'node:http';

import { afterEach, describe, expect, test } from 'bun:test';

import { CodexMachineTasksAuthError } from '../server/codex-machine-tasks/auth-context';
import type { SshGatewayExecutionResult } from '../server/ssh-control-gateway/contracts';
import { isConfiguredSshControlGatewayRoute } from '../server/ssh-control-gateway/configured-runtime';
import { createSshControlGatewayHttpApi } from '../server/ssh-control-gateway/http';

const servers: Server[] = [];
const environmentId = '11111111-1111-4111-8111-111111111111';

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
  })));
});

describe('SSH control gateway HTTP boundary', () => {
  test('the productive router admits both typed control endpoints and nothing adjacent', () => {
    expect(isConfiguredSshControlGatewayRoute('/api/compute/control/status')).toBe(true);
    expect(isConfiguredSshControlGatewayRoute('/api/compute/control/workspace-runtime')).toBe(true);
    expect(isConfiguredSshControlGatewayRoute('/api/compute/control/workspace-runtime/launch')).toBe(true);
    expect(isConfiguredSshControlGatewayRoute('/api/compute/control/worktree/prepare')).toBe(true);
    expect(isConfiguredSshControlGatewayRoute('/api/compute/control/shell')).toBe(false);
  });

  test('binds machine identity, idempotency, and the exact typed status request', async () => {
    const calls: unknown[] = [];
    const origin = await start(createSshControlGatewayHttpApi({
      async execute(actor, request) {
        calls.push({ actor, request });
        return success(request.operationId);
      }
    }, async () => ({ callerMachineId: 'machine-one', userId: 'owner-one' })));
    const response = await fetch(`${origin}/api/compute/control/status`, {
      body: JSON.stringify({ environmentId, operationId: 'operation-one' }),
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'operation-one' },
      method: 'POST'
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.json()).toEqual(success('operation-one'));
    expect(calls).toEqual([{
      actor: { id: 'machine-one', kind: 'machine', ownerUserId: 'owner-one' },
      request: { environmentId, operation: 'status.v1', operationId: 'operation-one' }
    }]);
  });

  test('accepts only a fully bound typed Workspace runtime request', async () => {
    const calls: unknown[] = [];
    const operationId = 'runtime-operation-one';
    const input = {
      environmentId,
      expectedCommit: '0123456789abcdef0123456789abcdef01234567',
      expectedManifestDigest: 'a'.repeat(64),
      mode: 'process', operation: 'workspace-runtime.start.v1', operationId,
      workspaceId: '123e4567-e89b-42d3-a456-426614174001'
    };
    const origin = await start(createSshControlGatewayHttpApi({
      async execute(actor, request) {
        calls.push({ actor, request });
        return workspaceSuccess(operationId);
      }
    }, async () => ({ callerMachineId: 'machine-one', userId: 'owner-one' })));
    const response = await fetch(`${origin}/api/compute/control/workspace-runtime`, {
      body: JSON.stringify(input),
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': operationId },
      method: 'POST'
    });
    expect(response.status).toBe(200);
    expect(calls).toEqual([{
      actor: { id: 'machine-one', kind: 'machine', ownerUserId: 'owner-one' },
      request: input
    }]);
    const injected = await fetch(`${origin}/api/compute/control/workspace-runtime`, {
      body: JSON.stringify({ ...input, path: '/tmp/foreign', operationId: 'runtime-operation-two' }),
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'runtime-operation-two' },
      method: 'POST'
    });
    expect(injected.status).toBe(409);
    expect(calls).toHaveLength(1);
  });

  test('accepts only a machine-bound Worktree preparation request', async () => {
    const calls: unknown[] = [];
    const operationId = 'worktree-operation-one';
    const input = {
      branch: 'issue-658-runtime-mutations',
      commit: '0123456789abcdef0123456789abcdef01234567',
      environmentId,
      operationId,
      repository: 'DotNaos/project-space',
      workspaceId: '123e4567-e89b-42d3-a456-426614174001',
      worktreeOwnerThreadId: '123e4567-e89b-42d3-a456-426614174002'
    };
    const origin = await start(createSshControlGatewayHttpApi({
      async execute(actor, request) {
        calls.push({ actor, request });
        return worktreeSuccess(request);
      }
    }, async () => ({ callerMachineId: 'machine-one', userId: 'owner-one' })));
    const response = await fetch(`${origin}/api/compute/control/worktree/prepare`, {
      body: JSON.stringify(input),
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': operationId },
      method: 'POST'
    });
    expect(response.status).toBe(200);
    expect(calls).toEqual([{
      actor: { id: 'machine-one', kind: 'machine', ownerUserId: 'owner-one' },
      request: { ...input, operation: 'worktree.prepare.v1' }
    }]);
    const injected = await fetch(`${origin}/api/compute/control/worktree/prepare`, {
      body: JSON.stringify({ ...input, path: '/tmp/foreign', operationId: 'worktree-operation-two' }),
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'worktree-operation-two' },
      method: 'POST'
    });
    expect(injected.status).toBe(409);
    expect(calls).toHaveLength(1);
  });

  test('rejects browsers, query input, unknown fields, and mismatched idempotency', async () => {
    let calls = 0;
    const service = { execute: async () => { calls += 1; return success('operation-one'); } };
    const human = await start(createSshControlGatewayHttpApi(
      service,
      async () => ({ userId: 'owner-one' })
    ));
    const browser = await request(human, { environmentId, operationId: 'operation-one' });
    expect(browser.status).toBe(403);

    const machine = await start(createSshControlGatewayHttpApi(
      service,
      async () => ({ callerMachineId: 'machine-one', userId: 'owner-one' })
    ));
    const query = await fetch(`${machine}/api/compute/control/status?unexpected=true`, {
      body: JSON.stringify({ environmentId, operationId: 'operation-one' }),
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'operation-one' },
      method: 'POST'
    });
    expect(query.status).toBe(409);
    const unknown = await request(machine, {
      environmentId, operationId: 'operation-one', shell: 'whoami'
    });
    expect(unknown.status).toBe(409);
    const mismatch = await fetch(`${machine}/api/compute/control/status`, {
      body: JSON.stringify({ environmentId, operationId: 'operation-one' }),
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'different' },
      method: 'POST'
    });
    expect(mismatch.status).toBe(409);
    expect(calls).toBe(0);
  });

  test('returns a bounded machine-authentication error without dispatch', async () => {
    const origin = await start(createSshControlGatewayHttpApi(
      { async execute() { throw new Error('must not dispatch'); } },
      async () => { throw new CodexMachineTasksAuthError(401); }
    ));

    const response = await request(origin, { environmentId, operationId: 'operation-one' });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: {
        code: 'authentication_failed',
        message: 'Project Space machine authentication failed.'
      }
    });
  });
});

async function start(handler: ReturnType<typeof createSshControlGatewayHttpApi>) {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (!await handler(request, response, url)) response.writeHead(404).end();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing server address.');
  return `http://127.0.0.1:${address.port}`;
}

function request(origin: string, body: Record<string, unknown>) {
  return fetch(`${origin}/api/compute/control/status`, {
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'operation-one' },
    method: 'POST'
  });
}

function success(operationId: string): SshGatewayExecutionResult {
  return {
    audit: {
      actorId: 'machine-one', actorKind: 'machine', capability: 'project_cli',
      completedAt: '2026-08-12T10:00:00.000Z', gatewayId: 'gateway-one',
      operation: 'status.v1', operationId, outcome: 'succeeded',
      routeClass: 'ssh_private_network', routeId: '22222222-2222-4222-8222-222222222222',
      targetEnvironmentId: environmentId, targetIdentityRevision: '1:environment:test'
    },
    replayed: false,
    result: {
      checkedAt: '2026-08-12T10:00:00.000Z', operation: 'status.v1', operationId,
      schemaVersion: 1, state: 'ready', targetIdentityRevision: '1:environment:test',
      type: 'result'
    }
  };
}

function workspaceSuccess(operationId: string): SshGatewayExecutionResult {
  return {
    audit: {
      actorId: 'machine-one', actorKind: 'machine', capability: 'project_cli',
      completedAt: '2026-08-12T10:00:00.000Z', gatewayId: 'gateway-one',
      operation: 'workspace-runtime.start.v1', operationId, outcome: 'succeeded',
      routeClass: 'ssh_private_network', routeId: '22222222-2222-4222-8222-222222222222',
      targetEnvironmentId: environmentId, targetIdentityRevision: '1:environment:test'
    },
    replayed: false,
    result: {
      checkedAt: '2026-08-12T10:00:00.000Z', disposition: 'created',
      generation: '123e4567-e89b-42d3-a456-426614174000', manifestDigest: 'a'.repeat(64),
      mode: 'process', operation: 'workspace-runtime.start.v1', operationId,
      schemaVersion: 1, sourceHead: '0123456789abcdef0123456789abcdef01234567',
      state: 'running', targetIdentityRevision: '1:environment:test', type: 'result',
      workspaceId: '123e4567-e89b-42d3-a456-426614174001'
    }
  };
}

function worktreeSuccess(request: {
  branch?: string;
  commit?: string;
  operationId: string;
  workspaceId?: string;
}): SshGatewayExecutionResult {
  return {
    audit: {
      actorId: 'machine-one', actorKind: 'machine', capability: 'project_cli',
      completedAt: '2026-08-12T10:00:00.000Z', gatewayId: 'gateway-one',
      operation: 'worktree.prepare.v1', operationId: request.operationId, outcome: 'succeeded',
      routeClass: 'ssh_private_network', routeId: '22222222-2222-4222-8222-222222222222',
      targetEnvironmentId: environmentId, targetIdentityRevision: '1:environment:test'
    },
    replayed: false,
    result: {
      branch: request.branch!, checkedAt: '2026-08-12T10:00:00.000Z', commit: request.commit!,
      operation: 'worktree.prepare.v1', operationId: request.operationId, schemaVersion: 1,
      state: 'ready', targetIdentityRevision: '1:environment:test', type: 'result',
      workspaceId: request.workspaceId!
    }
  };
}
