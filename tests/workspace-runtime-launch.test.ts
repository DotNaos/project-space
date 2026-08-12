import { describe, expect, test } from 'bun:test';

import { MemoryRuntimeSessionStore } from '../server/workspace-runtime-session/memory-store';
import {
  WorkspaceRuntimeLaunchService,
  WorkspaceRuntimeSshStartDispatcher,
  type WorkspaceRuntimeStartDispatch
} from '../server/workspace-runtime-session/launch-service';
import { workspaceRuntimeCodexCapability } from '../src/shared/workspace-runtime-codex-api';
import { workspaceRuntimeControlCapability } from '../src/shared/workspace-runtime-session-api';

const authority = {
  branch: 'issue-625', commit: 'a'.repeat(40),
  environmentId: '11111111-1111-4111-8111-111111111111',
  generation: '22222222-2222-4222-8222-222222222222', manifestDigest: 'b'.repeat(64),
  mode: 'process' as const, operationId: 'workspace-start:625', ownerUserId: 'owner', profile: 'codex' as const,
  runtimeVersion: '0.5.0-test', workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
};

describe('Workspace Runtime trusted launch boundary', () => {
  test('preallocates one generation-scoped credential and passes it only to typed SSH control', async () => {
    const sessions = new MemoryRuntimeSessionStore(undefined, undefined, () => 'A'.repeat(43));
    let dispatched: WorkspaceRuntimeStartDispatch | undefined;
    const service = new WorkspaceRuntimeLaunchService({
      dispatcher: {
        async replay() { return undefined; },
        async start(input) {
          dispatched = input;
          return {
            checkedAt: new Date().toISOString(), generation: input.expectedGeneration,
            manifestDigest: input.expectedManifestDigest, operation: input.operation,
            operationId: input.operationId, sourceHead: input.expectedCommit,
            state: 'running', workspaceId: input.workspaceId
          };
        }
      },
      endpoint: 'wss://projects.os-home.net/api/workspace-runtimes/socket', sessions
    });
    const result = await service.start(authority);
    expect(dispatched).toMatchObject({
      expectedGeneration: authority.generation,
      runtimeSessionEndpoint: 'wss://projects.os-home.net/api/workspace-runtimes/socket',
      runtimeSessionToken: 'A'.repeat(43), workspaceId: authority.workspaceId
    });
    expect(dispatched?.runtimeSessionCapabilities).not.toContain(workspaceRuntimeCodexCapability);
    expect(dispatched?.runtimeSessionRequestedCapabilities).toEqual([
      workspaceRuntimeCodexCapability,
      workspaceRuntimeControlCapability
    ]);
    expect(JSON.stringify(result)).not.toContain('A'.repeat(43));
    const scope = await sessions.authenticate('A'.repeat(43));
    expect(scope).toMatchObject({
      environmentId: authority.environmentId, generation: authority.generation,
      requestedCapabilities: [workspaceRuntimeCodexCapability, workspaceRuntimeControlCapability],
      workspaceId: authority.workspaceId
    });
    expect(scope?.capabilities).not.toContain(workspaceRuntimeCodexCapability);
  });

  test('launches the inspection profile with no Connector-backed Codex capability', async () => {
    const sessions = new MemoryRuntimeSessionStore(undefined, undefined, () => 'I'.repeat(43));
    let dispatched: WorkspaceRuntimeStartDispatch | undefined;
    const service = new WorkspaceRuntimeLaunchService({
      dispatcher: {
        async replay() { return undefined; },
        async start(input) {
          dispatched = input;
          return {
            checkedAt: new Date().toISOString(), generation: input.expectedGeneration,
            manifestDigest: input.expectedManifestDigest, operation: input.operation,
            operationId: input.operationId, sourceHead: input.expectedCommit,
            state: 'running', workspaceId: input.workspaceId
          };
        }
      },
      endpoint: 'wss://projects.os-home.net/api/workspace-runtimes/socket', sessions
    });
    await service.start({ ...authority, operationId: 'workspace-start:inspection', profile: 'inspection' });
    expect(dispatched?.runtimeSessionRequestedCapabilities).toEqual([workspaceRuntimeControlCapability]);
    expect(dispatched?.runtimeSessionRequestedCapabilities).not.toContain(workspaceRuntimeCodexCapability);
  });

  test('revokes the short-lived credential when dispatch is rejected or returns changed authority', async () => {
    for (const changedResult of [false, true]) {
      const sessions = new MemoryRuntimeSessionStore(undefined, undefined, () => 'B'.repeat(43));
      const service = new WorkspaceRuntimeLaunchService({
        dispatcher: {
          async replay() { return undefined; },
          async start(input) {
            if (!changedResult) throw new Error('dispatch failed');
            return {
              checkedAt: new Date().toISOString(), generation: '33333333-3333-4333-8333-333333333333',
              manifestDigest: input.expectedManifestDigest, operation: input.operation,
              operationId: input.operationId, sourceHead: input.expectedCommit,
              state: 'running', workspaceId: input.workspaceId
            };
          }
        },
        endpoint: 'wss://projects.os-home.net/api/workspace-runtimes/socket', sessions
      });
      await expect(service.start(authority)).rejects.toThrow();
      expect(await sessions.authenticate('B'.repeat(43))).toBeNull();
    }
  });

  test('replays the durable SSH result before issuing or replacing a runtime credential', async () => {
    let issued = 0;
    let dispatched = 0;
    const result = {
      checkedAt: new Date().toISOString(), generation: authority.generation,
      manifestDigest: authority.manifestDigest, operation: 'workspace-runtime.start.v1' as const,
      operationId: authority.operationId, sourceHead: authority.commit,
      state: 'running' as const, workspaceId: authority.workspaceId
    };
    const service = new WorkspaceRuntimeLaunchService({
      dispatcher: {
        async replay(input) {
          expect(input).toEqual(authority);
          return result;
        },
        async start() {
          dispatched += 1;
          return result;
        }
      },
      endpoint: 'wss://projects.os-home.net/api/workspace-runtimes/socket',
      sessions: {
        async issue() {
          issued += 1;
          throw new Error('must not issue');
        },
        async revoke() { throw new Error('must not revoke'); }
      }
    });
    await expect(service.start(authority)).resolves.toEqual({ replayed: true, result });
    expect({ dispatched, issued }).toEqual({ dispatched: 0, issued: 0 });
  });

  test('dispatches the protected credential through the internal typed SSH service only', async () => {
    const token = 'C'.repeat(43);
    let received: { actor: unknown; request: unknown } | undefined;
    const dispatcher = new WorkspaceRuntimeSshStartDispatcher({
      replaySucceeded: async () => undefined,
      execute: async (actor, request) => {
        received = { actor, request };
        return {
          audit: {
            actorId: actor.id, actorKind: actor.kind, capability: 'project_cli',
            gatewayId: 'gateway-one', operation: request.operation,
            operationId: request.operationId, outcome: 'succeeded',
            routeClass: 'ssh_private_network', routeId: '22222222-2222-4222-8222-222222222222',
            targetEnvironmentId: request.environmentId,
            targetIdentityRevision: 'revision-one'
          },
          replayed: false,
          result: {
            checkedAt: new Date().toISOString(), generation: authority.generation,
            manifestDigest: authority.manifestDigest, mode: authority.mode,
            operation: 'workspace-runtime.start.v1', operationId: authority.operationId,
            schemaVersion: 1, sourceHead: authority.commit, state: 'running',
            targetIdentityRevision: 'revision-one', type: 'result',
            workspaceId: authority.workspaceId
          }
        };
      }
    }, { id: 'machine-one', kind: 'machine', ownerUserId: authority.ownerUserId });
    const result = await dispatcher.start({
      environmentId: authority.environmentId, expectedBranch: authority.branch,
      expectedCommit: authority.commit,
      expectedGeneration: authority.generation, expectedManifestDigest: authority.manifestDigest,
      mode: authority.mode, operation: 'workspace-runtime.start.v1',
      operationId: authority.operationId, ownerUserId: authority.ownerUserId,
      expectedRuntimeVersion: authority.runtimeVersion,
      runtimeSessionCapabilities: ['runtime.lifecycle', 'runtime.heartbeat'],
      runtimeSessionEndpoint: 'wss://projects.os-home.net/api/workspace-runtimes/socket',
      runtimeSessionExpiresAt: new Date(Date.now() + 30_000).toISOString(),
      runtimeSessionToken: token, runtimeSessionVersion: authority.runtimeVersion,
      workspaceId: authority.workspaceId
    });
    expect(result.generation).toBe(authority.generation);
    expect((received?.request as { runtimeSessionToken?: string }).runtimeSessionToken).toBe(token);
    expect(JSON.stringify(result)).not.toContain(token);
  });

  test('allows only one credential issue and dispatch for concurrent identical starts', async () => {
    const sessions = new MemoryRuntimeSessionStore(undefined, undefined, () => 'D'.repeat(43));
    let dispatched = 0;
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const service = new WorkspaceRuntimeLaunchService({
      dispatcher: {
        async replay() { return undefined; },
        async start(input) {
          dispatched += 1;
          await blocked;
          return {
            checkedAt: new Date().toISOString(), generation: input.expectedGeneration,
            manifestDigest: input.expectedManifestDigest, operation: input.operation,
            operationId: input.operationId, sourceHead: input.expectedCommit,
            state: 'running', workspaceId: input.workspaceId
          };
        }
      },
      endpoint: 'wss://projects.os-home.net/api/workspace-runtimes/socket', sessions
    });
    const first = service.start(authority);
    const second = service.start(authority);
    await expect(second).rejects.toMatchObject({ code: 'operation_in_progress' });
    release();
    await expect(first).resolves.toMatchObject({ replayed: false });
    expect(dispatched).toBe(1);
    expect(await sessions.authenticate('D'.repeat(43))).toMatchObject({ generation: authority.generation });
  });
});
