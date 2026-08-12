import { createServer, type Server } from 'node:http';

import { afterEach, describe, expect, test } from 'bun:test';

import { createWorkspaceRuntimeLaunchHttpApi } from '../server/workspace-runtime-session/launch-http';

const servers: Server[] = [];
const request = {
  branch: 'issue-625', commit: 'a'.repeat(40),
  environmentId: '11111111-1111-4111-8111-111111111111',
  generation: '22222222-2222-4222-8222-222222222222', manifestDigest: 'b'.repeat(64),
  mode: 'process', operationId: 'workspace-start:625', runtimeVersion: '0.4.66',
  workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
};

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe('Workspace Runtime productive launch HTTP boundary', () => {
  test('binds machine owner identity and reaches the trusted launch service without exposing the token', async () => {
    const token = 'A'.repeat(43);
    const calls: unknown[] = [];
    const origin = await start(createWorkspaceRuntimeLaunchHttpApi({
      endpoint: () => 'wss://projects.os-home.net/api/workspace-runtimes/socket',
      gateway: {
        async replaySucceeded() { return undefined; },
        async execute(actor, input) {
          calls.push({ actor, input });
          return success(actor.id, input, request.generation);
        }
      },
      resolveActor: async () => ({ callerMachineId: 'machine-one', userId: 'owner-one' }),
      sessions: {
        async issue(input) {
          expect(input.ownerUserId).toBe('owner-one');
          return { credential: {
            capabilities: input.capabilities, credentialId: '33333333-3333-4333-8333-333333333333',
            environmentId: input.environmentId, expiresAt: new Date(Date.now() + 60_000).toISOString(),
            generation: input.generation, schemaVersion: 1, token, workspaceId: input.workspaceId
          } };
        },
        async revoke() { throw new Error('must not revoke'); }
      }
    }));
    const response = await fetch(`${origin}/api/compute/control/workspace-runtime/launch`, {
      body: JSON.stringify(request),
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': request.operationId },
      method: 'POST'
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ replayed: false, result: { generation: request.generation, state: 'running' } });
    expect(JSON.stringify(body)).not.toContain(token);
    expect(calls).toHaveLength(1);
  });

  test('rejects browser actors, owner injection, and changed idempotency before issuance', async () => {
    let issues = 0;
    const handler = createWorkspaceRuntimeLaunchHttpApi({
      endpoint: () => 'wss://projects.os-home.net/api/workspace-runtimes/socket',
      gateway: { async execute() { throw new Error('must not execute'); }, async replaySucceeded() { return undefined; } },
      resolveActor: async () => ({ userId: 'owner-one' }),
      sessions: {
        async issue() { issues += 1; throw new Error('must not issue'); },
        async revoke() {}
      }
    });
    const origin = await start(handler);
    const browser = await post(origin, request);
    expect(browser.status).toBe(403);

    const machineOrigin = await start(createWorkspaceRuntimeLaunchHttpApi({
      endpoint: () => 'wss://projects.os-home.net/api/workspace-runtimes/socket',
      gateway: { async execute() { throw new Error('must not execute'); }, async replaySucceeded() { return undefined; } },
      resolveActor: async () => ({ callerMachineId: 'machine-one', userId: 'owner-one' }),
      sessions: {
        async issue() { issues += 1; throw new Error('must not issue'); },
        async revoke() {}
      }
    }));
    expect((await post(machineOrigin, { ...request, ownerUserId: 'other-owner' })).status).toBe(409);
    expect((await fetch(`${machineOrigin}/api/compute/control/workspace-runtime/launch`, {
      body: JSON.stringify(request), headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'changed' }, method: 'POST'
    })).status).toBe(409);
    expect(issues).toBe(0);
  });
});

async function start(handler: ReturnType<typeof createWorkspaceRuntimeLaunchHttpApi>) {
  const server = createServer(async (incoming, response) => {
    const url = new URL(incoming.url ?? '/', 'http://127.0.0.1');
    if (!await handler(incoming, response, url)) response.writeHead(404).end();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing server address.');
  return `http://127.0.0.1:${address.port}`;
}

function post(origin: string, body: Record<string, unknown>) {
  return fetch(`${origin}/api/compute/control/workspace-runtime/launch`, {
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': request.operationId },
    method: 'POST'
  });
}

function success(actorId: string, input: any, generation: string) {
  return {
    audit: {
      actorId, actorKind: 'machine' as const, capability: 'project_cli' as const,
      gatewayId: 'gateway-one', operation: input.operation, operationId: input.operationId,
      outcome: 'succeeded' as const, routeClass: 'ssh_private_network' as const,
      routeId: '44444444-4444-4444-8444-444444444444', targetEnvironmentId: input.environmentId,
      targetIdentityRevision: 'revision-one'
    },
    replayed: false,
    result: {
      checkedAt: new Date().toISOString(), generation, manifestDigest: input.expectedManifestDigest,
      mode: input.mode, operation: input.operation, operationId: input.operationId,
      schemaVersion: 1 as const, sourceHead: input.expectedCommit, state: 'running' as const,
      targetIdentityRevision: 'revision-one', type: 'result' as const, workspaceId: input.workspaceId
    }
  };
}
