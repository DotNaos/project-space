import { describe, expect, test } from 'bun:test';

import { MemoryCanonicalRuntimeControlOperationStore } from '../server/canonical-runtime-control/memory-operation-store';
import { createCanonicalRuntimeControlService } from '../server/canonical-runtime-control/service';
import { createWorkspaceRuntimeControlDispatcher } from '../server/canonical-runtime-control/workspace-runtime-dispatcher';
import { MemoryRuntimeSessionStore } from '../server/workspace-runtime-session/memory-store';
import { WorkspaceRuntimeSessionService } from '../server/workspace-runtime-session/service';
import {
  canonicalRuntimeControlApiVersion,
  canonicalRuntimeControlOperations,
  type CanonicalRuntimeControlOperation
} from '../src/shared/canonical-runtime-control-api';
import type { ComputeInventorySnapshot } from '../src/shared/compute-environment-api';
import type { WorkspaceRuntimeSessionSnapshot } from '../src/shared/workspace-runtime-session-api';
import {
  workspaceRuntimeBaseCapabilities,
  workspaceRuntimeControlCapability
} from '../src/shared/workspace-runtime-session-api';

const environmentId = '11111111-1111-4111-8111-111111111111';
const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const generation = '22222222-2222-4222-8222-222222222222';
const actor = { actorId: 'flora', actorKind: 'agent' as const, ownerUserId: 'owner' };

function fixture(options: { authorized?: boolean; runtime?: Partial<WorkspaceRuntimeSessionSnapshot> } = {}) {
  const calls: Array<Record<string, unknown>> = [];
  const compute = {
    connectors: [{ associatedAt: new Date(0).toISOString(), connectorId: 'legacy-connector', environmentId }],
    environmentDefinitions: [{
      bootstrapStrategy: 'workspace_runtime', id: 'definition', kind: 'docker', name: 'Runtime',
      operatingSystemFamily: 'other', ownership: 'built_in', slug: 'runtime', supportedArchitectures: []
    }],
    environments: [{
      environmentDefinitionId: 'definition', hostAssociation: { evidence: 'none', resolution: 'not_applicable' },
      id: environmentId, identity: { key: 'environment:canonical', version: 7 }, kind: 'docker',
      name: 'Canonical runtime', platformId: 'platform', resourceMode: 'dedicated'
    }],
    hosts: [],
    platforms: [{ id: 'platform', kind: 'local', name: 'Local' }],
    violations: []
  } satisfies ComputeInventorySnapshot;
  const runtime = {
    branch: 'issue-647', capabilities: ['runtime.control.v1' as never], commit: 'a'.repeat(40),
    connectionState: 'online', devServers: [], environmentId, expiresAt: '2026-08-13T00:00:00.000Z',
    generation, lastEventAt: '2026-08-12T00:00:00.000Z', lastHeartbeatAt: '2026-08-12T00:00:00.000Z',
    lastSequence: 1, lifecycleState: 'running', manifestDigest: 'b'.repeat(64), runtimeVersion: '1.0.0',
    schemaVersion: 1, sessionId: 'session-runtime', workspaceId, ...options.runtime
  } satisfies WorkspaceRuntimeSessionSnapshot;
  const service = createCanonicalRuntimeControlService({
    authorizer: {
      async authorize(input) {
        calls.push({ phase: input.phase, operation: input.operation });
        return options.authorized !== false;
      }
    },
    dispatcher: {
      async dispatch(input) {
        calls.push({
          dispatched: input.request.operation,
          environmentId: input.target.environmentId,
          generation: input.target.generation,
          workspaceId: input.target.workspaceId
        });
        return { output: { accepted: true }, state: 'completed' };
      }
    },
    inventory: {
      async compute() { return compute; },
      async runtimes() { return [runtime]; }
    },
    operations: new MemoryCanonicalRuntimeControlOperationStore()
  });
  return { calls, compute, runtime, service };
}

function request(operation: CanonicalRuntimeControlOperation, operationId = `operation:${operation}`) {
  return {
    apiVersion: canonicalRuntimeControlApiVersion,
    environmentId,
    expectedGeneration: generation,
    expectedTargetIdentityRevision: '7:environment:canonical',
    operation,
    operationId,
    workspaceId
  };
}

