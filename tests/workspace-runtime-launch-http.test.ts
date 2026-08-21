import { createServer, type Server } from 'node:http';

import { afterEach, describe, expect, test } from 'bun:test';

import { createWorkspaceRuntimeLaunchHttpApi } from '../server/workspace-runtime-session/launch-http';
import { createWorkspaceRuntimeClientLaunchHttpApi } from '../server/workspace-runtime-session/client-launch-http';

const servers: Server[] = [];
const worktreeOwnerThreadId = '44444444-4444-4444-8444-444444444444';
const clientTargetIdentityRevision = 'identity-d893e11b0c955018d297d71ee445e277';
const request = {
  branch: 'issue-625', commit: 'a'.repeat(40),
  environmentId: '11111111-1111-4111-8111-111111111111',
  generation: '22222222-2222-4222-8222-222222222222', manifestDigest: 'b'.repeat(64),
  mode: 'process', operationId: 'workspace-start:625', profile: 'inspection', runtimeVersion: '0.4.66',
  workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
};

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe('Workspace Runtime productive launch HTTP boundary', () => {
  test('issues an exact Environment/Host Runtime credential without opening server SSH', async () => {
    const token = 'A'.repeat(43);
    let issued = 0;
    const origin = await startClient(createWorkspaceRuntimeClientLaunchHttpApi({
      endpoint: () => 'wss://projects.os-home.net/api/workspace-runtimes/socket',
      resolveActor: async () => ({ callerMachineId: 'machine-one', userId: 'owner-one' }),
      resolveTarget: async () => ({
        environmentId: request.environmentId,
        hostId: '33333333-3333-4333-8333-333333333333',
        targetIdentityRevision: '7:environment:canonical'
      }),
      sessions: {
        async issue(input) {
          issued += 1;
          return { credential: {
            capabilities: input.capabilities,
            credentialId: '55555555-5555-4555-8555-555555555555',
            environmentId: input.environmentId,
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            generation: input.generation,
            schemaVersion: 1,
            token,
            workspaceId: input.workspaceId
          } };
        },
        async revoke() { throw new Error('must not revoke'); }
      }
    }));
    const response = await fetch(`${origin}/api/compute/control/workspace-runtime/client-launch`, {
      body: JSON.stringify({
        ...request,
        hostId: '33333333-3333-4333-8333-333333333333',
        targetIdentityRevision: clientTargetIdentityRevision
      }),
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': request.operationId },
      method: 'POST'
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      controlTargetIdentityRevision: '7:environment:canonical',
      environmentId: request.environmentId,
      hostId: '33333333-3333-4333-8333-333333333333',
      operation: 'workspace-runtime.start.v1',
      runtimeSessionToken: token,
      state: 'ready',
      targetIdentityRevision: clientTargetIdentityRevision
    });
    expect(issued).toBe(1);
  });

  test('rejects a changed exact Host or identity revision before issuing a Runtime credential', async () => {
    let issued = 0;
    const origin = await startClient(createWorkspaceRuntimeClientLaunchHttpApi({
      endpoint: () => 'wss://projects.os-home.net/api/workspace-runtimes/socket',
      resolveActor: async () => ({ callerMachineId: 'machine-one', userId: 'owner-one' }),
      resolveTarget: async () => ({
        environmentId: request.environmentId,
        hostId: '33333333-3333-4333-8333-333333333333',
        targetIdentityRevision: '7:environment:canonical'
      }),
      sessions: {
        async issue() { issued += 1; throw new Error('must not issue'); },
        async revoke() {}
      }
    }));
    const changedHost = await postClient(origin, {
      ...request,
      hostId: '44444444-4444-4444-8444-444444444444',
      targetIdentityRevision: '7:environment:canonical'
    });
    expect(changedHost.status).toBe(503);
    const changedRevision = await postClient(origin, {
      ...request,
      hostId: '33333333-3333-4333-8333-333333333333',
      targetIdentityRevision: '8:environment:canonical'
    });
    expect(changedRevision.status).toBe(503);
    expect(issued).toBe(0);
  });

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
      resolvePresentation: async (input) => {
        expect(input).toEqual({
          branch: request.branch, commit: request.commit,
          environmentId: request.environmentId, ownerUserId: 'owner-one',
          workspaceId: request.workspaceId, worktreeOwnerThreadId
        });
        return { repository: 'DotNaos/project-space', task: { number: 717 } };
      },
      sessions: {
        async issue(input) {
          expect(input.ownerUserId).toBe('owner-one');
          expect(input.presentation).toEqual({
            repository: 'DotNaos/project-space', task: { number: 717 }
          });
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
      body: JSON.stringify({
        ...request,
        worktreeOwnerThreadId
      }),
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': request.operationId },
      method: 'POST'
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ replayed: false, result: { generation: request.generation, state: 'running' } });
    expect(JSON.stringify(body)).not.toContain(token);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ input: { operationId: request.operationId } });
  });

  test('replays a completed launch when optional presentation discovery disappears', async () => {
    let completed: ReturnType<typeof success> | undefined;
    let issues = 0;
    const origin = await start(createWorkspaceRuntimeLaunchHttpApi({
      endpoint: () => 'wss://projects.os-home.net/api/workspace-runtimes/socket',
      gateway: {
        async execute(actor, input) {
          completed = success(actor.id, input, request.generation);
          return completed;
        },
        async replaySucceeded() { return completed; }
      },
      resolveActor: async () => ({ callerMachineId: 'machine-one', userId: 'owner-one' }),
      resolvePresentation: async () => ({
        repository: 'DotNaos/project-space', task: { number: 717 }
      }),
      sessions: {
        async issue(input) {
          issues += 1;
          return { credential: {
            capabilities: input.capabilities,
            credentialId: '33333333-3333-4333-8333-333333333333',
            environmentId: input.environmentId,
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            generation: input.generation,
            schemaVersion: 1,
            token: 'A'.repeat(43),
            workspaceId: input.workspaceId
          } };
        },
        async revoke() { throw new Error('must not revoke'); }
      }
    }));

    const first = await post(origin, {
      ...request,
      worktreeOwnerThreadId
    });
    expect(first.status).toBe(200);
    expect((await first.json()).replayed).toBe(false);

    const retry = await post(origin, request);
    expect(retry.status).toBe(200);
    expect((await retry.json()).replayed).toBe(true);
    expect(issues).toBe(1);
  });

  test('rejects browser actors, owner injection, and changed idempotency before issuance', async () => {
    let issues = 0;
    const handler = createWorkspaceRuntimeLaunchHttpApi({
      endpoint: () => 'wss://projects.os-home.net/api/workspace-runtimes/socket',
      gateway: {
        async execute(actor, input) { return success(actor.id, input, request.generation); },
        async replaySucceeded() { return undefined; }
      },
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

  test('rejects malformed Worktree binding and ignores optional context that cannot be verified', async () => {
    let issues = 0;
    const handler = createWorkspaceRuntimeLaunchHttpApi({
      endpoint: () => 'wss://projects.os-home.net/api/workspace-runtimes/socket',
      gateway: { async execute() { throw new Error('must not execute'); }, async replaySucceeded() { return undefined; } },
      resolveActor: async () => ({ callerMachineId: 'machine-one', userId: 'owner-one' }),
      sessions: {
        async issue() { issues += 1; throw new Error('must not issue'); },
        async revoke() {}
      }
    });
    const malformed = await start(handler);
    expect((await post(malformed, {
      ...request, worktreeOwnerThreadId: 'caller-selected-label'
    })).status).toBe(409);

    const unavailable = await start(createWorkspaceRuntimeLaunchHttpApi({
      endpoint: () => 'wss://projects.os-home.net/api/workspace-runtimes/socket',
      gateway: {
        async execute(actor, input) { return success(actor.id, input, request.generation); },
        async replaySucceeded() { return undefined; }
      },
      resolveActor: async () => ({ callerMachineId: 'machine-one', userId: 'owner-one' }),
      resolvePresentation: async () => undefined,
      sessions: {
        async issue(input) {
          issues += 1;
          expect(input.presentation).toBeUndefined();
          return { credential: {
            capabilities: input.capabilities, credentialId: '33333333-3333-4333-8333-333333333333',
            environmentId: input.environmentId, expiresAt: new Date(Date.now() + 60_000).toISOString(),
            generation: input.generation, schemaVersion: 1, token: 'A'.repeat(43), workspaceId: input.workspaceId
          } };
        },
        async revoke() {}
      }
    }));
    expect((await post(unavailable, {
      ...request,
      worktreeOwnerThreadId
    })).status).toBe(200);
    expect(issues).toBe(1);
  });

  test('advertises presentation support only to authenticated machines', async () => {
    const origin = await start(createWorkspaceRuntimeLaunchHttpApi({
      endpoint: () => 'wss://projects.os-home.net/api/workspace-runtimes/socket',
      gateway: { async execute() { throw new Error('unused'); }, async replaySucceeded() { return undefined; } },
      resolveActor: async () => ({ callerMachineId: 'machine-one', userId: 'owner-one' }),
      sessions: {
        async issue() { throw new Error('unused'); },
        async revoke() { throw new Error('unused'); }
      }
    }));
    const response = await fetch(`${origin}/api/compute/control/workspace-runtime/capabilities`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      capabilities: ['workspace-runtime-presentation.v1'], schemaVersion: 1
    });
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

async function startClient(handler: ReturnType<typeof createWorkspaceRuntimeClientLaunchHttpApi>) {
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

function postClient(origin: string, body: Record<string, unknown>) {
  return fetch(`${origin}/api/compute/control/workspace-runtime/client-launch`, {
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