describe('canonical runtime control', () => {
  test('routes every migrated responsibility through one exact Runtime target without Connector input', async () => {
    const runtime = fixture();
    for (const operation of canonicalRuntimeControlOperations) {
      expect(await runtime.service.execute(actor, request(operation))).toMatchObject({
        compatibilityAlias: false,
        environmentId,
        generation,
        operation,
        state: 'completed',
        workspaceId
      });
    }
    const dispatches = runtime.calls.filter((entry) => entry.dispatched);
    expect(dispatches).toHaveLength(canonicalRuntimeControlOperations.length);
    expect(dispatches.every((entry) => !('connectorId' in entry))).toBe(true);
  });

  test('makes a legacy Connector alias enter the same resolver and both authorization phases', async () => {
    const runtime = fixture();
    const result = await runtime.service.executeLegacyAlias(actor, {
      apiVersion: canonicalRuntimeControlApiVersion,
      connectorId: 'legacy-connector',
      expectedGeneration: generation,
      operation: 'git.status',
      operationId: 'legacy:git-status',
      workspaceId
    });
    expect(result).toMatchObject({
      compatibilityAlias: true,
      environmentId,
      targetIdentityRevision: '7:environment:canonical'
    });
    expect(runtime.calls.map(({ phase }) => phase).filter(Boolean))
      .toEqual(['target_resolution', 'execution']);
    expect(runtime.calls.find(({ dispatched }) => dispatched)).not.toHaveProperty('connectorId');
  });

  test('fails closed for unknown aliases, ambiguous identities, stale generations, and denied actors', async () => {
    await expect(fixture().service.executeLegacyAlias(actor, {
      apiVersion: 1, connectorId: 'unknown', expectedGeneration: generation,
      operation: 'git.status', operationId: 'legacy:unknown', workspaceId
    })).rejects.toMatchObject({ code: 'target_unavailable' });
    await expect(fixture({ runtime: { generation: 'different-generation' } }).service.execute(
      actor,
      request('git.status', 'canonical:stale')
    )).rejects.toMatchObject({ code: 'target_unavailable' });
    await expect(fixture({ authorized: false }).service.execute(
      actor,
      request('git.status', 'canonical:denied')
    )).rejects.toMatchObject({ code: 'authorization_denied' });
  });

  test('replays identical input and rejects operation ID reuse with changed input', async () => {
    const runtime = fixture();
    const first = await runtime.service.execute(actor, request('git.status', 'stable-operation'));
    const replay = await runtime.service.execute(actor, request('git.status', 'stable-operation'));
    expect(first.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    await expect(runtime.service.execute(actor, request('git.diff', 'stable-operation')))
      .rejects.toMatchObject({ code: 'operation_conflict' });
    expect(runtime.calls.filter(({ dispatched }) => dispatched)).toHaveLength(1);
  });

  test('rejects secret-shaped payloads before target resolution', async () => {
    await expect(fixture().service.execute(actor, {
      ...request('git.commit', 'unsafe-payload'),
      payload: { secretToken: 'do-not-store' }
    })).rejects.toMatchObject({ code: 'invalid_request' });
  });

  test('dispatches through the authenticated outbound Runtime socket with no Connector process', async () => {
    const base = fixture();
    const store = new MemoryRuntimeSessionStore();
    const sessions = new WorkspaceRuntimeSessionService(store);
    const issued = await store.issue({
      branch: 'issue-647', capabilities: [...workspaceRuntimeBaseCapabilities],
      commit: 'a'.repeat(40), environmentId, generation, manifestDigest: 'b'.repeat(64),
      operationId: 'runtime-control-credential', ownerUserId: actor.ownerUserId,
      requestedCapabilities: [workspaceRuntimeControlCapability], runtimeVersion: '1.0.0',
      workspaceId
    });
    const scope = await store.authenticate(issued.credential.token);
    expect(scope).not.toBeNull();
    const socket = {
      close() {},
      messages: [] as string[],
      send(value: string) { this.messages.push(value); }
    };
    const active = await sessions.register(socket, scope!, {
      branch: 'issue-647', commit: 'a'.repeat(40), environmentId, generation,
      manifestDigest: 'b'.repeat(64), readyCapabilities: [workspaceRuntimeControlCapability],
      resumeAfterControlCommandSequence: 0, resumeAfterControlEventSequence: 0,
      resumeAfterSequence: 0, runtimeVersion: '1.0.0', schemaVersion: 1,
      type: 'runtime.register', workspaceId
    });
    await sessions.append(active, {
      eventId: 'runtime-running', observedAt: new Date().toISOString(), schemaVersion: 1,
      sequence: 1, state: 'running', type: 'runtime.lifecycle'
    });
    const dispatcher = createWorkspaceRuntimeControlDispatcher(sessions, { timeoutMs: 1_000 });
    const service = createCanonicalRuntimeControlService({
      authorizer: { async authorize() { return true; } },
      dispatcher,
      inventory: {
        async compute() { return base.compute; },
        async runtimes() { return sessions.list(actor.ownerUserId); }
      },
      operations: new MemoryCanonicalRuntimeControlOperationStore()
    });
    const pending = service.execute(actor, request('dev-server.start', 'runtime:dev-server-start'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const command = JSON.parse(socket.messages.at(-1)!) as Record<string, unknown>;
    expect(command).toMatchObject({
      environmentId,
      generation,
      operation: 'dev-server.start',
      type: 'runtime.control.command',
      workspaceId
    });
    sessions.acceptControl(active, {
      ...command,
      output: { server: 'dev', state: 'ready' },
      state: 'completed',
      type: 'runtime.control.result'
    } as never);
    await expect(pending).resolves.toMatchObject({
      output: { server: 'dev', state: 'ready' },
      state: 'completed'
    });
    dispatcher.close();
    sessions.close();
  });
});
